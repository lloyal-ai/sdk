export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

import type { PageStream } from './page-stream';
import type { AgentPanel } from './agent-panel';

export interface ViewState {
  agentLabel: Map<number, string>;
  nextLabel: number;
  /** Accumulated token text per agent — populated in verbose mode for the
   *  block dump at tool_call/done boundaries. Empty in streaming mode. */
  agentText: Map<number, string>;
  agentStatus: Map<number, { state: string; tokenCount: number; detail: string }>;
  traceQuery: string;
  /** Vertical streaming region for the synthesis phase. Open between
   *  synthesize:start and synthesize:done; consumes every agent:produce
   *  event during that window. */
  synthStream: PageStream;
  /** Vertical streaming region for research agents. Open across each
   *  generation window (between tool calls), closed on agent:tool_call
   *  and agent:report so tree log lines print cleanly between segments. */
  agentStream: PageStream;
  /** Set once synth finished streaming — answerHandler skips re-render. */
  synthStreamed: boolean;
  /** Multi-region panel for parallel agent streams (flat-mode research,
   *  verify, etc.). When set, agentHandler routes agent:* events into the
   *  panel instead of the shared agentStream / status line path. Cleared
   *  when the parallel section ends. */
  agentPanel: AgentPanel | null;
  /** Maps agentId → panel region index. Populated on agent:spawn while
   *  agentPanel is active. */
  agentRow: Map<number, number>;
  /** Short-term: flat-mode verify pool doesn't have its own panel yet, so
   *  its 3 concurrent agents would interleave into garbled output. When
   *  this flag is true (between verify:start and verify:done in flat
   *  mode), agentHandler skips all rendering; the user sees a single
   *  "Verifying…" status line instead. Remove when verify wires up its
   *  own AgentPanel. */
  verifyMuted: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewHandler = (ev: any) => void;
