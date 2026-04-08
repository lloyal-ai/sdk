import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, ensure } from 'effection';
import type { Operation, Channel } from 'effection';
import { Branch, Session, buildUserDelta } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  Ctx, createAgentPool, diverge, DefaultAgentPolicy,
} from '@lloyal-labs/lloyal-agents';
import type { Tool, AgentPoolResult, DivergeResult } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent } from './tui';
import { reportTool } from '@lloyal-labs/rig';

function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const RESEARCH = loadTask('research');
const DRAFT = loadTask('draft');
const CRITIQUE = loadTask('critique');
const REVISE = loadTask('revise');

// ── Options ──────────────────────────────────────────────────────

export interface HarnessOpts {
  session: Session;
  tools: Tool[];
  events: Channel<WorkflowEvent, void>;
  maxTurns: number;
  critiqueAttempts: number;
  trace: boolean;
}

// ── Phase 1: Research ────────────────────────────────────────────

function* research(
  query: string,
  opts: HarnessOpts,
): Operation<{ findings: string; pool: AgentPoolResult; timeMs: number }> {
  yield* opts.events.send({ type: 'research:start' });
  const t = performance.now();

  const pool = yield* createAgentPool({
    tasks: [{ content: query }],
    tools: [...opts.tools, reportTool],
    systemPrompt: RESEARCH.system,
    terminalTool: 'report',
    maxTurns: opts.maxTurns,
    trace: opts.trace,
    policy: new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } }),
  });

  const timeMs = performance.now() - t;
  const findings = pool.agents[0]?.result ?? '(no findings)';
  yield* opts.events.send({ type: 'research:done', pool, timeMs });
  return { findings, pool, timeMs };
}

// ── Phase 2: Draft ───────────────────────────────────────────────

function* draft(
  findings: string,
  query: string,
  opts: HarnessOpts,
): Operation<{ branch: Branch; output: string; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const t = performance.now();

  yield* opts.events.send({ type: 'draft:start' });

  const branch = Branch.create(ctx, 0, { temperature: 0.6 });
  yield* ensure(() => { if (!branch.disposed) branch.pruneSync(); });

  const userContent = DRAFT.user
    .replace('{{findings}}', findings)
    .replace('{{query}}', query);

  const messages = [
    { role: 'system', content: DRAFT.system },
    { role: 'user', content: userContent },
  ];
  const { prompt } = ctx.formatChatSync(JSON.stringify(messages));
  const tokens = ctx.tokenizeSync(prompt, true);
  yield* call(() => branch.prefill(tokens));

  let output = '';
  let tokenCount = 0;
  for (;;) {
    const { token, text, isStop } = branch.produceSync();
    if (isStop) break;
    yield* call(() => branch.commit(token));
    output += text;
    tokenCount++;
    yield* opts.events.send({ type: 'draft:text', text });
  }

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'draft:done', tokenCount, timeMs });
  return { branch, output, tokenCount, timeMs };
}

// ── Phase 3: Critique ────────────────────────────────────────────

function* critique(
  draftBranch: Branch,
  opts: HarnessOpts,
): Operation<{ branch: Branch; output: string; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const t = performance.now();

  yield* opts.events.send({ type: 'critique:start', attempts: opts.critiqueAttempts });

  const critiqueRoot = draftBranch.forkSync();
  yield* ensure(() => { if (!critiqueRoot.disposed) critiqueRoot.pruneSync(); });
  const delta = buildUserDelta(ctx, CRITIQUE.user);
  yield* call(() => critiqueRoot.prefill(delta));

  const result: DivergeResult = yield* diverge({
    parent: critiqueRoot,
    attempts: opts.critiqueAttempts,
    params: { temperature: 0.7 },
  });

  const timeMs = performance.now() - t;
  yield* opts.events.send({
    type: 'critique:done',
    output: result.bestOutput,
    attempts: result.attempts.length,
    tokenCount: result.totalTokens,
    timeMs,
  });
  return { branch: result.best, output: result.bestOutput, tokenCount: result.totalTokens, timeMs };
}

// ── Phase 4: Revise ──────────────────────────────────────────────

function* revise(
  critiqueBranch: Branch,
  opts: HarnessOpts,
): Operation<{ output: string; tokenCount: number; timeMs: number }> {
  const ctx: SessionContext = yield* Ctx.expect();
  const t = performance.now();

  yield* opts.events.send({ type: 'revise:start' });

  const reviseBranch = critiqueBranch.forkSync();
  yield* ensure(() => { if (!reviseBranch.disposed) reviseBranch.pruneSync(); });
  const delta = buildUserDelta(ctx, REVISE.user);
  yield* call(() => reviseBranch.prefill(delta));

  let output = '';
  let tokenCount = 0;
  for (;;) {
    const { token, text, isStop } = reviseBranch.produceSync();
    if (isStop) break;
    yield* call(() => reviseBranch.commit(token));
    output += text;
    tokenCount++;
    yield* opts.events.send({ type: 'revise:text', text });
  }

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'revise:done', tokenCount, timeMs });
  return { output, tokenCount, timeMs };
}

// ── Workflow composition ─────────────────────────────────────────

export function* handleQuery(query: string, opts: HarnessOpts): Operation<void> {
  yield* opts.events.send({ type: 'query', query });

  const r = yield* research(query, opts);
  const d = yield* draft(r.findings, query, opts);
  const cr = yield* critique(d.branch, opts);
  const v = yield* revise(cr.branch, opts);

  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();

  yield* opts.events.send({
    type: 'stats',
    timings: [
      { label: 'Research', tokens: r.pool.totalTokens, detail: `${r.pool.totalToolCalls} tools`, timeMs: r.timeMs },
      { label: 'Draft', tokens: d.tokenCount, detail: '', timeMs: d.timeMs },
      { label: 'Critique', tokens: cr.tokenCount, detail: `${opts.critiqueAttempts} attempts`, timeMs: cr.timeMs },
      { label: 'Revise', tokens: v.tokenCount, detail: '', timeMs: v.timeMs },
    ],
    ctxPct: Math.round(100 * p.cellsUsed / (p.nCtx || 1)),
    ctxPos: p.cellsUsed,
    ctxTotal: p.nCtx || 1,
  });
}
