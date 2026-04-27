/**
 * App state shape for the compare DAG TUI.
 *
 * Topology is fixed at startup (one `dag:topology` event seeds it), then
 * each node's runtime fields evolve with the agent event stream. The
 * reducer is pure — see reducer.ts.
 */

export type NodeStatus = 'pending' | 'running' | 'done';

export interface NodeRuntime {
  id: string;
  dependsOn: string[];
  /** Color slot — assigned in topo order so the same node always gets the same color. */
  colorIndex: number;
  status: NodeStatus;
  agentId?: number;
  startMs?: number;
  endMs?: number;
  /** Streaming buffer — last lines of agent:produce text, used as card body. */
  tail: string[];
  toolCalls: number;
  lastTool?: string;
  reportChars?: number;
  tokens: number;
  /** Total characters of streamed text (sum of agent:produce ev.text.length).
   *  Drives the live "N chars" stat in the card subheading. Persists past
   *  report; once done, we keep the running count so the user sees the
   *  same number that was visible during streaming. */
  charsProduced: number;
}

export interface Topology {
  /** Node ids grouped by topological layer (layer 0 = no deps). */
  layers: string[][];
  /** Edge list as [parentId, childId]. */
  edges: [string, string][];
}

export interface AppState {
  /** Wall-clock ms when `dag:topology` arrived; null until then. */
  t0Ms: number | null;
  /** Last update timestamp — used by elapsed display. */
  nowMs: number;
  /** All nodes keyed by id. Iteration follows insertion order = topological order. */
  nodes: Map<string, NodeRuntime>;
  /** Reverse lookup for routing agent:* events to their node. */
  agentToNode: Map<number, string>;
  topology: Topology | null;
  /** Synthesis result — populated when the unique sink node reports. */
  finalAnswer: string | null;
  /** Aggregate counts for the header. */
  totalTokens: number;
  totalToolCalls: number;
  /** KV pressure from the most recent agent:tick. Drives the header gauge. */
  kvCellsUsed: number;
  kvNCtx: number;
  /** Fatal error reported by the harness. When non-null, App renders a
   *  red error panel below the DAG canvas instead of the synthesis. */
  fatalError: { message: string; stack?: string } | null;
}

export const initialState: AppState = {
  t0Ms: null,
  nowMs: 0,
  nodes: new Map(),
  agentToNode: new Map(),
  topology: null,
  finalAnswer: null,
  totalTokens: 0,
  totalToolCalls: 0,
  kvCellsUsed: 0,
  kvNCtx: 0,
  fatalError: null,
};
