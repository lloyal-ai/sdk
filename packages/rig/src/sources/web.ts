import * as fs from "node:fs";
import * as path from "node:path";
import type { Operation } from "effection";
import { Source, Trace, createToolkit } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
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

  constructor(buffer: FetchedPage[], maxChars?: number) {
    super(maxChars);
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
export class WebSource extends Source<SourceContext, Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: WebSearchTool;
  private _researchPrompt: { system: string; user: string };
  private _researchTool: WebResearchTool | null = null;

  /** @inheritDoc */
  readonly name = "web";

  /**
   * @param provider - Search backend (e.g. {@link TavilyProvider}) for web_search calls
   */
  constructor(provider: SearchProvider, opts?: { topN?: number }) {
    super();
    this._researchPrompt = readTask("web-research");
    this._fetchPage = new BufferingFetchPage(this._buffer);
    this._webSearch = new WebSearchTool(provider, opts?.topN);
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
      const webResearch = new WebResearchTool({
        name: "web_research",
        description:
          "Spawn parallel web research agents that search the web, fetch pages, and report findings.",
        systemPrompt: this._researchPrompt.system,
        reporterPrompt: ctx.reporterPrompt,
        maxTurns: ctx.maxTurns,
        trace: ctx.trace,
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
