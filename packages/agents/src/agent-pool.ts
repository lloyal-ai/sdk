import { resource, call, ensure, createSignal, spawn, scoped, each } from 'effection';
import type { Operation, Channel } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType, type GrammarTrigger, type ParsedToolCall, type SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore } from '@lloyal-labs/sdk';
import { Ctx, Store, Events } from './context';
import { buildToolResultDelta } from '@lloyal-labs/sdk';
import type {
  TraceToken,
  PressureThresholds,
  AgentTaskSpec,
  AgentPoolOptions,
  AgentPoolResult,
  AgentEvent,
} from './types';

// ── Internal agent state machine ───────────────────────────────
// generating → awaiting_tool → generating  (tool result prefilled)
// generating → done                         (stop + no tool call, or report)
// awaiting_tool → done                      (tool error)

type AgentInternalState = 'generating' | 'awaiting_tool' | 'done';

interface AgentInternal {
  id: number;           // = branch.handle
  parentId: number;     // = parent.handle
  branch: Branch;
  state: AgentInternalState;
  fmt: {
    format: number;
    reasoningFormat: number;
    thinkingForcedOpen: boolean;
    parser: string;
    grammar: string;
    grammarLazy: boolean;
    grammarTriggers: GrammarTrigger[];
  };
  rawOutput: string;
  tokenCount: number;
  toolCallCount: number;
  turns: number;
  findings: string | null;
  traceBuffer: TraceToken[];
}

interface SettledTool {
  agentId: number;
  prefillTokens: number[];
  toolName: string;
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
): Operation<{ agent: AgentInternal; suffixTokens: number[] }> {
  const messages = [
    { role: 'system', content: task.systemPrompt },
    { role: 'user', content: task.content },
  ];
  const fmtOpts = task.tools ? { tools: task.tools } : {};
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

  return {
    agent: {
      id: branch.handle,
      parentId: parent.handle,
      branch,
      state: 'generating',
      fmt: {
        format: fmt.format,
        reasoningFormat: fmt.reasoningFormat,
        thinkingForcedOpen: fmt.thinkingForcedOpen,
        parser: fmt.parser,
        grammar: fmt.grammar,
        grammarLazy: fmt.grammarLazy,
        grammarTriggers: fmt.grammarTriggers,
      },
      rawOutput: '',
      tokenCount: 0,
      toolCallCount: 0,
      turns: 0,
      findings: null,
      traceBuffer: [],
    },
    suffixTokens,
  };
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
    const { tasks, tools, maxTurns = 100, terminalTool, trace = false, pressure: pressureOpts } = opts;

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

    // ── Setup: fork branches, collect suffix tokens ──────────
    // setupAgent is now a generator — each branch registers its own ensure()
    // for cleanup. No manual try/finally needed here.
    const agents: AgentInternal[] = [];
    const prefillSetup: [Branch, number[]][] = [];

    for (const task of tasks) {
      const parent = task.parent;
      if (!parent) throw new Error('useAgentPool: each task must have a parent branch');

      const { agent, suffixTokens } = yield* setupAgent(parent, task, ctx);
      agents.push(agent);
      prefillSetup.push([agent.branch, suffixTokens]);
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
        dropped.state = 'done';
      }
    }
    if (prefillSetup.length > 0) {
      yield* call(() => store.prefill(prefillSetup));
    }

    // Emit spawn events — TUI uses parentAgentId to detect sub-agents
    for (const a of agents) {
      yield* events.send({ type: 'agent:spawn', agentId: a.id, parentAgentId: a.parentId });
    }

    // ── Lazy grammar setup ───────────────────────────────────
    const applyLazyGrammar = (a: AgentInternal): void => {
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
      const toolCalls: { agent: AgentInternal; tc: ParsedToolCall }[] = [];

      for (const a of agents) {
        if (a.state !== 'generating') continue;

        if (pressure.critical) {
          a.state = 'done';
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

          const tc = parsed.toolCalls[0];
          if (!tc) {
            a.state = 'done';
            if (!a.findings && a.toolCallCount > 0 && parsed.content) {
              a.findings = parsed.content;
              yield* events.send({ type: 'agent:report', agentId: a.id, findings: a.findings });
            }
            yield* events.send({ type: 'agent:done', agentId: a.id });
            continue;
          }

          // Over budget: deny non-terminal tool calls when the agent has
          // exceeded maxTurns or KV headroom is negative. Terminal tools
          // (e.g. `report()`) are always allowed through — an agent that has
          // done research and wants to report should never be blocked by
          // pressure, since the report call itself consumes minimal KV.
          const overBudget = (a.turns >= maxTurns || pressure.headroom < 0)
            && (!terminalTool || tc.name !== terminalTool);

          if (overBudget) {
            a.state = 'done';
            yield* events.send({ type: 'agent:done', agentId: a.id });
            continue;
          }

          // Terminal tool — intercept, extract findings, mark done.
          if (terminalTool && tc.name === terminalTool) {
            if (a.toolCallCount === 0 && hasNonTerminalTools) {
              const callId = tc.id || `call_${a.toolCallCount}`;
              const errorMsg = 'You must perform research before reporting. Call at least one tool first.';
              a.turns++;
              a.state = 'awaiting_tool';
              const prefillTokens = buildToolResultDelta(ctx, JSON.stringify({ error: errorMsg }), callId);
              settledBuffer.push({ agentId: a.id, prefillTokens, toolName: tc.name });
              a.rawOutput = '';
              continue;
            }
            try { a.findings = JSON.parse(tc.arguments).findings; } catch { a.findings = tc.arguments; }
            a.state = 'done';
            a.toolCallCount++;
            totalToolCalls++;
            yield* events.send({ type: 'agent:tool_call', agentId: a.id, tool: tc.name, args: tc.arguments });
            yield* events.send({ type: 'agent:report', agentId: a.id, findings: a.findings! });
            yield* events.send({ type: 'agent:done', agentId: a.id });
            continue;
          }

          // Collect tool call — dispatched in Phase 4 after decode phases
          a.state = 'awaiting_tool';
          toolCalls.push({ agent: a, tc });
          a.rawOutput = '';
          continue;
        }

        entries.push([a.branch, token]);
        a.rawOutput += text;
        a.tokenCount++;
        if (trace) {
          const entropy = a.branch.modelEntropy();
          const surprisal = a.branch.modelSurprisal(token);
          a.traceBuffer.push({ text, entropy, surprisal });
          yield* events.send({
            type: 'agent:produce', agentId: a.id, text, tokenCount: a.tokenCount,
            entropy, surprisal,
          });
        } else {
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
        const settledAgents: AgentInternal[] = [];

        for (const item of settled) {
          const a = agentById.get(item.agentId);
          if (!a || a.state === 'done') continue;

          if (item.prefillTokens.length > headroom) {
            if (trace) {
              try { process.stderr.write(`[SETTLE] REJECT ${item.toolName}:${item.prefillTokens.length} > headroom=${headroom}\n`); } catch {}
            }
            a.state = 'done';
            yield* events.send({ type: 'agent:done', agentId: a.id });
            continue;
          }

          prefillPairs.push([a.branch, item.prefillTokens]);
          settledAgents.push(a);
          headroom -= item.prefillTokens.length;
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
            a.state = 'generating';
            a.rawOutput = '';
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

        agent.toolCallCount++;
        totalToolCalls++;
        agent.turns++;

        yield* events.send({ type: 'agent:tool_call', agentId: agent.id, tool: tc.name, args: tc.arguments });

        const tool = tools.get(tc.name);
        const toolContext = {
          agentId: agent.id,
          onProgress: (p: { filled: number; total: number }) => {
            progressBridge.send({ type: 'agent:tool_progress', agentId: agent.id, tool: tc.name, filled: p.filled, total: p.total });
          },
        };

        try {
          const result: unknown = yield* scoped(function*() {
            return yield* call(() =>
              tool ? tool.execute(toolArgs, toolContext) : Promise.resolve({ error: `Unknown tool: ${tc.name}` })
            );
          });

          const resultStr = JSON.stringify(result);
          yield* events.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr });

          const prefillTokens = buildToolResultDelta(ctx, resultStr, callId);
          settledBuffer.push({ agentId: agent.id, prefillTokens, toolName: tc.name });
        } catch (err) {
          agent.state = 'done';
          agent.findings = `Tool error: ${(err as Error).message}`;
        }
      }

      // -- Termination
      if (agents.every(a => a.state === 'done')) break;
    }

    // ── Provide result — suspends, branches stay alive ───────
    // Branch cleanup is handled by each branch's ensure() from setupAgent —
    // when this resource's scope exits, all ensure() callbacks fire.
    const result: AgentPoolResult = {
      agents: agents.map(a => ({
          agentId: a.id,
          parentAgentId: a.parentId,
          branch: a.branch,
          findings: a.findings,
          toolCallCount: a.toolCallCount,
          tokenCount: a.tokenCount,
          ppl: a.branch.perplexity,
          samplingPpl: a.branch.samplingPerplexity,
          trace: trace ? a.traceBuffer : undefined,
        })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      totalToolCalls,
      steps,
      counters,
    };

    yield* provide(result);
  });
}
