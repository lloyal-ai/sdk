import type { Branch } from '@lloyal-labs/sdk';
import type { GrammarTrigger } from '@lloyal-labs/sdk';
import type { TraceToken } from './types';

// ── Status ──────────────────────────────────────────────────

/**
 * Agent status — domain language for where the agent is in its lifecycle.
 *
 * - `idle`: created but not yet generating, OR finished but branch still
 *    alive (extraction window for scratchpad)
 * - `active`: generating tokens (between PRODUCE start and stop token)
 * - `awaiting_tool`: tool call parsed, waiting for result in SETTLE
 * - `disposed`: branch pruned, agent no longer usable
 *
 * @category Agents
 */
export type AgentStatus = 'idle' | 'active' | 'awaiting_tool' | 'disposed';

/**
 * How the agent's findings were produced — provenance for trace/debugging.
 *
 * @category Agents
 */
export type ResultSource =
  | 'report_tool'   // agent voluntarily called report()
  | 'free_text'     // agent emitted prose without tool call
  | 'scratchpad'    // extracted post-idle via fork+generate
  | 'nudge'         // agent reported after nudge injection
  | 'tool_error';   // tool threw, error captured as findings

// ── Format config ───────────────────────────────────────────

/**
 * Immutable prompt format configuration set at agent creation.
 * Derived from `formatChatSync()` output.
 *
 * @category Agents
 */
export interface FormatConfig {
  format: number;
  reasoningFormat: number;
  generationPrompt: string;
  parser: string;
  grammar: string;
  grammarLazy: boolean;
  grammarTriggers: GrammarTrigger[];
}

// ── Tool history ────────────────────────────────────────────

/**
 * Metadata for a single tool invocation — what was called, how expensive
 * it was, and what context remained after. Content is in the branch KV;
 * this is the metadata the policy reads for informed decisions.
 *
 * @category Agents
 */
export interface ToolHistoryEntry {
  /** Tool name (e.g. 'web_search', 'fetch_page') */
  name: string;
  /** Summarized arguments (e.g. query string, URL) */
  args: string;
  /** Number of tokens prefilled for this tool's result */
  resultTokenCount: number;
  /** Context available percent after this result settled */
  contextAfterPercent: number;
  /** Timestamp (performance.now) when result was recorded */
  timestamp: number;
}

// ── Agent ───────────────────────────────────────────────────

/**
 * An agent is a branch with intent.
 *
 * A Branch is a forkable KV cache sequence — it stores every token the
 * model has seen and generated. An Agent adds: a task to accomplish,
 * a policy for how to accomplish it, and a record of what it has done.
 *
 * The branch is the ground truth. The agent is the interpretation layer
 * that gives meaning to what's in the branch and makes decisions about
 * what to do next.
 *
 * Agents are plain classes — not Effection resources, not spawned
 * concurrently. The pool creates agents, manages their scope, and runs
 * the tick loop. The agent encapsulates state, policy, and findings.
 *
 * @category Agents
 */
export class Agent {
  // ── Identity ────────────────────────────────────────────

  /** Stable identifier — equals branch.handle */
  readonly id: number;

  /** Parent branch handle — trace metadata for UI tree reconstruction */
  readonly parentId: number;

  /** The KV sequence this agent owns */
  readonly branch: Branch;

  /** Immutable prompt format configuration */
  readonly fmt: FormatConfig;

  /** The task text this agent was assigned — used by echo detection guard */
  readonly task: string;

  // ── Mutable state ───────────────────────────────────────

  private _status: AgentStatus = 'idle';
  private _rawOutput = '';
  private _tokenCount = 0;
  private _toolCallCount = 0;
  private _turns = 0;
  private _result: string | null = null;
  private _resultSource: ResultSource | null = null;
  private _toolHistory: ToolHistoryEntry[] = [];
  private _nestedResults: string[] = [];
  private _traceBuffer: TraceToken[] = [];

  /** The agent that called the tool which spawned this agent's pool (null for top-level) */
  readonly parent: Agent | null = null;

  // ── Constructor ─────────────────────────────────────────

  constructor(opts: {
    id: number;
    parentId: number;
    branch: Branch;
    fmt: FormatConfig;
    parent?: Agent | null;
    task?: string;
  }) {
    this.id = opts.id;
    this.parentId = opts.parentId;
    this.branch = opts.branch;
    this.fmt = opts.fmt;
    this.task = opts.task ?? '';
    this.parent = opts.parent ?? null;
  }

  // ── Status ──────────────────────────────────────────────

  get status(): AgentStatus { return this._status; }

  /**
   * Transition to a new status. Enforces valid transitions:
   * - idle → active (first produce)
   * - active → awaiting_tool (tool call parsed)
   * - active → idle (stop token, report, or kill)
   * - awaiting_tool → active (tool result settled)
   * - awaiting_tool → idle (settle reject + kill)
   * - idle → disposed (branch pruned)
   */
  transition(to: AgentStatus): void {
    const from = this._status;
    const valid =
      (from === 'idle' && (to === 'active' || to === 'disposed')) ||
      (from === 'active' && (to === 'awaiting_tool' || to === 'idle')) ||
      (from === 'awaiting_tool' && (to === 'active' || to === 'idle'));
    if (!valid) {
      throw new Error(`Invalid agent status transition: ${from} → ${to}`);
    }
    this._status = to;
  }

  // ── Token accounting ────────────────────────────────────

  get rawOutput(): string { return this._rawOutput; }
  get tokenCount(): number { return this._tokenCount; }
  get toolCallCount(): number { return this._toolCallCount; }
  get turns(): number { return this._turns; }
  get traceBuffer(): TraceToken[] { return this._traceBuffer; }

  /** Accumulate generated token text into the current turn */
  accumulateToken(text: string): void {
    this._rawOutput += text;
    this._tokenCount++;
  }

  /** Accumulate token with trace data */
  accumulateTokenWithTrace(text: string, entropy: number, surprisal: number): void {
    this._rawOutput += text;
    this._tokenCount++;
    this._traceBuffer.push({ text, entropy, surprisal });
  }

  /** Reset per-turn output after tool result is settled */
  resetTurn(): void { this._rawOutput = ''; }

  /** Increment turn counter */
  incrementTurns(): void { this._turns++; }

  /** Increment tool call counter */
  incrementToolCalls(): void { this._toolCallCount++; }

  // ── Tool history ────────────────────────────────────────

  get toolHistory(): readonly ToolHistoryEntry[] { return this._toolHistory; }

  /** Record metadata for a completed tool invocation */
  recordToolResult(entry: ToolHistoryEntry): void {
    this._toolHistory.push(entry);
  }

  // ── Child findings ─────────────────────────────────────────

  /** Findings collected from recursive tool results (inner sub-agent findings) */
  get nestedResults(): readonly string[] { return this._nestedResults; }

  /** Collect inner findings from a recursive tool's result */
  addNestedResults(results: string[]): void {
    this._nestedResults.push(...results);
  }

  /**
   * Walk the agent lineage (self → caller → caller's caller → ...),
   * collecting results from each ancestor via the provided function.
   *
   * Self is visited first, then the calling agent, then its caller, etc.
   * Iterative — no stack overflow on deep recursion chains.
   *
   * @example Check if any ancestor fetched a URL
   * ```typescript
   * const fetched = agent.walkAncestors(a => a.toolHistory)
   *   .some(h => h.name === 'fetch_page' && h.args === url);
   * ```
   */
  walkAncestors<T>(fn: (agent: Agent) => readonly T[]): T[] {
    const result: T[] = [...fn(this)];
    let current = this.parent;
    while (current) {
      result.push(...fn(current));
      current = current.parent;
    }
    return result;
  }

  // ── Findings ────────────────────────────────────────────

  get result(): string | null { return this._result; }
  get resultSource(): ResultSource | null { return this._resultSource; }

  /** Set findings with provenance tracking — single write path */
  reportResult(content: string, source: ResultSource): void {
    this._result = content;
    this._resultSource = source;
  }

  // ── Branch-derived readings ─────────────────────────────

  get position(): number { return this.branch.position; }
  get forkHead(): number { return this.branch.forkHead; }
  /** Number of unique KV cells this agent owns above the fork point */
  get uniqueCells(): number { return this.branch.position - this.branch.forkHead; }

  /** Whether the grammar allows free text output (not tool-call-only) */
  get grammarAllowsFreeText(): boolean {
    return !this.fmt.grammarLazy || !this.fmt.grammar;
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** Mark agent as disposed — called by pool when branch is pruned */
  dispose(): void {
    this._status = 'disposed';
  }
}
