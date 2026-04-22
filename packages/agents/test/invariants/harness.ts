import { run, createChannel, scoped } from 'effection';
import type { Channel } from 'effection';
import { MockSessionContext } from '../../../sdk/test/MockSessionContext';
import { Branch } from '../../../sdk/src/Branch';
import { BranchStore } from '../../../sdk/src/BranchStore';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool } from '../../src/agent-pool';
import type { Orchestrator } from '../../src/orchestrators';
import { parallel, chain } from '../../src/orchestrators';
import { Ctx, Store, Events, Trace } from '../../src/context';
import type { AgentPolicy } from '../../src/AgentPolicy';
import type { AgentPoolResult, AgentEvent } from '../../src/types';
import type { TraceEvent } from '../../src/trace-types';
import type { Tool } from '../../src/Tool';
import { CapturingTraceWriter } from '../helpers/capturing-trace';

const STOP = 999;

export type NativeOp = 'prefill' | 'commit' | 'sample';

export interface NativeCall {
  seq: number;
  op: NativeOp;
  tStart: number;
  tEnd: number;
  branchCount: number;
  tokenCount: number;
}

export interface PoolRun {
  result: AgentPoolResult;
  traceEvents: TraceEvent[];
  channelEvents: AgentEvent[];
  nativeCalls: NativeCall[];
  ctx: InstrumentedMockSessionContext;
}

/**
 * MockSessionContext wrapper that records every native entry point
 * with start/end timestamps. Temporal overlap between two recorded calls
 * is prima facie evidence that two fibers reached the native layer
 * simultaneously — which the architecture forbids.
 */
export class InstrumentedMockSessionContext extends MockSessionContext {
  readonly nativeCalls: NativeCall[] = [];
  private _seq = 0;

  async _storePrefill(handles: number[], tokenArrays: number[][]): Promise<void> {
    const tStart = performance.now();
    const seq = this._seq++;
    await super._storePrefill(handles, tokenArrays);
    const tEnd = performance.now();
    this.nativeCalls.push({
      seq, op: 'prefill', tStart, tEnd,
      branchCount: handles.length,
      tokenCount: tokenArrays.reduce((s, a) => s + a.length, 0),
    });
  }

  async _storeCommit(handles: number[], tokens: number[]): Promise<void> {
    const tStart = performance.now();
    const seq = this._seq++;
    await super._storeCommit(handles, tokens);
    const tEnd = performance.now();
    this.nativeCalls.push({
      seq, op: 'commit', tStart, tEnd,
      branchCount: handles.length,
      tokenCount: tokens.length,
    });
  }
}

function createInstrumentedMockSdk(opts: { nCtx?: number; cellsUsed?: number }) {
  const ctx = new InstrumentedMockSessionContext(opts);
  const store = new BranchStore(ctx);
  const root = Branch.create(ctx, 0);
  return { ctx, store, root };
}

/** Deterministic token sequence for a spawned agent. Terminate with STOP. */
export interface AgentScript {
  /** Tokens returned by produceSync in order. Exhaustion returns STOP. */
  tokens: number[];
  /** If set, parseChatOutput returns this tool call when isStop fires. */
  toolCall?: { name: string; arguments: string; id?: string };
  /**
   * If set, parseChatOutput ALSO returns this tool call during isPartial
   * parses — latching `agent.currentTool` on the first observe() call.
   * Used to test terminal-tool-protection / absolute-floor interactions.
   */
  partialToolCall?: { name: string; arguments: string; id?: string };
  /** If set, parseChatOutput returns this content (free-text path). */
  content?: string;
}

export interface PoolSpec {
  nCtx?: number;
  cellsUsed?: number;
  /** Per-fork token script, indexed by fork order (0 = first forked agent). */
  scripts: AgentScript[];
  policy: AgentPolicy;
  tools?: Map<string, Tool>;
  toolsJson?: string;
  terminalTool?: string;
  maxTurns?: number;
  taskCount?: number;
  orchestrate?: Orchestrator;
  trace?: boolean;
  pruneOnReport?: boolean;
  /** See `AgentPoolOptions.enableThinking`. @default false */
  enableThinking?: boolean;
}

/**
 * Run a real useAgentPool against an instrumented MockSessionContext and
 * capture trace events, channel events, and native-call timing.
 *
 * The returned PoolRun is the sole input to invariant predicates.
 */
export async function runPool(spec: PoolSpec): Promise<PoolRun> {
  const { ctx, store, root } = createInstrumentedMockSdk({
    nCtx: spec.nCtx,
    cellsUsed: spec.cellsUsed,
  });

  // Wire scripted _branchSample: index by forkCount, advance per sample.
  let forkCount = 0;
  const branchForkIndex = new Map<number, number>();
  const branchSampleCount = new Map<number, number>();

  const origFork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parentHandle: number): number => {
    const handle = origFork(parentHandle);
    branchForkIndex.set(handle, forkCount++);
    branchSampleCount.set(handle, 0);
    return handle;
  };

  // parseChatOutput needs to know which agent's output it's parsing, but
  // it only receives the raw string — not the branch handle. Track the
  // last-sampled handle as a side channel so parseChatOutput can look up
  // the script that produced those tokens.
  let lastSampledHandle = 0;
  ctx._branchSample = (handle: number): number => {
    lastSampledHandle = handle;
    const fi = branchForkIndex.get(handle) ?? -1;
    const script = fi >= 0 ? spec.scripts[fi] : undefined;
    const tokens = script?.tokens ?? [STOP];
    const idx = branchSampleCount.get(handle) ?? 0;
    branchSampleCount.set(handle, idx + 1);
    return idx < tokens.length ? tokens[idx] : STOP;
  };

  ctx.parseChatOutput = (
    output: string,
    _format: ChatFormat,
    opts?: ParseChatOutputOptions,
  ): ParseChatOutputResult => {
    const fi = branchForkIndex.get(lastSampledHandle) ?? -1;
    const script = fi >= 0 ? spec.scripts[fi] : undefined;
    if (opts?.isPartial) {
      // Partial parse — if the script declares a partialToolCall, latch it
      // so agent.observe() sets currentTool. Used for terminal-tool-protection
      // scenarios where we need the protection path to engage.
      if (script?.partialToolCall) {
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ ...script.partialToolCall, id: script.partialToolCall.id ?? 'c1' }],
        };
      }
      return { content: '', reasoningContent: '', toolCalls: [] };
    }
    if (script?.toolCall) {
      return {
        content: '',
        reasoningContent: '',
        toolCalls: [{ ...script.toolCall, id: script.toolCall.id ?? 'c1' }],
      };
    }
    return { content: script?.content ?? '', reasoningContent: '', toolCalls: [] };
  };

  const trace = new CapturingTraceWriter();
  const channelEvents: AgentEvent[] = [];

  const rootTokens = ctx.tokenizeSync('system prompt');
  await root.prefill(rootTokens);

  const toolsJson = spec.toolsJson ?? (spec.tools && spec.tools.size > 0
    ? JSON.stringify([...spec.tools.values()].map(t => t.schema))
    : '');

  const result = await run(function* () {
    yield* Ctx.set(ctx as any);
    yield* Store.set(store);
    const events: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(events as any);
    yield* Trace.set(trace);

    const taskCount = spec.taskCount ?? spec.scripts.length;
    const taskSpecs = Array.from({ length: taskCount }, (_, i) => ({
      content: `Task ${i}`,
      seed: i,
    }));
    const orchestrate = spec.orchestrate ?? parallel(taskSpecs);

    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        root,
        orchestrate,
        systemPrompt: 'You are an agent.',
        toolsJson,
        tools: spec.tools ?? new Map(),
        policy: spec.policy,
        maxTurns: spec.maxTurns ?? 100,
        terminalTool: spec.terminalTool,
        trace: spec.trace ?? false,
        pruneOnReport: spec.pruneOnReport ?? false,
        enableThinking: spec.enableThinking,
      });
      let next = yield* sub.next();
      while (!next.done) {
        channelEvents.push(next.value);
        next = yield* sub.next();
      }
      return next.value;
    });
  });

  return {
    result,
    traceEvents: trace.events,
    channelEvents,
    nativeCalls: ctx.nativeCalls,
    ctx,
  };
}

// Re-export orchestrator factories for scenario/property convenience.
export { parallel, chain };
export { STOP };
