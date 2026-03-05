import type { Chunk } from '../resources/types';

export interface ScoredChunk {
  file: string;
  heading: string;
  score: number;
  startLine: number;
  endLine: number;
}

export interface ScoredResult {
  results: ScoredChunk[];
  filled: number;
  total: number;
}

export interface Reranker {
  score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult>;
  tokenizeChunks(chunks: Chunk[]): Promise<void>;
  dispose(): void;
}
