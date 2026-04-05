import { resource, call, ensure, createSignal, spawn, scoped, each} from 'effection';
import type { Operation, Channel } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType, type GrammarTrigger, type ParsedToolCall, type SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore } from '@lloyal-labs/sdk';
import { Ctx, Store, Events, Trace, TraceParent, CallingAgent } from './context';
import { buildToolResultDelta } from '@lloyal-labs/sdk';
import { traceScope } from './trace-scope';
import type { TraceWriter } from './trace-writer';
import type { AgentPolicy, IdleReason } from './AgentPolicy';
import { Agent } from './Agent';
import { DefaultAgentPolicy } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
import { Tool } from './Tool';
import type {
  PressureThresholds,
  AgentTaskSpec,
  AgentPoolOptions,
  AgentPoolResult,
  AgentEvent,
  ToolContext,
} from './types';

// ── Agent state transitions ────────────────────────────────────
// idle → active         (first produce)
// active → awaiting_tool (tool call parsed)
// active → idle          (stop token, report, or kill)
// awaiting_tool → active (tool result settled)
// awaiting_tool → idle   (settle reject + kill)
// idle → disposed        (branch pruned)

interface SettledTool {
  agentId: number;
  prefillTokens: number[];
  toolName: string;
  callId: string;
  probe?: string;
}

/**
 * Immutable KV budget snapshot for one tick of the agent loop
 *
 * Frozen at phase boundaries (PRODUCE, SETTLE, DISPATCH) so that all
 * decisions within a phase are evaluated against the same baseline.
 * Without this, items processed earlier in a loop would see different
 * pressure than items processed later — making reject/nudge/kill
 * decisions order-dependent and nondeterministic.
 *
 * Created from `SessionContext._storeKvPressure()` which returns
 * `{ nCtx, cellsUsed, remaining }` where `remaining = nCtx - cellsUsed`.
 * `cellsUsed` tracks unique KV cells per branch — incremented on
 * `decode_each` / `decode_scatter`, decremented on release by
 * `position - fork_head` (unique cells above the fork point), reset on
 * bulk ops like `retainOnly` and `drain`.
 *
 * Two thresholds partition `remaining` into three zones:
 *
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │                    nCtx                              │
 * │  ┌──────────┬───────────────────┬──────────────────┐ │
 * │  │cellsUsed │    headroom > 0   │    softLimit     │ │
 * │  │ (in use) │   (new work OK)   │   (reserved)     │ │
 * │  └──────────┴───────────────────┴──────────────────┘ │
 * │              ◄── remaining ──►  │                    │
 * │                                 │                    │
 * │  headroom = remaining - softLimit                    │
 * │  critical = remaining < hardLimit                    │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * - **headroom > 0** — room for new work (tool results, generation)
 * - **headroom ≤ 0** — over budget. SETTLE rejects tool results, PRODUCE
 *   hard-cuts non-terminal tool calls. Terminal tools still pass.
 * - **critical** — remaining below hardLimit. Agents killed before
 *   `produceSync()` to prevent llama_decode crashes.
 *
 * @category Agents
 */
export class ContextPressure {
  /** Default softLimit: 1024 tokens reserved for downstream work */
  static readonly DEFAULT_SOFT_LIMIT = 1024;
  /** Default hardLimit: 128 tokens crash-prevention floor */
  static readonly DEFAULT_HARD_LIMIT = 128;

  /** Total KV cache capacity (max positions). 0 when no context limit. */
  readonly nCtx: number;
  /** KV cells currently in use (monotonic within a pool run). */
  readonly cellsUsed: number;
  /**
   * KV slots remaining (`nCtx - cellsUsed`).
   * Infinity when nCtx ≤ 0 (no context limit).
   */
  readonly remaining: number;
  /** Remaining KV floor — tokens reserved for downstream work */
  readonly softLimit: number;
  /** Crash-prevention floor — agents killed when remaining drops below */
  readonly hardLimit: number;

  constructor(ctx: SessionContext, opts?: PressureThresholds) {
    const p = ctx._storeKvPressure();
    this.nCtx = p.nCtx;
    this.cellsUsed = p.cellsUsed;
    this.remaining = p.nCtx <= 0 ? Infinity : p.remaining;
    this.softLimit = opts?.softLimit ?? ContextPressure.DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts?.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT;
  }

  /**
   * Tokens available for new work: `remaining - softLimit`.
   * Positive means room to accept tool results or continue generating.
   * Negative means over budget — SETTLE rejects, PRODUCE hard-cuts.
   */
  get headroom(): number { return this.remaining - this.softLimit; }

  /** `remaining < hardLimit` — agent must not call `produceSync()`. */
  get critical(): boolean { return this.remaining < this.hardLimit; }

  /** Can `tokenCount` tokens fit while staying above softLimit? */
  canFit(tokenCount: number): boolean { return tokenCount <= this.headroom; }

  /**
   * KV available as 0–100 integer. Single source of truth for the
   * percentage shown to agents (`contextAvailablePercent`), recorded
   * on tool history (`contextAfterPercent`), and used by
   * `policy.shouldExplore()`.
   */
  get percentAvailable(): number {
    return this.nCtx > 0
      ? Math.max(0, Math.round((this.remaining / this.nCtx) * 100))
      : 100;
  }
}

/**
 * Inline recovery for a single killed agent (trailing stop).
 *
 * Prefills the extraction prompt into the agent's own branch, sets eager
 * report grammar, generates to stop token, parses JSON, reports result,
 * and prunes the branch — all before the tick loop continues. The freed
 * KV lets remaining agents keep researching.
 *
 * Returns true if the agent reported findings.
 */
function* recoverInline(
  agent: Agent,
  policy: AgentPolicy,
  ctx: SessionContext,
  store: BranchStore,
  tw: TraceWriter,
  parentTraceId: number,
  events: Channel<AgentEvent, void>,
): Operation<boolean> {
  const recovery = policy.onRecovery?.(agent);
  if (!recovery || recovery.type === 'skip') {
    if (!agent.branch.disposed) agent.branch.pruneSync();
    return false;
  }

  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: recovery.prompt.system },
      { role: 'user', content: recovery.prompt.user },
    ]), { enableThinking: false },
  );
  const sep = ctx.getTurnSeparator();
  const delta = ctx.tokenizeSync(prompt, false);
  const tokens = [...sep, ...delta];

  // Check if extraction prompt fits
  const pressure = new ContextPressure(ctx);
  if (pressure.remaining < tokens.length) {
    if (!agent.branch.disposed) agent.branch.pruneSync();
    return false;
  }

  // Eager report grammar
  const reportGrammar: string = yield* call(() =>
    ctx.jsonSchemaToGrammar(JSON.stringify({
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
    })),
  );

  // Recovery runs in its own scope — if decode fails (KV exhaustion),
  // the scope tears down cleanly without propagating to the pool.
  // Mirrors the old prepare()-based recovery which used try/catch around
  // a Resource with its own ensure().
  let reported = false;
  try {
    yield* scoped(function*() {
      yield* call(() => store.prefill([[agent.branch, tokens]]));
      agent.branch.setGrammar(reportGrammar);

      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'branch:prefill', branchHandle: agent.id,
        tokenCount: tokens.length, role: 'recovery',
      });
      yield* events.send({ type: 'agent:spawn', agentId: agent.id, parentAgentId: agent.parentId });

      // Single-agent produce/commit loop
      let output = '';
      let tokenCount = 0;
      for (;;) {
        const { token, text, isStop } = agent.branch.produceSync();
        if (isStop) break;
        output += text;
        tokenCount++;
        yield* call(() => store.commit([[agent.branch, token]]));
        yield* events.send({ type: 'agent:produce', agentId: agent.id, text, tokenCount });
      }

      // Parse + report
      const parsed = JSON.parse(output) as { result: string };
      if (parsed?.result) {
        agent.reportResult(parsed.result, 'scratchpad');
        yield* events.send({ type: 'agent:report', agentId: agent.id, result: agent.result! });
        reported = true;
      }
    });
  } catch { /* decode failure or malformed JSON — non-fatal, prune below */ }

  // Always prune after scope exits (success or decode failure)
  if (!agent.branch.disposed) agent.branch.pruneSync();

  // Emit tick so TUI updates pressure percentage after prune
  const postPressure = new ContextPressure(ctx);
  yield* events.send({ type: 'agent:tick', cellsUsed: postPressure.cellsUsed, nCtx: postPressure.nCtx });

  return reported;
}


// ── PRODUCE action handlers ─────────────────────────────────────
// Each handler encapsulates state transitions, events, and trace for one
// policy action outcome. The PRODUCE switch dispatches to these.

function* handleFreeTextReport(
  a: Agent, content: string, events: Channel<AgentEvent, void>,
): Operation<void> {
  a.reportResult(content, 'free_text');
  a.transition('idle');
  yield* events.send({ type: 'agent:report', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
}

function* handleIdleDrop(
  a: Agent, reason: IdleReason, events: Channel<AgentEvent, void>,
  tw: TraceWriter, parentTraceId: number,
): Operation<void> {
  a.transition('idle');
  if (reason !== 'free_text_stop') {
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:agentDrop', agentId: a.id,
      reason: reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut' });
  }
  yield* events.send({ type: 'agent:done', agentId: a.id });
}

function* handleNudge(
  a: Agent, message: string, tc: ParsedToolCall | undefined,
  ctx: SessionContext, tools: Map<string, Tool>,
): Operation<SettledTool> {
  const callId = tc?.id || `call_${a.toolCallCount}`;
  const nudgeResult = { error: message };
  a.incrementTurns();
  a.transition('awaiting_tool');
  const prefillTokens = buildToolResultDelta(ctx, JSON.stringify(nudgeResult), callId);
  const probe = tools?.get(tc?.name || '')?.probe(nudgeResult) ?? undefined;
  a.resetTurn();
  return { agentId: a.id, prefillTokens, toolName: tc?.name || '', callId, probe };
}

function* handleReport(
  a: Agent, result: string, tc: ParsedToolCall, terminalTool: string,
  pruneOnReport: boolean, events: Channel<AgentEvent, void>,
): Operation<void> {
  a.reportResult(result, 'report_tool');
  a.transition('idle');
  a.incrementToolCalls();
  yield* events.send({ type: 'agent:tool_call', agentId: a.id, tool: terminalTool, args: tc.arguments });
  yield* events.send({ type: 'agent:report', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
  if (pruneOnReport && !a.branch.disposed) a.branch.pruneSync();
}

/**
 * Fork an agent from a parent branch with its own system prompt and task.
 *
 * Generator — uses sync native calls so Effection sees everything.
 * On scope exit (error, cancellation), `ensure()` prunes the branch
 * automatically — the orphaned-branch leak is structurally impossible.
 */
function* setupAgent(
  parent: Branch,
  task: AgentTaskSpec,
  ctx: SessionContext,
): Operation<{ agent: Agent; suffixTokens: number[]; formattedPrompt: string }> {
  const messages = [
    { role: 'system', content: task.systemPrompt },
    { role: 'user', content: task.content },
  ];
  const fmtOpts: Record<string, unknown> = { enableThinking: false };
  if (task.tools) fmtOpts.tools = task.tools;
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  if (task.tools && (fmt.format === CHAT_FORMAT_CONTENT_ONLY || fmt.format === CHAT_FORMAT_GENERIC)) {
    // Error before fork — no branch to clean up
    throw new Error('Model does not support tool calling. Please use a model with native tool support (e.g. Qwen3, Llama 3.x, Mistral).');
  }
  const branch = parent.forkSync();
  yield* ensure(() => { if (!branch.disposed) branch.pruneSync(); });
  const sep = ctx.getTurnSeparator();
  const suffixTokens = [...sep, ...ctx.tokenizeSync(fmt.prompt, false)];
  if (task.seed != null) branch.reseedSampler(task.seed);

  // Read calling agent from Effection context (set during outer pool's DISPATCH)
  let callingAgent: Agent | null = null;
  try { const a = yield* CallingAgent.get(); if (a) callingAgent = a; } catch { /* top-level — no caller */ }

  const agent = new Agent({
    id: branch.handle,
    parentId: parent.handle,
    branch,
    parent: callingAgent,
    task: task.content,
    fmt: {
      format: fmt.format,
      reasoningFormat: fmt.reasoningFormat,
      generationPrompt: fmt.generationPrompt,
      parser: fmt.parser,
      grammar: fmt.grammar,
      grammarLazy: fmt.grammarLazy,
      grammarTriggers: fmt.grammarTriggers,
    },
  });

  return { agent, suffixTokens, formattedPrompt: fmt.prompt };
}

/**
 * Concurrent agent generation loop as an Effection resource
 *
 * Runs N agents in parallel using a four-phase tick loop over shared
 * {@link BranchStore} infrastructure. Each agent forks from a parent
 * branch, generates tokens, invokes tools, and reports findings.
 *
 * **Four-phase tick loop:**
 * 1. **PRODUCE** — sample all active agents via `produceSync()` (no async gap)
 * 2. **COMMIT** — single GPU call via `store.commit()` for all produced tokens
 * 3. **SETTLE** — drain settled tool results, batch prefill, reset grammars
 * 4. **DISPATCH** — execute collected tool calls sequentially via `scoped()` + `call()`
 *
 * Tool dispatch uses `scoped()` + `call()` — each tool executes to completion
 * before the next tick, ensuring exclusive `llama_context` access (no concurrent decode).
 *
 * **Resource semantics:** `provide()` suspends after all agents complete,
 * keeping branches alive so the caller can fork from them (e.g. for
 * verification). Branches are pruned when the scope exits — each branch's
 * `ensure()` from `setupAgent` handles cleanup automatically.
 *
 * For automatic branch cleanup on return, use {@link runAgents} instead.
 *
 * @param opts - Pool configuration: tasks, tools, sampling params, max turns
 * @returns Agent pool result with per-agent findings and aggregate statistics
 *
 * @example Shared root with agent pool
 * ```typescript
 * const pool = yield* withSharedRoot(
 *   { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
 *   function*(root) {
 *     return yield* useAgentPool({
 *       tasks: questions.map(q => ({
 *         systemPrompt: RESEARCH_PROMPT,
 *         content: q,
 *         tools: toolsJson,
 *         parent: root,
 *       })),
 *       tools: toolMap,
 *       maxTurns: 6,
 *     });
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function useAgentPool(opts: AgentPoolOptions): Operation<AgentPoolResult> {
  return resource(function*(provide) {
    const ctx: SessionContext = yield* Ctx.expect();
    const store: BranchStore = yield* Store.expect();
    const events: Channel<AgentEvent, void> = yield* Events.expect();

    // Bridge for onProgress callbacks — Signal is correct here (external callback).
    // A spawned forwarder drains the bridge into the Channel with proper scope context.
    const progressBridge = createSignal<AgentEvent, void>();
    yield* spawn(function*() {
      for (const ev of yield* each(progressBridge)) {
        yield* events.send(ev);
        yield* each.next();
      }
    });
    const tw = yield* Trace.expect();
    const { tasks, tools, maxTurns = 100, terminalTool, trace = false, pruneOnReport = false } = opts;

    // Tool index map for trace — position in toolkit array
    const toolIndexMap = new Map([...tools.keys()].map((name, i) => [name, i]));
    const toolkitSize = tools.size;

    const poolT0 = performance.now();
    let poolParentTraceId: number | null = null;
    try { const p = yield* TraceParent.get(); if (p != null) poolParentTraceId = p; } catch { /* top level */ }
    const poolScope = traceScope(tw, poolParentTraceId, 'pool', { agentCount: tasks.length, maxTurns, terminalTool });

    // Whether the pool's tool registry contains tools besides the terminal tool.
    // When false, agents are allowed to call the terminal tool as their first
    // action (e.g. reporter sub-agents that only have `report()`). When true,
    // the first tool call must be a non-terminal tool to prevent agents from
    // immediately reporting without doing any work.
    //
    // IMPORTANT: this checks the pool's `tools` registry, not individual task
    // schemas (`task.tools`). A reporter pool must pass only the terminal tool
    // in its registry — passing the full tool map makes this flag true and
    // traps reporters in an infinite rejection loop.
    const hasNonTerminalTools = terminalTool ? [...tools.keys()].some(k => k !== terminalTool) : tools.size > 0;
    const policy = opts.policy ?? new DefaultAgentPolicy();
    const pressureOpts: PressureThresholds = policy.pressureThresholds
      ?? { softLimit: ContextPressure.DEFAULT_SOFT_LIMIT, hardLimit: ContextPressure.DEFAULT_HARD_LIMIT };
    const policyConfig: PolicyConfig = { maxTurns, terminalTool, hasNonTerminalTools };

    // ── Setup: fork branches, collect suffix tokens ──────────
    // setupAgent is now a generator — each branch registers its own ensure()
    // for cleanup. No manual try/finally needed here.
    const agents: Agent[] = [];
    const prefillSetup: [Branch, number[]][] = [];

    for (const task of tasks) {
      const parent = task.parent;
      if (!parent) throw new Error('useAgentPool: each task must have a parent branch');

      const { agent, suffixTokens, formattedPrompt } = yield* setupAgent(parent, task, ctx);
      agents.push(agent);
      prefillSetup.push([agent.branch, suffixTokens]);
      tw.write({
        traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
        type: 'branch:create', branchHandle: agent.id, parentHandle: agent.parentId,
        position: 0, role: 'agentFork',
      });
      tw.write({
        traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
        type: 'prompt:format', promptText: formattedPrompt,
        taskContent: task.content,
        tokenCount: suffixTokens.length,
        messages: JSON.stringify([
          { role: 'system', content: task.systemPrompt },
          { role: 'user', content: task.content },
        ]),
        tools: task.tools, role: 'agentSuffix',
      });
    }

    // Batch prefill all agent suffixes — pressure-gated.
    // Each suffix is the full formatted chat (system prompt + tools JSON +
    // user message + generation prompt), tokenized via formatChatSync().
    // Suffix cost is model-dependent: ~250-400 tokens per agent depending
    // on chat template verbosity and tool schema size.
    const initPressure = new ContextPressure(ctx, pressureOpts);
    const totalSuffix = prefillSetup.reduce((s, [, t]) => s + t.length, 0);
    if (!initPressure.canFit(totalSuffix)) {
      // Not enough room — drop agents from the end until it fits
      while (prefillSetup.length > 0) {
        const needed = prefillSetup.reduce((s, [, t]) => s + t.length, 0);
        if (initPressure.canFit(needed)) break;
        prefillSetup.pop();
        const dropped = agents.pop()!;
        dropped.dispose();
        tw.write({
          traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
          type: 'pool:agentDrop', agentId: dropped.id, reason: 'pressure_init',
        });
      }
    }
    if (prefillSetup.length > 0) {
      yield* call(() => store.prefill(prefillSetup));
    }

    tw.write({
      traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
      type: 'pool:open', agentCount: agents.length,
      taskSuffixTokens: prefillSetup.map(([, t]) => t.length),
      pressure: { remaining: initPressure.remaining, softLimit: initPressure.softLimit, headroom: initPressure.headroom },
    });

    // Emit spawn events and activate agents
    for (const a of agents) {
      a.transition('active');
      yield* events.send({ type: 'agent:spawn', agentId: a.id, parentAgentId: a.parentId });
    }

    // ── Lazy grammar setup ───────────────────────────────────
    const applyLazyGrammar = (a: Agent): void => {
      if (a.fmt.grammar && a.fmt.grammarLazy && a.fmt.grammarTriggers.length > 0) {
        const triggers = a.fmt.grammarTriggers.map(t => {
          if (t.type === GrammarTriggerType.WORD) {
            const nlIdx = t.value.indexOf('\n');
            if (nlIdx >= 0 && nlIdx < t.value.length - 1) {
              return { ...t, value: t.value.slice(0, nlIdx + 1) };
            }
          }
          return t;
        });
        a.branch.setGrammarLazy(a.fmt.grammar, triggers);
      }
    };
    for (const a of agents) applyLazyGrammar(a);

    const agentById = new Map(agents.map(a => [a.id, a]));
    let steps = 0;
    let totalToolCalls = 0;
    const counters = { warmPrefillCalls: 0, warmPrefillBranches: 0 };

    // ── Phase operations (close over pool scope) ────────────

    /** SETTLE: prefill tool results that fit, defer oversized items for next tick */
    function* settle(items: SettledTool[]): Operation<SettledTool[]> {
      const settlePressure = new ContextPressure(ctx, pressureOpts);
      let headroom = settlePressure.headroom;

      if (trace) {
        const desc = items.map(s => `${s.toolName}:${s.prefillTokens.length}`).join(', ');
        try { process.stderr.write(`[SETTLE] remaining=${settlePressure.remaining} headroom=${headroom} cellsUsed=${settlePressure.cellsUsed} nCtx=${settlePressure.nCtx} items=[${desc}]\n`); } catch {}
      }

      const prefillPairs: [Branch, number[]][] = [];
      const settledAgents: Agent[] = [];
      const deferred: SettledTool[] = [];

      for (const item of items) {
        const a = agentById.get(item.agentId);
        if (!a || a.status === 'idle') continue;

        if (item.prefillTokens.length > headroom) {
          if (trace) {
            try { process.stderr.write(`[SETTLE] DEFER ${item.toolName}:${item.prefillTokens.length} > headroom=${headroom}\n`); } catch {}
          }
          deferred.push(item);
          continue;
        }

        prefillPairs.push([a.branch, item.prefillTokens]);
        settledAgents.push(a);
        headroom -= item.prefillTokens.length;
        const postSettle = new ContextPressure(ctx, pressureOpts);
        a.recordToolResult({
          name: item.toolName, args: item.callId,
          resultTokenCount: item.prefillTokens.length,
          contextAfterPercent: postSettle.percentAvailable,
          timestamp: performance.now(),
        });
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
          type: 'branch:prefill', branchHandle: a.id,
          tokenCount: item.prefillTokens.length, role: 'toolResult' });
      }

      if (prefillPairs.length > 0) {
        if (trace) {
          const total = prefillPairs.reduce((s, [, t]) => s + t.length, 0);
          try { process.stderr.write(`[SETTLE] PREFILL ${prefillPairs.length} branches, ${total} tokens, headroom_after=${headroom}\n`); } catch {}
        }
        yield* call(() => store.prefill(prefillPairs));
        counters.warmPrefillCalls++;
        counters.warmPrefillBranches += prefillPairs.length;

        // Probe prefill from DISPATCH
        const probePairs: [Branch, number[]][] = [];
        for (const a of settledAgents) {
          const probe = items.find(s => s.agentId === a.id)?.probe;
          if (probe) {
            const probeTokens = ctx.tokenizeSync(probe, false);
            probePairs.push([a.branch, probeTokens]);
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
              type: 'branch:prefill', branchHandle: a.id,
              tokenCount: probeTokens.length, role: 'probe', probeText: probe });
          }
        }
        if (probePairs.length > 0) {
          yield* call(() => store.prefill(probePairs));
        }

        for (const a of settledAgents) {
          a.transition('active');
          a.resetTurn();
          applyLazyGrammar(a);
        }
      }

      return deferred;
    }

    /** DISPATCH: execute tool calls sequentially, return settled items for next tick */
    function* dispatch(calls: { agent: Agent; tc: ParsedToolCall }[]): Operation<SettledTool[]> {
      const results: SettledTool[] = [];

      for (const { agent, tc } of calls) {
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
        const callId = tc.id || `call_${agent.toolCallCount}`;

        agent.incrementToolCalls();
        totalToolCalls++;
        agent.incrementTurns();

        yield* events.send({ type: 'agent:tool_call', agentId: agent.id, tool: tc.name, args: tc.arguments });

        const tool = tools.get(tc.name);
        const dispatchPressure = new ContextPressure(ctx, pressureOpts);
        const explore = policy.shouldExplore?.(agent, dispatchPressure) ?? true;

        const dispatchTraceId = tw.nextId();
        const toolT0 = performance.now();
        tw.write({
          traceId: dispatchTraceId, parentTraceId: poolScope.traceId, ts: toolT0,
          type: 'tool:dispatch', agentId: agent.id, tool: tc.name,
          toolIndex: toolIndexMap.get(tc.name) ?? -1, toolkitSize,
          args: toolArgs, callId,
          explore, percentAvailable: dispatchPressure.percentAvailable,
        });
        const toolContext: ToolContext = {
          agentId: agent.id, branch: agent.branch,
          onProgress: (p: { filled: number; total: number }) => {
            progressBridge.send({ type: 'agent:tool_progress', agentId: agent.id, tool: tc.name, filled: p.filled, total: p.total });
          },
          scorer: opts.scorer, explore,
          pressurePercentAvailable: dispatchPressure.percentAvailable,
        };

        try {
          yield* TraceParent.set(dispatchTraceId);
          yield* CallingAgent.set(agent);

          const result: unknown = yield* scoped(function*() {
            return yield* call(() =>
              tool ? tool.execute(toolArgs, toolContext) : Promise.resolve({ error: `Unknown tool: ${tc.name}` })
            );
          });

          const postToolPressure = new ContextPressure(ctx, pressureOpts);
          const contextAvailablePercent = postToolPressure.percentAvailable;
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            (result as Record<string, unknown>)._contextAvailablePercent = contextAvailablePercent;
            const resultObj = result as Record<string, unknown>;
            if (Array.isArray(resultObj.results)) {
              agent.addNestedResults((resultObj.results as unknown[]).filter((f): f is string => typeof f === 'string'));
            }
            if (Array.isArray(resultObj.nestedResults)) {
              agent.addNestedResults((resultObj.nestedResults as unknown[]).filter((f): f is string => typeof f === 'string'));
            }
          }

          const resultStr = JSON.stringify(result);
          yield* events.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr, contextAvailablePercent });

          const prefillTokens = buildToolResultDelta(ctx, resultStr, callId);
          const probe = tool?.probe(result) ?? undefined;
          results.push({ agentId: agent.id, prefillTokens, toolName: tc.name, callId, probe });

          tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
            type: 'tool:result', agentId: agent.id, tool: tc.name,
            result, prefillTokenCount: prefillTokens.length,
            durationMs: performance.now() - toolT0 });
        } catch (err) {
          agent.transition('idle');
          agent.reportResult(`Tool error: ${(err as Error).message}`, 'tool_error');
          tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
            type: 'tool:error', agentId: agent.id, tool: tc.name,
            error: (err as Error).message });
        }
      }

      return results;
    }

    // ── Four-phase tick loop ─────────────────────────────────
    let pendingSettled: SettledTool[] = [];

    // ── Four-phase tick loop ─────────────────────────────────
    let recoveryAttempted = false;
    for (;;) {
      // -- Phase 1: PRODUCE -- sample from active agents, collect tool calls
      policy.resetTick?.();
      const pressure = new ContextPressure(ctx, pressureOpts);

      if (trace && (pressure.critical || pressure.headroom < 0)) {
        try { process.stderr.write(`[PRODUCE] ${pressure.critical ? 'CRITICAL' : 'SOFT_LIMIT'} remaining=${pressure.remaining} headroom=${pressure.headroom} cellsUsed=${pressure.cellsUsed} nCtx=${pressure.nCtx}\n`); } catch {}
      }

      const entries: [Branch, number][] = [];
      const toolCalls: { agent: Agent; tc: ParsedToolCall }[] = [];
      const nudges: SettledTool[] = [];

      for (const a of agents) {
        if (a.status !== 'active') continue;

        const policyExit = policy.shouldExit?.(a, pressure);
        if (policyExit ?? pressure.critical) {
          a.transition('idle');
          const exitReason = pressure.critical ? 'pressure_critical' as const
            : policyExit ? 'policy_exit' as const
            : 'pressure_critical' as const;
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: exitReason });
          yield* events.send({ type: 'agent:done', agentId: a.id });
          // Trailing stop: extract findings inline, free KV for remaining agents
          yield* recoverInline(a, policy, ctx, store, tw, poolScope.traceId, events);
          continue;
        }

        const { token, text, isStop } = a.branch.produceSync();
        if (isStop) {
          const parsed = ctx.parseChatOutput(a.rawOutput, a.fmt.format, {
            reasoningFormat: a.fmt.reasoningFormat,
            generationPrompt: a.fmt.generationPrompt,
            parser: a.fmt.parser,
          });

          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'agent:turn', agentId: a.id, turn: a.turns,
            rawOutput: a.rawOutput,
            parsedContent: parsed.content || null,
            parsedToolCalls: parsed.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
          });

          // Policy decides what to do with the parsed output
          const action = policy.onProduced(a, parsed, pressure, policyConfig);

          switch (action.type) {
            case 'free_text_report':
              yield* handleFreeTextReport(a, action.content, events);
              continue;
            case 'idle':
              yield* handleIdleDrop(a, action.reason, events, tw, poolScope.traceId);
              continue;
            case 'nudge':
              nudges.push(yield* handleNudge(a, action.message, parsed.toolCalls[0], ctx, tools));
              tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                type: 'pool:agentNudge', agentId: a.id, reason: 'pressure_softcut' });
              continue;
            case 'report':
              yield* handleReport(a, action.result, parsed.toolCalls[0], terminalTool!, pruneOnReport, events);
              totalToolCalls++;
              continue;
            case 'tool_call':
              a.transition('awaiting_tool');
              toolCalls.push({ agent: a, tc: action.tc });
              a.resetTurn();
              continue;
          }
        }

        entries.push([a.branch, token]);
        if (trace) {
          const entropy = a.branch.modelEntropy();
          const surprisal = a.branch.modelSurprisal(token);
          a.accumulateTokenWithTrace(text, entropy, surprisal);
          yield* events.send({
            type: 'agent:produce', agentId: a.id, text, tokenCount: a.tokenCount,
            entropy, surprisal,
          });
        } else {
          a.accumulateToken(text);
          yield* events.send({ type: 'agent:produce', agentId: a.id, text, tokenCount: a.tokenCount });
        }
      }

      // -- Phase 2: COMMIT -- batch-decode produced tokens
      if (entries.length > 0) {
        yield* call(() => store.commit(entries));
        steps++;
        const commitPressure = new ContextPressure(ctx, pressureOpts);
        yield* events.send({ type: 'agent:tick', cellsUsed: commitPressure.cellsUsed, nCtx: commitPressure.nCtx });
      }

      // -- Phase 3: SETTLE (settle what fits, defer what doesn't)
      const toSettle = [...pendingSettled, ...nudges];
      const deferred = toSettle.length > 0 ? yield* settle(toSettle) : [];

      // Stall-breaker: if items are deferred and no active agents remain,
      // sacrifice an awaiting_tool agent to free KV. Without this, agents
      // with oversized results stay awaiting_tool indefinitely — PRODUCE
      // skips them, headroom never recovers, the pool loops forever.
      if (deferred.length > 0 && !agents.some(a => a.status === 'active')) {
        const victim = agents.find(a => a.status === 'awaiting_tool' && !a.branch.disposed);
        if (victim) {
          victim.transition('idle');
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: victim.id, reason: 'pressure_settle_reject' });
          yield* events.send({ type: 'agent:done', agentId: victim.id });
          yield* recoverInline(victim, policy, ctx, store, tw, poolScope.traceId, events);
        }
      }

      // -- Phase 4: DISPATCH
      const dispatched = yield* dispatch(toolCalls);

      // Deferred + new dispatch results → next tick's SETTLE
      pendingSettled = [...deferred, ...dispatched];

      // -- Termination + recovery
      if (agents.every(a => a.status === 'idle' || a.status === 'disposed')) {
        if (!recoveryAttempted) {
          recoveryAttempted = true;
          // Recover any idle agents that weren't handled by inline recovery
          // (e.g., killed by max_turns, time budget, or free_text_stop)
          for (const a of agents) {
            if (a.status === 'idle' && !a.result && !a.branch.disposed) {
              yield* recoverInline(a, policy, ctx, store, tw, poolScope.traceId, events);
            }
          }
        }
        break;
      }
    }

    // ── Provide result — suspends, branches stay alive ───────
    // Branch cleanup is handled by each branch's ensure() from setupAgent —
    // when this resource's scope exits, all ensure() callbacks fire.
    tw.write({
      traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
      type: 'pool:close',
      agents: agents.map(a => ({
        agentId: a.id, tokenCount: a.tokenCount,
        toolCallCount: a.toolCallCount, result: a.result,
        ppl: a.branch.disposed ? 0 : a.branch.perplexity,
      })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      steps, durationMs: performance.now() - poolT0,
    });
    poolScope.close();

    const result: AgentPoolResult = {
      agents: agents.map(a => ({
          agentId: a.id,
          parentAgentId: a.parentId,
          branch: a.branch,
          result: a.result,
          toolCallCount: a.toolCallCount,
          tokenCount: a.tokenCount,
          ppl: a.branch.disposed ? 0 : a.branch.perplexity,
          samplingPpl: a.branch.disposed ? 0 : a.branch.samplingPerplexity,
          trace: trace ? a.traceBuffer : undefined,
          nestedResults: [...a.nestedResults],
        })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      totalToolCalls,
      steps,
      counters,
    };

    yield* provide(result);
  });
}
