import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx,
  generate, useAgentPool, runAgents, diverge, withSharedRoot,
} from '@lloyal-labs/lloyal-agents';
import type { Tool, AgentPoolResult, DivergeResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent, OpTiming } from './tui';
import { computeAgreement } from './agreement';
import { reportTool } from '../shared/tools';

/** Load a task prompt file. Convention: system prompt above `---`, user content below. */
function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const PLAN = loadTask('plan');
const RESEARCH = loadTask('research');
const VERIFY = loadTask('verify');
const EVAL = loadTask('eval');
const REPORT = loadTask('report');

// ── Options ──────────────────────────────────────────────────────

export interface WorkflowOpts {
  session: Session;
  toolMap: Map<string, Tool>;
  toolsJson: string;
  agentCount: number;
  verifyCount: number;
  maxTurns: number;
  trace: boolean;
  events: Channel<WorkflowEvent, void>;
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

  // Free KV from successful agents before spawning reporters
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
    pressure: { softLimit: 200, hardLimit: 64 },
  });

  hardCut.forEach((a, i) => {
    if (reporters.agents[i]?.findings) a.findings = reporters.agents[i].findings;
  });
}

// ── Operations ───────────────────────────────────────────────────

function* plan(query: string, opts: WorkflowOpts): Operation<{ questions: string[]; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const t = performance.now();

  const schema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: opts.agentCount,
      },
    },
    required: ['questions'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));

  const userContent = PLAN.user
    .replace('{{count}}', String(opts.agentCount))
    .replace('{{query}}', query);

  const messages = [
    { role: 'system', content: PLAN.system },
    { role: 'user', content: userContent },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  let output: string;
  let tokenCount: number;

  const parent = opts.session.trunk ?? undefined;
  if (parent) {
    const lead: Branch = yield* call(() => parent.fork());
    try {
      lead.setGrammar(grammar);
      const sep = ctx.getTurnSeparator();
      const delta: number[] = yield* call(() => ctx.tokenize(prompt, false));
      yield* call(() => lead.prefill([...sep, ...delta]));

      ({ output, tokenCount } = yield* call(async () => {
        let o = '';
        let tc = 0;
        for await (const { text } of lead) { o += text; tc++; }
        return { output: o, tokenCount: tc };
      }));
    } finally {
      yield* call(() => lead.prune());
    }
  } else {
    const result = yield* generate({ prompt, grammar, params: { temperature: 0.3 } });
    output = result.output;
    tokenCount = result.tokenCount;
  }

  let questions: string[];
  try {
    questions = JSON.parse(output).questions.slice(0, opts.agentCount);
    if (!questions.length) throw new Error('empty');
  } catch {
    questions = Array.from({ length: opts.agentCount }, (_, i) => `${query} (aspect ${i + 1})`);
  }

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'plan', questions, tokenCount, timeMs });
  return { questions, tokenCount, timeMs };
}

function* research(
  questions: string[],
  opts: WorkflowOpts,
): Operation<{ pool: AgentPoolResult; sharedPrefixLength: number; timeMs: number }> {
  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const { result: pool, prefixLen: sharedPrefixLength } = yield* withSharedRoot(
    { systemPrompt: RESEARCH.system, tools: opts.toolsJson },
    function*(root, prefixLen) {
      const pool = yield* useAgentPool({
        tasks: agentTasks(questions, opts.toolsJson, root),
        tools: opts.toolMap, maxTurns: opts.maxTurns, trace: opts.trace,
        terminalTool: 'report',
        pressure: { softLimit: 2048 },
      });

      yield* reportPass(pool, opts);
      return { result: pool, prefixLen };
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });
  return { pool, sharedPrefixLength, timeMs };
}

function* warmResearch(
  questions: string[],
  opts: WorkflowOpts,
): Operation<{ pool: AgentPoolResult; timeMs: number }> {
  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const pool = yield* scoped(function*() {
    const pool = yield* useAgentPool({
      tasks: agentTasks(questions, opts.toolsJson, opts.session.trunk!, Date.now()),
      tools: opts.toolMap, maxTurns: opts.maxTurns, trace: opts.trace,
      terminalTool: 'report',
      pressure: { softLimit: 1024 },
    });

    yield* reportPass(pool, opts);
    return pool;
  });

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });
  return { pool, timeMs };
}

function* verify(
  pool: AgentPoolResult,
  questions: string[],
  query: string,
  opts: WorkflowOpts,
): Operation<{ result: DivergeResult; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const findingsText = pool.agents
    .map((a, i) => `Q: ${questions[i]}\nA: ${(a.findings || '').trim()}`)
    .join('\n\n');

  const userContent = VERIFY.user
    .replace('{{findings}}', findingsText)
    .replace('{{query}}', query);

  const messages = [
    { role: 'system', content: VERIFY.system },
    { role: 'user', content: userContent },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  yield* opts.events.send({ type: 'verify:start', count: opts.verifyCount });
  const t = performance.now();
  const result = yield* diverge({
    prompt,
    attempts: opts.verifyCount,
    params: { temperature: 0.7 },
  });
  const timeMs = performance.now() - t;
  const agreement = computeAgreement(result.attempts.map(a => a.output));
  yield* opts.events.send({ type: 'verify:agreement', result: agreement });
  yield* opts.events.send({ type: 'verify:done', result, timeMs });
  return { result, timeMs };
}

function* evaluate(
  verifyResult: DivergeResult,
  opts: WorkflowOpts,
): Operation<{ converged: boolean | null; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();

  const responsesText = verifyResult.attempts
    .map((a, i) => `Response ${i + 1}: ${a.output.trim()}`)
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
  yield* opts.events.send({ type: 'eval:done', converged: result.parsed as boolean | null, tokenCount: result.tokenCount, timeMs });
  return { converged: result.parsed as boolean | null, tokenCount: result.tokenCount, timeMs };
}

function* answer(verifyResult: DivergeResult, opts: WorkflowOpts): Operation<void> {
  yield* opts.events.send({ type: 'answer', text: verifyResult.bestOutput });
}

function* promote(verifyResult: DivergeResult, opts: WorkflowOpts): Operation<void> {
  yield* call(() => opts.session.promote(verifyResult.best));
}

function* respond(
  pool: AgentPoolResult,
  query: string,
  opts: WorkflowOpts,
): Operation<{ tokenCount: number; timeMs: number }> {
  const agentFindings = pool.agents
    .map((a: { findings: string | null }, i: number) =>
      a.findings ? `[Agent ${i}] ${a.findings.trim()}` : null)
    .filter(Boolean)
    .join('\n\n');

  yield* call(() => opts.session.prefillUser(agentFindings
    ? `Research findings:\n${agentFindings}\n\nUser question: ${query}\n\nAnswer based on the research findings above.`
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

function* coldQuery(query: string, opts: WorkflowOpts): Operation<void> {
  const t0 = performance.now();

  const p = yield* plan(query, opts);
  const r = yield* research(p.questions, opts);
  const v = yield* verify(r.pool, p.questions, query, opts);
  const e = yield* evaluate(v.result, opts);
  yield* answer(v.result, opts);
  yield* promote(v.result, opts);

  const timings: OpTiming[] = [
    { label: 'Plan', tokens: p.tokenCount, detail: '', timeMs: p.timeMs },
    {
      label: 'Research', tokens: r.pool.totalTokens,
      detail: `(${r.pool.agents.map(a => a.tokenCount).join(' + ')})  ${r.pool.totalToolCalls} tools`,
      timeMs: r.timeMs,
    },
    {
      label: 'Verify', tokens: v.result.totalTokens,
      detail: `(${v.result.attempts.map(a => a.tokenCount).join(' + ')})`,
      timeMs: v.timeMs,
    },
    { label: 'Eval', tokens: e.tokenCount, detail: `converged: ${e.converged ? 'yes' : 'no'}`, timeMs: e.timeMs },
  ];

  const kvSaved = r.sharedPrefixLength * (p.questions.length - 1)
    + v.result.prefixLength * (v.result.attempts.length - 1);
  const kvLine = `KV shared    ${r.sharedPrefixLength} \u00d7 ${p.questions.length - 1} + ${v.result.prefixLength} \u00d7 ${v.result.attempts.length - 1} = ${kvSaved.toLocaleString()} tok saved`;

  yield* summarize(timings, opts, { kvLine });

  yield* opts.events.send({
    type: 'complete',
    data: {
      planTokens: p.tokenCount,
      agentTokens: r.pool.totalTokens, researchSteps: r.pool.steps,
      agentPpl: r.pool.agents.map(a => a.ppl),
      verifyTokens: v.result.totalTokens, verifySteps: v.result.steps,
      evalTokens: e.tokenCount, converged: e.converged,
      totalToolCalls: r.pool.totalToolCalls,
      prefixTokens: v.result.prefixLength,
      sharedPrefixTokens: r.sharedPrefixLength,
      agentCount: p.questions.length, attemptCount: v.result.attempts.length,
      wallTimeMs: Math.round(performance.now() - t0),
      planMs: Math.round(p.timeMs), researchMs: Math.round(r.timeMs),
      verifyMs: Math.round(v.timeMs), evalMs: Math.round(e.timeMs),
      ...r.pool.counters,
    },
  });
}

function* warmQuery(query: string, opts: WorkflowOpts): Operation<void> {
  const p = yield* plan(query, opts);
  const r = yield* warmResearch(p.questions, opts);
  const resp = yield* respond(r.pool, query, opts);

  const timings: OpTiming[] = [
    { label: 'Plan', tokens: p.tokenCount, detail: '', timeMs: p.timeMs },
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

export function* handleQuery(query: string, opts: WorkflowOpts): Operation<void> {
  yield* opts.events.send({ type: 'query', query, warm: !!opts.session.trunk });
  yield* (opts.session.trunk ? warmQuery : coldQuery)(query, opts);
}
