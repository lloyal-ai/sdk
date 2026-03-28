import { call } from "effection";
import type { Operation } from "effection";
import { Source, Trace } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import type { Resource, Chunk } from "../resources/types";
import type { Reranker } from "../tools/types";
import { SearchTool } from "../tools/search";
import { ReadFileTool } from "../tools/read-file";
import { GrepTool } from "../tools/grep";

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
 * No orchestration, no prompts, no node:fs. Use {@link spawnAgents}
 * from your harness to orchestrate agents with these tools.
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
      new ReadFileTool(resources, opts?.readFile),
      new GrepTool(resources, opts?.grep),
    ];
  }

  /** @inheritDoc */
  get tools(): Tool[] { return this._tools; }

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
