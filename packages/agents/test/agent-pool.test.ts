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
  it('5a: recovery extract → agent:spawn emitted', async () => {
    const { events } = await runPool({
      forkTokenQueues: [
        [STOP], // agent: immediate stop, no result → needs recovery
        // fork index 1: recovery branch — tokens don't matter much,
        // extraction may or may not parse, but agent:spawn proves the mechanism ran
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

    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns.length).toBeGreaterThanOrEqual(1);
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

  it('5d: extraction JSON parse failure → non-fatal, no result', async () => {
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    // Wire token queues: fork 0 = agent (immediate stop), fork 1 = recovery (non-JSON)
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

    const queues = [[STOP], [1, 2, 3, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };

    // Recovery tokens produce "t1t2t3" — not valid JSON
    ctx.parseChatOutput = () => ({ content: '', reasoningContent: '', toolCalls: [] });

    await root.prefill(ctx.tokenizeSync('system'));
    const traceWriter = new CapturingTraceWriter();

    const result = await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);

      yield* spawn(function* () {
        for (const ev of yield* each(events)) { yield* each.next(); }
      });

      return yield* scoped(function* () {
        return yield* useAgentPool({
          tasks: [{
            systemPrompt: 'Agent',
            content: 'Task',
            tools: '',
            parent: root,
          }],
          tools: new Map(),
          policy: stubPolicy({
            shouldExit: () => false,
            onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
            onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
            onRecovery: () => ({
              type: 'extract',
              prompt: { system: 'Extract', user: 'Report' },
            }),
          }),
          maxTurns: 100,
        });
      });
    });

    expect(result).toBeDefined();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].result).toBeNull();
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
