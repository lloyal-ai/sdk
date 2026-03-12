import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, Tool,
  generate, diverge, useAgentPool, runAgents, withSharedRoot, createToolkit,
} from '@lloyal-labs/lloyal-agents';
import type { AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent, OpTiming } from './tui';
import { reportTool } from '../shared/tools';
import { PlanTool } from '../shared/tools/plan';
import type { PlanResult } from '../shared/tools/plan';
import type { Reranker, ScoredChunk } from '../shared/tools/types';
import type { Chunk } from '../shared/resources/types';
import { WebResearchTool } from '../shared/tools/web-research';
import { WebSearchTool, TavilyProvider } from '../shared/tools/web-search';
import { FetchPageTool } from '../shared/tools/fetch-page';

/** Load a task prompt file. Convention: system prompt above `---`, user content below. */
function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const PLAN = loadTask('plan');
const RESEARCH = loadTask('research');
const SYNTHESIZE = loadTask('synthesize');
const VERIFY = loadTask('verify');
const EVAL = loadTask('eval');
const REPORT = loadTask('report');
const EXTRACT = loadTask('extract');

// ── Options ──────────────────────────────────────────────────────

export interface WorkflowOpts {
  session: Session;
  reranker: Reranker;
  agentCount: number;
  verifyCount: number;
  maxTurns: number;
  trace: boolean;
  findingsMaxChars?: number;
  events: Channel<WorkflowEvent, void>;
}

export type QueryResult =
  | { type: 'done' }
  | { type: 'clarify'; questions: string[] };

function planIntent(plan: PlanResult): string {
  const r = plan.questions.filter(q => q.intent === 'research').length;
  const cl = plan.questions.filter(q => q.intent === 'clarify').length;
  if (r === 0 && cl === 0) return 'passthrough';
  if (r === 0) return 'clarify';
  if (cl > 0) return 'mixed';
  return 'decompose';
}

// ── Buffering fetch_page ─────────────────────────────────────────

interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

class BufferingFetchPage extends Tool<{ url: string }> {
  readonly name = 'fetch_page';
  readonly description = 'Fetch a web page and extract its article content. Returns a summary and any links worth following. Use to read search results or follow links discovered in pages.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL to fetch' } },
    required: ['url'],
  };

  private _inner: FetchPageTool;
  private _buffer: FetchedPage[];
  private _parent: Branch;

  constructor(buffer: FetchedPage[], parent: Branch, maxChars?: number) {
    super();
    this._inner = new FetchPageTool(maxChars);
    this._buffer = buffer;
    this._parent = parent;
  }

  *execute(args: { url: string }): Operation<unknown> {
    const result = yield* this._inner.execute(args);
    const r = result as Record<string, unknown>;
    if (typeof r?.content === 'string' && r.content !== '[Could not extract article content]') {
      const content = r.content as string;
      // Buffer full content for reranking
      this._buffer.push({
        url: (r.url as string) || args.url,
        title: (r.title as string) || '',
        text: content,
      });

      // Attention scratchpad: fork, attend to full content, extract summary + links, prune
      const ctx: SessionContext = yield* Ctx.expect();
      const schema = {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          links: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'links'],
      };
      const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));
      const extractPrompt = EXTRACT.user
        .replace('{{url}}', args.url)
        .replace('{{title}}', (r.title as string) || '')
        .replace('{{content}}', content);
      const messages = [
        { role: 'system', content: EXTRACT.system },
        { role: 'user', content: extractPrompt },
      ];
      const { prompt } = ctx.formatChatSync(JSON.stringify(messages));

      try {
        const extracted = yield* generate<{ summary: string; links: string[] }>({
          prompt,
          grammar,
          params: { temperature: 0.3 },
          parse: (o) => JSON.parse(o),
          parent: this._parent,
        });
        return {
          url: r.url || args.url,
          title: r.title || '',
          summary: extracted.parsed?.summary || '',
          links: extracted.parsed?.links || [],
        };
      } catch {
        return result; // fallback to full result on extraction failure
      }
    }
    return result;
  }
}

// ── Reranking ────────────────────────────────────────────────────

function chunkFetchedPages(pages: FetchedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    const paragraphs = page.text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 40);

    if (paragraphs.length === 0) {
      if (page.text.trim().length > 40) {
        chunks.push({
          resource: page.url, heading: page.title || page.url,
          text: page.text.trim(), tokens: [],
          startLine: 1, endLine: 1,
        });
      }
      continue;
    }

    for (let i = 0; i < paragraphs.length; i++) {
      chunks.push({
        resource: page.url, heading: page.title || page.url,
        text: paragraphs[i], tokens: [],
        startLine: i + 1, endLine: i + 1,
      });
    }
  }
  return chunks;
}

function* rerankFindings(
  buffer: FetchedPage[],
  query: string,
  reranker: Reranker,
  topN = 10,
  maxChars = 4000,
): Operation<string> {
  if (buffer.length === 0) return '';

  const chunks = chunkFetchedPages(buffer);
  if (chunks.length === 0) return '';

  yield* call(() => reranker.tokenizeChunks(chunks));

  let scored: ScoredChunk[] = [];
  yield* call(async () => {
    for await (const { results } of reranker.score(query, chunks)) {
      scored = results;
    }
  });

  const passages: string[] = [];
  let totalChars = 0;
  for (const sc of scored.slice(0, topN)) {
    const chunk = chunks.find(c => c.resource === sc.file && c.startLine === sc.startLine);
    const passage = `[${sc.heading}](${sc.file})\n${chunk?.text || ''}`;
    if (totalChars + passage.length > maxChars && passages.length > 0) break;
    passages.push(passage);
    totalChars += passage.length;
  }
  return passages.join('\n\n---\n\n');
}

// ── Agent task builder ───────────────────────────────────────────

function agentTasks(questions: string[], toolsJson: string, parent: Branch, seed?: number) {
  return questions.map((q, i) => ({
    systemPrompt: RESEARCH.system,
    content: q,
    tools: toolsJson,
    parent,
    seed: seed != null ? seed + i : undefined,
  }));
}

const reportOnlyTools = JSON.stringify([reportTool.schema]);

function* reportPass(
  pool: AgentPoolResult,
  opts: WorkflowOpts,
): Operation<void> {
  const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
  if (hardCut.length === 0) return;

  for (const a of pool.agents) {
    if (a.findings && !a.branch.disposed) a.branch.pruneSync();
  }

  const reporters = yield* runAgents({
    tasks: hardCut.map(a => ({
      systemPrompt: REPORT.system,
      content: REPORT.user,
      tools: reportOnlyTools,
      parent: a.branch,
    })),
    tools: new Map([['report', reportTool]]),
    terminalTool: 'report',
    trace: opts.trace,
    pressure: { softLimit: 1024, hardLimit: 256 },
  });

  hardCut.forEach((a, i) => {
    if (reporters.agents[i]?.findings) a.findings = reporters.agents[i].findings;
  });
}

// ── Web toolkit factory ──────────────────────────────────────────

function buildWebToolkit(opts: WorkflowOpts, buffer: FetchedPage[], parent: Branch) {
  const webResearchTool = new WebResearchTool({
    systemPrompt: RESEARCH.system,
    reporterPrompt: REPORT,
    maxTurns: opts.maxTurns,
    trace: opts.trace,
  });
  const fullToolkit = createToolkit([
    new WebSearchTool(new TavilyProvider()),
    new BufferingFetchPage(buffer, parent),
    webResearchTool,
    reportTool,
  ]);
  webResearchTool.setToolkit(fullToolkit);
  return fullToolkit;
}

// ── Operations ───────────────────────────────────────────────────

function* research(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
  maxTurns?: number,
): Operation<{ pool: AgentPoolResult; findings: string; sharedPrefixLength: number; timeMs: number }> {
  const effectiveMaxTurns = maxTurns ?? opts.maxTurns;
  const buffer: FetchedPage[] = [];

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const { result: pool, prefixLen: sharedPrefixLength } = yield* withSharedRoot(
    { systemPrompt: RESEARCH.system },
    function*(root, prefixLen) {
      const fullToolkit = buildWebToolkit(opts, buffer, root);
      const pool = yield* useAgentPool({
        tasks: agentTasks(questions, fullToolkit.toolsJson, root),
        tools: fullToolkit.toolMap, maxTurns: effectiveMaxTurns, trace: opts.trace,
        terminalTool: 'report',
        pressure: { softLimit: 2048 },
      });

      yield* reportPass(pool, opts);
      return { result: pool, prefixLen };
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  // Rerank buffered pages — top passages go to synthesis verbatim
  const findings = yield* rerankFindings(buffer, query, opts.reranker, 10, opts.findingsMaxChars);

  return { pool, findings, sharedPrefixLength, timeMs };
}

function* warmResearch(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
): Operation<{ pool: AgentPoolResult; findings: string; timeMs: number }> {
  const buffer: FetchedPage[] = [];
  const fullToolkit = buildWebToolkit(opts, buffer, opts.session.trunk!);

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const pool = yield* scoped(function*() {
    const pool = yield* useAgentPool({
      tasks: agentTasks(questions, fullToolkit.toolsJson, opts.session.trunk!, Date.now()),
      tools: fullToolkit.toolMap, maxTurns: opts.maxTurns, trace: opts.trace,
      terminalTool: 'report',
      pressure: { softLimit: 1024 },
    });

    yield* reportPass(pool, opts);
    return pool;
  });

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  const findings = yield* rerankFindings(buffer, query, opts.reranker, 10, opts.findingsMaxChars);

  return { pool, findings, timeMs };
}

function* synthesize(
  findings: string,
  query: string,
  opts: WorkflowOpts,
): Operation<{
  pool: AgentPoolResult;
  eval: { converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number };
  timeMs: number;
}> {
  const content = SYNTHESIZE.user
    .replace('{{findings}}', findings)
    .replace('{{query}}', query);

  yield* opts.events.send({ type: 'synthesize:start' });
  const t = performance.now();

  const reportOnlyToolkit = createToolkit([reportTool]);

  // Synthesis runs inside withSharedRoot; verify+eval run outside so that
  // pruning the shared root frees KV (via fork_head decrement) before diverge.
  const synthPool = yield* withSharedRoot(
    { systemPrompt: SYNTHESIZE.system, tools: reportOnlyToolkit.toolsJson },
    function*(root) {
      const pool = yield* useAgentPool({
        tasks: [{ systemPrompt: SYNTHESIZE.system, content, tools: reportOnlyToolkit.toolsJson, parent: root }],
        tools: reportOnlyToolkit.toolMap,
        terminalTool: 'report',
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        pressure: { softLimit: 1024 },
      });

      yield* reportPass(pool, opts);
      return pool;
    },
  );
  // withSharedRoot's finally has pruned the shared root — KV freed

  const synthTimeMs = performance.now() - t;
  yield* opts.events.send({ type: 'synthesize:done', pool: synthPool, timeMs: synthTimeMs });

  const agent = synthPool.agents[0];
  yield* opts.events.send({ type: 'answer', text: agent?.findings || '' });

  // N cheap text-only samples for entropy check — runs with freed KV
  const ctx: SessionContext = yield* Ctx.expect();
  const verifyContent = VERIFY.user
    .replace('{{findings}}', findings)
    .replace('{{query}}', query);
  const messages = [
    { role: 'system', content: VERIFY.system },
    { role: 'user', content: verifyContent },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  const samples = yield* diverge({
    prompt,
    attempts: opts.verifyCount,
    params: { temperature: 0.7 },
  });

  const e = yield* evaluate(samples.attempts.map(a => a.output), opts);

  return { pool: synthPool, eval: e, timeMs: synthTimeMs };
}

function* evaluate(
  responses: string[],
  opts: WorkflowOpts,
): Operation<{ converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();

  const responsesText = responses
    .map((r, i) => `Response ${i + 1}: ${r.trim()}`)
    .join('\n\n');

  const userContent = EVAL.user.replace('{{responses}}', responsesText);

  const messages = [
    { role: 'system', content: EVAL.system },
    { role: 'user', content: userContent },
  ];

  const evalSchema = {
    type: 'object',
    properties: { converged: { type: 'boolean' } },
    required: ['converged'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(evalSchema)));
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  const t = performance.now();
  const result = yield* generate({
    prompt,
    grammar,
    params: { temperature: 0 },
    parse: (output: string) => {
      try { return JSON.parse(output).converged as boolean; }
      catch { return null; }
    },
  });
  const timeMs = performance.now() - t;
  const sampleCount = responses.length;
  yield* opts.events.send({ type: 'eval:done', converged: result.parsed as boolean | null, tokenCount: result.tokenCount, sampleCount, timeMs });
  return { converged: result.parsed as boolean | null, tokenCount: result.tokenCount, sampleCount, timeMs };
}

function* respond(
  query: string,
  opts: WorkflowOpts,
  findings?: string,
): Operation<{ tokenCount: number; timeMs: number }> {
  yield* call(() => opts.session.prefillUser(findings
    ? `Research findings:\n${findings}\n\nUser question: ${query}\n\nAnswer based on the research findings above.`
    : query));

  yield* opts.events.send({ type: 'response:start' });
  const t = performance.now();
  let tokenCount = 0;
  const trunk = opts.session.trunk!;
  for (;;) {
    const { token, text, isStop } = trunk.produceSync();
    if (isStop) break;
    yield* call(() => trunk.commit(token));
    tokenCount++;
    yield* opts.events.send({ type: 'response:text', text });
  }
  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'response:done' });
  return { tokenCount, timeMs };
}

function* summarize(
  timings: OpTiming[],
  opts: WorkflowOpts,
  extra?: { kvLine?: string },
): Operation<void> {
  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;
  yield* opts.events.send({
    type: 'stats', timings,
    kvLine: extra?.kvLine,
    ctxPct: Math.round(100 * p.cellsUsed / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });
}

// ── Workflow compositions ────────────────────────────────────────

function* coldResearch(
  questions: string[],
  query: string,
  plan: PlanResult,
  opts: WorkflowOpts,
  maxTurns?: number,
): Operation<void> {
  const t0 = performance.now();

  const r = yield* research(questions, query, opts, maxTurns);
  const s = yield* synthesize(r.findings, query, opts);

  // Lightweight trunk — findings only, no tool-call bloat
  const findings = s.pool.agents[0]?.findings || '';
  if (findings) {
    const ctx: SessionContext = yield* Ctx.expect();
    const messages = [
      { role: 'user', content: query },
      { role: 'assistant', content: findings },
    ];
    const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));
    const tokens: number[] = yield* call(() => ctx.tokenize(prompt, false));
    const trunk = Branch.create(ctx, 0, {});
    yield* call(() => trunk.prefill(tokens));
    yield* call(() => opts.session.promote(trunk));
  }

  const timings: OpTiming[] = [
    { label: 'Plan', tokens: plan.tokenCount, detail: planIntent(plan), timeMs: plan.timeMs },
    {
      label: 'Research', tokens: r.pool.totalTokens,
      detail: `(${r.pool.agents.map(a => a.tokenCount).join(' + ')})  ${r.pool.totalToolCalls} tools`,
      timeMs: r.timeMs,
    },
    {
      label: 'Synthesize', tokens: s.pool.totalTokens,
      detail: `(${s.pool.agents.map(a => a.tokenCount).join(' + ')})  ${s.pool.totalToolCalls} tools`,
      timeMs: s.timeMs,
    },
    { label: 'Eval', tokens: s.eval.tokenCount, detail: `converged: ${s.eval.converged ? 'yes' : 'no'}`, timeMs: s.eval.timeMs },
  ];

  const kvSaved = r.sharedPrefixLength * (questions.length - 1);
  const kvLine = questions.length > 1
    ? `KV shared    ${r.sharedPrefixLength} \u00d7 ${questions.length - 1} = ${kvSaved.toLocaleString()} tok saved`
    : undefined;

  yield* summarize(timings, opts, { kvLine });

  yield* opts.events.send({
    type: 'complete',
    data: {
      intent: planIntent(plan),
      planTokens: plan.tokenCount,
      agentTokens: r.pool.totalTokens, researchSteps: r.pool.steps,
      agentPpl: r.pool.agents.map(a => a.ppl),
      synthTokens: s.pool.totalTokens, synthToolCalls: s.pool.totalToolCalls,
      evalTokens: s.eval.tokenCount, converged: s.eval.converged,
      totalToolCalls: r.pool.totalToolCalls + s.pool.totalToolCalls,
      sharedPrefixTokens: r.sharedPrefixLength,
      agentCount: questions.length, synthCount: s.pool.agents.length,
      wallTimeMs: Math.round(performance.now() - t0),
      planMs: Math.round(plan.timeMs), researchMs: Math.round(r.timeMs),
      synthMs: Math.round(s.timeMs), evalMs: Math.round(s.eval.timeMs),
      ...r.pool.counters,
    },
  });
}

function* warmDecompose(
  questions: string[],
  query: string,
  plan: PlanResult,
  opts: WorkflowOpts,
): Operation<void> {
  const r = yield* warmResearch(questions, query, opts);
  const resp = yield* respond(query, opts, r.findings);

  const timings: OpTiming[] = [
    { label: 'Plan', tokens: plan.tokenCount, detail: planIntent(plan), timeMs: plan.timeMs },
    {
      label: 'Research', tokens: r.pool.totalTokens,
      detail: `(${r.pool.agents.map(a => a.tokenCount).join(' + ')})  ${r.pool.totalToolCalls} tools`,
      timeMs: r.timeMs,
    },
    { label: 'Response', tokens: resp.tokenCount, detail: '', timeMs: resp.timeMs },
  ];

  yield* summarize(timings, opts);
}

// ── Entry point ──────────────────────────────────────────────────

export function* handleQuery(
  query: string,
  opts: WorkflowOpts,
  context?: string,
): Operation<QueryResult> {
  yield* opts.events.send({ type: 'query', query, warm: !!opts.session.trunk });

  const planTool = new PlanTool({
    prompt: PLAN,
    session: opts.session,
    maxQuestions: opts.agentCount,
  });
  const p = (yield* planTool.execute({ query, context })) as PlanResult;

  const research = p.questions.filter(q => q.intent === 'research');
  const clarify = p.questions.filter(q => q.intent === 'clarify');
  const intent = research.length === 0 && clarify.length === 0 ? 'passthrough'
    : research.length === 0 ? 'clarify'
    : clarify.length > 0 ? 'mixed' : 'decompose';

  yield* opts.events.send({
    type: 'plan', intent, questions: p.questions,
    tokenCount: p.tokenCount, timeMs: p.timeMs,
  });

  if (intent === 'clarify') {
    return { type: 'clarify', questions: clarify.map(q => q.text) };
  }

  const warm = !!opts.session.trunk;
  const researchQuestions = research.map(q => q.text);

  if (researchQuestions.length === 0) {
    // Passthrough — no sub-questions, research query directly
    if (warm) {
      const resp = yield* respond(query, opts);
      const timings: OpTiming[] = [
        { label: 'Plan', tokens: p.tokenCount, detail: 'passthrough', timeMs: p.timeMs },
        { label: 'Response', tokens: resp.tokenCount, detail: '', timeMs: resp.timeMs },
      ];
      yield* summarize(timings, opts);
    } else {
      yield* coldResearch([query], query, p, opts, opts.maxTurns * 2);
    }
    return { type: 'done' };
  }

  // Has research questions — dispatch agents
  const maxTurns = researchQuestions.length === 1 ? opts.maxTurns * 2 : undefined;
  if (warm) {
    yield* warmDecompose(researchQuestions, query, p, opts);
  } else {
    yield* coldResearch(researchQuestions, query, p, opts, maxTurns);
  }
  return { type: 'done' };
}
