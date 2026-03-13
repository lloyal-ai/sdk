import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, Tool, generate, diverge, useAgentPool, withSharedRoot, createToolkit,
} from '@lloyal-labs/lloyal-agents';
import type { Source } from '@lloyal-labs/lloyal-agents';
import type { AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent, OpTiming } from './tui';
import { reportTool } from '../shared/tools';
import { PlanTool } from '../shared/tools/plan';
import type { PlanResult } from '../shared/tools/plan';
import type { Reranker, ScoredChunk } from '../shared/tools/types';
import type { Chunk } from '../shared/resources/types';
import { WebResearchTool } from '../shared/tools/web-research';
import type { SourceContext } from '../shared/sources/types';

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
  sources: Source<SourceContext, Chunk>[];
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

// ── Reranking ────────────────────────────────────────────────────

function* rerankChunks(
  chunks: Chunk[],
  query: string,
  reranker: Reranker,
  topN = 10,
  maxChars = 4000,
): Operation<string> {
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

function agentTasks(questions: string[], toolsJson: string, parent: Branch, researchPrompt: { system: string }, seed?: number) {
  return questions.map((q, i) => ({
    systemPrompt: researchPrompt.system,
    content: q,
    tools: toolsJson,
    parent,
    seed: seed != null ? seed + i : undefined,
  }));
}

function* reportPass(
  pool: AgentPoolResult,
  opts: WorkflowOpts,
): Operation<void> {
  const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
  if (hardCut.length === 0) return;

  // Free KV from agents that already reported
  for (const a of pool.agents) {
    if (a.findings && !a.branch.disposed) a.branch.pruneSync();
  }

  // Scratchpad extraction: fork, grammar-extract findings, prune — works under pressure
  const ctx: SessionContext = yield* Ctx.expect();
  const schema = {
    type: 'object',
    properties: { findings: { type: 'string' } },
    required: ['findings'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));
  const messages = [
    { role: 'system', content: REPORT.system },
    { role: 'user', content: REPORT.user },
  ];
  const { prompt } = ctx.formatChatSync(JSON.stringify(messages));

  for (const a of hardCut) {
    try {
      const result = yield* generate<{ findings: string }>({
        prompt,
        grammar,
        parse: (o: string) => JSON.parse(o),
        parent: a.branch,
      });
      if (result.parsed?.findings) a.findings = result.parsed.findings;
    } catch { /* extraction failure non-fatal */ }
    if (!a.branch.disposed) a.branch.pruneSync();
  }
}

function collectAgentFindings(pool: AgentPoolResult, questions: string[]): string {
  const sections: string[] = [];
  for (let i = 0; i < pool.agents.length; i++) {
    const a = pool.agents[i];
    if (!a.findings) continue;
    const q = questions[i] || `Agent ${i + 1}`;
    sections.push(`### ${q}\n${a.findings}`);
  }
  return sections.join('\n\n');
}

// ── Prompt + toolkit factories ───────────────────────────────────

function buildResearchPrompt(
  template: { system: string; user: string },
  sources: Source<SourceContext, Chunk>[],
): { system: string; user: string } {
  const toolGuide = sources.map(s => s.toolGuide).join('\n');
  const processSteps = sources.map(s => s.processSteps).join('\n');
  return {
    system: template.system
      .replace('{{toolGuide}}', toolGuide)
      .replace('{{processSteps}}', processSteps),
    user: template.user,
  };
}

function buildToolkit(
  sources: Source<SourceContext, Chunk>[],
  researchPrompt: { system: string; user: string },
  reportPrompt: { system: string; user: string },
  opts: { maxTurns: number; trace: boolean },
) {
  const researchTool = new WebResearchTool({
    systemPrompt: researchPrompt.system,
    reporterPrompt: reportPrompt,
    maxTurns: opts.maxTurns,
    trace: opts.trace,
  });
  const tools: Tool[] = sources.flatMap(s => s.tools);
  tools.push(researchTool, reportTool);
  const toolkit = createToolkit(tools);
  researchTool.setToolkit(toolkit);
  return toolkit;
}

// ── Operations ───────────────────────────────────────────────────

function* research(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
  maxTurns?: number,
): Operation<{ pool: AgentPoolResult; agentFindings: string; sourcePassages: string; sharedPrefixLength: number; timeMs: number }> {
  const effectiveMaxTurns = maxTurns ?? opts.maxTurns;
  const researchPrompt = buildResearchPrompt(RESEARCH, opts.sources);
  if (opts.trace) {
    process.stderr.write(`\n── compiled research prompt ──\n${researchPrompt.system}\n──────────────────────────────\n\n`);
  }

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const { pool, prefixLen: sharedPrefixLength, chunks } = yield* withSharedRoot(
    { systemPrompt: researchPrompt.system },
    function*(root, prefixLen) {
      for (const source of opts.sources)
        yield* source.bind({ parent: root, reranker: opts.reranker });
      const toolkit = buildToolkit(opts.sources, researchPrompt, REPORT, { maxTurns: effectiveMaxTurns, trace: opts.trace });
      const pool = yield* useAgentPool({
        tasks: agentTasks(questions, toolkit.toolsJson, root, researchPrompt),
        tools: toolkit.toolMap, maxTurns: effectiveMaxTurns, trace: opts.trace,
        terminalTool: 'report',
        pressure: { softLimit: 2048 },
      });

      yield* reportPass(pool, opts);
      const chunks = opts.sources.flatMap(s => s.getChunks());
      return { pool, prefixLen, chunks };
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  const agentFindings = collectAgentFindings(pool, questions);
  const sourcePassages = yield* rerankChunks(chunks, query, opts.reranker, 10, opts.findingsMaxChars);

  return { pool, agentFindings, sourcePassages, sharedPrefixLength, timeMs };
}

function* warmResearch(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
): Operation<{ pool: AgentPoolResult; agentFindings: string; sourcePassages: string; timeMs: number }> {
  const researchPrompt = buildResearchPrompt(RESEARCH, opts.sources);
  if (opts.trace) {
    process.stderr.write(`\n── compiled research prompt (warm) ──\n${researchPrompt.system}\n─────────────────────────────────────\n\n`);
  }
  for (const source of opts.sources)
    yield* source.bind({ parent: opts.session.trunk!, reranker: opts.reranker });
  const toolkit = buildToolkit(opts.sources, researchPrompt, REPORT, { maxTurns: opts.maxTurns, trace: opts.trace });

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const pool = yield* scoped(function*() {
    const pool = yield* useAgentPool({
      tasks: agentTasks(questions, toolkit.toolsJson, opts.session.trunk!, researchPrompt, Date.now()),
      tools: toolkit.toolMap, maxTurns: opts.maxTurns, trace: opts.trace,
      terminalTool: 'report',
      pressure: { softLimit: 1024 },
    });

    yield* reportPass(pool, opts);
    return pool;
  });

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  const agentFindings = collectAgentFindings(pool, questions);
  const chunks = opts.sources.flatMap(s => s.getChunks());
  const sourcePassages = yield* rerankChunks(chunks, query, opts.reranker, 10, opts.findingsMaxChars);

  return { pool, agentFindings, sourcePassages, timeMs };
}

function* synthesize(
  agentFindings: string,
  sourcePassages: string,
  query: string,
  opts: WorkflowOpts,
): Operation<{
  pool: AgentPoolResult;
  eval: { converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number };
  timeMs: number;
}> {
  const content = SYNTHESIZE.user
    .replace('{{agentFindings}}', agentFindings || '(none)')
    .replace('{{sourcePassages}}', sourcePassages || '(none)')
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
    .replace('{{agentFindings}}', agentFindings || '(none)')
    .replace('{{sourcePassages}}', sourcePassages || '(none)')
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
  context?: { agentFindings: string; sourcePassages: string },
): Operation<{ tokenCount: number; timeMs: number }> {
  const prefillContent = context
    ? `Research notes:\n${context.agentFindings}\n\nSource passages:\n${context.sourcePassages}\n\nUser question: ${query}\n\nAnswer the user's specific question using the evidence above. Address the precise concern raised.`
    : query;
  yield* call(() => opts.session.prefillUser(prefillContent));

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
  const s = yield* synthesize(r.agentFindings, r.sourcePassages, query, opts);

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
  const resp = yield* respond(query, opts, {
    agentFindings: r.agentFindings,
    sourcePassages: r.sourcePassages,
  });

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
