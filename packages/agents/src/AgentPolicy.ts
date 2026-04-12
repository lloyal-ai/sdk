import type { Agent, ToolHistoryEntry } from './Agent';
import { ContextPressure } from './agent-pool';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import type { PressureThresholds } from './types';

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
   * SETTLE phase: tool result won't fit in KV — what should happen?
   *
   * @deprecated SETTLE no longer kills agents. Oversized tool results are
   * deferred until headroom recovers via the trailing stop in PRODUCE.
   * This method is retained for backward compatibility with custom policies
   * but is no longer called by the pool.
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
  onRecovery?(agent: Agent): RecoveryAction;
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
  /** KV availability threshold (0–100). Above → explore. Below → exploit.
   *  Uses ContextPressure.percentAvailable. @default 40 */
  exploreThreshold?: number;
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
}

export class DefaultAgentPolicy implements AgentPolicy {
  private _minToolCalls: number;
  private _guards: ToolGuard[];
  private _exploreThreshold: number;
  private _forceExploit = false;
  private _recovery: DefaultAgentPolicyOpts['recovery'] | null;
  private _budget: DefaultAgentPolicyOpts['budget'] | null;
  private _startTime: number;

  constructor(opts?: DefaultAgentPolicyOpts) {
    this._minToolCalls = opts?.minToolCallsBeforeReport ?? 2;
    this._exploreThreshold = opts?.exploreThreshold ?? 40;
    this._guards = opts?.guards ?? [
      ...defaultToolGuards,
      ...(opts?.extraGuards ?? []),
    ];
    this._recovery = opts?.recovery ?? null;
    this._budget = opts?.budget ?? null;
    this._startTime = performance.now();
  }

  private _elapsed(): number { return performance.now() - this._startTime; }

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
    if (this._isOverBudget(agent, tc, pressure, config)) return this._handleOverBudget(agent, tc, pressure, config);
    const guardRejection = this._checkGuards(tc, agent);
    if (guardRejection) return guardRejection;
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
    const timeNudge = timeSoft != null && this._elapsed() >= timeSoft;
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
    const timeNudge = timeSoft != null && this._elapsed() >= timeSoft;

    if (config.terminalTool && agent.toolCallCount > 0 && !pressure.critical) {
      if (!this._nudgedThisTick) {
        this._nudgedThisTick = true;
        const msg = timeNudge
          ? 'Time limit approaching — report your findings now.'
          : agent.turns >= config.maxTurns
            ? 'Turn limit reached — report your findings now.'
            : 'KV memory pressure — report your findings now.';
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
    _pressure: ContextPressure,
    config: PolicyConfig,
  ): SettleAction {
    // Nudge if possible — stateless, no escalation tracking
    if (config.terminalTool && agent.toolCallCount > 0) {
      return { type: 'nudge', message: 'Tool result too large for remaining KV. Report your findings now.' };
    }
    // No terminal tool: kill
    return { type: 'idle', reason: 'pressure_settle_reject' as IdleReason };
  }

  /**
   * UI-driven override. Harness calls this when the user wants agents
   * to wrap up. Overrides pressure-based logic immediately.
   */
  setExploitMode(force: boolean): void { this._forceExploit = force; }

  shouldExplore(_agent: Agent, pressure: ContextPressure): boolean {
    if (this._forceExploit) return false;
    return pressure.percentAvailable > this._exploreThreshold;
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

  shouldExit(_agent: Agent, pressure: ContextPressure): boolean {
    if (!pressure.critical) {
      const timeHard = this._budget?.time?.hardLimit;
      if (timeHard != null && this._elapsed() >= timeHard) return true;
      return false;
    }
    if (this._killedThisTick) return false;
    this._killedThisTick = true;
    return true;
  }

  onRecovery(agent: Agent): RecoveryAction {
    if (!this._recovery) return { type: 'skip' };
    const minTokens = this._recovery.minTokens ?? 100;
    const minToolCalls = this._recovery.minToolCalls ?? 2;
    if (agent.tokenCount < minTokens || agent.toolCallCount < minToolCalls) {
      return { type: 'skip' };
    }
    return { type: 'extract', prompt: this._recovery.prompt };
  }
}
