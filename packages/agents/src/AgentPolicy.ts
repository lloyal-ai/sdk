import type { Agent, ToolHistoryEntry } from './Agent';
import type { ContextPressure } from './agent-pool';
import type { ParsedToolCall } from '@lloyal-labs/sdk';

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
export const defaultToolGuards: ToolGuard[] = [
  {
    tools: ['fetch_page'],
    reject: (args, history) => {
      const url = args.url as string | undefined;
      return !!url && history.some(h => h.name === 'fetch_page' && h.args === url);
    },
    message: 'This URL was already fetched. Try a different source.',
  },
  {
    tools: ['web_search'],
    reject: (args, history) => {
      const query = (args.query as string | undefined)?.toLowerCase();
      return !!query && history.some(h => h.name === 'web_search' && h.args.toLowerCase() === query);
    },
    message: 'This query was already searched. Refine your search or report findings.',
  },
  {
    tools: ['web_research', 'research'],
    reject: (_args, _lineage, agent) => {
      // Agent-local history: each agent must do its own research before delegating,
      // regardless of what ancestors did. Lineage history would let children bypass
      // this by inheriting parent's search+fetch — producing blind relay chains.
      const local = agent.toolHistory;
      const hasSearch = local.some(h => h.name === 'web_search' || h.name === 'search');
      const hasFetch = local.some(h => h.name === 'fetch_page' || h.name === 'read_file');
      return !hasSearch || !hasFetch;
    },
    message: 'Read your search results with fetch_page before spawning sub-agents.',
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
  | { type: 'report'; findings: string }
  | { type: 'nudge'; message?: string }
  | { type: 'idle'; reason: IdleReason }
  | { type: 'free_text_report'; content: string };

/**
 * Action returned by policy.onSettleReject.
 * @category Agents
 */
export type SettleAction =
  | { type: 'nudge' }
  | { type: 'idle'; reason: IdleReason };

// ── Policy interface ────────────────────────────────────────

/**
 * Agent lifecycle policy — injected strategy for pressure, nudge,
 * recursion, report timing, and findings quality decisions.
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
   * Called when prefillTokens.length > headroom. Policy decides whether
   * to nudge (inject "report now" error) or kill (transition to idle).
   */
  onSettleReject(
    agent: Agent,
    resultTokens: number,
    pressure: ContextPressure,
    config: PolicyConfig,
  ): SettleAction;
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
export class DefaultAgentPolicy implements AgentPolicy {
  onProduced(
    agent: Agent,
    parsed: { content: string | null; toolCalls: ParsedToolCall[] },
    pressure: ContextPressure,
    config: PolicyConfig,
  ): ProduceAction {
    const tc = parsed.toolCalls[0];

    // No tool call — natural stop
    if (!tc) {
      if (!agent.findings && agent.toolCallCount > 0 && parsed.content) {
        return { type: 'free_text_report', content: parsed.content };
      }
      return { type: 'idle', reason: 'free_text_stop' };
    }

    // Over budget check: turns exceeded or headroom negative, non-terminal tool
    const overBudget = (agent.turns >= config.maxTurns || pressure.headroom < 0)
      && (!config.terminalTool || tc.name !== config.terminalTool);

    if (overBudget) {
      // First offense: nudge if conditions met
      if (config.terminalTool && !agent.nudged && agent.toolCallCount > 0 && !pressure.critical) {
        return { type: 'nudge' };
      }
      // Second offense or no terminal tool: kill
      return { type: 'idle', reason: agent.turns >= config.maxTurns ? 'max_turns' : 'pressure_softcut' };
    }

    // Terminal tool — intercept and extract findings
    if (config.terminalTool && tc.name === config.terminalTool) {
      // Prevent reporting without sufficient research (minimum 2 non-report tool calls).
      // Nudged agents bypass — they may have only 1 tool call but were told to report.
      if (agent.toolCallCount < 2 && config.hasNonTerminalTools && !agent.nudged) {
        return { type: 'nudge', message: 'You must conduct research before reporting. Use web_search or fetch_page to find evidence first.' };
      }
      let findings: string;
      try { findings = JSON.parse(tc.arguments).findings; } catch { findings = tc.arguments; }
      return { type: 'report', findings };
    }

    // Check declarative guards against full lineage
    const lineageHistory = agent.walkLineage(a => a.toolHistory);
    let toolArgs: Record<string, unknown>;
    try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }

    for (const guard of defaultToolGuards) {
      if (guard.tools.includes(tc.name) && guard.reject(toolArgs, lineageHistory, agent)) {
        return { type: 'nudge', message: guard.message };
      }
    }

    // Normal tool call
    return { type: 'tool_call', tc };
  }

  onSettleReject(
    agent: Agent,
    _resultTokens: number,
    _pressure: ContextPressure,
    config: PolicyConfig,
  ): SettleAction {
    // First offense: nudge if conditions met
    if (config.terminalTool && !agent.nudged && agent.toolCallCount > 0) {
      return { type: 'nudge' };
    }
    // Second offense: kill
    return { type: 'idle', reason: 'pressure_settle_reject' as IdleReason };
  }
}
