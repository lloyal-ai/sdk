export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

import type { PageStream } from './page-stream';

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewHandler = (ev: any) => void;
