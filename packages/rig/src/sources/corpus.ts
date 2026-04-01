import { call } from "effection";
import type { Operation } from "effection";
import { Source, Trace } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import type { Resource, Chunk } from "../resources/types";
import type { Reranker } from "../tools/types";
import { SearchTool } from "../tools/search";
import { ReadFileTool } from "../tools/read-file";
import { GrepTool } from "../tools/grep";

/** Data for rendering the corpus-research Eta template */
export interface CorpusPromptData {
  toc: string;
}

/**
 * Configuration for {@link CorpusSource}.
 *
 * @category Rig
 */
export interface CorpusSourceOpts {
  /** GrepTool configuration */
  grep?: {
    /** Max matches returned. @default 50 */
    maxResults?: number;
    /** Max chars per matched line. @default 200 */
    lineMaxChars?: number;
  };
  /** ReadFileTool configuration */
  readFile?: {
    /** Default max lines when no range specified. @default 100 */
    defaultMaxLines?: number;
  };
}

/**
 * Corpus-backed data source using local file search, read, and grep
 *
 * Provides three tools: semantic search (via reranker), file reading,
 * and regex grep. On {@link bind}, tokenizes chunks through the reranker
 * and prepends a reranker-backed search tool.
 *
 * System prompt data is provided via {@link promptData}: the reranker
 * scores the task against chunk section paths to find semantically
 * relevant starting points. The harness renders this data into an
 * Eta template (same pattern as synthesize.eta).
 *
 * @category Rig
 */
export class CorpusSource extends Source<{ reranker: Reranker }, Chunk> {
  private _chunks: Chunk[];
  private _tools: Tool[];
  private _bound = false;

  /** @inheritDoc */
  readonly name = "corpus";

  /**
   * @param resources - Loaded file resources for read_file and grep tools
   * @param chunks - Pre-split chunks for reranker-backed search
   * @param opts - Configuration for grep and read_file tools
   */
  constructor(resources: Resource[], chunks: Chunk[], opts?: CorpusSourceOpts) {
    super();
    this._chunks = chunks;
    this._tools = [
      new ReadFileTool(resources, { ...opts?.readFile, chunks }),
      new GrepTool(resources, opts?.grep),
    ];
  }

  /** @inheritDoc */
  get tools(): Tool[] { return this._tools; }

  /**
   * Provide data for rendering the corpus-research Eta template.
   *
   * Returns the TOC (structural orientation). The harness renders
   * this into its corpus-research.eta template (same pattern as
   * synthesize.eta). Agents discover relevant content through their
   * tools (search snippets, read_file relatedSections), not through
   * pre-scored suggestions in the prompt.
   */
  promptData(): CorpusPromptData {
    return { toc: this._buildToc() };
  }

  /** Build table of contents from chunk index: file → top-level headings */
  private _buildToc(): string {
    const byFile = new Map<string, string[]>();
    for (const c of this._chunks) {
      if (!c.section) continue;
      const isTopLevel = !c.section.includes(' > ');
      if (!isTopLevel) continue;
      const topics = byFile.get(c.resource) ?? [];
      if (!topics.includes(c.heading)) topics.push(c.heading);
      byFile.set(c.resource, topics);
    }
    for (const c of this._chunks) {
      if (!byFile.has(c.resource)) byFile.set(c.resource, []);
    }
    const lines: string[] = [];
    for (const [file, topics] of byFile) {
      lines.push(
        topics.length > 0
          ? `${file} (topics: ${topics.join(', ')})`
          : file,
      );
    }
    return lines.join('\n');
  }

  /**
   * Late-bind reranker: tokenize chunks and prepend SearchTool.
   * Idempotent — skips if already bound.
   * @inheritDoc
   */
  *bind(ctx: { reranker: Reranker }): Operation<void> {
    if (this._bound) return;
    this._reranker = ctx.reranker;
    const tw = yield* Trace.expect();
    tw.write({ traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'source:bind', sourceName: this.name });
    yield* call(() => ctx.reranker.tokenizeChunks(this._chunks));
    this._tools.unshift(new SearchTool(this._chunks, ctx.reranker));
    this._bound = true;
  }
}
