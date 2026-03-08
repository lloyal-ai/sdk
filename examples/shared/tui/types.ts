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
  traceQuery: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewHandler = (ev: any) => void;
