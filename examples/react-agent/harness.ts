import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Operation, Channel } from 'effection';
import { Session } from '@lloyal-labs/sdk';
import {
  Ctx, agentPool, parallel, DefaultAgentPolicy,
} from '@lloyal-labs/lloyal-agents';
import type { Tool } from '@lloyal-labs/lloyal-agents';
import type { WorkflowEvent } from './tui';
import { reportTool } from '@lloyal-labs/rig';

function loadTask(name: string): { system: string; user: string } {
  const raw = fs.readFileSync(path.resolve(__dirname, `tasks/${name}.md`), 'utf8').trim();
  const sep = raw.indexOf('\n---\n');
  if (sep === -1) return { system: raw, user: '' };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

const RESEARCH = loadTask('research');

// ── Options ──────────────────────────────────────────────────────

export interface HarnessOpts {
  session: Session;
  tools: Tool[];
  events: Channel<WorkflowEvent, void>;
  maxTurns: number;
  trace: boolean;
}

// ── Workflow ─────────────────────────────────────────────────────

export function* handleQuery(query: string, opts: HarnessOpts): Operation<void> {
  yield* opts.events.send({ type: 'query', query });

  const t = performance.now();
  yield* opts.events.send({ type: 'research:start' });

  const pool = yield* agentPool({
    orchestrate: parallel([{ content: query }]),
    tools: [...opts.tools, reportTool],
    systemPrompt: RESEARCH.system,
    terminalTool: 'report',
    maxTurns: opts.maxTurns,
    trace: opts.trace,
    policy: new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } }),
  });

  const timeMs = performance.now() - t;
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  const ctx = yield* Ctx.expect();
  const p = ctx._storeKvPressure();

  yield* opts.events.send({
    type: 'answer',
    text: pool.agents[0]?.result ?? '(no findings)',
    tokenCount: pool.totalTokens,
    toolCalls: pool.totalToolCalls,
    timeMs,
    ctxPct: Math.round(100 * p.cellsUsed / (p.nCtx || 1)),
    ctxPos: p.cellsUsed,
    ctxTotal: p.nCtx || 1,
  });
}
