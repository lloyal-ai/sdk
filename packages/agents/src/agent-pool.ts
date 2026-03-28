import { resource, call, ensure, createSignal, spawn, scoped, each } from 'effection';
import type { Operation, Channel } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType, type GrammarTrigger, type ParsedToolCall, type SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore } from '@lloyal-labs/sdk';
import { Ctx, Store, Events, Trace, TraceParent, CallingAgent } from './context';
import { buildToolResultDelta } from '@lloyal-labs/sdk';
import { traceScope } from './trace-scope';
import { generate } from './generate';
import { Agent } from './Agent';
import { DefaultAgentPolicy } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
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
}

/**
 * Immutable KV budget snapshot for one tick of the agent loop
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
    fmt: {
      format: fmt.format,
      reasoningFormat: fmt.reasoningFormat,
      thinkingForcedOpen: fmt.thinkingForcedOpen,
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
    const { tasks, tools, maxTurns = 100, terminalTool, trace = false, pressure: pressureOpts, pruneOnReport = false } = opts;

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

    // ── Tool dispatch coordination ───────────────────────────
    // Tool results land in settledBuffer during DISPATCH, drained by SETTLE
    // in the next tick. DISPATCH awaits each tool to completion via
    // scoped() + call() — no concurrent llama_decode possible.
    const settledBuffer: SettledTool[] = [];
    const agentById = new Map(agents.map(a => [a.id, a]));

    let steps = 0;
    let totalToolCalls = 0;
    const counters = {
      warmPrefillCalls: 0,
      warmPrefillBranches: 0,
    };

    // ── Four-phase tick loop ─────────────────────────────────
    for (;;) {
      // -- Phase 1: PRODUCE -- sample from active agents, collect tool calls
      const pressure = new ContextPressure(ctx, pressureOpts);

      if (trace && (pressure.critical || pressure.headroom < 0)) {
        const p = ctx._storeKvPressure();
        try { process.stderr.write(`[PRODUCE] ${pressure.critical ? 'CRITICAL' : 'SOFT_LIMIT'} remaining=${p.remaining} headroom=${pressure.headroom} cellsUsed=${p.cellsUsed} nCtx=${p.nCtx}\n`); } catch {}
      }

      const entries: [Branch, number][] = [];
      const toolCalls: { agent: Agent; tc: ParsedToolCall }[] = [];

      for (const a of agents) {
        if (a.status !== 'active') continue;

        if (pressure.critical) {
          a.transition('idle');
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: 'pressure_critical' });
          yield* events.send({ type: 'agent:done', agentId: a.id });
          continue;
        }

        const { token, text, isStop } = a.branch.produceSync();
        if (isStop) {
          const parsed = ctx.parseChatOutput(a.rawOutput, a.fmt.format, {
            reasoningFormat: a.fmt.reasoningFormat,
            thinkingForcedOpen: a.fmt.thinkingForcedOpen,
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
              a.reportResult(action.content, 'free_text');
              a.transition('idle');
              yield* events.send({ type: 'agent:report', agentId: a.id, result: a.result! });
              yield* events.send({ type: 'agent:done', agentId: a.id });
              continue;

            case 'idle':
              a.transition('idle');
              if (action.reason !== 'free_text_stop') {
                tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                  type: 'pool:agentDrop', agentId: a.id,
                  reason: action.reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut' });
              }
              yield* events.send({ type: 'agent:done', agentId: a.id });
              continue;

            case 'nudge': {
              const tc = parsed.toolCalls[0];
              const callId = tc?.id || `call_${a.toolCallCount}`;
              const isResearchFirst = terminalTool && tc?.name === terminalTool && a.toolCallCount === 0 && hasNonTerminalTools;
              const nudgeMsg = action.message
                ? JSON.stringify({ error: action.message })
                : isResearchFirst
                  ? JSON.stringify({ error: 'You must perform research before reporting. Call at least one tool first.' })
                  : JSON.stringify({ error: 'KV memory pressure — you cannot call more tools. Report your findings now.' });
              if (!isResearchFirst) a.markNudged();
              a.incrementTurns();
              a.transition('awaiting_tool');
              const prefillTokens = buildToolResultDelta(ctx, nudgeMsg, callId);
              settledBuffer.push({ agentId: a.id, prefillTokens, toolName: tc?.name || '', callId });
              a.resetTurn();
              if (!isResearchFirst) {
                tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                  type: 'pool:agentNudge', agentId: a.id, reason: 'pressure_softcut' });
              }
              continue;
            }

            case 'report':
              a.reportResult(action.result, 'report_tool');
              a.transition('idle');
              a.incrementToolCalls();
              totalToolCalls++;
              yield* events.send({ type: 'agent:tool_call', agentId: a.id, tool: terminalTool!, args: parsed.toolCalls[0].arguments });
              yield* events.send({ type: 'agent:report', agentId: a.id, result: a.result! });
              yield* events.send({ type: 'agent:done', agentId: a.id });
              if (pruneOnReport && !a.branch.disposed) {
                a.branch.pruneSync();
              }
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
        const tp = ctx._storeKvPressure();
        yield* events.send({ type: 'agent:tick', cellsUsed: tp.cellsUsed, nCtx: tp.nCtx });
      }

      // -- Phase 3: SETTLE -- drain settled tool buffer, batch prefill
      const settled = settledBuffer.splice(0);
      if (settled.length > 0) {
        // Fresh snapshot — Phase 2 commits may have advanced positions
        const settlePressure = new ContextPressure(ctx, pressureOpts);
        let headroom = settlePressure.headroom;

        if (trace) {
          const p = ctx._storeKvPressure();
          const items = settled.map(s => `${s.toolName}:${s.prefillTokens.length}`).join(', ');
          try { process.stderr.write(`[SETTLE] remaining=${p.remaining} headroom=${headroom} cellsUsed=${p.cellsUsed} nCtx=${p.nCtx} items=[${items}]\n`); } catch {}
        }

        const prefillPairs: [Branch, number[]][] = [];
        const settledAgents: Agent[] = [];

        for (const item of settled) {
          const a = agentById.get(item.agentId);
          if (!a || a.status === 'idle') continue;

          if (item.prefillTokens.length > headroom) {
            if (trace) {
              try { process.stderr.write(`[SETTLE] REJECT ${item.toolName}:${item.prefillTokens.length} > headroom=${headroom}\n`); } catch {}
            }
            const settleAction = policy.onSettleReject(a, item.prefillTokens.length, settlePressure, policyConfig);
            if (settleAction.type === 'nudge') {
              const nudgeMsg = JSON.stringify({ error: 'Tool result too large for remaining KV. Report your findings now.' });
              const nudgeTokens = buildToolResultDelta(ctx, nudgeMsg, item.callId);
              if (nudgeTokens.length <= headroom) {
                a.markNudged();
                prefillPairs.push([a.branch, nudgeTokens]);
                settledAgents.push(a);
                headroom -= nudgeTokens.length;
                tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                  type: 'pool:agentNudge', agentId: a.id, reason: 'pressure_settle_reject' });
                continue;
              }
            }
            // Nudge failed (tokens don't fit) or policy said kill
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
              type: 'pool:agentDrop', agentId: a.id, reason: 'pressure_settle_reject' });
            a.transition('idle');
            yield* events.send({ type: 'agent:done', agentId: a.id });
            continue;
          }

          prefillPairs.push([a.branch, item.prefillTokens]);
          settledAgents.push(a);
          headroom -= item.prefillTokens.length;
          // Record tool history for policy decisions
          const postSettle = ctx._storeKvPressure();
          a.recordToolResult({
            name: item.toolName,
            args: item.callId,
            resultTokenCount: item.prefillTokens.length,
            contextAfterPercent: postSettle.nCtx > 0
              ? Math.max(0, Math.round((postSettle.remaining / postSettle.nCtx) * 100))
              : 100,
            timestamp: performance.now(),
          });
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'branch:prefill', branchHandle: a.id,
            tokenCount: item.prefillTokens.length, role: 'toolResult' });
        }

        if (prefillPairs.length > 0) {
          if (trace) {
            const totalPrefill = prefillPairs.reduce((s, [, t]) => s + t.length, 0);
            try { process.stderr.write(`[SETTLE] PREFILL ${prefillPairs.length} branches, ${totalPrefill} tokens, headroom_after=${headroom}\n`); } catch {}
          }
          yield* call(() => store.prefill(prefillPairs));
          counters.warmPrefillCalls++;
          counters.warmPrefillBranches += prefillPairs.length;

          // Only NOW transition state + reset grammar
          for (const a of settledAgents) {
            a.transition('active');
            a.resetTurn();
            applyLazyGrammar(a);
          }
        }
      }

      // -- Phase 4: DISPATCH -- execute collected tool calls sequentially
      // scoped() creates an error boundary — inner pool errors are caught
      // here instead of crashing the outer pool. call() yields the Operation
      // directly, ensuring exclusive llama_context access (no concurrent
      // AsyncWorkers). See docs/agents/concurrency.md.
      for (const { agent, tc } of toolCalls) {
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
        const callId = tc.id || `call_${agent.toolCallCount}`;

        agent.incrementToolCalls();
        totalToolCalls++;
        agent.incrementTurns();

        yield* events.send({ type: 'agent:tool_call', agentId: agent.id, tool: tc.name, args: tc.arguments });

        const dispatchTraceId = tw.nextId();
        const toolT0 = performance.now();
        tw.write({
          traceId: dispatchTraceId, parentTraceId: poolScope.traceId, ts: toolT0,
          type: 'tool:dispatch', agentId: agent.id, tool: tc.name,
          toolIndex: toolIndexMap.get(tc.name) ?? -1, toolkitSize,
          args: toolArgs, callId,
        });

        const tool = tools.get(tc.name);
        const toolContext: ToolContext = {
          agentId: agent.id,
          branch: agent.branch,
          onProgress: (p: { filled: number; total: number }) => {
            progressBridge.send({ type: 'agent:tool_progress', agentId: agent.id, tool: tc.name, filled: p.filled, total: p.total });
          },
          scorer: opts.scorer,
        };

        try {
          // Set TraceParent + CallingAgent so inner pools inherit lineage
          yield* TraceParent.set(dispatchTraceId);
          yield* CallingAgent.set(agent);

          const result: unknown = yield* scoped(function*() {
            return yield* call(() =>
              tool ? tool.execute(toolArgs, toolContext) : Promise.resolve({ error: `Unknown tool: ${tc.name}` })
            );
          });

          // Inject context availability into tool result so agent can make pressure-aware decisions
          const postToolPressure = ctx._storeKvPressure();
          const contextAvailablePercent = postToolPressure.nCtx > 0
            ? Math.max(0, Math.round((postToolPressure.remaining / postToolPressure.nCtx) * 100))
            : 100;
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            (result as Record<string, unknown>)._contextAvailablePercent = contextAvailablePercent;

            // Collect nested results from recursive tool returns
            const resultObj = result as Record<string, unknown>;
            if (Array.isArray(resultObj.results)) {
              agent.addNestedResults(
                (resultObj.results as unknown[]).filter((f): f is string => typeof f === 'string')
              );
            }
            if (Array.isArray(resultObj.nestedResults)) {
              agent.addNestedResults(
                (resultObj.nestedResults as unknown[]).filter((f): f is string => typeof f === 'string')
              );
            }
          }

          const resultStr = JSON.stringify(result);
          yield* events.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr, contextAvailablePercent });

          const prefillTokens = buildToolResultDelta(ctx, resultStr, callId);
          settledBuffer.push({ agentId: agent.id, prefillTokens, toolName: tc.name, callId });

          tw.write({
            traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
            type: 'tool:result', agentId: agent.id, tool: tc.name,
            result, prefillTokenCount: prefillTokens.length,
            durationMs: performance.now() - toolT0,
          });
        } catch (err) {
          agent.transition('idle');
          agent.reportResult(`Tool error: ${(err as Error).message}`, 'tool_error');
          tw.write({
            traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
            type: 'tool:error', agentId: agent.id, tool: tc.name,
            error: (err as Error).message,
          });
        }
      }

      // -- Termination
      if (agents.every(a => a.status === 'idle' || a.status === 'disposed')) break;
    }

    // ── Idle processing: scratchpad extraction ────────────────
    // Replaces harness-level reportPass. Agents in 'idle' without findings
    // get scratchpad extraction if they did enough work. This runs BEFORE
    // pool:close trace so findings are populated in the trace.
    if (opts.extractionPrompt) {
      // Free KV from agents that already reported — gives room for extraction
      for (const a of agents) {
        if (a.result && !a.branch.disposed) {
          a.branch.pruneSync();
        }
      }

      const reportSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
      };
      const reportGrammar: string = yield* call(() =>
        ctx.jsonSchemaToGrammar(JSON.stringify(reportSchema)),
      );
      const reportMessages = [
        { role: 'system', content: opts.extractionPrompt.system },
        { role: 'user', content: opts.extractionPrompt.user },
      ];
      const { prompt: extractionPromptStr } = ctx.formatChatSync(
        JSON.stringify(reportMessages), { enableThinking: false },
      );

      for (const a of agents) {
        if (a.status !== 'idle' || a.result || a.branch.disposed) continue;

        // Confabulation guard: skip agents that barely ran
        const minTokens = opts.extractionPrompt?.minTokens ?? 100;
        const minToolCalls = opts.extractionPrompt?.minToolCalls ?? 2;
        if (a.tokenCount < minTokens || a.toolCallCount < minToolCalls) {
          if (!a.branch.disposed) a.branch.pruneSync();
          continue;
        }

        try {
          const result = yield* generate<{ result: string }>({
            prompt: extractionPromptStr,
            grammar: reportGrammar,
            parse: (o: string) => JSON.parse(o),
            parent: a.branch,
          });
          if (result.parsed?.result) {
            a.reportResult(result.parsed.result, 'scratchpad');
            yield* events.send({ type: 'agent:report', agentId: a.id, result: a.result! });
          }
        } catch {
          /* extraction failure non-fatal */
        }
        if (!a.branch.disposed) a.branch.pruneSync();
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
