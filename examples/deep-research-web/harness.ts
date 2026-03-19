import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, generate, diverge, useAgentPool, withSharedRoot, createToolkit,
} from '@lloyal-labs/lloyal-agents';
import type { Source } from '@lloyal-labs/lloyal-agents';
import type { AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent, OpTiming } from './tui';
import { reportTool, PlanTool } from '@lloyal-labs/rig';
import type { PlanResult, Reranker, ScoredChunk, Chunk, SourceContext } from '@lloyal-labs/rig';

/** Load a task prompt file. Convention: system prompt above `---`, user content below. */
function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const PLAN = loadTask('plan');
const ROOT = loadTask('root');
const BRIDGE = loadTask('bridge');
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

// ── Source research result ────────────────────────────────────

interface SourceResearchResult {
  findings: string[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
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
  const { prompt } = ctx.formatChatSync(JSON.stringify(messages), { enableThinking: false });

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

// ── Operations ───────────────────────────────────────────────────

function* research(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
  maxTurns?: number,
): Operation<{ agentFindings: string; sourcePassages: string; totalTokens: number; totalToolCalls: number; timeMs: number }> {
  const effectiveMaxTurns = maxTurns ?? opts.maxTurns;

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const findingSections: string[] = [];
  let totalTokens = 0;
  let totalToolCalls = 0;

  // withSharedRoot sets ScratchpadParent context — tools that need
  // scratchpad extraction read it automatically from the Effection scope
  const chunks = yield* withSharedRoot(
    { systemPrompt: ROOT.system },
    function*(root) {
      for (const source of opts.sources)
        yield* source.bind({
          reranker: opts.reranker,
          reporterPrompt: REPORT, reportTool,
          maxTurns: effectiveMaxTurns, trace: opts.trace,
        });

      let activeQuestions = questions;

      for (let i = 0; i < opts.sources.length; i++) {
        const source = opts.sources[i];
        const result = (yield* source.researchTool.execute({ questions: activeQuestions })) as SourceResearchResult;
        totalTokens += result.totalTokens;
        totalToolCalls += result.totalToolCalls;

        const sectionFindings = result.findings.filter(Boolean)
          .map((f, j) => `### Agent ${j + 1}\n${f}`).join('\n\n');
        if (sectionFindings) findingSections.push(`## ${source.name} research\n\n${sectionFindings}`);

        // Exit gate: structure discoveries as durable context for the next source
        if (i < opts.sources.length - 1 && sectionFindings) {
          const sourceChunks = source.getChunks();
          const passages = yield* rerankChunks(sourceChunks, query, opts.reranker, 10, opts.findingsMaxChars);

          yield* opts.events.send({ type: 'bridge:start' });
          const bt = performance.now();

          const bridgeContent = BRIDGE.user
            .replace('{{agentFindings}}', sectionFindings)
            .replace('{{sourcePassages}}', passages)
            .replace('{{query}}', query);
          const reportOnlyToolkit = createToolkit([reportTool]);

          const discoveries = yield* withSharedRoot(
            { systemPrompt: BRIDGE.system, tools: reportOnlyToolkit.toolsJson },
            function*(bridgeRoot) {
              const pool = yield* useAgentPool({
                tasks: [{ systemPrompt: BRIDGE.system, content: bridgeContent, tools: reportOnlyToolkit.toolsJson, parent: bridgeRoot }],
                tools: reportOnlyToolkit.toolMap,
                terminalTool: 'report',
                maxTurns: effectiveMaxTurns,
                trace: opts.trace,
                pressure: { softLimit: 1024 },
              });
              yield* reportPass(pool, opts);
              totalTokens += pool.totalTokens;
              totalToolCalls += pool.totalToolCalls;
              return pool.agents[0]?.findings || '';
            },
          );

          const bridgeTimeMs = performance.now() - bt;
          yield* opts.events.send({ type: 'bridge:done', findings: discoveries, timeMs: bridgeTimeMs });

          if (discoveries) {
            activeQuestions = questions.map(q =>
              `${q}\n\nPrior research discoveries:\n${discoveries}`
            );
          }
        }
      }

      return opts.sources.flatMap(s => s.getChunks());
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', totalTokens, totalToolCalls, timeMs });

  const agentFindings = findingSections.join('\n\n');
  const sourcePassages = yield* rerankChunks(chunks, query, opts.reranker, 10, opts.findingsMaxChars);

  return { agentFindings, sourcePassages, totalTokens, totalToolCalls, timeMs };
}

function* warmResearch(
  questions: string[],
  query: string,
  opts: WorkflowOpts,
  maxTurns?: number,
): Operation<{ agentFindings: string; sourcePassages: string; totalTokens: number; totalToolCalls: number; timeMs: number }> {
  const effectiveMaxTurns = maxTurns ?? opts.maxTurns;
  for (const source of opts.sources)
    yield* source.bind({
      reranker: opts.reranker,
      reporterPrompt: REPORT, reportTool,
      maxTurns: effectiveMaxTurns, trace: opts.trace,
    });

  yield* opts.events.send({ type: 'research:start', agentCount: questions.length });
  const t = performance.now();

  const findingSections: string[] = [];
  let totalTokens = 0;
  let totalToolCalls = 0;
  let activeQuestions = questions;

  for (let i = 0; i < opts.sources.length; i++) {
    const source = opts.sources[i];
    const result = (yield* source.researchTool.execute({ questions: activeQuestions })) as SourceResearchResult;
    totalTokens += result.totalTokens;
    totalToolCalls += result.totalToolCalls;

    const sectionFindings = result.findings.filter(Boolean)
      .map((f, j) => `### Agent ${j + 1}\n${f}`).join('\n\n');
    if (sectionFindings) findingSections.push(`## ${source.name} research\n\n${sectionFindings}`);

    // Exit gate: structure discoveries as durable context for the next source
    if (i < opts.sources.length - 1 && sectionFindings) {
      const sourceChunks = source.getChunks();
      const passages = yield* rerankChunks(sourceChunks, query, opts.reranker, 10, opts.findingsMaxChars);

      yield* opts.events.send({ type: 'bridge:start' });
      const bt = performance.now();

      const bridgeContent = BRIDGE.user
        .replace('{{agentFindings}}', sectionFindings)
        .replace('{{sourcePassages}}', passages)
        .replace('{{query}}', query);
      const reportOnlyToolkit = createToolkit([reportTool]);

      const discoveries = yield* withSharedRoot(
        { systemPrompt: BRIDGE.system, tools: reportOnlyToolkit.toolsJson },
        function*(bridgeRoot) {
          const pool = yield* useAgentPool({
            tasks: [{ systemPrompt: BRIDGE.system, content: bridgeContent, tools: reportOnlyToolkit.toolsJson, parent: bridgeRoot }],
            tools: reportOnlyToolkit.toolMap,
            terminalTool: 'report',
            maxTurns: effectiveMaxTurns,
            trace: opts.trace,
            pressure: { softLimit: 1024 },
          });
          yield* reportPass(pool, opts);
          totalTokens += pool.totalTokens;
          totalToolCalls += pool.totalToolCalls;
          return pool.agents[0]?.findings || '';
        },
      );

      const bridgeTimeMs = performance.now() - bt;
      yield* opts.events.send({ type: 'bridge:done', findings: discoveries, timeMs: bridgeTimeMs });

      if (discoveries) {
        activeQuestions = questions.map(q =>
          `${q}\n\nPrior research discoveries:\n${discoveries}`
        );
      }
    }
  }

  const chunks = opts.sources.flatMap(s => s.getChunks());
  const timeMs = performance.now() - t;

  yield* opts.events.send({ type: 'research:done', totalTokens, totalToolCalls, timeMs });

  const agentFindings = findingSections.join('\n\n');
  const sourcePassages = yield* rerankChunks(chunks, query, opts.reranker, 10, opts.findingsMaxChars);

  return { agentFindings, sourcePassages, totalTokens, totalToolCalls, timeMs };
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

  // Grounding tools from all sources + report — synthesis can independently verify
  const groundingTools = opts.sources.flatMap(s => s.groundingTools);
  const synthToolkit = createToolkit([...groundingTools, reportTool]);

  // Synthesis runs inside withSharedRoot; verify+eval run outside so that
  // pruning the shared root frees KV (via fork_head decrement) before diverge.
  const synthPool = yield* withSharedRoot(
    { systemPrompt: SYNTHESIZE.system, tools: synthToolkit.toolsJson },
    function*(root) {
      const pool = yield* useAgentPool({
        tasks: [{ systemPrompt: SYNTHESIZE.system, content, tools: synthToolkit.toolsJson, parent: root }],
        tools: synthToolkit.toolMap,
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
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages), { enableThinking: false }));

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
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages), { enableThinking: false }));

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

// ── Routing ──────────────────────────────────────────────────────

type Route =
  | { type: 'clarify'; questions: string[] }
  | { type: 'research'; questions: string[]; maxTurns: number };

function route(plan: PlanResult, query: string, maxTurns: number): Route {
  const research = plan.questions.filter(q => q.intent === 'research');
  const clarify = plan.questions.filter(q => q.intent === 'clarify');

  if (research.length === 0 && clarify.length > 0)
    return { type: 'clarify', questions: clarify.map(q => q.text) };

  // passthrough (empty array) or decompose — both go through research
  const questions = research.length > 0 ? research.map(q => q.text) : [query];
  const effectiveMaxTurns = questions.length === 1 ? maxTurns * 2 : maxTurns;
  return { type: 'research', questions, maxTurns: effectiveMaxTurns };
}

// ── Finalize ─────────────────────────────────────────────────────

function* promoteTrunk(
  query: string,
  response: string,
  opts: WorkflowOpts,
): Operation<void> {
  const ctx: SessionContext = yield* Ctx.expect();
  const messages = [
    { role: 'user', content: query },
    { role: 'assistant', content: response },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages), { enableThinking: false }));
  const tokens: number[] = yield* call(() => ctx.tokenize(prompt, false));
  const trunk = Branch.create(ctx, 0, {});
  yield* call(() => trunk.prefill(tokens));
  yield* call(() => opts.session.promote(trunk));
}

function* appendTurn(
  query: string,
  response: string,
  opts: WorkflowOpts,
): Operation<void> {
  const ctx: SessionContext = yield* Ctx.expect();
  const sep = ctx.getTurnSeparator();
  const messages = [
    { role: 'user', content: query },
    { role: 'assistant', content: response },
  ];
  const { prompt } = ctx.formatChatSync(JSON.stringify(messages), { enableThinking: false });
  const tokens = ctx.tokenizeSync(prompt, false);
  yield* call(() => opts.session.trunk!.prefill([...sep, ...tokens]));
}

// ── Entry point ──────────────────────────────────────────────────

export function* handleQuery(
  query: string,
  opts: WorkflowOpts,
  context?: string,
): Operation<QueryResult> {
  yield* opts.events.send({ type: 'query', query, warm: !!opts.session.trunk });
  const t0 = performance.now();

  // Plan
  const planTool = new PlanTool({
    prompt: PLAN,
    session: opts.session,
    maxQuestions: opts.agentCount,
  });
  const plan = (yield* planTool.execute({ query, context })) as PlanResult;
  const r = route(plan, query, opts.maxTurns);

  const intent = r.type === 'clarify' ? 'clarify'
    : plan.questions.length === 0 ? 'passthrough' : 'decompose';
  yield* opts.events.send({
    type: 'plan', intent, questions: plan.questions,
    tokenCount: plan.tokenCount, timeMs: plan.timeMs,
  });

  if (r.type === 'clarify')
    return { type: 'clarify', questions: r.questions };

  // Research → Synthesize → Eval → Finalize
  const warm = !!opts.session.trunk;
  const res = warm
    ? yield* warmResearch(r.questions, query, opts, r.maxTurns)
    : yield* research(r.questions, query, opts, r.maxTurns);

  const s = yield* synthesize(res.agentFindings, res.sourcePassages, query, opts);

  const findings = s.pool.agents[0]?.findings || '';
  if (warm) {
    yield* appendTurn(query, findings, opts);
  } else if (findings) {
    yield* promoteTrunk(query, findings, opts);
  }

  const timings: OpTiming[] = [
    { label: 'Plan', tokens: plan.tokenCount, detail: intent, timeMs: plan.timeMs },
    {
      label: 'Research', tokens: res.totalTokens,
      detail: `${res.totalToolCalls} tools`,
      timeMs: res.timeMs,
    },
    {
      label: 'Synthesize', tokens: s.pool.totalTokens,
      detail: `(${s.pool.agents.map(a => a.tokenCount).join(' + ')})  ${s.pool.totalToolCalls} tools`,
      timeMs: s.timeMs,
    },
    { label: 'Eval', tokens: s.eval.tokenCount, detail: `converged: ${s.eval.converged ? 'yes' : 'no'}`, timeMs: s.eval.timeMs },
  ];

  yield* summarize(timings, opts);

  yield* opts.events.send({
    type: 'complete',
    data: {
      intent,
      planTokens: plan.tokenCount,
      agentTokens: res.totalTokens,
      synthTokens: s.pool.totalTokens, synthToolCalls: s.pool.totalToolCalls,
      evalTokens: s.eval.tokenCount, converged: s.eval.converged,
      totalToolCalls: res.totalToolCalls + s.pool.totalToolCalls,
      agentCount: r.questions.length, synthCount: s.pool.agents.length,
      wallTimeMs: Math.round(performance.now() - t0),
      planMs: Math.round(plan.timeMs), researchMs: Math.round(res.timeMs),
      synthMs: Math.round(s.timeMs), evalMs: Math.round(s.eval.timeMs),
    },
  });
  return { type: 'done' };
}
