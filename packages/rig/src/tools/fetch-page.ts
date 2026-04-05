import { call } from "effection";
import type { Operation } from "effection";
import { Tool, Trace } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema, ToolContext } from "@lloyal-labs/lloyal-agents";
import { chunkHtml } from "../sources/chunking";
import type { Chunk } from "../resources/types";
import type { Reranker, ScoredChunk } from "./types";

/** Select top-K scored chunks within a token budget. */
function selectTopChunks(
  scored: ScoredChunk[],
  chunks: Chunk[],
  topK: number,
  tokenBudget: number,
): Array<{ text: string; heading: string; score: number }> {
  const selected: Array<{ text: string; heading: string; score: number }> = [];
  let tokenTotal = 0;

  for (const sc of scored.slice(0, topK)) {
    const chunk = chunks.find(
      (c) => c.resource === sc.file && c.startLine === sc.startLine,
    );
    if (!chunk?.text) continue;

    const chunkTokens = chunk.tokens.length || Math.ceil(chunk.text.length / 4);

    if (tokenTotal + chunkTokens > tokenBudget) {
      // First chunk exceeds budget — truncate on paragraph boundary
      if (selected.length === 0) {
        const charLimit = tokenBudget * 4;
        let truncated = chunk.text.slice(0, charLimit);
        const lastBreak = Math.max(
          truncated.lastIndexOf("\n\n"),
          truncated.lastIndexOf(". "),
        );
        if (lastBreak > charLimit * 0.4)
          truncated = truncated.slice(0, lastBreak + 1);
        selected.push({
          text: truncated + "\n\n[truncated]",
          heading: sc.heading,
          score: sc.score,
        });
      }
      break;
    }

    selected.push({ text: chunk.text, heading: sc.heading, score: sc.score });
    tokenTotal += chunkTokens;
  }

  return selected;
}

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
  readonly name = "fetch_page";
  readonly description =
    "Fetch a web page and extract its article content. Returns readable text with title and excerpt. Use to read search results or follow links discovered in pages. Pass a query to get only the most relevant sections.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      query: {
        type: "string",
        description:
          "What to look for in this page (optional — improves relevance of returned content)",
      },
    },
    required: ["url"],
  };

  private _maxChars: number;
  private _reranker: Reranker | null = null;
  private _topK: number;
  private _timeout: number;
  private _tokenBudget: number;

  constructor(opts?: {
    maxChars?: number;
    topK?: number;
    timeout?: number;
    tokenBudget?: number;
  }) {
    super();
    this._maxChars = opts?.maxChars ?? 6000;
    this._topK = opts?.topK ?? 5;
    this._timeout = opts?.timeout ?? 10_000;
    this._tokenBudget = opts?.tokenBudget ?? 2048;
  }

  /** Inject reranker for chunk scoring. Call from Source.bind(). */
  setReranker(reranker: Reranker): void {
    this._reranker = reranker;
  }

  *execute(
    args: { url: string; query?: string },
    context?: ToolContext,
  ): Operation<unknown> {
    const url = args.url?.trim();
    if (!url) return { error: "url must not be empty" };

    // Early reject PDF URLs
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.endsWith(".pdf") ||
      lowerUrl.includes(".pdf?") ||
      lowerUrl.includes(".pdf#")
    ) {
      return {
        error:
          "PDF documents cannot be extracted. Try searching for an HTML version of this content.",
        url,
      };
    }

    const maxChars = this._maxChars;
    const reranker = this._reranker;
    const topK = this._topK;
    const timeout = this._timeout;
    const tokenBudget = this._tokenBudget;

    // Step 1: Fetch + readability (async)
    const fetched = yield* call(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; lloyal-agents/1.0)",
          },
          signal: controller.signal,
        });
      } catch (err) {
        return {
          error: `Fetch failed: ${(err as Error).message}`,
          url,
        } as const;
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok)
        return { error: `HTTP ${res.status} ${res.statusText}`, url } as const;

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/pdf")) {
        return {
          error:
            "PDF documents cannot be extracted. Try searching for an HTML version of this content.",
          url,
        } as const;
      }

      const html = await res.text();

      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);

      if (!document || !document.documentElement) {
        return { url, content: "[Could not parse HTML]" } as const;
      }

      const { Readability } = await import("@mozilla/readability");
      const article = new Readability(document).parse();

      if (!article)
        return { url, content: "[Could not extract article content]" } as const;

      return {
        url,
        title: article.title ?? "",
        content: article.textContent ?? "",
        articleHtml: article.content ?? "",
        excerpt: article.excerpt ?? "",
      } as const;
    });

    // Early return on error or no article
    if ("error" in fetched) return fetched;
    if (!fetched.articleHtml) {
      let content = fetched.content;
      if (content.length > maxChars)
        content = content.slice(0, maxChars) + "\n\n[truncated]";
      return {
        url: fetched.url,
        title: fetched.title,
        content,
        excerpt: fetched.excerpt,
      };
    }

    // Step 2: Reranker path — chunk HTML structurally, score, return top-K
    if (reranker && args.query) {
      const chunks = yield* call(() =>
        chunkHtml(fetched.articleHtml, url, fetched.title),
      );

      // Write chunks to trace for replay sufficiency
      let tw;
      try {
        tw = yield* Trace.expect();
      } catch {
        /* no trace context */
      }
      const rerankT0 = performance.now();
      if (tw) {
        tw.write({
          traceId: tw.nextId(),
          parentTraceId: null,
          ts: rerankT0,
          type: "rerank:start",
          query: args.query,
          chunkCount: chunks.length,
          tool: "fetch_page",
          url,
          chunks: chunks.map((c) => ({
            heading: c.heading,
            textLength: c.text.length,
            startLine: c.startLine,
          })),
        });
      }

      if (chunks.length > 0) {
        yield* call(() => reranker.tokenizeChunks(chunks));

        // Score chunks against agent's local query
        let scored: ScoredChunk[] = [];
        yield* call(async () => {
          for await (const batch of reranker.score(args.query!, chunks)) {
            if (context?.onProgress)
              context.onProgress({ filled: batch.filled, total: batch.total });
            scored = batch.results;
          }
        });

        // Explore mode (default): agent-local scoring only. The agent chose
        // this page — content scored against what it asked for. Filtering
        // against original query removes bridging content that produces
        // hypothesis greps. alsoOnPage provides discovery signals instead.
        //
        // Exploit mode (!explore): dual scoring via scoreRelevanceBatch.
        if (!context?.explore && context?.scorer && scored.length > 0) {
          type ScoredWithOriginal = ScoredChunk & { _toolQueryScore: number };
          const chunkTexts = scored.map((sc) => {
            const chunk = chunks.find(
              (c) => c.resource === sc.file && c.startLine === sc.startLine,
            );
            return chunk?.text ?? "";
          });
          const combinedScores: number[] = yield* call(() =>
            context.scorer!.scoreRelevanceBatch(chunkTexts, args.query!),
          );
          const reordered: ScoredWithOriginal[] = scored
            .map((sc, i) => ({
              ...sc,
              score: combinedScores[i],
              _toolQueryScore: sc.score,
            }))
            .sort((a, b) => b.score - a.score);
          scored = reordered;

          if (tw) {
            tw.write({
              traceId: tw.nextId(),
              parentTraceId: null,
              ts: performance.now(),
              type: "entailment:content:exploit",
              tool: "fetch_page",
              pressure: {
                percentAvailable: context.pressurePercentAvailable ?? -1,
                remaining: -1,
                nCtx: -1,
              },
              chunks: reordered.slice(0, 5).map((sc) => ({
                heading: sc.heading,
                toolQueryScore: sc._toolQueryScore,
                combinedScore: sc.score,
              })),
            });
          }
        }

        // Select top-K within token budget (tokens populated by tokenizeChunks)
        const topChunks = selectTopChunks(scored, chunks, topK, tokenBudget);

        if (tw) {
          tw.write({
            traceId: tw.nextId(),
            parentTraceId: null,
            ts: performance.now(),
            type: "rerank:end",
            topResults: topChunks.map((c) => ({
              file: url,
              heading: c.heading,
              score: c.score,
              textPreview: c.text.slice(0, 200),
            })),
            selectedPassageCount: topChunks.length,
            totalChars: topChunks.reduce((sum, c) => sum + c.text.length, 0),
            durationMs: performance.now() - rerankT0,
            tool: "fetch_page",
            url,
          });
        }

        if (topChunks.length > 0) {
          // Discovery signal: headings of chunks that didn't make the cut.
          // Lightweight (~50 tokens) but gives the agent topics to explore.
          const selectedHeadings = new Set(topChunks.map((c) => c.heading));
          const alsoOnPage = scored
            .filter((sc) => !selectedHeadings.has(sc.heading))
            .map((sc) => sc.heading)
            .filter((h, i, arr) => arr.indexOf(h) === i);

          return {
            url,
            title: fetched.title,
            content: topChunks.map((c) => c.text).join("\n\n---\n\n"),
            chunks: topChunks.length,
            ...(alsoOnPage.length > 0 ? { alsoOnPage } : {}),
          };
        }
      }
    }

    // Fallback: return full content, truncated
    let content = fetched.content;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[truncated]";
    }
    return { url, title: fetched.title, content, excerpt: fetched.excerpt };
  }
}
