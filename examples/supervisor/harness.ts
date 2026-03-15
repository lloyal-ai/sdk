import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from 'effection';
import type { Operation, Channel } from 'effection';
import { Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, generate, useAgentPool, runAgents, withSharedRoot,
} from '@lloyal-labs/lloyal-agents';
import type { Tool, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent } from './tui';
import { reportTool } from '@lloyal-labs/rig';

function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const CLASSIFY = loadTask('classify');
const SPECIALIST = loadTask('specialist');
const SYNTHESIZE = loadTask('synthesize');

const SPECIALISTS: Record<string, string> = {
  factual: 'Find specific facts, definitions, data points. Quote exact passages. Do not infer.',
  analytical: 'Trace reasoning chains. Identify causes and effects. Connect evidence to conclusions.',
  comparative: 'Identify entities being compared. List dimensions. Note similarities and differences.',
};

const reportOnlyTools = JSON.stringify([reportTool.schema]);

function* reportPass(
  pool: AgentPoolResult,
  opts: HarnessOpts,
): Operation<void> {
  const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
  if (hardCut.length === 0) return;

  for (const a of pool.agents) {
    if (a.findings && !a.branch.disposed) a.branch.pruneSync();
  }

  const reporters = yield* runAgents({
    tasks: hardCut.map(a => ({
      systemPrompt: 'You are a research reporter. Call the report tool with a concise summary of the key findings from the research above.',
      content: 'Report your findings.',
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

// ── Options ──────────────────────────────────────────────────────

export interface HarnessOpts {
  session: Session;
  toolMap: Map<string, Tool>;
  toolsJson: string;
  events: Channel<WorkflowEvent, void>;
  maxTurns: number;
  trace: boolean;
}

// ── Phase 1: Classify ────────────────────────────────────────────

function* classify(
  query: string,
  opts: HarnessOpts,
): Operation<{ routes: string[]; rationale: string; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const t = performance.now();

  yield* opts.events.send({ type: 'classify:start' });

  const schema = {
    type: 'object',
    properties: {
      specialists: {
        type: 'array',
        items: { type: 'string', enum: ['factual', 'analytical', 'comparative'] },
        minItems: 1,
        maxItems: 3,
      },
      rationale: { type: 'string' },
    },
    required: ['specialists', 'rationale'],
  };
  const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));

  const userContent = CLASSIFY.user.replace('{{query}}', query);
  const messages = [
    { role: 'system', content: CLASSIFY.system },
    { role: 'user', content: userContent },
  ];
  const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

  const result = yield* generate({
    prompt,
    grammar,
    params: { temperature: 0.3 },
    parse: (o: string) => JSON.parse(o) as { specialists: string[]; rationale: string },
  });

  let routes: string[];
  let rationale: string;
  try {
    const parsed = result.parsed as { specialists: string[]; rationale: string };
    routes = parsed.specialists.filter(s => s in SPECIALISTS);
    rationale = parsed.rationale;
    if (!routes.length) routes = ['factual'];
  } catch {
    routes = ['factual'];
    rationale = 'Defaulting to factual specialist';
  }

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'classify:done', routes, rationale, tokenCount: result.tokenCount, timeMs });
  return { routes, rationale, tokenCount: result.tokenCount, timeMs };
}

// ── Phase 2: Dispatch ────────────────────────────────────────────

function* dispatch(
  query: string,
  routes: string[],
  opts: HarnessOpts,
): Operation<{ pool: AgentPoolResult; timeMs: number }> {
  yield* opts.events.send({ type: 'dispatch:start', routes });
  const t = performance.now();

  const { result: pool } = yield* withSharedRoot(
    { systemPrompt: SPECIALIST.system, tools: opts.toolsJson },
    function*(root) {
      const tasks = routes.map((route, i) => ({
        systemPrompt: SPECIALIST.system,
        content: `${SPECIALISTS[route]}\n\nQuestion: ${query}`,
        tools: opts.toolsJson,
        parent: root,
        seed: Date.now() + i,
      }));

      const pool = yield* useAgentPool({
        tasks,
        tools: opts.toolMap,
        maxTurns: opts.maxTurns,
        terminalTool: 'report',
        trace: opts.trace,
        pressure: { softLimit: 2048 },
      });

      yield* reportPass(pool, opts);
      return { result: pool };
    },
  );

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'dispatch:done', pool, routes, timeMs });
  return { pool, timeMs };
}

// ── Phase 3: Synthesize ──────────────────────────────────────────

function* synthesize(
  pool: AgentPoolResult,
  routes: string[],
  query: string,
  opts: HarnessOpts,
): Operation<{ tokenCount: number; timeMs: number }> {
  const findings = pool.agents
    .map((a, i) => `[${routes[i]}] ${(a.findings || '').trim()}`)
    .join('\n\n');

  yield* call(() => opts.session.prefillUser(
    `Specialist findings:\n${findings}\n\nSynthesize answering: ${query}`
  ));

  yield* opts.events.send({ type: 'synthesize:start' });
  const t = performance.now();
  let tokenCount = 0;
  const trunk = opts.session.trunk!;
  for (;;) {
    const { token, text, isStop } = trunk.produceSync();
    if (isStop) break;
    yield* call(() => trunk.commit(token));
    tokenCount++;
    yield* opts.events.send({ type: 'synthesize:text', text });
  }
  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'synthesize:done', tokenCount, timeMs });
  return { tokenCount, timeMs };
}

// ── Workflow composition ─────────────────────────────────────────

export function* handleQuery(query: string, opts: HarnessOpts): Operation<void> {
  yield* opts.events.send({ type: 'query', query });

  const cl = yield* classify(query, opts);
  const d = yield* dispatch(query, cl.routes, opts);
  const s = yield* synthesize(d.pool, cl.routes, query, opts);

  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();

  yield* opts.events.send({
    type: 'stats',
    timings: [
      { label: 'Classify', tokens: cl.tokenCount, detail: cl.routes.join(', '), timeMs: cl.timeMs },
      {
        label: 'Dispatch',
        tokens: d.pool.totalTokens,
        detail: `(${d.pool.agents.map(a => a.tokenCount).join(' + ')})  ${d.pool.totalToolCalls} tools`,
        timeMs: d.timeMs,
      },
      { label: 'Synthesize', tokens: s.tokenCount, detail: '', timeMs: s.timeMs },
    ],
    ctxPct: Math.round(100 * p.cellsUsed / (p.nCtx || 1)),
    ctxPos: p.cellsUsed,
    ctxTotal: p.nCtx || 1,
  });
}
