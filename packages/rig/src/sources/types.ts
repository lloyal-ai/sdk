import type { Tool } from '@lloyal-labs/lloyal-agents';
import type { Reranker } from '../tools/types';

/**
 * Runtime context passed to {@link Source.bind} during pipeline setup
 *
 * Carries shared dependencies that are not available at source construction
 * time — the reranker instance, reporter prompt/tool, and pipeline-level
 * configuration. Each source receives the same context so research and
 * grounding tools share a consistent environment.
 *
 * @category Rig
 */
export interface SourceContext {
  /** Reranker instance used by corpus sources to tokenize chunks and score results */
  reranker: Reranker;
  /** System/user prompt pair for the report-writing pass inside research tools */
  reporterPrompt: { system: string; user: string };
  /** Shared report tool instance injected into every source's research toolkit */
  reportTool: Tool;
  /** Maximum tool-use turns for research sub-agents before forced termination */
  maxTurns: number;
  /** Whether to emit structured trace events during research execution */
  trace: boolean;
}
