export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

export interface ViewState {
  agentLabel: Map<number, string>;
  nextLabel: number;
  agentText: Map<number, string>;
  agentStatus: Map<number, { state: string; tokenCount: number; detail: string }>;
  agentParent: Map<number, number>;  // childId -> parentId (sub-agent tracking)
  rootToAgent: Map<number, number>;  // root branch handle -> calling agent id
  spawningQueue: number[];           // agent IDs currently in web_research/research tool calls
  traceQuery: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewHandler = (ev: any) => void;
