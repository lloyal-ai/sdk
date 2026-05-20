/**
 * Chunk / Reranker abstraction types.
 *
 * These interfaces live in `@lloyal-labs/lloyal-agents` (not rig) so that
 * agent-pool code, app factories, and harness contexts can refer to a
 * common Reranker shape without depending on rig's concrete chunking
 * implementation. Concrete chunking utilities (`chunkResources`,
 * `chunkHtml`, `chunkFetchedPages`) and the cross-encoder-backed
 * `createReranker(...)` factory live in `@lloyal-labs/rig`.
 *
 * The pattern mirrors `Source` and `Tool`: abstract type in agents,
 * concrete subclasses/factories in rig.
 *
 * @packageDocumentation
 * @category Contract
 */

/**
 * A loaded document available for search, read, and grep operations.
 *
 * Represents a single file (typically Markdown) loaded into memory.
 * Resources are chunked into {@link Chunk} instances for reranking.
 */
export interface Resource {
  /** File name (basename, not full path) used as the resource identifier. */
  name: string;
  /** Full text content of the file. */
  content: string;
}

/**
 * A scored passage within a {@link Resource}, used for reranking and retrieval.
 *
 * The `tokens` array is populated lazily by {@link Reranker.tokenizeChunks}
 * before scoring. Once tokenized, a chunk is bound to that reranker's
 * cross-encoder vocabulary — re-binding requires re-tokenization.
 */
export interface Chunk {
  /** Resource identifier (file name or URL) this chunk belongs to. */
  resource: string;
  /** Leaf section heading (e.g. "Recovery loop"). */
  heading: string;
  /** Hierarchical section path (e.g. "Agents > Lifecycle > Recovery loop"). Empty for web chunks. */
  section: string;
  /** Raw text content of the chunk. */
  text: string;
  /** Pre-tokenized representation for the reranker — empty until {@link Reranker.tokenizeChunks} runs. */
  tokens: number[];
  /** First line number (1-based) in the source resource. */
  startLine: number;
  /** Last line number (1-based) in the source resource. */
  endLine: number;
}

/**
 * A single chunk scored by the {@link Reranker} against a query.
 */
export interface ScoredChunk {
  /** Source filename containing the chunk. */
  file: string;
  /** Leaf section heading (e.g. "Recovery loop"). */
  heading: string;
  /** Hierarchical section path (e.g. "Agents > Lifecycle > Recovery loop"). Empty for web chunks. */
  section: string;
  /** First ~200 chars of chunk text — gives agents content at search time. */
  snippet: string;
  /** Relevance score (higher = more relevant). */
  score: number;
  /** Start line in the source file (1-indexed). */
  startLine: number;
  /** End line in the source file (1-indexed). */
  endLine: number;
}

/**
 * Progressive reranker output emitted during scoring.
 *
 * Streamed from {@link Reranker.score} as an async iterable, allowing
 * callers to report progress while scoring is in flight.
 */
export interface ScoredResult {
  /** Scored chunks accumulated so far, ordered by relevance. */
  results: ScoredChunk[];
  /** Number of chunks scored so far. */
  filled: number;
  /** Total number of chunks to score. */
  total: number;
}

/**
 * Cross-encoder reranker for scoring corpus chunks against a query.
 *
 * Apps obtain the harness-wide reranker via `RerankerCtx.expect()` at
 * factory time — `source.bind({reranker})` is no longer the mechanism.
 * Implementations tokenize chunks up front via {@link tokenizeChunks},
 * then stream progressive results from {@link score}.
 */
export interface Reranker {
  /** Score chunks against a query, streaming progressive results. */
  score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult>;
  /** Score raw text strings against a query in one batch. Returns scores (0–1) in input order. */
  scoreBatch(query: string, texts: string[]): Promise<number[]>;
  /** Pre-tokenize chunks for subsequent scoring calls. */
  tokenizeChunks(chunks: Chunk[]): Promise<void>;
  /** Release reranker resources. */
  dispose(): void;
}
