/** Monotonically increasing trace ID. Cheap — just an incrementing counter. */
export type TraceId = number;

/** Base shape for all trace events */
interface TraceEventBase {
  traceId: TraceId;
  parentTraceId: TraceId | null;
  ts: number; // performance.now()
}

/** Discriminated union of all trace event types */
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
        findings: string | null;
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
  | TraceEventBase & { type: 'rerank:start'; query: string; chunkCount: number }
  | TraceEventBase & {
      type: 'rerank:end';
      topResults: Array<{ file: string; heading: string; score: number }>;
      selectedPassageCount: number;
      totalChars: number;
      durationMs: number;
    }

  // ── Source events (rig package) ─────────────
  | TraceEventBase & { type: 'source:bind'; sourceName: string }
  | TraceEventBase & { type: 'source:research'; sourceName: string; questions: string[] }
  | TraceEventBase & { type: 'source:chunks'; sourceName: string; chunkCount: number };
