import * as fs from "node:fs";
import * as path from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import { Source } from "@lloyal-labs/lloyal-agents";
import { Tool, Ctx, Trace, generate, createToolkit } from "@lloyal-labs/lloyal-agents";
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

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

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
  private _parent: Branch | undefined;
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

  setParent(parent: Branch): void {
    this._parent = parent;
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

      // Attention scratchpad: fork, attend to full content, extract summary + links, prune
      const parent = this._parent!;
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
      const { prompt } = ctx.formatChatSync(JSON.stringify(messages));

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
  private _parent: Branch | undefined;
  private _extractTask: { system: string; user: string };

  constructor(provider: SearchProvider, extractTask: { system: string; user: string }) {
    super();
    this._inner = new WebSearchTool(provider);
    this._extractTask = extractTask;
  }

  setParent(parent: Branch): void {
    this._parent = parent;
  }

  *execute(args: { query: string }): Operation<unknown> {
    const results = yield* this._inner.execute(args);

    // If error or not an array, return as-is (no scratchpad needed)
    if (!Array.isArray(results) || results.length === 0) return results;

    // No parent set (e.g. in synthesis grounding) — return raw results
    if (!this._parent) return results;

    // Scratchpad: fork from outer root, attend to full results, extract URLs + summary
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
    const { prompt } = ctx.formatChatSync(JSON.stringify(messages));

    try {
      const extracted = yield* generate<{ urls: string[]; summary: string }>({
        prompt,
        grammar,
        params: { temperature: 0.3 },
        parse: (o) => JSON.parse(o),
        parent: this._parent,
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

export class WebSource extends Source<SourceContext, Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: BufferingWebSearch;
  private _researchPrompt: { system: string; user: string };
  private _researchTool: WebResearchTool | null = null;

  readonly name = "web";

  constructor(provider: SearchProvider) {
    super();
    const extractTask = readTask("extract");
    const searchExtractTask = readTask("search-extract");
    this._researchPrompt = readTask("web-research");
    this._fetchPage = new BufferingFetchPage(this._buffer, extractTask);
    this._webSearch = new BufferingWebSearch(provider, searchExtractTask);
  }

  get researchTool(): Tool {
    if (!this._researchTool)
      throw new Error("WebSource: bind() must be called first");
    return this._researchTool;
  }

  get groundingTools(): Tool[] { return [this._webSearch, this._fetchPage]; }

  *bind(ctx: SourceContext): Operation<void> {
    this._buffer.length = 0;
    this._fetchPage.setParent(ctx.parent);
    this._webSearch.setParent(ctx.parent);
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

  getChunks(): Chunk[] {
    return chunkFetchedPages(this._buffer);
  }
}
