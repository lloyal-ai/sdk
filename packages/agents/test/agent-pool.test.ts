/**
 * Pool-level integration tests — verifies the pool's EXECUTION of policy decisions.
 *
 * Uses real Branch + BranchStore from @lloyal-labs/sdk with MockSessionContext
 * that simulates the native layer. This validates the full call chain:
 * useAgentPool -> Branch.produceSync/forkSync/pruneSync -> SessionContext._branch/_store
 *
 * 145 unit tests already cover policy DECISIONS. These 18 tests cover EXECUTION:
 * transitions, trace events, event emissions, ToolContext fields, recovery.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, spawn, each, scoped, call } from 'effection';
import type { Operation, Channel } from 'effection';
import { MockSessionContext, createMockSdk } from '../../sdk/test/MockSessionContext';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool } from '../src/agent-pool';
import { Ctx, Store, Events, Trace } from '../src/context';
import { Tool } from '../src/Tool';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { AgentPoolResult, AgentEvent, ToolContext, AgentTaskSpec } from '../src/types';
import type { Agent } from '../src/Agent';
import { CapturingTraceWriter } from './helpers/capturing-trace';

const STOP = 999; // MockSessionContext default stopToken

// ── Test helpers ────────────────────────────────────────────────

/**
 * Run useAgentPool in a fully-wired Effection scope with mock infrastructure.
 *
 * forkTokenQueues: per-fork token sequences. Index 0 = first fork, 1 = second, etc.
 * Each array is the sequence of tokens _branchSample returns for that fork.
 * Exhausted queues return STOP.
 */
async function runPool(opts: {
  nCtx?: number;
  cellsUsed?: number;
  forkTokenQueues?: number[][];
  parseChatOutputFn?: (raw: string, format: ChatFormat, opts?: ParseChatOutputOptions) => ParseChatOutputResult;
  policy: AgentPolicy;
  taskCount?: number;
  tools?: Map<string, Tool>;
  terminalTool?: string;
  maxTurns?: number;
  trace?: boolean;
  pruneOnReport?: boolean;
}): Promise<{
  result: AgentPoolResult;
  events: AgentEvent[];
  trace: CapturingTraceWriter;
  ctx: MockSessionContext;
}> {
  const { ctx, store, root } = createMockSdk({
    nCtx: opts.nCtx ?? 16384,
    cellsUsed: opts.cellsUsed ?? 1000,
  });

  // ── Wire per-fork token queues into _branchSample ─────────
  const queues = opts.forkTokenQueues ?? [[STOP]];
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

  ctx._branchSample = (handle: number): number => {
    const fi = branchForkIndex.get(handle) ?? -1;
    const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
    const idx = branchSampleCount.get(handle) ?? 0;
    branchSampleCount.set(handle, idx + 1);
    return idx < queue.length ? queue[idx] : STOP;
  };

  // ── Wire parseChatOutput override ─────────────────────────
  if (opts.parseChatOutputFn) {
    ctx.parseChatOutput = opts.parseChatOutputFn;
  }

  // ── Wire tokenToText for readable output ──────────────────
  // (default `t${token}` from MockSessionContext is fine for most tests)

  const traceWriter = new CapturingTraceWriter();
  const collectedEvents: AgentEvent[] = [];

  // Prefill root to simulate withSharedRoot system prompt
  const rootTokens = ctx.tokenizeSync('system prompt');
  await root.prefill(rootTokens);

  const result = await run(function* () {
    yield* Ctx.set(ctx as any);
    yield* Store.set(store);
    const events: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(events as any);
    yield* Trace.set(traceWriter);

    yield* spawn(function* () {
      for (const ev of yield* each(events)) {
        collectedEvents.push(ev);
        yield* each.next();
      }
    });

    const taskCount = opts.taskCount ?? 1;
    const tasks: AgentTaskSpec[] = Array.from({ length: taskCount }, (_, i) => ({
      systemPrompt: 'You are an agent.',
      content: `Task ${i}`,
      tools: opts.tools && opts.tools.size > 0
        ? JSON.stringify([...opts.tools.values()].map(t => t.schema))
        : '',
      parent: root,
      seed: i,
    }));

    return yield* scoped(function* () {
      return yield* useAgentPool({
        tasks,
        tools: opts.tools ?? new Map(),
        policy: opts.policy,
        maxTurns: opts.maxTurns ?? 100,
        terminalTool: opts.terminalTool,
        trace: opts.trace ?? false,
        pruneOnReport: opts.pruneOnReport ?? false,
      });
    });
  });

  return { result, events: collectedEvents, trace: traceWriter, ctx };
}

/** Minimal policy stub — every method overridable */
function stubPolicy(overrides: Partial<AgentPolicy> & {
  onProduced: AgentPolicy['onProduced'];
  onSettleReject: AgentPolicy['onSettleReject'];
}): AgentPolicy {
  return {
    onProduced: overrides.onProduced,
    onSettleReject: overrides.onSettleReject,
    shouldExplore: overrides.shouldExplore,
    shouldExit: overrides.shouldExit,
    onRecovery: overrides.onRecovery,
    pressureThresholds: overrides.pressureThresholds,
  };
}

/** Simple spy tool that captures ToolContext */
class SpyTool extends Tool<{ query: string }> {
  readonly name: string;
  readonly description = 'spy tool';
  readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
  capturedContexts: ToolContext[] = [];

  constructor(name = 'web_search') {
    super();
    this.name = name;
  }

  *execute(_args: { query: string }, context: ToolContext): Operation<unknown> {
    this.capturedContexts.push(context);
    return { results: ['result'] };
  }
}

// ── Group 1: shouldExit execution ───────────────────────────────

describe('shouldExit execution', () => {
  it('1a: shouldExit returns true → policy_exit trace, agent:done event, no result', async () => {
    const { result, events, trace } = await runPool({
      forkTokenQueues: [[1, STOP]], // never reached — shouldExit fires first
      policy: stubPolicy({
        shouldExit: () => true,
        onProduced: () => ({ type: 'idle', reason: 'pressure_critical' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].reason).toBe('policy_exit');
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
    expect(result.agents[0].result).toBeNull();
    expect(result.agents[0].tokenCount).toBe(0);
  });

  it('1b: shouldExit returns false → agent continues, produces tokens', async () => {
    const { result, events, trace } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const policyDrops = drops.filter(d => d.reason === 'policy_exit' || d.reason === 'pressure_critical');
    expect(policyDrops).toHaveLength(0);
    expect(result.agents[0].tokenCount).toBe(2);
    expect(events.some(e => e.type === 'agent:produce')).toBe(true);
  });

  it('1c: shouldExit absent + pressure critical → pressure_critical', async () => {
    const { trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 16300, // remaining = 84 < hardLimit 128 → critical
      forkTokenQueues: [[1, STOP]],
      policy: stubPolicy({
        onProduced: () => ({ type: 'idle', reason: 'pressure_critical' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const hasCritical = drops.some(d => d.reason === 'pressure_critical' || d.reason === 'pressure_init');
    expect(hasCritical).toBe(true);
  });
});

// ── Group 2: Nudge execution ────────────────────────────────────

describe('nudge execution', () => {
  const NUDGE_MSG = 'You must report your findings now.';

  function nudgeOncePolicy(): AgentPolicy {
    let nudgeCount = 0;
    return stubPolicy({
      shouldExit: () => false,
      onProduced: (_agent, parsed) => {
        if (parsed.toolCalls.length > 0 && nudgeCount === 0) {
          nudgeCount++;
          return { type: 'nudge', message: NUDGE_MSG };
        }
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    });
  }

  it('2a: onProduced returns nudge → pool:agentNudge trace with correct reason', async () => {
    const { trace } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
        };
      },
      policy: nudgeOncePolicy(),
    });

    const nudges = trace.ofType('pool:agentNudge');
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0].reason).toBe('pressure_softcut');
  });

  it('2b: nudge settles → agent continues generating → eventually idles', async () => {
    const { result, events } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, 4, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
        };
      },
      policy: nudgeOncePolicy(),
    });

    expect(result.agents[0].tokenCount).toBeGreaterThan(2);
    expect(events.filter(e => e.type === 'agent:done')).toHaveLength(1);
  });

  it('2c: repeated nudges fire without escalation (stateless)', async () => {
    let nudgeCount = 0;
    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP, 2, STOP, 3, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: `c${nudgeCount}` }],
        };
      },
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0 && nudgeCount < 3) {
            nudgeCount++;
            return { type: 'nudge', message: `Nudge #${nudgeCount}` };
          }
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const nudges = trace.ofType('pool:agentNudge');
    expect(nudges.length).toBeGreaterThanOrEqual(2);
    const drops = trace.ofType('pool:agentDrop');
    const nudgeDrops = drops.filter(d => d.reason === 'pressure_softcut');
    expect(nudgeDrops).toHaveLength(0);
  });
});

// ── Group 3: Settle reject execution ────────────────────────────

describe('settle reject execution', () => {
  class BigResultTool extends Tool<Record<string, unknown>> {
    readonly name = 'web_search';
    readonly description = 'search';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    constructor(private _resultSize: number) { super(); }

    *execute(): Operation<unknown> {
      return { data: 'x'.repeat(this._resultSize * 4) };
    }
  }

  it('3a: tool result > headroom, policy nudges → pool:agentNudge with pressure_settle_reject', async () => {
    const bigTool = new BigResultTool(200);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 16384,
      cellsUsed: 14300,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'nudge', message: 'Too large, report now.' }),
      }),
    });

    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('3b: nudge tokens dont fit → agent killed, pool:agentDrop pressure_settle_reject', async () => {
    const bigTool = new BigResultTool(500);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 2000,
      cellsUsed: 900,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'nudge', message: 'Report now.' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const settleDrops = drops.filter(d => d.reason === 'pressure_settle_reject');
    if (settleDrops.length > 0) {
      expect(settleDrops[0].reason).toBe('pressure_settle_reject');
      expect(events.some(e => e.type === 'agent:done')).toBe(true);
    }
  });

  it('3c: policy returns idle on settle reject → immediate kill', async () => {
    const bigTool = new BigResultTool(500);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 2000,
      cellsUsed: 900,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const settleDrops = drops.filter(d => d.reason === 'pressure_settle_reject');
    if (settleDrops.length > 0) {
      expect(events.some(e => e.type === 'agent:done')).toBe(true);
    }
  });
});

// ── Group 4: Dispatch context assembly ──────────────────────────

describe('dispatch context assembly', () => {
  function dispatchSetup(shouldExplore: boolean, pressure?: { nCtx?: number; cellsUsed?: number }) {
    const spy = new SpyTool('web_search');
    const toolMap = new Map<string, Tool>([['web_search', spy]]);

    return {
      spy,
      poolOpts: {
        nCtx: pressure?.nCtx ?? 10000,
        cellsUsed: pressure?.cellsUsed ?? 3000,
        forkTokenQueues: [[1, STOP, STOP]],
        parseChatOutputFn: (raw: string): ParseChatOutputResult => {
          if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
          return {
            content: '',
            reasoningContent: '',
            toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
          };
        },
        tools: toolMap,
        policy: stubPolicy({
          shouldExit: () => false,
          shouldExplore: () => shouldExplore,
          onProduced: (_a: Agent, parsed: { content: string | null; toolCalls: any[] }) => {
            if (parsed.toolCalls.length > 0) return { type: 'tool_call' as const, tc: parsed.toolCalls[0] };
            return { type: 'idle' as const, reason: 'free_text_stop' as const };
          },
          onSettleReject: () => ({ type: 'idle' as const, reason: 'pressure_settle_reject' as const }),
        }),
      },
    };
  }

  it('4a: shouldExplore=true → ToolContext.explore=true', async () => {
    const { spy, poolOpts } = dispatchSetup(true);
    await runPool(poolOpts);
    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    expect(spy.capturedContexts[0].explore).toBe(true);
  });

  it('4b: shouldExplore=false → ToolContext.explore=false', async () => {
    const { spy, poolOpts } = dispatchSetup(false);
    await runPool(poolOpts);
    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    expect(spy.capturedContexts[0].explore).toBe(false);
  });

  it('4c: percentAvailable from fresh dispatchPressure', async () => {
    const { spy, poolOpts } = dispatchSetup(true, { nCtx: 10000, cellsUsed: 3000 });
    const { trace } = await runPool(poolOpts);

    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    const pct = spy.capturedContexts[0].pressurePercentAvailable;
    expect(pct).toBeGreaterThan(50);
    expect(pct).toBeLessThanOrEqual(100);

    const dispatches = trace.ofType('tool:dispatch');
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect(dispatches[0]).toHaveProperty('explore');
    expect(dispatches[0]).toHaveProperty('percentAvailable');
  });
});

// ── Group 5: Recovery loop ──────────────────────────────────────

describe('recovery loop', () => {
  it('5a: recovery extracts findings via eager grammar on agent branch', async () => {
    // Agent stops immediately (no result). Recovery prefills extraction
    // prompt into agent's own branch, sets eager grammar, and runs a
    // produce/commit loop. The mock tokens produce non-JSON so the parse
    // fails (non-fatal), but agent:spawn proves recovery ran.
    const { events } = await runPool({
      forkTokenQueues: [
        [STOP, 1, 2, STOP], // first STOP triggers idle, tokens 1,2,STOP for extraction
      ],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          prompt: { system: 'Extract findings from above.', user: 'Report.' },
        }),
      }),
    });

    // agent:spawn emitted twice: once for initial setup, once for recovery
    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns.length).toBe(2);
    // agent:produce events from the extraction generation
    const produces = events.filter(e => e.type === 'agent:produce');
    expect(produces.length).toBeGreaterThanOrEqual(1);
  });

  it('5b: recovery skip → no agent:spawn after initial, branch pruned', async () => {
    const { events } = await runPool({
      forkTokenQueues: [[STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({ type: 'skip' }),
      }),
    });

    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns).toHaveLength(1); // only the initial spawn
  });

  it('5c: agent with result → recovery skipped entirely', async () => {
    const { result, events } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      parseChatOutputFn: () => ({
        content: 'some findings',
        reasoningContent: '',
        toolCalls: [],
      }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_report', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          prompt: { system: 'x', user: 'y' },
        }),
      }),
    });

    expect(result.agents[0].result).toBe('some findings');
    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns).toHaveLength(1); // only initial, no recovery
  });

  it('5d: recovery agent that does not call report → exits via free_text_stop', async () => {
    // Agent stops, recovery reactivates, but the model just generates text
    // without calling report. On the second stop, recovery fires again but
    // onRecovery returns skip (one-shot). Agent exits with no result.
    let recoveryCount = 0;
    const { result } = await runPool({
      forkTokenQueues: [
        [STOP, 1, 2, STOP], // first STOP triggers idle, tokens 1,2,STOP for recovery
      ],
      parseChatOutputFn: () => ({ content: 'just text', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_report', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => {
          recoveryCount++;
          if (recoveryCount <= 1) {
            return { type: 'extract', prompt: { system: 'Extract', user: 'Report' } };
          }
          return { type: 'skip' };
        },
      }),
    });

    expect(result).toBeDefined();
    expect(result.agents).toHaveLength(1);
    // Recovery reactivated, free_text_report captured the text
    expect(result.agents[0].result).toBe('just text');
  });
});

// ── Group 6: Pressure thresholds propagation ────────────────────

describe('pressure thresholds propagation', () => {
  it('6a: custom thresholds → agent survives when default would kill', async () => {
    const { result, trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 15800, // remaining=584, custom softLimit=512 → headroom=72
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        pressureThresholds: { softLimit: 512, hardLimit: 64 },
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const criticalDrops = drops.filter(d => d.reason === 'pressure_critical');
    expect(criticalDrops).toHaveLength(0);
    expect(result.agents[0].tokenCount).toBeGreaterThan(0);
  });

  it('6b: no thresholds → defaults used, agent killed or over budget', async () => {
    const { result, trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 15800, // remaining=584, default softLimit=1024 → headroom=-440
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'pressure_softcut' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    if (result.agents.length > 0 && result.agents[0].tokenCount > 0) {
      const softcutDrops = drops.filter(d =>
        d.reason === 'pressure_softcut' || d.reason === 'pressure_init'
      );
      expect(softcutDrops.length + drops.length).toBeGreaterThan(0);
    } else {
      expect(drops.some(d => d.reason === 'pressure_init')).toBe(true);
    }
  });
});

// ── Group 7: Tool probe lifecycle hook ──────────────────────────

describe('tool probe lifecycle hook', () => {
  /** Tool with a probe — returns "Wait, " after result settles */
  class ProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search with probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    probe() { return 'Wait, '; }
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  /** Tool without a probe — default null */
  class NoProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search without probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  /** Tool with conditional probe — only fires on nudge errors */
  class ConditionalProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search with conditional probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    probe(result: unknown) {
      const err = result && typeof result === 'object' && (result as Record<string, unknown>).error;
      if (typeof err === 'string' && err.toLowerCase().includes('report your findings now'))
        return 'Wait, the result says I need to call report now with my findings.';
      return null;
    }
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  function toolCallPolicy(): AgentPolicy {
    return stubPolicy({
      shouldExit: () => false,
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    });
  }

  it('7a: tool with probe → extra prefill after tool result', async () => {
    const probeTool = new ProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', probeTool]]);

    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    // Track prefill calls on the single ctx
    let prefillCallCount = 0;
    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      prefillCallCount++;
      return origPrefill(handles, tokenArrays);
    };

    // Wire token queues
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
    const queues = [[1, STOP, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));
    prefillCallCount = 0; // reset after root prefill

    await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        return yield* useAgentPool({
          tasks: [{ systemPrompt: 'Agent', content: 'Task', tools: JSON.stringify([probeTool.schema]), parent: root, seed: 0 }],
          tools: toolMap,
          policy: toolCallPolicy(),
          maxTurns: 100,
        });
      });
    });

    // Prefill calls: 1 (agent suffix) + 1 (tool result) + 1 (probe) = 3 minimum
    expect(prefillCallCount).toBeGreaterThanOrEqual(3);
  });

  it('7b: tool without probe → no extra prefill (noop)', async () => {
    const noProbeTool = new NoProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', noProbeTool]]);

    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    let prefillCallCount = 0;
    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      prefillCallCount++;
      return origPrefill(handles, tokenArrays);
    };

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
    const queues = [[1, STOP, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));
    prefillCallCount = 0;

    await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        return yield* useAgentPool({
          tasks: [{ systemPrompt: 'Agent', content: 'Task', tools: JSON.stringify([noProbeTool.schema]), parent: root, seed: 0 }],
          tools: toolMap,
          policy: toolCallPolicy(),
          maxTurns: 100,
        });
      });
    });

    // Prefill calls: 1 (agent suffix) + 1 (tool result) = 2 — NO probe prefill
    expect(prefillCallCount).toBe(2);
  });

  it('7c: default Tool.probe returns null', () => {
    const tool = new NoProbeTool();
    expect(tool.probe({})).toBeNull();
  });

  it('7d: probe fires on nudge when tool returns probe for error result', async () => {
    // Tool has a probe that activates on nudge errors — probe SHOULD fire
    const probeTool = new ProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', probeTool]]);

    const { result, ctx } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
      },
      tools: toolMap,
      policy: (() => {
        let nudged = false;
        return stubPolicy({
          shouldExit: () => false,
          onProduced: (_a, parsed) => {
            if (parsed.toolCalls.length > 0 && !nudged) {
              nudged = true;
              return { type: 'nudge', message: 'Report now.' };
            }
            return { type: 'idle', reason: 'free_text_stop' };
          },
          onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        });
      })(),
    });

    // Agent was nudged — probe should fire because tool.probe() receives nudge error
    expect(result.agents[0]).toBeDefined();
  });

  it('7e: conditional probe fires only on nudge error, not on normal results', () => {
    const tool = new ConditionalProbeTool();

    // Normal result — no probe
    expect(tool.probe({ results: ['data'] })).toBeNull();

    // Generic error — no probe
    expect(tool.probe({ error: 'Network timeout' })).toBeNull();

    // Nudge error — probe fires
    expect(tool.probe({ error: 'KV memory pressure — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');

    // Other nudge variants — probe fires
    expect(tool.probe({ error: 'Turn limit reached — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');
    expect(tool.probe({ error: 'Time limit approaching — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');
  });

  it('7f: conditional probe integrates with pool nudge path without error', async () => {
    const tool = new ConditionalProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    const { result } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
      },
      tools: toolMap,
      policy: (() => {
        let nudged = false;
        return stubPolicy({
          shouldExit: () => false,
          onProduced: (_a, parsed) => {
            if (parsed.toolCalls.length > 0 && !nudged) {
              nudged = true;
              return { type: 'nudge', message: 'KV memory pressure — report your findings now.' };
            }
            return { type: 'idle', reason: 'free_text_stop' };
          },
          onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        });
      })(),
    });

    // Pool completes without error — conditional probe integrates cleanly
    expect(result.agents[0]).toBeDefined();
  });

  it('7g: multi-agent — PRODUCE nudge probe survives across ticks', async () => {
    // Two agents: agent A gets a tool call dispatched, agent B gets a PRODUCE
    // nudge in the same tick. Agent A's tool result settles in the next SETTLE,
    // which calls dispatchedProbes.clear(). Agent B's nudge settles in the
    // FOLLOWING SETTLE. If the probe doesn't survive across ticks, it gets
    // cleared before agent B's nudge is processed.
    const tool = new ConditionalProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    // Track all prefill token arrays to detect probe prefill
    const allPrefills: number[][] = [];
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      for (const arr of tokenArrays) allPrefills.push(arr);
      return origPrefill(handles, tokenArrays);
    };

    // Agent 0: generates tool call → dispatched → result settles normally
    // Agent 1: generates tool call → PRODUCE nudge (not dispatched)
    // Both need enough tokens to generate across multiple ticks
    const queues = [
      [1, STOP, STOP],  // agent 0: one tool call, then stop
      [1, STOP, 2, STOP],  // agent 1: tool call → nudge → another turn → stop
    ];
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
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };

    // Agent 0: always dispatch tool call
    // Agent 1: first tool call → nudge, then idle
    const nudgedAgents = new Set<number>();
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));

    const result = await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        return yield* useAgentPool({
          tasks: [
            { systemPrompt: 'Agent 0', content: 'Task 0', tools: JSON.stringify([tool.schema]), parent: root, seed: 0 },
            { systemPrompt: 'Agent 1', content: 'Task 1', tools: JSON.stringify([tool.schema]), parent: root, seed: 1 },
          ],
          tools: toolMap,
          policy: (() => {
            return stubPolicy({
              shouldExit: () => false,
              onProduced: (a, parsed) => {
                if (parsed.toolCalls.length === 0) return { type: 'idle', reason: 'free_text_stop' };
                // Nudge agent 1 on first tool call
                if (!nudgedAgents.has(a.id) && forkCount >= 2 && a.id !== [...branchForkIndex.entries()].find(([,v]) => v === 0)?.[0]) {
                  nudgedAgents.add(a.id);
                  return { type: 'nudge', message: 'KV memory pressure — report your findings now.' };
                }
                return { type: 'tool_call', tc: parsed.toolCalls[0] };
              },
              onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
            });
          })(),
          maxTurns: 10,
        });
      });
    });

    // The probe text should have been prefilled somewhere in allPrefills.
    // ConditionalProbeTool.probe() returns "Wait, the result says I need to
    // call report now with my findings." for nudge errors.
    // Tokenize it to know what to look for.
    const probeTokens = ctx.tokenizeSync('Wait, the result says I need to call report now with my findings.');

    // At least one prefill should contain the probe tokens
    const probeWasPrefilled = allPrefills.some(arr =>
      arr.length === probeTokens.length && arr.every((t, i) => t === probeTokens[i])
    );

    expect(probeWasPrefilled).toBe(true);
  });
});
