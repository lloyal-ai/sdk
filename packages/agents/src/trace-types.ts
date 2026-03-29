/**
 * Monotonically increasing trace ID
 *
 * Allocated by {@link TraceWriter.nextId}. Cheap — just an incrementing
 * counter. Used to build parent-child relationships across scopes, agent
 * pools, and tool dispatches in the trace tree.
 *
 * @category Agents
 */
export type TraceId = number;

/** Base shape for all trace events */
interface TraceEventBase {
  traceId: TraceId;
  parentTraceId: TraceId | null;
  ts: number; // performance.now()
}

/**
 * Discriminated union of all trace event types
 *
 * Every variant extends {@link TraceEventBase} with a `type` discriminant.
 * Events cover the full lifecycle of agent execution: scope open/close,
 * prompt formatting, branch creation/prefill/prune, generation start/end,
 * agent pool ticks, tool dispatch/result, diverge attempts, reranker
 * passes, and source bindings.
 *
 * Written to a {@link TraceWriter} throughout the runtime. Consumers
 * (e.g. {@link JsonlTraceWriter}) serialize events to JSONL for
 * post-hoc analysis.
 *
 * @category Agents
 */
export type TraceEvent =
  // ── Scope events ────────────────────────────
  | TraceEventBase & { type: 'scope:open'; name: string; meta?: Record<string, unknown> }
  | TraceEventBase & { type: 'scope:close'; name: string; durationMs: number }

  // ── Prompt events ───────────────────────────
  | TraceEventBase & {
      type: 'prompt:format';
      promptText: string;
      taskContent?: string;
      tokenCount: number;
      messages: string;
      tools?: string;
      grammar?: string;
      role: 'sharedRoot' | 'agentSuffix' | 'generate' | 'diverge' | 'toolResultDelta';
    }

  // ── Branch events ───────────────────────────
  | TraceEventBase & {
      type: 'branch:create';
      branchHandle: number;
      parentHandle: number | null;
      position: number;
      role: 'root' | 'sharedRoot' | 'agentFork' | 'scratchpad' | 'divergeAttempt';
    }
  | TraceEventBase & {
      type: 'branch:prefill';
      branchHandle: number;
      tokenCount: number;
      role: 'sharedPrefix' | 'agentSuffix' | 'toolResult' | 'warmDelta' | 'scratchpad';
    }
  | TraceEventBase & { type: 'branch:prune'; branchHandle: number; position: number }

  // ── Generation events ───────────────────────
  | TraceEventBase & {
      type: 'generate:start';
      branchHandle: number;
      hasGrammar: boolean;
      hasParent: boolean;
      role: string;
    }
  | TraceEventBase & {
      type: 'generate:end';
      branchHandle: number;
      tokenCount: number;
      output: string;
      parsed?: unknown;
    }

  // ── Agent pool events ───────────────────────
  | TraceEventBase & {
      type: 'pool:open';
      agentCount: number;
      taskSuffixTokens: number[];
      pressure: { remaining: number; softLimit: number; headroom: number };
    }
  | TraceEventBase & {
      type: 'pool:close';
      agents: Array<{
        agentId: number;
        tokenCount: number;
        toolCallCount: number;
        result: string | null;
        ppl: number;
      }>;
      totalTokens: number;
      steps: number;
      durationMs: number;
    }
  | TraceEventBase & {
      type: 'pool:tick';
      phase: 'PRODUCE' | 'COMMIT' | 'SETTLE' | 'DISPATCH';
      activeAgents: number;
      pressure: { remaining: number; cellsUsed: number; nCtx: number; headroom: number };
    }
  | TraceEventBase & {
      type: 'pool:agentDrop';
      agentId: number;
      reason:
        | 'pressure_init'
        | 'pressure_critical'
        | 'pressure_softcut'
        | 'pressure_settle_reject'
        | 'maxTurns'
        | 'stop_token';
    }
  | TraceEventBase & {
      type: 'pool:agentNudge';
      agentId: number;
      reason: 'pressure_softcut' | 'pressure_settle_reject';
    }

  // ── Agent per-turn output ────────────────────
  | TraceEventBase & {
      type: 'agent:turn';
      agentId: number;
      turn: number;
      rawOutput: string;
      parsedContent: string | null;
      parsedToolCalls: Array<{ name: string; arguments: string }>;
    }

  // ── Tool events ─────────────────────────────
  | TraceEventBase & {
      type: 'tool:dispatch';
      agentId: number;
      tool: string;
      toolIndex: number;
      toolkitSize: number;
      args: Record<string, unknown>;
      callId: string;
    }
  | TraceEventBase & {
      type: 'tool:result';
      agentId: number;
      tool: string;
      result: unknown;
      prefillTokenCount: number;
      durationMs: number;
    }
  | TraceEventBase & { type: 'tool:error'; agentId: number; tool: string; error: string }

  // ── Diverge events ──────────────────────────
  | TraceEventBase & { type: 'diverge:start'; attempts: number; prefixLength: number }
  | TraceEventBase & {
      type: 'diverge:end';
      bestIdx: number;
      ppls: number[];
      outputs: string[];
      totalTokens: number;
    }

  // ── Reranker events (rig package) ───────────
  | TraceEventBase & {
      type: 'rerank:start';
      query: string;
      chunkCount: number;
      tool?: string;
      url?: string;
      chunks?: Array<{ heading: string; textLength: number; startLine: number }>;
    }
  | TraceEventBase & {
      type: 'rerank:end';
      topResults: Array<{ file: string; heading: string; score: number; textPreview?: string }>;
      selectedPassageCount: number;
      totalChars: number;
      durationMs: number;
      tool?: string;
      url?: string;
    }

  // ── Source events (rig package) ─────────────
  | TraceEventBase & { type: 'source:bind'; sourceName: string }
  | TraceEventBase & { type: 'source:research'; sourceName: string; questions: string[] }
  | TraceEventBase & { type: 'source:chunks'; sourceName: string; chunkCount: number }

  // ── Entailment scoring events ──────────────
  | TraceEventBase & { type: 'entailment:search'; tool: string; query: string; [key: string]: unknown }
  | TraceEventBase & { type: 'entailment:search:reordered'; tool: string; after: Array<{ title: string; url: string }> }
  | TraceEventBase & { type: 'entailment:delegate'; tool: string; tasks: Array<{ text: string; score: number; kept: boolean }> }
  | TraceEventBase & { type: 'entailment:delegate:echo'; tool: string; agentTask: string; tasks: Array<{ text: string; echoScore: number }>; threshold: number; rejected: boolean }
  | TraceEventBase & {
      /** Exploit-mode dual scoring at a content boundary (search/fetch_page).
       *  Emitted when policy.shouldExplore() returns false and the tool
       *  applies scoreRelevanceBatch to tighten focus. */
      type: 'entailment:content:exploit';
      tool: string;
      /** Pressure snapshot that triggered exploit mode. */
      pressure: { percentAvailable: number; remaining: number; nCtx: number };
      /** Top chunks with both score flavors.
       *  toolQueryScore: reranker score against this tool call's query arg.
       *  combinedScore: min(toolQueryScore, originalQueryScore). */
      chunks: Array<{ heading: string; toolQueryScore: number; combinedScore: number }>;
    };
