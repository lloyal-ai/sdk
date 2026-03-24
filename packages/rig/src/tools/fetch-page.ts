import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import { chunkHtml } from '../sources/chunking';
import type { Reranker, ScoredChunk } from './types';

/**
 * Fetch a web page and extract readable article content.
 *
 * Uses the Fetch API with a 10-second timeout, then extracts the
 * article body via linkedom + Readability.
 *
 * When a reranker is set (via {@link setReranker}) and the agent provides
 * a `query` argument, the article HTML is structurally chunked on heading
 * boundaries (same pattern as corpus `parseMarkdown`) and scored against
 * the query. Only the top-K most relevant verbatim chunks are returned —
 * reducing KV pressure without lossy summarization. The reranker runs on
 * its own `llama_context`, consuming zero inference KV.
 *
 * Without a reranker or query, returns the full content truncated to
 * `maxChars` (default 6000). Fully backward compatible.
 *
 * @category Rig
 */
export class FetchPageTool extends Tool<{ url: string; query?: string }> {
  readonly name = 'fetch_page';
  readonly description = 'Fetch a web page and extract its article content. Returns readable text with title and excerpt. Use to read search results or follow links discovered in pages. Pass a query to get only the most relevant sections.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      query: { type: 'string', description: 'What to look for in this page (optional — improves relevance of returned content)' },
    },
    required: ['url'],
  };

  private _maxChars: number;
  private _reranker: Reranker | null = null;
  private _topK: number;

  constructor(maxChars = 6000, topK = 5) {
    super();
    this._maxChars = maxChars;
    this._topK = topK;
  }

  /** Inject reranker for chunk scoring. Call from Source.bind(). */
  setReranker(reranker: Reranker): void {
    this._reranker = reranker;
  }

  *execute(args: { url: string; query?: string }, context?: ToolContext): Operation<unknown> {
    const url = args.url?.trim();
    if (!url) return { error: 'url must not be empty' };

    // Early reject PDF URLs
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?') || lowerUrl.includes('.pdf#')) {
      return { error: 'PDF documents cannot be extracted. Try searching for an HTML version of this content.', url };
    }

    const maxChars = this._maxChars;
    const reranker = this._reranker;
    const topK = this._topK;

    // Step 1: Fetch + readability (async)
    const fetched = yield* call(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lloyal-agents/1.0)' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return { error: `Fetch failed: ${(err as Error).message}`, url } as const;
      }

      if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}`, url } as const;

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/pdf')) {
        return { error: 'PDF documents cannot be extracted. Try searching for an HTML version of this content.', url } as const;
      }

      const html = await res.text();

      const { parseHTML } = await import('linkedom');
      const { document } = parseHTML(html);

      const { Readability } = await import('@mozilla/readability');
      const article = new Readability(document).parse();

      if (!article) return { url, content: '[Could not extract article content]' } as const;

      return {
        url,
        title: article.title ?? '',
        content: article.textContent ?? '',
        articleHtml: article.content ?? '',
        excerpt: article.excerpt ?? '',
      } as const;
    });

    // Early return on error or no article
    if ('error' in fetched) return fetched;
    if (!fetched.articleHtml) {
      let content = fetched.content;
      if (content.length > maxChars) content = content.slice(0, maxChars) + '\n\n[truncated]';
      return { url: fetched.url, title: fetched.title, content, excerpt: fetched.excerpt };
    }

    // Step 2: Reranker path — chunk HTML structurally, score, return top-K
    if (reranker && args.query) {
      const chunks = yield* call(() => chunkHtml(fetched.articleHtml, url, fetched.title));

      // Write chunks to trace for replay sufficiency
      let tw;
      try { tw = yield* Trace.expect(); } catch { /* no trace context */ }
      const rerankT0 = performance.now();
      if (tw) {
        tw.write({
          traceId: tw.nextId(),
          parentTraceId: null,
          ts: rerankT0,
          type: 'rerank:start',
          query: args.query,
          chunkCount: chunks.length,
          tool: 'fetch_page',
          url,
          chunks: chunks.map(c => ({ heading: c.heading, textLength: c.text.length, startLine: c.startLine })),
        });
      }

      if (chunks.length > 0) {
        yield* call(() => reranker.tokenizeChunks(chunks));

        let scored: ScoredChunk[] = [];
        yield* call(async () => {
          for await (const batch of reranker.score(args.query!, chunks)) {
            if (context?.onProgress) context.onProgress({ filled: batch.filled, total: batch.total });
            scored = batch.results;
          }
        });

        // Select top-K within token budget (tokens populated by tokenizeChunks)
        const TOKEN_BUDGET = 2048;
        const topChunks: Array<{ text: string; heading: string; score: number }> = [];
        let tokenTotal = 0;
        for (const sc of scored.slice(0, topK)) {
          const chunk = chunks.find(c => c.resource === sc.file && c.startLine === sc.startLine);
          if (!chunk?.text) continue;
          const chunkTokens = chunk.tokens.length || Math.ceil(chunk.text.length / 4);
          if (topChunks.length > 0 && tokenTotal + chunkTokens > TOKEN_BUDGET) break;
          topChunks.push({ text: chunk.text, heading: sc.heading, score: sc.score });
          tokenTotal += chunkTokens;
        }

        if (tw) {
          tw.write({
            traceId: tw.nextId(),
            parentTraceId: null,
            ts: performance.now(),
            type: 'rerank:end',
            topResults: topChunks.map(c => ({
              file: url,
              heading: c.heading,
              score: c.score,
              textPreview: c.text.slice(0, 200),
            })),
            selectedPassageCount: topChunks.length,
            totalChars: topChunks.reduce((sum, c) => sum + c.text.length, 0),
            durationMs: performance.now() - rerankT0,
            tool: 'fetch_page',
            url,
          });
        }

        if (topChunks.length > 0) {
          return {
            url,
            title: fetched.title,
            content: topChunks.map(c => c.text).join('\n\n---\n\n'),
            chunks: topChunks.length,
          };
        }
      }
    }

    // Fallback: return full content, truncated
    let content = fetched.content;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '\n\n[truncated]';
    }
    return { url, title: fetched.title, content, excerpt: fetched.excerpt };
  }
}
