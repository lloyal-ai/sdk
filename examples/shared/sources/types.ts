import type { Branch } from '@lloyal-labs/sdk';
import type { Tool } from '@lloyal-labs/lloyal-agents';
import type { Reranker } from '../tools/types';

export interface SourceContext {
  parent: Branch;
  reranker: Reranker;
  reporterPrompt: { system: string; user: string };
  reportTool: Tool;
  maxTurns: number;
  trace: boolean;
}
