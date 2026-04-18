import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from 'effection';
import type { Operation, Channel } from 'effection';
import { Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, agent, agentPool, DefaultAgentPolicy,
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

const SPECIALISTS: Record<string, string> = {
  factual: 'Find specific facts, definitions, data points. Quote exact passages. Do not infer.',
  analytical: 'Trace reasoning chains. Identify causes and effects. Connect evidence to conclusions.',
  comparative: 'Identify entities being compared. List dimensions. Note similarities and differences.',
};

// ── Options ──────────────────────────────────────────────────────

export interface HarnessOpts {
  session: Session;
  tools: Tool[];
  events: Channel<WorkflowEvent, void>;
  maxTurns: number;
  trace: boolean;
}

// ── Phase 1: Classify ────────────────────────────────────────────

function* classify(
  query: string,
  opts: HarnessOpts,
): Operation<{ routes: string[]; rationale: string; tokenCount: number; timeMs: number }> {
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

  const userContent = CLASSIFY.user.replace('{{query}}', query);
  const classifier = yield* agent({
    systemPrompt: CLASSIFY.system,
    task: userContent,
    schema,
    params: { temperature: 0.3 },
  });

  let routes: string[];
  let rationale: string;
  try {
    const parsed = JSON.parse(classifier.rawOutput) as { specialists: string[]; rationale: string };
    routes = parsed.specialists.filter(s => s in SPECIALISTS);
    rationale = parsed.rationale;
    if (!routes.length) routes = ['factual'];
  } catch {
    routes = ['factual'];
    rationale = 'Defaulting to factual specialist';
  }

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'classify:done', routes, rationale, tokenCount: classifier.tokenCount, timeMs });
  return { routes, rationale, tokenCount: classifier.tokenCount, timeMs };
}

// ── Phase 2: Dispatch ────────────────────────────────────────────

function* dispatch(
  query: string,
  routes: string[],
  opts: HarnessOpts,
): Operation<{ pool: AgentPoolResult; timeMs: number }> {
  yield* opts.events.send({ type: 'dispatch:start', routes });
  const t = performance.now();

  const pool = yield* agentPool({
    tasks: routes.map((route, i) => ({
      content: `${SPECIALISTS[route]}\n\nQuestion: ${query}`,
      seed: Date.now() + i,
    })),
    tools: [...opts.tools, reportTool],
    systemPrompt: SPECIALIST.system,
    terminalTool: 'report',
    maxTurns: opts.maxTurns,
    trace: opts.trace,
    policy: new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } }),
  });

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
    .map((a, i) => `[${routes[i]}] ${(a.result || '').trim()}`)
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
