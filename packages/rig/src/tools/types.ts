/**
 * Rig-resident tool adapter types.
 *
 * The reranker abstraction (`Reranker`, `ScoredResult`, `ScoredChunk`)
 * moved to `@lloyal-labs/lloyal-agents` in RFC §6.3 alongside `Chunk`
 * and `Resource` — abstract types live in agents, concrete factories
 * (`createReranker`) and chunking utilities (`chunkResources`,
 * `chunkHtml`, `chunkFetchedPages`) stay in rig. Re-exported here for
 * rig-internal callers; new code should import from
 * `@lloyal-labs/lloyal-agents`.
 *
 * `SearchProvider` + `SearchResult` are HTTP-adapter shapes used only
 * by rig's keyless / Tavily provider; they stay rig-resident.
 *
 * @packageDocumentation
 * @category Rig
 */

export type { Reranker, ScoredChunk, ScoredResult } from '@lloyal-labs/lloyal-agents';

// ── Web search adapter ──────────────────────────────────

/**
 * A single result from a {@link SearchProvider} web search
 *
 * @category Rig
 */
export interface SearchResult {
  /** Page title */
  title: string;
  /** Page URL */
  url: string;
  /** Excerpt or snippet from the page content */
  snippet: string;
  /** Full page content — markdown when provider supports it, plain text otherwise */
  rawContent?: string;
  /** Provider-side relevance score (higher = more relevant) */
  score?: number;
}

/**
 * Adapter interface for web search backends
 *
 * Implement this to plug in a search provider (e.g. Tavily, Brave,
 * SerpAPI). Pass the implementation to {@link WebSearchTool}.
 *
 * @see {@link TavilyProvider} for the default implementation
 *
 * @category Rig
 */
export interface SearchProvider {
  /** Execute a web search and return ranked results */
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  /** When true, rawContent on results is markdown with heading structure suitable for parseMarkdown chunking */
  readonly returnsFullContentMarkdown: boolean;
}
