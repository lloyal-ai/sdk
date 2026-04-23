import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import type { AgentPolicy } from './AgentPolicy';
import type { EntailmentScorer } from './source';
import type { ToolHistoryEntry } from './Agent';

// ── Tool base class types ──────────────────────────────────────

/**
 * JSON Schema definition for tool parameter validation
 *
 * Describes the shape of arguments a {@link Tool} accepts. Passed to the
 * model via `formatChat()` so it can generate valid tool-call arguments.
 *
 * @category Agents
 */
export interface JsonSchema {
  /** JSON Schema type (e.g. `"object"`, `"string"`, `"array"`) */
  type: string;
  /** Property definitions when `type` is `"object"` */
  properties?: Record<string, unknown>;
  /** Required property names when `type` is `"object"` */
  required?: string[];
  /** Additional schema constraints (minItems, enum, etc.) */
  [key: string]: unknown;
}

/**
 * OpenAI-compatible function tool schema
 *
 * The wrapper format expected by `formatChat()` when passing tools to the
 * model. {@link Tool.schema} generates this automatically from the tool's
 * `name`, `description`, and `parameters`.
 *
 * @category Agents
 */
export interface ToolSchema {
  /** Always `"function"` for function-calling tools */
  type: 'function';
  /** Function definition containing name, description, and parameter schema */
  function: {
    /** Tool name — used as the function identifier in tool calls */
    name: string;
    /** Human-readable description shown to the model */
    description: string;
    /** JSON Schema describing the tool's arguments */
    parameters: JsonSchema;
  };
}

/**
 * Execution context passed to {@link Tool.execute}
 *
 * Provides callbacks for reporting progress during long-running tool
 * operations (e.g. reranker scoring chunks).
 *
 * @category Agents
 */
export interface ToolContext {
  /** Stable agent identifier — branch handle at creation time */
  agentId: number;
  /**
   * The calling agent's branch — use for recursive tools that spawn
   * sub-agents via {@link withSharedRoot} with `parent` option.
   * Sub-agents forking from this branch inherit the agent's full
   * KV state (Continuous Context).
   */
  branch?: Branch;
  /** Progress callback for long-running operations */
  onProgress?: (p: { filled: number; total: number }) => void;
  /**
   * Entailment scorer for maintaining semantic coherence with the
   * original query across recursive depths. Tools use this to score
   * results against the root intent before returning to the agent.
   */
  scorer?: EntailmentScorer;
  /**
   * When false, content-boundary tools apply dual scoring
   * (scoreRelevanceBatch) for tighter focus. Computed per-DISPATCH
   * by policy.shouldExplore(). @default true
   */
  explore?: boolean;
  /**
   * KV percent available at DISPATCH time. Always set (from
   * ContextPressure.percentAvailable). Used by tools to include the
   * pressure snapshot in exploit-mode trace events without needing
   * a SessionContext reference.
   */
  pressurePercentAvailable?: number;
  /**
   * Tool histories of sibling agents in the same pool (excluding self).
   * Used by tools to detect cross-agent duplicate calls and return
   * a "resource unavailable" error to force diversification.
   */
  peerHistory?: ToolHistoryEntry[];
}

// ── Trace types ───────────────────────────────────────────────

/**
 * Per-token trace entry captured when {@link AgentPoolOptions.trace} is true
 *
 * Each entry corresponds to one sampled token and the distribution state
 * at the moment it was drawn. Available on {@link AgentResult.trace} after
 * pool completion.
 *
 * @category Agents
 */
export interface TraceToken {
  /** Decoded text for this token */
  text: string;
  /** Shannon entropy of the full vocabulary distribution (bits, base-2) */
  entropy: number;
  /** Surprisal of the chosen token: -log2(p) */
  surprisal: number;
}

// ── Agent pool types ───────────────────────────────────────────

/**
 * Task specification for a single agent in {@link useAgentPool}
 *
 * Each task defines the agent's system prompt, user content, available
 * tools, and parent branch to fork from. The parent branch determines
 * the agent's KV prefix — fork from a shared root to amortize system
 * prompt tokenization across agents.
 *
 * @category Agents
 */
export interface AgentTaskSpec {
  /** System prompt defining the agent's role and behavior */
  systemPrompt: string;
  /** User message content — the agent's specific sub-question or task */
  content: string;
  /** JSON-serialized tool schemas (from {@link createToolkit}) */
  tools?: string;
  /** PRNG seed for sampler diversity — pass different seeds per agent */
  seed?: number;
  /** Parent branch to fork from (required by {@link useAgentPool}) */
  parent?: Branch;
}

/**
 * Sampling parameters for generation
 *
 * Controls the sampler chain applied during token generation. Passed to
 * {@link Branch.create}, {@link generate}, {@link diverge}, and agent
 * pool tasks.
 *
 * @category Agents
 */
export interface SamplingParams {
  /** Temperature for softmax scaling (0 = greedy, higher = more random) */
  temperature?: number;
  /** Nucleus sampling threshold — cumulative probability cutoff */
  topP?: number;
  /** Top-K sampling — keep only the K most likely tokens */
  topK?: number;
  /** Minimum probability threshold relative to the most likely token */
  minP?: number;
  /** Additional sampler-specific parameters */
  [key: string]: unknown;
}

/**
 * KV pressure thresholds controlling agent shutdown under context exhaustion
 *
 * Two thresholds govern what happens as remaining KV shrinks:
 *
 * **softLimit** (default 1024) — remaining KV floor for new work.
 * Enforced at three points:
 * - **SETTLE**: tool results that would cross this floor are rejected and
 *   the agent is marked done. This is the primary enforcement point — tool
 *   results (search results, etc.) are the largest KV consumers.
 * - **PRODUCE (stop-token boundary)**: agents that want a non-terminal tool
 *   call are hard-cut. Terminal tools (e.g. `report()`) still pass.
 * - **INIT prefill**: agents that don't fit above this floor are dropped.
 *
 * Set to account for downstream pool needs (reporters, verification).
 *
 * **hardLimit** (default 128) — crash-prevention floor.
 * When remaining drops below this, agents are killed immediately before
 * `produceSync()`. Prevents `llama_decode` "no memory slot" failures.
 * Pure safety net — should never be the primary budget control.
 *
 * @category Agents
 */
export interface PressureThresholds {
  /**
   * Remaining KV floor for new work (tokens). When remaining drops below
   * this, SETTLE rejects tool results, PRODUCE hard-cuts non-terminal tool
   * calls, and INIT drops agents that don't fit.
   *
   * Set to account for downstream pool needs (reporters, verification).
   * Default: 1024
   */
  softLimit?: number;
  /**
   * Crash-prevention floor (tokens). When remaining drops below this,
   * `pressure.critical` is true and agents are killed before the next
   * decode. Must be >= the context's `nBatch` — otherwise native decode
   * can't allocate the next batch when the kill fires, and recovery's
   * prefill will OOM. The pool validates this at startup.
   * Default: 512 (matches llama.cpp's default `n_batch`).
   */
  hardLimit?: number;
}

/**
 * Configuration for {@link useAgentPool} and {@link runAgents}
 *
 * @category Agents
 */
export interface AgentPoolOptions {
  /**
   * Shared root branch. Orchestrator-spawned agents fork from this by default.
   * Produced by {@link withSharedRoot} in the {@link agentPool} wrapper.
   */
  root: Branch;
  /**
   * Orchestrator callback — declares the execution pattern (parallel, chain,
   * fanout, dag, or a custom shape). Drives task spawning, waiting, and
   * spine extension through the provided {@link PoolContext}.
   */
  orchestrate: (ctx: import('./orchestrators').PoolContext) => Operation<void>;
  /** JSON-serialized tool schemas for chat formatting. Derived from tool map. */
  toolsJson: string;
  /**
   * Tool registry mapping tool names to {@link Tool} instances.
   *
   * This is the **execution registry** — it determines which tools can be
   * dispatched at runtime. It is distinct from the per-task `task.tools`
   * JSON schema that tells the model which tools are available.
   *
   * The registry also controls {@link AgentPoolOptions.terminalTool | terminalTool}
   * gating: if the registry contains only the terminal tool, agents are
   * allowed to call it as their first action (e.g. reporter sub-agents).
   * If the registry contains other tools, the first call must be
   * non-terminal to prevent agents from reporting without doing work.
   */
  tools: Map<string, import('./Tool').Tool>;
  /** Sampling parameters applied to all agents */
  params?: SamplingParams;
  /** Maximum tool-call turns per agent before forced termination */
  maxTurns?: number;
  /** Tool name that signals agent completion. When the model calls this tool,
   *  findings are extracted from arguments and the agent is marked done.
   *  The tool is intercepted — never dispatched to execute(). If omitted,
   *  agents complete only via stop token or hard-cut. */
  terminalTool?: string;
  /** Enable per-token entropy/surprisal on `agent:produce` events */
  trace?: boolean;
  /** Prune agent branches immediately when they call the terminal tool.
   *  Frees KV for remaining agents mid-pool. Only agents that reported
   *  findings are pruned — hard-cut agents keep their branches for
   *  reportPass extraction. @default false */
  pruneOnReport?: boolean;
  /** Custom agent policy. Configure recovery (scratchpad extraction),
   *  time limits, explore/exploit threshold, and tool guards via
   *  {@link DefaultAgentPolicyOpts}. @default DefaultAgentPolicy with default opts */
  policy?: AgentPolicy;
  /**
   * Whether the chat template delimits `<think>` blocks for this pool's
   * agents. Captured once at pool creation, stored on each agent's
   * `fmt.enableThinking`, and threaded through every `buildToolResultDelta`
   * call so the parser's `generation_prompt` stays consistent with the
   * actual KV state. Setting `true` gives the template's generation prompt
   * the `<think>\n` prefix that thinking-capable models (Qwen3 family)
   * expect — thoughts are correctly delimited and `parseChatOutput`
   * extracts them into `reasoning_content`. Setting `false` omits think
   * tokens; if the model emits them anyway (as Qwen3.5 does) they leak
   * into visible content.
   * @default false
   */
  enableThinking?: boolean;
  /** Entailment scorer for semantic coherence across recursive depths.
   *  Passed to every tool via {@link ToolContext.scorer}. */
  scorer?: EntailmentScorer;
}

/**
 * Result for a single completed agent
 *
 * @category Agents
 */
export interface AgentResult {
  /** Stable agent identifier (branch handle at creation time) */
  agentId: number;
  /** Parent branch handle — shared root for top-level agents, parent agentId for sub-agents */
  parentAgentId: number;
  /** The agent's branch — still alive when returned from {@link useAgentPool} */
  branch: Branch;
  /** The Agent class instance — carries full state (tool history, format config, lineage) */
  agent: import('./Agent').Agent;
  /** Agent's result (from terminal tool or final output), or null */
  result: string | null;
  /** Number of tool calls the agent made */
  toolCallCount: number;
  /** Total tokens generated by this agent */
  tokenCount: number;
  /** Model-level perplexity at completion (exp of mean NLL from raw logits) */
  ppl: number;
  /** Sampling-level perplexity at completion (from filtered distribution) */
  samplingPpl: number;
  /** Per-token trace data (present only when {@link AgentPoolOptions.trace} is true) */
  trace?: TraceToken[];
  /** Results collected from recursive tool results (inner sub-agent findings) */
  nestedResults: readonly string[];
}

/**
 * Aggregate result from a completed agent pool run
 *
 * Returned by both {@link useAgentPool} and {@link runAgents}. Contains
 * per-agent results plus aggregate statistics for display and telemetry.
 *
 * @category Agents
 */
export interface AgentPoolResult {
  /** Per-agent results in task order */
  agents: AgentResult[];
  /** Sum of all agent token counts */
  totalTokens: number;
  /** Sum of all agent tool calls */
  totalToolCalls: number;
  /** Number of batched commit steps in the tick loop */
  steps: number;
  /** Internal performance counters for telemetry */
  counters: {
    /** Number of batch prefill calls for tool result injection */
    warmPrefillCalls: number;
    /** Total branches across all warm prefill batches */
    warmPrefillBranches: number;
  };
}

// ── Generate types ─────────────────────────────────────────────

/**
 * Options for single-branch {@link generate}
 *
 * @category Agents
 */
export interface GenerateOptions {
  /** Pre-formatted prompt string (from `formatChat()` + `tokenize()`) */
  prompt: string;
  /** GBNF grammar string for constrained generation */
  grammar?: string;
  /** Sampling parameters */
  params?: SamplingParams;
  /** Optional parser applied to the raw output string */
  parse?: (output: string) => unknown;
  /** Fork from parent instead of creating a fresh root. Prompt is prefilled as a delta (with turn separator). */
  parent?: Branch;
}

/**
 * Result from single-branch {@link generate}
 *
 * @category Agents
 */
export interface GenerateResult<T = unknown> {
  /** Raw generated text */
  output: string;
  /** Number of tokens generated */
  tokenCount: number;
  /** Parsed output (present only when `parse` was provided in options) */
  parsed?: T;
}

// ── Diverge types ──────────────────────────────────────────────

/**
 * Options for multi-branch {@link diverge}
 *
 * Either `parent` or `prompt` must be provided. When `parent` is given,
 * branches fork from it and no new root is created. When only `prompt`
 * is given, a fresh root is created, prefilled, and cleaned up on error.
 *
 * @category Agents
 */
export interface DivergeOptions {
  /** Pre-formatted prompt for creating a fresh root (mutually exclusive with parent) */
  prompt?: string;
  /** Number of parallel generation attempts */
  attempts: number;
  /** Parent branch to fork from (mutually exclusive with prompt) */
  parent?: Branch;
  /** Sampling parameters for all attempts */
  params?: SamplingParams;
  /** Base seed for sampler diversity across attempts. @default 2000 */
  seedBase?: number;
}

/**
 * Single attempt result from {@link diverge}
 *
 * @category Agents
 */
export interface DivergeAttempt {
  /** The attempt's branch (only the best branch survives after diverge) */
  branch: Branch;
  /** Generated text for this attempt */
  output: string;
  /** Number of tokens generated */
  tokenCount: number;
  /** Model perplexity — lower indicates more coherent generation */
  ppl: number;
}

/**
 * Aggregate result from {@link diverge}
 *
 * The `best` branch is still alive; all other attempt branches have been
 * pruned. The caller owns cleanup — typically via {@link Session.promote}
 * to make the best branch the new conversation trunk.
 *
 * @category Agents
 */
export interface DivergeResult {
  /** Lowest-perplexity branch — still alive, caller owns cleanup */
  best: Branch;
  /** Text output from the best attempt */
  bestOutput: string;
  /** All attempts (losers already pruned, branches disposed) */
  attempts: DivergeAttempt[];
  /** Sum of all attempt token counts */
  totalTokens: number;
  /** Number of batched commit steps */
  steps: number;
  /** Shared prefix length in tokens (for KV savings calculation) */
  prefixLength: number;
}

// ── Runtime events ─────────────────────────────────────────────

/**
 * Events emitted by the runtime during agent pool execution
 *
 * Subscribe to these via the `events` channel from {@link initAgents}.
 * Harnesses can extend this union with phase-level events for display.
 *
 * @category Agents
 */
export type AgentEvent =
  | { type: 'agent:spawn'; agentId: number; parentAgentId: number }
  | { type: 'agent:produce'; agentId: number; text: string; tokenCount: number; entropy?: number; surprisal?: number }
  | { type: 'agent:tool_call'; agentId: number; tool: string; args: string }
  | { type: 'agent:tool_result'; agentId: number; tool: string; result: string; contextAvailablePercent?: number }
  | { type: 'agent:tool_progress'; agentId: number; tool: string; filled: number; total: number }
  | { type: 'agent:report'; agentId: number; result: string }
  | { type: 'agent:done'; agentId: number }
  | { type: 'agent:tick'; cellsUsed: number; nCtx: number };
