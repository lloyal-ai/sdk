import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from 'effection';
import type { Operation, Channel } from 'effection';
import { Session } from '@lloyal-labs/sdk';
import {
  Ctx, useAgentPool, runAgents, withSharedRoot,
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

const RESEARCH = loadTask('research');

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

// ── Workflow ─────────────────────────────────────────────────────

export function* handleQuery(query: string, opts: HarnessOpts): Operation<void> {
  yield* opts.events.send({ type: 'query', query });

  const t = performance.now();
  yield* opts.events.send({ type: 'research:start' });

  const { result: pool } = yield* withSharedRoot(
    { systemPrompt: RESEARCH.system, tools: opts.toolsJson },
    function*(root) {
      const pool = yield* useAgentPool({
        tasks: [{
          systemPrompt: RESEARCH.system,
          content: query,
          tools: opts.toolsJson,
          parent: root,
        }],
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
  yield* opts.events.send({ type: 'research:done', pool, timeMs });

  const ctx = yield* Ctx.expect();
  const p = ctx._storeKvPressure();

  yield* opts.events.send({
    type: 'answer',
    text: pool.agents[0]?.findings ?? '(no findings)',
    tokenCount: pool.totalTokens,
    toolCalls: pool.totalToolCalls,
    timeMs,
    ctxPct: Math.round(100 * p.cellsUsed / (p.nCtx || 1)),
    ctxPos: p.cellsUsed,
    ctxTotal: p.nCtx || 1,
  });
}
