import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from 'effection';
import type { Operation } from 'effection';
import { Source, createToolkit } from '@lloyal-labs/lloyal-agents';
import type { Tool } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '../resources/types';
import type { SourceContext } from './types';
import { SearchTool } from '../tools/search';
import { ReadFileTool } from '../tools/read-file';
import { GrepTool } from '../tools/grep';
import { ResearchTool } from '../tools/research';

function readTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

export class CorpusSource extends Source<SourceContext, Chunk> {
  private _chunks: Chunk[];
  private _tools: Tool[] = [];
  private _researchTool: ResearchTool | null = null;
  private _bound = false;

  readonly name = 'corpus';

  constructor(resources: Resource[], chunks: Chunk[]) {
    super();
    this._chunks = chunks;
    this._tools = [
      new ReadFileTool(resources),
      new GrepTool(resources),
    ];
  }

  get researchTool(): Tool {
    if (!this._researchTool) throw new Error('CorpusSource: bind() must be called first');
    return this._researchTool;
  }

  *bind(ctx: SourceContext): Operation<void> {
    if (this._bound) return;
    yield* call(() => ctx.reranker.tokenizeChunks(this._chunks));
    this._tools.unshift(new SearchTool(this._chunks, ctx.reranker));

    const researchPrompt = readTask('corpus-research');
    const research = new ResearchTool({
      systemPrompt: researchPrompt.system,
      reporterPrompt: ctx.reporterPrompt,
      maxTurns: ctx.maxTurns,
      trace: ctx.trace,
    });
    const toolkit = createToolkit([...this._tools, research, ctx.reportTool]);
    research.setToolkit(toolkit);
    this._researchTool = research;
    this._bound = true;
  }
}
