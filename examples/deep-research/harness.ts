import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx,
  generate, diverge, useAgentPool, runAgents, withSharedRoot, createToolkit,
} from '@lloyal-labs/lloyal-agents';
import type { Tool, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent, OpTiming } from './tui';
import { reportTool } from '../shared/tools';
import { ResearchTool } from '../shared/tools/research';
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
const ROUTE = loadTask('route');
const ENTAILMENT = loadTask('entailment');
const WEB_RESEARCH = loadTask('web-research');

// ── Options ──────────────────────────────────────────────────────

export interface WorkflowOpts {
  session: Session;
  toolMap: Map<string, Tool>;
  toolsJson: string;
  agentCount: number;
  verifyCount: number;
  maxTurns: number;
  trace: boolean;
  hasCorpus: boolean;
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
  const researchTool = new ResearchTool({
    systemPrompt: RESEARCH.system,
    reporterPrompt: REPORT,
    maxTurns: opts.maxTurns,
    trace: opts.trace,
  });
  const fullToolkit = createToolkit([...opts.toolMap.values(), researchTool]);
  researchTool.setToolkit(fullToolkit);

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const { result: pool, prefixLen: sharedPrefixLength } = yield* withSharedRoot(
    { systemPrompt: RESEARCH.system, tools: fullToolkit.toolsJson },
    function*(root, prefixLen) {
      const pool = yield* useAgentPool({
        tasks: agentTasks(questions, fullToolkit.toolsJson, root),
        tools: fullToolkit.toolMap, maxTurns: opts.maxTurns, trace: opts.trace,
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
  const researchTool = new ResearchTool({
    systemPrompt: RESEARCH.system,
    reporterPrompt: REPORT,
    maxTurns: opts.maxTurns,
    trace: opts.trace,
  });
  const fullToolkit = createToolkit([...opts.toolMap.values(), researchTool]);
  researchTool.setToolkit(fullToolkit);

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
  return { pool, timeMs };
}

function* synthesize(
  pool: AgentPoolResult,
  questions: string[],
  query: string,
  opts: WorkflowOpts,
): Operation<{
  pool: AgentPoolResult;
  eval: { converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number };
  entailment: { entailed: boolean | null; tokenCount: number; timeMs: number };
  webPool?: AgentPoolResult;
  webTimeMs?: number;
  timeMs: number;
}> {
  const findingsText = pool.agents
    .map((a, i) => `Q: ${questions[i]}\nA: ${(a.findings || '').trim()}`)
    .join('\n\n');

  const content = SYNTHESIZE.user
    .replace('{{findings}}', findingsText)
    .replace('{{query}}', query);

  yield* opts.events.send({ type: 'synthesize:start' });
  const t = performance.now();

  const inner = yield* withSharedRoot(
    { systemPrompt: SYNTHESIZE.system, tools: opts.toolsJson },
    function*(root) {
      // 1. ONE synthesis agent with tools — grounded answer
      const synthPool = yield* useAgentPool({
        tasks: [{ systemPrompt: SYNTHESIZE.system, content, tools: opts.toolsJson, parent: root }],
        tools: opts.toolMap,
        terminalTool: 'report',
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        pressure: { softLimit: 1024 },
      });

      yield* reportPass(synthPool, opts);

      const synthTimeMs = performance.now() - t;
      yield* opts.events.send({ type: 'synthesize:done', pool: synthPool, timeMs: synthTimeMs });

      // 2. N cheap text-only samples for entropy check
      const ctx: SessionContext = yield* Ctx.expect();
      const verifyContent = VERIFY.user
        .replace('{{findings}}', findingsText)
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

      // 3. Eval — semantic entropy on cheap samples
      const e = yield* evaluate(samples.attempts.map(a => a.output), opts);

      // 4. Entailment check — does synthesis answer the question?
      const synthesis = synthPool.agents[0]?.findings || '';
      const ent = yield* evaluateEntailment(synthesis, query, opts);

      let finalFindings = synthesis;
      let webPool: AgentPoolResult | undefined;
      let webTimeMs: number | undefined;

      // Entailment is the sole structural gate for web re-entry.
      // When corpus exists and entailment fails, web supplements.
      // URLs in the query are handled naturally — web agents see the full query text.
      const needsWeb = opts.hasCorpus && ent.entailed === false;

      if (needsWeb) {
        // 5. Web research — corpus findings in context, web tools only
        const web = yield* webResearch(findingsText, questions, query, opts);
        webPool = web.pool;
        webTimeMs = web.timeMs;

        // 6. Re-synthesize merging corpus + web findings
        const webFindingsText = web.pool.agents
          .map((a, i) => `Web[${i}]: ${(a.findings || '').trim()}`)
          .filter(f => f.length > 6)
          .join('\n\n');

        if (webFindingsText) {
          const mergedContent = SYNTHESIZE.user
            .replace('{{findings}}', `${findingsText}\n\nWeb sources:\n${webFindingsText}`)
            .replace('{{query}}', query);

          const resynthPool = yield* useAgentPool({
            tasks: [{ systemPrompt: SYNTHESIZE.system, content: mergedContent, tools: opts.toolsJson, parent: root }],
            tools: opts.toolMap,
            terminalTool: 'report',
            maxTurns: opts.maxTurns,
            trace: opts.trace,
            pressure: { softLimit: 1024 },
          });
          yield* reportPass(resynthPool, opts);
          finalFindings = resynthPool.agents[0]?.findings || synthesis;
        }
      }

      // 7. Answer
      yield* opts.events.send({ type: 'answer', text: finalFindings });

      return { synthPool, e, ent, synthTimeMs, webPool, webTimeMs };
    },
  );

  return {
    pool: inner.synthPool,
    eval: inner.e,
    entailment: inner.ent,
    webPool: inner.webPool,
    webTimeMs: inner.webTimeMs,
    timeMs: inner.synthTimeMs,
  };
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

function* evaluateEntailment(
  synthesis: string,
  query: string,
  opts: WorkflowOpts,
): Operation<{ entailed: boolean | null; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();

  const userContent = ENTAILMENT.user
    .replace('{{synthesis}}', synthesis)
    .replace('{{query}}', query);

  const messages = [
    { role: 'system', content: ENTAILMENT.system },
    { role: 'user', content: userContent },
  ];

  const schema = {
    type: 'object',
    properties: { entailed: { type: 'boolean' } },
    required: ['entailed'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  const t = performance.now();
  const result = yield* generate({
    prompt,
    grammar,
    params: { temperature: 0 },
    parse: (output: string) => {
      try { return JSON.parse(output).entailed as boolean; }
      catch { return null; }
    },
  });
  const timeMs = performance.now() - t;

  yield* opts.events.send({
    type: 'entailment:done',
    entailed: result.parsed as boolean | null,
    tokenCount: result.tokenCount,
    timeMs,
  });
  return { entailed: result.parsed as boolean | null, tokenCount: result.tokenCount, timeMs };
}

function* webResearch(
  findingsText: string,
  questions: string[],
  query: string,
  opts: WorkflowOpts,
): Operation<{ pool: AgentPoolResult; timeMs: number }> {
  const webToolkit = createToolkit([
    new WebSearchTool(new TavilyProvider()),
    new FetchPageTool(),
    reportTool,
  ]);

  const content = findingsText.trim()
    ? WEB_RESEARCH.user
        .replace('{{findings}}', findingsText)
        .replace('{{query}}', query)
    : `Original question: "${query}"\n\nResearch this question thoroughly using web_search and fetch_page, then report your findings with evidence and source URLs.`;

  yield* opts.events.send({ type: 'webresearch:start', agentCount: questions.length });
  const t = performance.now();

  const pool = yield* withSharedRoot(
    { systemPrompt: WEB_RESEARCH.system, tools: webToolkit.toolsJson },
    function*(root) {
      const pool = yield* useAgentPool({
        tasks: questions.map((q, i) => ({
          systemPrompt: WEB_RESEARCH.system,
          content: `${content}\n\nFocus area: ${q}`,
          tools: webToolkit.toolsJson,
          parent: root,
          seed: Date.now() + i,
        })),
        tools: webToolkit.toolMap,
        terminalTool: 'report',
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        pressure: { softLimit: 1024 },
      });
      yield* reportPass(pool, opts);
      return pool;
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'webresearch:done', pool, timeMs });
  return { pool, timeMs };
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

  // Research phase — branches on data source
  let researchPool: AgentPoolResult;
  let sharedPrefixLength = 0;
  let researchTimeMs: number;
  let researchLabel: string;

  if (opts.hasCorpus) {
    const r = yield* research(p.questions, opts);
    researchPool = r.pool;
    sharedPrefixLength = r.sharedPrefixLength;
    researchTimeMs = r.timeMs;
    researchLabel = 'Research';
  } else {
    const web = yield* webResearch('', p.questions, query, opts);
    researchPool = web.pool;
    researchTimeMs = web.timeMs;
    researchLabel = 'Web Research';
  }

  // Synthesize — same call regardless of data source
  const s = yield* synthesize(researchPool, p.questions, query, opts);

  // Lightweight trunk — findings only, no tool-call bloat from grounding
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
    { label: 'Plan', tokens: p.tokenCount, detail: '', timeMs: p.timeMs },
    {
      label: researchLabel, tokens: researchPool.totalTokens,
      detail: `(${researchPool.agents.map(a => a.tokenCount).join(' + ')})  ${researchPool.totalToolCalls} tools`,
      timeMs: researchTimeMs,
    },
    {
      label: 'Synthesize', tokens: s.pool.totalTokens,
      detail: `(${s.pool.agents.map(a => a.tokenCount).join(' + ')})  ${s.pool.totalToolCalls} tools`,
      timeMs: s.timeMs,
    },
    { label: 'Eval', tokens: s.eval.tokenCount, detail: `converged: ${s.eval.converged ? 'yes' : 'no'}`, timeMs: s.eval.timeMs },
    { label: 'Entailment', tokens: s.entailment.tokenCount, detail: `entailed: ${s.entailment.entailed ? 'yes' : 'no'}`, timeMs: s.entailment.timeMs },
  ];

  if (s.webPool) {
    timings.push({
      label: 'Web Research', tokens: s.webPool.totalTokens,
      detail: `(${s.webPool.agents.map(a => a.tokenCount).join(' + ')})  ${s.webPool.totalToolCalls} tools`,
      timeMs: s.webTimeMs!,
    });
  }

  const kvSaved = sharedPrefixLength * (p.questions.length - 1);
  const kvLine = sharedPrefixLength > 0
    ? `KV shared    ${sharedPrefixLength} \u00d7 ${p.questions.length - 1} = ${kvSaved.toLocaleString()} tok saved`
    : undefined;

  yield* summarize(timings, opts, kvLine ? { kvLine } : undefined);

  const totalToolCalls = researchPool.totalToolCalls + s.pool.totalToolCalls + (s.webPool?.totalToolCalls ?? 0);

  yield* opts.events.send({
    type: 'complete',
    data: {
      planTokens: p.tokenCount,
      agentTokens: researchPool.totalTokens, researchSteps: researchPool.steps,
      agentPpl: researchPool.agents.map(a => a.ppl),
      synthTokens: s.pool.totalTokens, synthToolCalls: s.pool.totalToolCalls,
      evalTokens: s.eval.tokenCount, converged: s.eval.converged,
      entailmentTokens: s.entailment.tokenCount, entailed: s.entailment.entailed,
      webResearchTokens: s.webPool?.totalTokens ?? 0,
      webResearchToolCalls: s.webPool?.totalToolCalls ?? 0,
      totalToolCalls,
      sharedPrefixTokens: sharedPrefixLength,
      agentCount: p.questions.length, synthCount: s.pool.agents.length,
      wallTimeMs: Math.round(performance.now() - t0),
      planMs: Math.round(p.timeMs), researchMs: Math.round(researchTimeMs),
      synthMs: Math.round(s.timeMs), evalMs: Math.round(s.eval.timeMs),
      entailmentMs: Math.round(s.entailment.timeMs),
      webResearchMs: s.webTimeMs ? Math.round(s.webTimeMs) : 0,
      ...researchPool.counters,
    },
  });
}

function* route(
  query: string,
  opts: WorkflowOpts,
): Operation<{ action: 'research' | 'respond'; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const trunk = opts.session.trunk!;

  const schema = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['research', 'respond'] } },
    required: ['action'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));

  const userContent = ROUTE.user.replace('{{query}}', query);
  const messages = [
    { role: 'system', content: ROUTE.system },
    { role: 'user', content: userContent },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  const t = performance.now();
  const lead: Branch = yield* call(() => trunk.fork());
  let output: string;
  let tokenCount: number;
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
  const timeMs = performance.now() - t;

  let action: 'research' | 'respond' = 'research';
  try {
    const parsed = JSON.parse(output).action;
    if (parsed === 'respond') action = 'respond';
  } catch { /* default to research */ }

  return { action, tokenCount, timeMs };
}

function* warmQuery(query: string, opts: WorkflowOpts): Operation<void> {
  // Route: does this follow-up need research or can we respond directly?
  const r = yield* route(query, opts);

  if (r.action === 'respond') {
    // Direct response from trunk — no plan, no research
    yield* call(() => opts.session.prefillUser(query));
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

    yield* summarize([
      { label: 'Route', tokens: r.tokenCount, detail: 'respond', timeMs: r.timeMs },
      { label: 'Response', tokens: tokenCount, detail: '', timeMs },
    ], opts);
    return;
  }

  // Research path
  const p = yield* plan(query, opts);

  let pool: AgentPoolResult;
  let researchTimeMs: number;
  let researchLabel: string;

  if (opts.hasCorpus) {
    const res = yield* warmResearch(p.questions, opts);
    pool = res.pool;
    researchTimeMs = res.timeMs;
    researchLabel = 'Research';
  } else {
    const web = yield* webResearch('', p.questions, query, opts);
    pool = web.pool;
    researchTimeMs = web.timeMs;
    researchLabel = 'Web Research';
  }

  const resp = yield* respond(pool, query, opts);

  const timings: OpTiming[] = [
    { label: 'Route', tokens: r.tokenCount, detail: 'research', timeMs: r.timeMs },
    { label: 'Plan', tokens: p.tokenCount, detail: '', timeMs: p.timeMs },
    {
      label: researchLabel, tokens: pool.totalTokens,
      detail: `(${pool.agents.map(a => a.tokenCount).join(' + ')})  ${pool.totalToolCalls} tools`,
      timeMs: researchTimeMs,
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
