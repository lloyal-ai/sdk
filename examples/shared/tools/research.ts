import type { Operation } from 'effection';
import { Tool, useAgentPool, runAgents, withSharedRoot } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, Toolkit, PressureThresholds } from '@lloyal-labs/lloyal-agents';

export interface ResearchToolOpts {
  systemPrompt: string;
  reporterPrompt: { system: string; user: string };
  maxTurns?: number;
  trace?: boolean;
  pressure?: PressureThresholds;
}

export class ResearchTool extends Tool<{ questions: string[] }> {
  readonly name = 'research';
  readonly description = 'Spawn parallel research agents to investigate sub-questions. Each question gets its own agent.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sub-questions to research in parallel',
      },
    },
    required: ['questions'],
  };

  private _systemPrompt: string;
  private _reporterPrompt: { system: string; user: string };
  private _maxTurns: number;
  private _trace: boolean;
  private _pressure?: PressureThresholds;
  private _toolkit: Toolkit | null = null;

  constructor(opts: ResearchToolOpts) {
    super();
    this._systemPrompt = opts.systemPrompt;
    this._reporterPrompt = opts.reporterPrompt;
    this._maxTurns = opts.maxTurns ?? 20;
    this._trace = opts.trace ?? false;
    this._pressure = opts.pressure;
  }

  setToolkit(toolkit: Toolkit): void {
    this._toolkit = toolkit;
  }

  *execute(args: { questions: string[] }): Operation<unknown> {
    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return { error: 'questions must be a non-empty array of strings', example: '{"questions": ["q1", "q2"]}' };
    }

    const toolkit = this._toolkit!;
    const systemPrompt = this._systemPrompt;
    const reporterPrompt = this._reporterPrompt;
    const maxTurns = this._maxTurns;
    const trace = this._trace;
    const pressure = this._pressure;

    return yield* withSharedRoot(
      { systemPrompt, tools: toolkit.toolsJson },
      function*(root) {
        const pool = yield* useAgentPool({
          tasks: questions.map(q => ({
            systemPrompt,
            content: q,
            tools: toolkit.toolsJson,
            parent: root,
          })),
          tools: toolkit.toolMap,
          terminalTool: 'report',
          maxTurns,
          trace,
          pressure,
        });

        // Force hard-cut agents to report — same pattern as prior harness reportPass
        const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
        if (hardCut.length > 0) {
          for (const a of pool.agents) {
            if (a.findings && !a.branch.disposed) a.branch.pruneSync();
          }
          const reportTool = toolkit.toolMap.get('report')!;
          const reporters = yield* runAgents({
            tasks: hardCut.map(a => ({
              systemPrompt: reporterPrompt.system,
              content: reporterPrompt.user,
              tools: JSON.stringify([reportTool.schema]),
              parent: a.branch,
            })),
            tools: new Map([['report', reportTool]]),
            terminalTool: 'report',
            trace,
            pressure: { softLimit: 200, hardLimit: 64 },
          });
          hardCut.forEach((a, i) => {
            if (reporters.agents[i]?.findings) a.findings = reporters.agents[i].findings;
          });
        }

        return {
          findings: pool.agents.map(a => a.findings).filter(Boolean),
          agentCount: pool.agents.length,
          totalTokens: pool.totalTokens,
          totalToolCalls: pool.totalToolCalls,
        };
      },
    );
  }
}
