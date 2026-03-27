import * as fs from "node:fs";
import * as path from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import { Source, Trace, createToolkit } from "@lloyal-labs/lloyal-agents";
import type { Tool, PressureThresholds } from "@lloyal-labs/lloyal-agents";
import type { Resource, Chunk } from "../resources/types";
import type { SourceContext } from "./types";
import { SearchTool } from "../tools/search";
import { ReadFileTool } from "../tools/read-file";
import { GrepTool } from "../tools/grep";
import { ResearchTool } from "../tools/research";

function readTask(name: string): { system: string; user: string } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, `${name}.md`), "utf8")
    .trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

/**
 * Corpus-backed research source using local file search, read, and grep
 *
 * Provides grounding tools (`search`, `read_file`, `grep`) over a set of
 * loaded {@link Resource} / {@link Chunk} pairs. On {@link bind}, tokenizes
 * chunks via the reranker and prepends a reranker-backed `search` tool to
 * the tool list. The `search` tool is ordered first so the model prefers
 * semantic search before falling back to `read_file` or `grep`.
 *
 * The research tool is a self-referential {@link ResearchTool} that spawns
 * sub-agents with corpus-specific prompts and the full grounding toolkit.
 *
 * @category Rig
 */
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
  /** ResearchTool overrides */
  research?: {
    /** Override pressure thresholds for inner research pool */
    pressure?: PressureThresholds;
  };
}

export class CorpusSource extends Source<SourceContext, Chunk> {
  private _chunks: Chunk[];
  private _tools: Tool[] = [];
  private _researchTool: ResearchTool | null = null;
  private _bound = false;
  private _researchOpts?: CorpusSourceOpts['research'];

  /** @inheritDoc */
  readonly name = "corpus";

  /**
   * @param resources - Loaded file resources for read_file and grep tools
   * @param chunks - Pre-split chunks for reranker-backed search
   * @param opts - Configuration for grep, read_file, and research tools
   */
  constructor(resources: Resource[], chunks: Chunk[], opts?: CorpusSourceOpts) {
    super();
    this._chunks = chunks;
    this._tools = [
      new ReadFileTool(resources, opts?.readFile),
      new GrepTool(resources, opts?.grep),
    ];
    this._researchOpts = opts?.research;
  }

  /** @inheritDoc */
  get researchTool(): Tool {
    if (!this._researchTool)
      throw new Error("CorpusSource: bind() must be called first");
    return this._researchTool;
  }

  /** @inheritDoc */
  get groundingTools(): Tool[] { return this._tools; }

  /**
   * Late-bind reranker and build the research toolkit
   *
   * Tokenizes all chunks through the reranker, prepends a {@link SearchTool}
   * to the tool list, then constructs the self-referential
   * {@link ResearchTool} with corpus-specific prompts. Idempotent — skips
   * if already bound.
   *
   * @inheritDoc
   */
  *bind(ctx: SourceContext): Operation<void> {
    if (this._bound) return;
    const tw = yield* Trace.expect();
    tw.write({ traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'source:bind', sourceName: this.name });
    yield* call(() => ctx.reranker.tokenizeChunks(this._chunks));
    this._tools.unshift(new SearchTool(this._chunks, ctx.reranker));

    const researchPrompt = readTask("corpus-research");
    const research = new ResearchTool({
      systemPrompt: researchPrompt.system,
      reporterPrompt: ctx.reporterPrompt,
      maxTurns: ctx.maxTurns,
      trace: ctx.trace,
      pressure: this._researchOpts?.pressure,
    });
    const toolkit = createToolkit([...this._tools, ctx.reportTool, research]);
    research.setToolkit(toolkit);
    this._researchTool = research;
    this._bound = true;
  }
}
