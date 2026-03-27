import type { Operation } from "effection";
import { Source, Trace } from "@lloyal-labs/lloyal-agents";
import type { Tool, PressureThresholds } from "@lloyal-labs/lloyal-agents";
import type { Chunk } from "../resources/types";
import type { SearchProvider } from "../tools/types";
import type { Reranker } from "../tools/types";
import { WebSearchTool } from "../tools/web-search";
import { FetchPageTool } from "../tools/fetch-page";
import { chunkFetchedPages } from "./chunking";
import type { FetchedPage } from "./chunking";

// Re-export for backwards compatibility
export { chunkFetchedPages, type FetchedPage } from "./chunking";

// ── BufferingFetchPage ───────────────────────────────────────

/**
 * Thin wrapper over {@link FetchPageTool} that buffers fetched content
 * for post-use reranking via {@link WebSource.getChunks}.
 *
 * @category Rig
 */
class BufferingFetchPage extends FetchPageTool {
  private _buffer: FetchedPage[];

  constructor(buffer: FetchedPage[], opts?: { maxChars?: number; topK?: number; timeout?: number; tokenBudget?: number }) {
    super(opts);
    this._buffer = buffer;
  }

  *execute(args: { url: string; query?: string }): Operation<unknown> {
    const result = yield* super.execute(args);
    const r = result as Record<string, unknown>;
    if (
      typeof r?.content === "string" &&
      r.content !== "[Could not extract article content]"
    ) {
      this._buffer.push({
        url: (r.url as string) || args.url,
        title: (r.title as string) || "",
        text: r.content as string,
      });
    }
    return result;
  }
}

// ── WebSource ────────────────────────────────────────────────

/**
 * Configuration for {@link WebSource}.
 *
 * @category Rig
 */
export interface WebSourceOpts {
  /** Max search results returned to agents. @default 8 */
  topN?: number;
  /** FetchPageTool configuration */
  fetch?: {
    /** Max chars for full-content fallback (no reranker). @default 6000 */
    maxChars?: number;
    /** Top-K reranked chunks returned. @default 5 */
    topK?: number;
    /** Fetch timeout in ms. @default 10000 */
    timeout?: number;
    /** Reranker token budget for chunk selection. @default 2048 */
    tokenBudget?: number;
  };
}

/**
 * Web-backed data source
 *
 * Provides two tools: {@link WebSearchTool} (search the web) and
 * {@link FetchPageTool} (fetch and extract page content with optional
 * reranking). Fetched content is buffered for post-use reranking via
 * {@link getChunks}.
 *
 * No orchestration, no prompts, no node:fs. Works on Node and React
 * Native identically. Use {@link spawnAgents} from your harness to
 * orchestrate agents with these tools.
 *
 * @category Rig
 */
export class WebSource extends Source<{ reranker: Reranker }, Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: WebSearchTool;

  /** @inheritDoc */
  readonly name = "web";

  /**
   * @param provider - Search backend (e.g. {@link TavilyProvider}) for web_search calls
   * @param opts - Configuration for search and fetch tools
   */
  constructor(provider: SearchProvider, opts?: WebSourceOpts) {
    super();
    this._fetchPage = new BufferingFetchPage(this._buffer, opts?.fetch);
    this._webSearch = new WebSearchTool(provider, opts?.topN);
  }

  /** @inheritDoc */
  get tools(): Tool[] {
    return [this._webSearch, this._fetchPage];
  }

  /**
   * Wire reranker to FetchPageTool for chunk scoring.
   * @inheritDoc
   */
  *bind(ctx: { reranker: Reranker }): Operation<void> {
    this._buffer.length = 0;
    this._fetchPage.setReranker(ctx.reranker);

    const tw = yield* Trace.expect();
    tw.write({
      traceId: tw.nextId(),
      parentTraceId: null,
      ts: performance.now(),
      type: "source:bind",
      sourceName: this.name,
    });
  }

  /** @inheritDoc */
  getChunks(): Chunk[] {
    return chunkFetchedPages(this._buffer);
  }
}
