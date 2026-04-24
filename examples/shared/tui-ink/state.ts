/**
 * Ink TUI — AppState shape.
 *
 * Populated by reducer.ts from StepEvent + AgentEvent. Components render
 * from this state and nothing else; no ambient ANSI, no side-effect logging.
 *
 * Layout model: each research agent owns a vertical `timeline` of items
 * (think blocks, tool calls, tool results, reports). Flat mode renders those
 * timelines as side-by-side columns; chain mode stacks them vertically.
 */

import type { Config, ConfigOrigin } from './config';

export type Phase = 'idle' | 'query' | 'plan' | 'research' | 'synth' | 'verify' | 'eval' | 'done';

/** Drives which top-level view the App renders. Distinct from `phase` —
 *  `phase` tracks the workflow progress; `uiPhase` tracks what the user
 *  currently interacts with. */
export type UiPhase =
  | 'boot'           // before config:loaded
  | 'composer'       // query input, source/mode editing
  | 'planning'       // planner running, spinner
  | 'plan_review'    // plan dialog visible, accept/edit/change-mode
  | 'clarifying'     // planner asked questions; composer takes the answer
  | 'research'       // column layout streaming
  | 'done';          // research complete, results visible, composer below

/** User-facing reasoning mode. 'deep' == chain-shaped orchestration
 *  (sequential tasks that build on each other); 'flat' == parallel-shaped
 *  orchestration (orthogonal tasks running concurrently). One encoding
 *  everywhere — no 'chain' alias. */
export type Mode = 'flat' | 'deep';

/** Per-agent chronological stream item. Column.tsx renders one component
 *  per kind. `live: true` on a think item means its body is currently
 *  streaming tokens and should render with a `▎` cursor. */
export type TimelineItem =
  | {
      kind: 'think';
      id: number;
      title: string;
      body: string;
      live: boolean;
      openedAt: number;
      closedAt: number | null;
    }
  | {
      kind: 'tool_call';
      id: number;
      tool: string;
      argsSummary: string;
    }
  | {
      kind: 'tool_result';
      id: number;
      tool: string;
      /** Optional back-reference to the tool_call id this result pairs with.
       *  Column renderer indents results under their matching call. */
      callId: number | null;
      byteLength: number;
      preview: string | null;
      hosts: string[];
      resultCount: number | null;
    }
  | {
      kind: 'report';
      id: number;
      body: string;
      tokenCount: number;
    };

export interface AgentRuntime {
  id: number;
  label: string;                          // "A0", "A1", …
  phase: 'idle' | 'thinking' | 'content' | 'tool' | 'done';
  tokenCount: number;
  toolCallCount: number;
  /** Research task index this agent was spawned for. Null for synth/verify/eval. */
  taskIndex: number | null;
  /** Short task description, used in the column header when present. */
  taskDescription: string | null;
  /** Chain-mode dependency hint ("builds on Task 1"), shown in header. */
  dependencyHint: string | null;
  /** Id of the currently-live think item in `timeline`, or null. */
  currentThinkId: number | null;
  /** Id of the most recent tool_call, paired with its tool_result when one lands. */
  pendingToolCallId: number | null;
  /** Live post-</think> token buffer. Tokens stream into this between
   *  closing a think block and the next agent:tool_call / agent:report
   *  (the model is writing tool-call JSON — report body lives inside).
   *  Cleared on tool_call / report (those fire structured items instead). */
  contentBuffer: string;
  /** Per-agent chronological stream. */
  timeline: TimelineItem[];
}

export interface Pressure {
  pct: number;
  cellsUsed: number;
  nCtx: number;
}

export interface SynthState {
  open: boolean;
  buffer: string;
  done: boolean;
  stats: { tokens: number; toolCalls: number; ppl: number; timeMs: number } | null;
}

export interface VerifyState {
  active: boolean;
  count: number;
  done: boolean;
  timeMs: number | null;
}

export interface EvalState {
  done: boolean;
  converged: boolean | null;
  sampleCount: number;
  tokenCount: number;
  timeMs: number;
}

export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

export interface Toast {
  message: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  /** Monotonic id so the view can animate/dismiss on change. */
  id: number;
}

export interface AppState {
  query: string;
  warm: boolean;
  /** Top-level view state — drives App.tsx branching. */
  uiPhase: UiPhase;
  /** Workflow phase — drives footer label, narrative visibility, etc. */
  phase: Phase;
  mode: Mode | null;
  plan: {
    intent: string;
    tasks: { description: string }[];
    clarifyQuestions: string[];
    tokenCount: number;
    timeMs: number;
  } | null;
  agents: Map<number, AgentRuntime>;
  /** Research agents in spawn order — drives the column layout. */
  researchAgentIds: number[];
  /** Aggregate source count across all agents' tool_results (deduplicated
   *  by host within a result). Rendered in the footer. */
  sourceCount: number;
  synth: SynthState;
  verify: VerifyState;
  evalState: EvalState | null;
  answer: string | null;
  pressure: Pressure | null;
  timings: OpTiming[];
  startedAt: number;
  /** Accumulated milliseconds of pipeline-active time across the current
   *  query's lifecycle (planning + research + synth + verify + eval).
   *  Excludes plan-review dwell and composer idle. */
  pipelineElapsedMs: number;
  /** Timestamp (ms) of when the pipeline-active phase last resumed. Null
   *  while paused (plan_review, composer, done). Live elapsed = paused
   *  accumulator + (now - resume) while non-null. */
  pipelineResumedAt: number | null;
  /** Monotonic counters used by the reducer to assign stable ids. */
  nextTimelineId: number;
  nextLabelIdx: number;
  /** Set by spine:task in chain mode; consumed by the next research agent:spawn. */
  pendingTaskIndex: number | null;
  /** Set by spine:task; descriptor copied onto the next spawned agent. */
  pendingTaskDescription: string | null;
  /** Count of research-phase spawns seen (flat mode uses this to assign taskIndex). */
  researchSpawnCount: number;
  /** Merged config from CLI > env > file > default. Null until config:loaded. */
  config: Config | null;
  /** Per-field origin — used to flag secrets as `(env)` in the composer. */
  configOrigin: ConfigOrigin | null;
  /** Most recent transient toast (e.g. "saved → harness.json"). */
  toast: Toast | null;
  /** Prefill for the composer when arriving from `edit_plan`. */
  composerPrefill: string;
  /** Set when the planner asks clarifying questions. Drives the clarifying
   *  UI (questions stay visible above the composer while the user types
   *  the answer) and carries the original query so main.ts can re-run the
   *  planner with the Q&A as context. */
  clarifyContext: {
    originalQuery: string;
    questions: string[];
  } | null;
  nextToastId: number;
}

export const initialState: AppState = {
  query: '',
  warm: false,
  uiPhase: 'boot',
  phase: 'idle',
  mode: null,
  plan: null,
  agents: new Map(),
  researchAgentIds: [],
  sourceCount: 0,
  synth: { open: false, buffer: '', done: false, stats: null },
  verify: { active: false, count: 0, done: false, timeMs: null },
  evalState: null,
  answer: null,
  pressure: null,
  timings: [],
  startedAt: Date.now(),
  pipelineElapsedMs: 0,
  pipelineResumedAt: null,
  nextTimelineId: 0,
  nextLabelIdx: 0,
  pendingTaskIndex: null,
  pendingTaskDescription: null,
  researchSpawnCount: 0,
  config: null,
  configOrigin: null,
  toast: null,
  composerPrefill: '',
  clarifyContext: null,
  nextToastId: 0,
};
