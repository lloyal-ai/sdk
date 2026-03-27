import * as fs from "node:fs";
import * as path from "node:path";
import type { Operation } from "effection";
import { Source, Trace, createToolkit } from "@lloyal-labs/lloyal-agents";
import type { Tool, PressureThresholds } from "@lloyal-labs/lloyal-agents";
import type { Chunk } from "../resources/types";
import type { SourceContext } from "./types";
import type { SearchProvider } from "../tools/types";
import { WebSearchTool } from "../tools/web-search";
import { FetchPageTool } from "../tools/fetch-page";
import { WebResearchTool } from "../tools/web-research";
import { chunkFetchedPages } from "./chunking";
import type { FetchedPage } from "./chunking";

// Re-export for backwards compatibility
export { chunkFetchedPages, type FetchedPage } from "./chunking";

// ── Task loader ──────────────────────────────────────────────────

function readTask(name: string): { system: string; user: string } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, `${name}.md`), "utf8")
    .trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

// ── BufferingFetchPage ───────────────────────────────────────────

/**
 * Thin wrapper over {@link FetchPageTool} that buffers fetched content
 * for post-research reranking via {@link WebSource.getChunks}.
 *
 * No scratchpad extraction. No content transformation. Just buffers
 * the raw text alongside returning the reranked result to the agent.
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

// ── WebSource ────────────────────────────────────────────────────

/**
 * Web-backed research source
 *
 * Agents search the web via {@link WebSearchTool} (returns titles, snippets,
 * URLs), then fetch promising pages via {@link FetchPageTool} (returns
 * reranked relevant chunks). Fetched content is buffered for post-research
 * passage reranking via {@link getChunks}.
 *
 * @category Rig
 */
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
  /** WebResearchTool overrides (applied on top of SourceContext) */
  research?: {
    /** Override tool name. @default "web_research" */
    name?: string;
    /** Override tool description */
    description?: string;
    /** Override pressure thresholds for inner research pool */
    pressure?: PressureThresholds;
  };
}

export class WebSource extends Source<SourceContext, Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: WebSearchTool;
  private _researchPrompt: { system: string; user: string };
  private _researchTool: WebResearchTool | null = null;
  private _researchOpts?: WebSourceOpts['research'];

  /** @inheritDoc */
  readonly name = "web";

  /**
   * @param provider - Search backend (e.g. {@link TavilyProvider}) for web_search calls
   * @param opts - Configuration for search, fetch, and research tools
   */
  constructor(provider: SearchProvider, opts?: WebSourceOpts) {
    super();
    this._researchPrompt = readTask("web-research");
    this._fetchPage = new BufferingFetchPage(this._buffer, opts?.fetch);
    this._webSearch = new WebSearchTool(provider, opts?.topN);
    this._researchOpts = opts?.research;
  }

  /** @inheritDoc */
  get researchTool(): Tool {
    if (!this._researchTool)
      throw new Error("WebSource: bind() must be called first");
    return this._researchTool;
  }

  /** @inheritDoc */
  get groundingTools(): Tool[] {
    return [this._webSearch, this._fetchPage];
  }

  /**
   * Wire reranker to FetchPageTool and build the research toolkit
   *
   * @inheritDoc
   */
  *bind(ctx: SourceContext): Operation<void> {
    this._buffer.length = 0;

    // Wire reranker to FetchPageTool for chunk scoring
    this._fetchPage.setReranker(ctx.reranker);

    const tw = yield* Trace.expect();
    tw.write({
      traceId: tw.nextId(),
      parentTraceId: null,
      ts: performance.now(),
      type: "source:bind",
      sourceName: this.name,
    });

    if (!this._researchTool) {
      const ro = this._researchOpts;
      const webResearch = new WebResearchTool({
        name: ro?.name ?? "web_research",
        description: ro?.description ??
          "Spawn parallel web research agents that search the web, fetch pages, and report findings.",
        systemPrompt: this._researchPrompt.system,
        reporterPrompt: ctx.reporterPrompt,
        maxTurns: ctx.maxTurns,
        trace: ctx.trace,
        pressure: ro?.pressure,
      });
      const toolkit = createToolkit([
        this._webSearch,
        this._fetchPage,
        ctx.reportTool,
        webResearch,
      ]);
      webResearch.setToolkit(toolkit);
      this._researchTool = webResearch;
    }
  }

  /** @inheritDoc */
  getChunks(): Chunk[] {
    return chunkFetchedPages(this._buffer);
  }
}
