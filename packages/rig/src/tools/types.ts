import type { Chunk } from '../resources/types';

/**
 * A single chunk scored by the {@link Reranker} against a query
 *
 * Returned as part of {@link ScoredResult} from reranker scoring.
 * Contains the file location, heading, relevance score, and line
 * range so downstream tools (e.g. {@link ReadFileTool}) can fetch
 * the exact content.
 *
 * @category Rig
 */
export interface ScoredChunk {
  /** Source filename containing the chunk */
  file: string;
  /** Leaf section heading (e.g. "Recovery loop") */
  heading: string;
  /** Hierarchical section path (e.g. "Agents > Lifecycle > Recovery loop"). Empty for web chunks. */
  section: string;
  /** First ~200 chars of chunk text — gives agents content at search time */
  snippet: string;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Start line in the source file (1-indexed) */
  startLine: number;
  /** End line in the source file (1-indexed) */
  endLine: number;
}

/**
 * Progressive reranker output emitted during scoring
 *
 * Streamed from {@link Reranker.score} as an async iterable,
 * allowing callers to report progress while scoring is in flight.
 *
 * @category Rig
 */
export interface ScoredResult {
  /** Scored chunks accumulated so far, ordered by relevance */
  results: ScoredChunk[];
  /** Number of chunks scored so far */
  filled: number;
  /** Total number of chunks to score */
  total: number;
}

/**
 * Embedding-based reranker for scoring corpus chunks against a query
 *
 * Implementations tokenize chunks up front via {@link tokenizeChunks},
 * then stream progressive results from {@link score}. Used by
 * {@link SearchTool} to rank knowledge-base passages.
 *
 * @category Rig
 */
export interface Reranker {
  /** Score chunks against a query, streaming progressive results */
  score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult>;
  /** Score raw text strings against a query in one batch. Returns scores (0–1) in input order. */
  scoreBatch(query: string, texts: string[]): Promise<number[]>;
  /** Pre-tokenize chunks for subsequent scoring calls */
  tokenizeChunks(chunks: Chunk[]): Promise<void>;
  /** Release reranker resources */
  dispose(): void;
}

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
