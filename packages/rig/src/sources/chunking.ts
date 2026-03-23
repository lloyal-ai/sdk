/**
 * Pure-TS chunking utilities for web page content
 *
 * Extracted from web.ts so they can be imported without pulling in
 * node:fs, linkedom, or @mozilla/readability.
 *
 * @packageDocumentation
 * @category Rig
 */

import type { Chunk } from '../resources/types';

/**
 * Raw page content buffered during web research for post-research reranking
 *
 * Populated by {@link BufferingFetchPage} as agents fetch pages. After
 * the research phase ends, buffered pages are converted to {@link Chunk}
 * instances via {@link chunkFetchedPages} for reranker scoring.
 *
 * @category Rig
 */
export interface FetchedPage {
  /** Resolved URL of the fetched page */
  url: string;
  /** Page title extracted during fetch (may be empty) */
  title: string;
  /** Full extracted article text */
  text: string;
}

/**
 * Convert buffered web pages into {@link Chunk} instances for reranking
 *
 * Splits each page's text on blank-line paragraph boundaries, filtering
 * paragraphs shorter than 40 characters. If no paragraphs survive the
 * filter, the full text is emitted as a single chunk (if long enough).
 *
 * @param pages - Buffered pages from web research
 * @returns Flat array of paragraph-level chunks with `tokens` arrays left empty for later tokenization
 *
 * @category Rig
 */
export function chunkFetchedPages(pages: FetchedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    const paragraphs = page.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40);

    if (paragraphs.length === 0) {
      if (page.text.trim().length > 40) {
        chunks.push({
          resource: page.url,
          heading: page.title || page.url,
          text: page.text.trim(),
          tokens: [],
          startLine: 1,
          endLine: 1,
        });
      }
      continue;
    }

    for (let i = 0; i < paragraphs.length; i++) {
      chunks.push({
        resource: page.url,
        heading: page.title || page.url,
        text: paragraphs[i],
        tokens: [],
        startLine: i + 1,
        endLine: i + 1,
      });
    }
  }
  return chunks;
}
