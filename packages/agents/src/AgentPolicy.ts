import type { Agent, ToolHistoryEntry } from './Agent';
import { ContextPressure } from './agent-pool';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import type { PressureThresholds } from './types';
import { renderTemplate } from './prompt';

// Recovery-phase KV accounting constants. These size the hardLimit reserve
// allocation for recoverInline: the prefill cost of the recovery prompt +
// room for llama.cpp's batch workspace. Used to compute the budget
// communicated to the model in its recovery prompt.
const RECOVERY_PREFILL_OVERHEAD = 150;
const BATCH_BUFFER = 512;

/**
 * Convert a token budget to a conservative word count for the model-facing
 * prompt. Tokens are tokenizer-specific; words are universal and better
 * reflected in training data. Applies a 0.7 words/token ratio (vs the
 * typical ~0.75) to under-advertise the budget, rounds down to the nearest
 * 10, and floors at 10 so the model always has a non-zero target.
 */
function tokenBudgetAsWords(budgetTokens: number): number {
  return Math.max(10, Math.floor(budgetTokens * 0.7 / 10) * 10);
}

// ── Declarative tool guards ─────────────────────────────

/**
 * A declarative guard that rejects tool calls based on agent lineage.
 * Guards are checked in order before any tool is dispatched.
 *
 * @category Agents
 */
export interface ToolGuard {
  /** Tool names this guard applies to */
  tools: string[];
  /** Return true to reject the call. Receives parsed args, full lineage history, and the agent itself. */
  reject: (args: Record<string, unknown>, lineageHistory: ToolHistoryEntry[], agent: Agent) => boolean;
  /** Error message sent back to the agent as a tool result */
  message: string;
}

/** Default guards for deduplication and recursion discipline */
function parseHistoryArgs(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr); } catch { return {}; }
}

export const defaultToolGuards: ToolGuard[] = [
  {
    tools: ['fetch_page'],
    reject: (args, history) => {
      const url = args.url as string | undefined;
      return !!url && history.some(h =>
        h.name === 'fetch_page' && parseHistoryArgs(h.args).url === url,
      );
    },
    message: 'This URL was already fetched. Try a different source.',
  },
  {
    tools: ['web_search'],
    reject: (args, history) => {
      const query = (args.query as string | undefined)?.toLowerCase();
      return !!query && history.some(h => {
        const prev = (parseHistoryArgs(h.args).query as string | undefined)?.toLowerCase();
        return h.name === 'web_search' && prev === query;
      });
    },
    message: 'This query was already searched. Refine your search or report findings.',
  },
];

// ── Action types ────────────────────────────────────────────

/**
 * Why the agent entered idle status.
 * @category Agents
 */
export type IdleReason =
  | 'reported'
  | 'pressure_critical'
  | 'pressure_softcut'
  | 'pressure_settle_reject'
  | 'settle_stall_break'
  | 'max_turns'
  | 'free_text_stop'
  | 'tool_error';

/**
 * Action returned by policy.onProduced — tells the pool what to do.
 * @category Agents
 */
export type ProduceAction =
  | { type: 'tool_call'; tc: ParsedToolCall }
  | { type: 'report'; result: string }
  | { type: 'nudge'; message: string }
  | { type: 'idle'; reason: IdleReason }
  | { type: 'free_text_report'; content: string };

/**
 * Action returned by policy.onSettleReject.
 * @category Agents
 */
export type SettleAction =
  | { type: 'nudge'; message: string }
  | { type: 'idle'; reason: IdleReason };

/**
 * Action returned by policy.onRecovery — what to do with an agent
 * that was killed without reporting.
 * @category Agents
 */
export type RecoveryAction =
  | { type: 'extract'; prompt: { system: string; user: string } }
  | { type: 'skip' };

// ── Policy interface ────────────────────────────────────────

/**
 * Agent lifecycle policy — injected strategy for pressure, nudge,
 * recursion, report timing, and result quality decisions.
 *
 * The pool consults the policy at PRODUCE and SETTLE boundaries.
 * Policy sees the agent's full state (status, tool history, pressure,
 * grammar config) and returns an action. Pool executes the action.
 *
 * @category Agents
 */
export interface AgentPolicy {
  /**
   * PRODUCE phase: agent hit stop token — what should happen?
   *
   * Called after parseChatOutput extracts content and/or tool calls.
   * Policy decides based on: parsed output, pressure, agent history,
   * terminal tool config, grammar constraints.
   */
  onProduced(
    agent: Agent,
    parsed: { content: string | null; toolCalls: ParsedToolCall[] },
    pressure: ContextPressure,
    config: PolicyConfig,
  ): ProduceAction;

  /**
   * SETTLE stall-break: consulted when deferred tool results have no
   * active siblings to free KV — the last-resort moment where a policy
   * decides whether to nudge the agent (replacing the oversized result
   * with a compact error payload) or drop it and let recovery extract.
   *
   * In normal operation, SETTLE defers oversized items across ticks.
   * Siblings completing (parallel) or the spine growing (chain) restores
   * headroom on subsequent ticks — this hook fires only when all agents
   * are `awaiting_tool`/idle and deferral can't resolve on its own.
   *
   * Return `{type: 'nudge'}` to replace the oversized item with a compact
   * error payload (carries the budget in its message). Return
   * `{type: 'idle', reason: 'pressure_settle_reject'}` to drop the agent.
   * If the hook is absent, the pool falls back to `settle_stall_break`.
   */
  onSettleReject(
    agent: Agent,
    resultTokens: number,
    pressure: ContextPressure,
    config: PolicyConfig,
  ): SettleAction;

  /**
   * DISPATCH phase: should this tool call explore or exploit?
   *
   * When true (explore), content-boundary tools use agent-local scoring only.
   * When false (exploit), tools apply dual scoring via scoreRelevanceBatch.
   * Non-monotonic — flips with live pressure. Separate from lifecycle.
   * Optional — defaults to true (explore) when absent.
   */
  shouldExplore?(agent: Agent, pressure: ContextPressure): boolean;

  /**
   * PRODUCE phase (pre-produceSync): should this agent be killed immediately?
   *
   * Called before the agent generates any tokens. Returns true to kill —
   * no nudge possible here (there's no tool call to attach a message to).
   * The branch stays alive for recovery via {@link onRecovery}.
   *
   * Signatures are narrow by design: `(agent, pressure)`. The policy is a
   * class — time, cost, or other signals live on `this` (e.g. `_startTime`).
   * The pool passes what it owns; the policy combines with its own state.
   *
   * Optional — defaults to `pressure.critical` when absent.
   */
  shouldExit?(agent: Agent, pressure: ContextPressure): boolean;

  /**
   * KV pressure thresholds for ContextPressure construction.
   * Pool reads this once at setup. Optional — defaults to
   * ContextPressure.DEFAULT_SOFT_LIMIT / DEFAULT_HARD_LIMIT.
   */
  readonly pressureThresholds?: PressureThresholds;

  /**
   * Reset per-tick state (e.g. trailing stop flags).
   * Called by the pool at the start of each tick iteration.
   * Optional — only needed if the policy tracks per-tick state.
   */
  resetTick?(): void;

  /**
   * Post-loop: should we extract findings from this killed agent?
   *
   * Called for each idle agent without a result after the tick loop ends.
   * Return `extract` with a prompt to fork from the agent's branch and
   * generate grammar-constrained findings. Return `skip` to prune.
   *
   * The pool owns the extraction grammar (`{ "result": "..." }` schema).
   * Custom prompts must produce output matching this shape.
   *
   * Optional — defaults to skip when absent.
   */
  onRecovery?(agent: Agent, pressure: ContextPressure): RecoveryAction;
}

/**
 * Pool-level configuration passed to policy methods.
 * @category Agents
 */
export interface PolicyConfig {
  maxTurns: number;
  terminalTool?: string;
  hasNonTerminalTools: boolean;
}

// ── Default policy ──────────────────────────────────────────

/**
 * Default policy replicating the current inline if-logic from agent-pool.ts.
 *
 * This is a 1:1 behavioral match — same pressure thresholds, same nudge
 * logic, same terminal tool interception. Extracted for testability and
 * future customization.
 *
 * @category Agents
 */
/**
 * Configuration for {@link DefaultAgentPolicy}.
 * @category Agents
 */
export interface DefaultAgentPolicyOpts {
  /** Min non-terminal tool calls before report is accepted without nudge. @default 2 */
  minToolCallsBeforeReport?: number;
  /** Replace default tool guards entirely. */
  guards?: ToolGuard[];
  /** Append additional guards to the defaults. */
  extraGuards?: ToolGuard[];
  /**
   * Explore/exploit thresholds — both axes checked independently.
   * Either falling below its threshold flips the policy into exploit mode
   * (rerank tool results against the original query via the entailment
   * scorer). Explore mode preserves the agent's local-query ordering.
   */
  shouldExplore?: {
    /** Minimum fraction of KV capacity (0–1) that must remain free for
     *  explore mode. Checks `pressure.percentAvailable / 100`. Below this
     *  fraction, exploit mode kicks in. @default 0.4 */
    context?: number;
    /** Maximum fraction of the time soft limit (0–1) that can be consumed
     *  before exploit mode kicks in. When `elapsed / timeSoftLimit >= time`,
     *  `shouldExplore` returns false regardless of KV headroom. Only
     *  applies when `budget.time.softLimit` is set. @default 0.5 */
    time?: number;
  };
  /** Scratchpad recovery for agents killed without reporting.
   *  Policy decides per-agent via {@link AgentPolicy.onRecovery}. */
  recovery?: {
    prompt: { system: string; user: string };
    /** Skip extraction for agents with fewer tokens than this. @default 100 */
    minTokens?: number;
    /** Skip extraction for agents with fewer tool calls than this. @default 2 */
    minToolCalls?: number;
  };
  /** Budget thresholds. softLimit = nudge, hardLimit = kill.
   *  Same naming pattern for both resource types.
   *  time budget is global across nesting levels (ms since policy creation). */
  budget?: {
    /** KV context budget (tokens remaining). */
    context?: { softLimit?: number; hardLimit?: number };
    /** Wall-time budget (ms since policy creation). */
    time?: { softLimit?: number; hardLimit?: number };
  };
  /** Terminal tool name. When set, agents mid-generation of this tool are
   *  protected from shouldExit — the hard limit is deferred until the tool
   *  call completes naturally or KV pressure forces a kill. */
  terminalTool?: string;
}

export class DefaultAgentPolicy implements AgentPolicy {
  private _minToolCalls: number;
  private _guards: ToolGuard[];
  private _exploreContext: number;
  private _exploreTime: number;
  private _forceExploit = false;
  private _recovery: DefaultAgentPolicyOpts['recovery'] | null;
  private _budget: DefaultAgentPolicyOpts['budget'] | null;
  private _terminalTool: string | null;
  private _startTime: number;

  constructor(opts?: DefaultAgentPolicyOpts) {
    this._minToolCalls = opts?.minToolCallsBeforeReport ?? 2;
    this._exploreContext = opts?.shouldExplore?.context ?? 0.4;
    this._exploreTime = opts?.shouldExplore?.time ?? 0.5;
    this._guards = opts?.guards ?? [
      ...defaultToolGuards,
      ...(opts?.extraGuards ?? []),
    ];
    this._recovery = opts?.recovery ?? null;
    this._budget = opts?.budget ?? null;
    this._terminalTool = opts?.terminalTool ?? null;
    this._startTime = performance.now();
  }

  /**
   * Elapsed wall time for *this agent* (since its first idle→active transition),
   * falling back to the policy's own construction time when the agent hasn't
   * started yet (defensive — shouldn't normally happen).
   *
   * Per-agent timing means orchestrators that spawn agents sequentially (e.g.
   * `chain`) get the correct "how long has this task been running?" semantics
   * without the time budget leaking across iterations.
   */
  private _elapsed(agent?: Agent): number {
    const started = agent?.startedAt ?? this._startTime;
    return performance.now() - started;
  }

  /** KV pressure thresholds for ContextPressure construction.
   *  Pool reads this once at setup. */
  get pressureThresholds(): PressureThresholds {
    return {
      softLimit: this._budget?.context?.softLimit
        ?? ContextPressure.DEFAULT_SOFT_LIMIT,
      hardLimit: this._budget?.context?.hardLimit
        ?? ContextPressure.DEFAULT_HARD_LIMIT,
    };
  }

  onProduced(
    agent: Agent,
    parsed: { content: string | null; toolCalls: ParsedToolCall[] },
    pressure: ContextPressure,
    config: PolicyConfig,
  ): ProduceAction {
    const tc = parsed.toolCalls[0];
    if (!tc) return this._handleNoToolCall(agent, parsed);
    if (this._isTerminalTool(tc, config)) return this._handleTerminalTool(tc, agent, config, pressure);
    // Guards before budget: when an agent is over budget AND emitting
    // a tool call the guards already want to reject (duplicate query,
    // duplicate fetch, delegation-before-research), the guard's specific
    // message is more actionable than a generic "report now within N
    // words" turn-limit nudge. Previously, `_isOverBudget` preempted the
    // guard — stuck agents (same query repeated past maxTurns) saw only
    // turn-limit nudges instead of the dedup message that named the
    // actual problem (see trace-1776819196054 agent 65539).
    const guardRejection = this._checkGuards(tc, agent);
    if (guardRejection) return guardRejection;
    if (this._isOverBudget(agent, tc, pressure, config)) return this._handleOverBudget(agent, tc, pressure, config);
    // Normal tool call
    return { type: 'tool_call', tc };
  }

  // ── onProduced decision predicates ─────────────────────

  private _handleNoToolCall(
    agent: Agent, parsed: { content: string | null },
  ): ProduceAction {
    if (!agent.result && agent.toolCallCount > 0 && parsed.content) {
      return { type: 'free_text_report', content: parsed.content };
    }
    return { type: 'idle', reason: 'free_text_stop' };
  }

  private _isTerminalTool(tc: ParsedToolCall, config: PolicyConfig): boolean {
    return !!(config.terminalTool && tc.name === config.terminalTool);
  }

  private _handleTerminalTool(
    tc: ParsedToolCall, agent: Agent, config: PolicyConfig, pressure: ContextPressure,
  ): ProduceAction {
    const underPressure = this._isUnderPressure(agent, pressure, config);
    if (agent.toolCallCount < this._minToolCalls && config.hasNonTerminalTools && !underPressure) {
      return { type: 'nudge', message: 'You must use tools before submitting results.' };
    }
    let result: string;
    try { result = JSON.parse(tc.arguments).result; } catch { result = tc.arguments; }
    return { type: 'report', result };
  }

  private _isUnderPressure(agent: Agent, pressure: ContextPressure, config: PolicyConfig): boolean {
    const timeSoft = this._budget?.time?.softLimit;
    const timeNudge = timeSoft != null && this._elapsed(agent) >= timeSoft;
    return agent.turns >= config.maxTurns || pressure.headroom < 0 || timeNudge;
  }

  private _isOverBudget(agent: Agent, tc: ParsedToolCall, pressure: ContextPressure, config: PolicyConfig): boolean {
    const underPressure = this._isUnderPressure(agent, pressure, config);
    return underPressure && (!config.terminalTool || tc.name !== config.terminalTool);
  }

  private _handleOverBudget(
    agent: Agent, tc: ParsedToolCall, pressure: ContextPressure, config: PolicyConfig,
  ): ProduceAction {
    const timeSoft = this._budget?.time?.softLimit;
    const timeNudge = timeSoft != null && this._elapsed(agent) >= timeSoft;

    if (config.terminalTool && agent.toolCallCount > 0 && !pressure.critical) {
      if (!this._nudgedThisTick) {
        this._nudgedThisTick = true;
        // Budget the model can emit before `pressure.critical` kills it.
        // Overshoot → kill → recoverInline extracts from the hardLimit reserve.
        // Expressed in words (not tokens) because tokenizers vary across
        // models but words are universal. Under-advertised + rounded down
        // so the model has slack on the ceiling.
        const words = tokenBudgetAsWords(pressure.remaining - pressure.hardLimit);
        const msg = timeNudge
          ? `Time limit reached — report your findings now within ${words} words.`
          : agent.turns >= config.maxTurns
            ? `Turn limit reached — report your findings now within ${words} words.`
            : `KV memory pressure — report your findings now within ${words} words.`;
        return { type: 'nudge', message: msg };
      }
      return { type: 'tool_call', tc };
    }
    return { type: 'idle', reason: agent.turns >= config.maxTurns ? 'max_turns' : 'pressure_softcut' };
  }

  private _checkGuards(tc: ParsedToolCall, agent: Agent): ProduceAction | null {
    const lineageHistory = agent.walkAncestors(a => a.toolHistory);
    let toolArgs: Record<string, unknown>;
    try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
    for (const guard of this._guards) {
      if (guard.tools.includes(tc.name) && guard.reject(toolArgs, lineageHistory, agent)) {
        return { type: 'nudge', message: guard.message };
      }
    }
    return null;
  }

  onSettleReject(
    agent: Agent,
    _resultTokens: number,
    pressure: ContextPressure,
    config: PolicyConfig,
  ): SettleAction {
    // Nudge if possible — stateless, no escalation tracking
    if (config.terminalTool && agent.toolCallCount > 0) {
      const words = tokenBudgetAsWords(pressure.remaining - pressure.hardLimit);
      return { type: 'nudge', message: `Tool result too large for remaining KV. Report your findings now within ${words} words.` };
    }
    // No terminal tool: kill
    return { type: 'idle', reason: 'pressure_settle_reject' as IdleReason };
  }

  /**
   * UI-driven override. Harness calls this when the user wants agents
   * to wrap up. Overrides pressure-based logic immediately.
   */
  setExploitMode(force: boolean): void { this._forceExploit = force; }

  shouldExit(agent: Agent, pressure: ContextPressure): boolean {
    // Terminal-tool protection applies in the graceful zone only — once
    // `pressure.critical` fires, the agent must yield so the pool can
    // kill+recover before native OOM. Holding this protection through
    // critical territory was the DOJ runaway cause (trace-1776782401659).
    if (this._terminalTool && agent.currentTool === this._terminalTool && !pressure.critical) return false;

    if (!pressure.critical) {
      const timeHard = this._budget?.time?.hardLimit;
      if (timeHard != null && this._elapsed(agent) >= timeHard) return true;
      return false;
    }
    if (this._killedThisTick) return false;
    this._killedThisTick = true;
    return true;
  }

  shouldExplore(agent: Agent, pressure: ContextPressure): boolean {
    if (this._forceExploit) return false;
    const contextOk =
      pressure.percentAvailable / 100 > this._exploreContext;
    const timeSoftLimit = this._budget?.time?.softLimit;
    const timeOk =
      timeSoftLimit == null
        ? true
        : this._elapsed(agent) / timeSoftLimit < this._exploreTime;
    return contextOk && timeOk;
  }

  /**
   * Trailing stop: at most one agent nudged or killed per tick.
   * The sacrificed agent's findings are extracted and its KV freed,
   * giving the remaining agents headroom to continue researching.
   * Both flags reset per tick via resetTick(), called by the pool.
   */
  private _killedThisTick = false;
  private _nudgedThisTick = false;

  resetTick(): void {
    this._killedThisTick = false;
    this._nudgedThisTick = false;
  }

  onRecovery(agent: Agent, pressure: ContextPressure): RecoveryAction {
    if (!this._recovery) return { type: 'skip' };
    const minTokens = this._recovery.minTokens ?? 100;
    const minToolCalls = this._recovery.minToolCalls ?? 2;
    if (agent.tokenCount < minTokens || agent.toolCallCount < minToolCalls) {
      return { type: 'skip' };
    }
    // Budget recovery's generation can consume: hardLimit reserve minus the
    // prefill overhead and llama.cpp's batch workspace. Expressed as words
    // (not tokens) and under-advertised so the model has slack — tokenizers
    // vary across models but words are universal. Rendered into the prompt
    // as `it.budget` so authors can reference it via `<%= it.budget %>`.
    const budgetTokens = Math.max(50, pressure.remaining - RECOVERY_PREFILL_OVERHEAD - BATCH_BUFFER);
    const budget = tokenBudgetAsWords(budgetTokens);
    const tctx = { budget };
    return {
      type: 'extract',
      prompt: {
        system: renderTemplate(this._recovery.prompt.system, tctx),
        user: renderTemplate(this._recovery.prompt.user, tctx),
      },
    };
  }
}
