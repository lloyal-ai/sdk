/**
 * A loaded document available for search, read, and grep operations
 *
 * Represents a single file (typically Markdown) loaded into memory.
 * Resources are chunked into {@link Chunk} instances for reranking.
 *
 * @category Rig
 */
export interface Resource {
  /** File name (basename, not full path) used as the resource identifier */
  name: string;
  /** Full text content of the file */
  content: string;
}

/**
 * A scored passage within a {@link Resource}, used for reranking and retrieval
 *
 * Chunks are produced by {@link chunkResources} (section-based for Markdown)
 * or {@link chunkFetchedPages} (paragraph-based for web content). The
 * {@link tokens} array is populated lazily by {@link Reranker.tokenizeChunks}
 * before scoring.
 *
 * @category Rig
 */
export interface Chunk {
  /** Resource identifier (file name or URL) this chunk belongs to */
  resource: string;
  /** Section heading or auto-generated preview used as a label */
  heading: string;
  /** Raw text content of the chunk */
  text: string;
  /** Pre-tokenized representation for the reranker — empty until {@link Reranker.tokenizeChunks} runs */
  tokens: number[];
  /** First line number (1-based) in the source resource */
  startLine: number;
  /** Last line number (1-based) in the source resource */
  endLine: number;
}
