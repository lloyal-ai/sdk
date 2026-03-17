import * as fs from "node:fs";
import * as path from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import { Source } from "@lloyal-labs/lloyal-agents";
import { Tool, Ctx, Trace, ScratchpadParent, generate, createToolkit } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema } from "@lloyal-labs/lloyal-agents";
import type { SessionContext } from "@lloyal-labs/sdk";
import type { Branch } from "@lloyal-labs/sdk";
import type { Chunk } from "../resources/types";
import type { SourceContext } from "./types";
import type { SearchProvider } from "../tools/types";
import { WebSearchTool } from "../tools/web-search";
import { FetchPageTool } from "../tools/fetch-page";
import { WebResearchTool } from "../tools/web-research";

// ── Task loader ──────────────────────────────────────────────────

function readTask(name: string): { system: string; user: string } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, `${name}.md`), "utf8")
    .trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

// ── FetchedPage + chunking ───────────────────────────────────────

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

// ── BufferingFetchPage ───────────────────────────────────────────

/**
 * Fetch-page wrapper that buffers full content and extracts a compact summary
 *
 * Wraps {@link FetchPageTool} to intercept successful fetches. Full page
 * content is pushed into a shared {@link FetchedPage} buffer for
 * post-research reranking. An attention scratchpad (forked from
 * {@link ScratchpadParent}) then grammar-constrains a summary + links
 * extraction, returning the compact result to the calling agent instead
 * of the full page text. Falls back to the full result if extraction
 * fails or no scratchpad parent is available.
 *
 * @category Rig
 */
class BufferingFetchPage extends Tool<{ url: string }> {
  readonly name = "fetch_page";
  readonly description =
    "Fetch a web page and extract its article content. Returns a summary and any links worth following. Use to read search results or follow links discovered in pages.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: { url: { type: "string", description: "URL to fetch" } },
    required: ["url"],
  };

  private _inner: FetchPageTool;
  private _buffer: FetchedPage[];
  private _extractTask: { system: string; user: string };

  constructor(
    buffer: FetchedPage[],
    extractTask: { system: string; user: string },
    maxChars?: number,
  ) {
    super();
    this._inner = new FetchPageTool(maxChars);
    this._buffer = buffer;
    this._extractTask = extractTask;
  }

  *execute(args: { url: string }): Operation<unknown> {
    const result = yield* this._inner.execute(args);
    const r = result as Record<string, unknown>;
    if (
      typeof r?.content === "string" &&
      r.content !== "[Could not extract article content]"
    ) {
      const content = r.content as string;
      // Buffer full content for reranking
      this._buffer.push({
        url: (r.url as string) || args.url,
        title: (r.title as string) || "",
        text: content,
      });

      // Attention scratchpad: fork from innermost active root, extract summary + links, prune
      let parent: Branch | undefined;
      try { parent = yield* ScratchpadParent.expect(); } catch { /* no parent — skip extraction */ }
      if (!parent || parent.disposed) return result;
      const ctx: SessionContext = yield* Ctx.expect();
      const schema = {
        type: "object",
        properties: {
          summary: { type: "string" },
          links: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "links"],
      };
      const grammar: string = yield* call(() =>
        ctx.jsonSchemaToGrammar(JSON.stringify(schema)),
      );
      const extractPrompt = this._extractTask.user
        .replace("{{url}}", args.url)
        .replace("{{title}}", (r.title as string) || "")
        .replace("{{content}}", content);
      const messages = [
        { role: "system", content: this._extractTask.system },
        { role: "user", content: extractPrompt },
      ];
      const { prompt } = ctx.formatChatSync(JSON.stringify(messages), { enableThinking: false });

      try {
        const extracted = yield* generate<{ summary: string; links: string[] }>(
          {
            prompt,
            grammar,
            params: { temperature: 0.3 },
            parse: (o) => JSON.parse(o),
            parent,
          },
        );
        return {
          url: r.url || args.url,
          title: r.title || "",
          summary: extracted.parsed?.summary || "",
          links: extracted.parsed?.links || [],
        };
      } catch {
        return result; // fallback to full result on extraction failure
      }
    }
    return result;
  }
}

// ── BufferingWebSearch ────────────────────────────────────────────

/**
 * Web-search wrapper that extracts a compact summary via attention scratchpad
 *
 * Wraps {@link WebSearchTool} and, when a {@link ScratchpadParent} is
 * available, forks a grammar-constrained generation to distill raw search
 * results into a list of promising URLs plus a brief summary. The compact
 * output reduces KV pressure on the calling agent. Falls back to raw
 * results if extraction fails or no scratchpad parent is available.
 *
 * @category Rig
 */
class BufferingWebSearch extends Tool<{ query: string }> {
  readonly name = "web_search";
  readonly description =
    "Search the web. Returns the most relevant URLs and a summary. Use fetch_page to read full content of promising results.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  };

  private _inner: WebSearchTool;
  private _extractTask: { system: string; user: string };

  constructor(provider: SearchProvider, extractTask: { system: string; user: string }) {
    super();
    this._inner = new WebSearchTool(provider);
    this._extractTask = extractTask;
  }

  *execute(args: { query: string }): Operation<unknown> {
    const results = yield* this._inner.execute(args);

    // If error or not an array, return as-is (no scratchpad needed)
    if (!Array.isArray(results) || results.length === 0) return results;

    // Scratchpad: fork from innermost active root, extract URLs + summary
    let parent: Branch | undefined;
    try { parent = yield* ScratchpadParent.expect(); } catch { /* no parent — return raw */ }
    if (!parent || parent.disposed) return results;

    const ctx: SessionContext = yield* Ctx.expect();
    const schema = {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "URLs worth fetching" },
        summary: { type: "string", description: "Brief summary of what the search found" },
      },
      required: ["urls", "summary"],
    };
    const grammar: string = yield* call(() =>
      ctx.jsonSchemaToGrammar(JSON.stringify(schema)),
    );

    const resultsText = (results as Array<{ title: string; url: string; snippet: string }>)
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
    const extractPrompt = this._extractTask.user
      .replace("{{query}}", args.query)
      .replace("{{results}}", resultsText);
    const messages = [
      { role: "system", content: this._extractTask.system },
      { role: "user", content: extractPrompt },
    ];
    const { prompt } = ctx.formatChatSync(JSON.stringify(messages), { enableThinking: false });

    try {
      const extracted = yield* generate<{ urls: string[]; summary: string }>({
        prompt,
        grammar,
        params: { temperature: 0.3 },
        parse: (o) => JSON.parse(o),
        parent,
      });
      return {
        urls: extracted.parsed?.urls || [],
        summary: extracted.parsed?.summary || "",
        resultCount: results.length,
      };
    } catch {
      return results; // fallback to raw results on extraction failure
    }
  }
}

// ── WebSource ────────────────────────────────────────────────────

/**
 * Web-backed research source using search + fetch with scratchpad extraction
 *
 * Wires up {@link BufferingWebSearch} and {@link BufferingFetchPage} for
 * grounding, and a self-referential {@link WebResearchTool} for spawning
 * parallel research sub-agents. Fetched page content is buffered in memory;
 * after research completes, {@link getChunks} converts the buffer into
 * {@link Chunk} instances via {@link chunkFetchedPages} for reranker scoring.
 *
 * @category Rig
 */
export class WebSource extends Source<SourceContext, Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: BufferingWebSearch;
  private _researchPrompt: { system: string; user: string };
  private _researchTool: WebResearchTool | null = null;

  /** @inheritDoc */
  readonly name = "web";

  /**
   * @param provider - Search backend (e.g. {@link TavilyProvider}) for web_search calls
   */
  constructor(provider: SearchProvider) {
    super();
    const extractTask = readTask("extract");
    const searchExtractTask = readTask("search-extract");
    this._researchPrompt = readTask("web-research");
    this._fetchPage = new BufferingFetchPage(this._buffer, extractTask);
    this._webSearch = new BufferingWebSearch(provider, searchExtractTask);
  }

  /** @inheritDoc */
  get researchTool(): Tool {
    if (!this._researchTool)
      throw new Error("WebSource: bind() must be called first");
    return this._researchTool;
  }

  /** @inheritDoc */
  get groundingTools(): Tool[] { return [this._webSearch, this._fetchPage]; }

  /**
   * Clear the page buffer and build the self-referential research toolkit
   *
   * Resets the internal {@link FetchedPage} buffer on every call so
   * prior-run content does not leak into a new research pass. Constructs
   * the {@link WebResearchTool} on first bind only (toolkit is stateless
   * once built).
   *
   * @inheritDoc
   */
  *bind(ctx: SourceContext): Operation<void> {
    this._buffer.length = 0;
    const tw = yield* Trace.expect();
    tw.write({ traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'source:bind', sourceName: this.name });

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
