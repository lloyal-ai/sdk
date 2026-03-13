import type { Branch } from '@lloyal-labs/sdk';
import type { Reranker } from '../tools/types';

export interface SourceContext {
  parent: Branch;
  reranker: Reranker;
}
