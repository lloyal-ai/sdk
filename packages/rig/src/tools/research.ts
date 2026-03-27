import type { Operation } from 'effection';
import { Tool, Trace, useAgentPool, withSharedRoot, traceScope } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, Toolkit, ToolContext, PressureThresholds } from '@lloyal-labs/lloyal-agents';

/**
 * Configuration for {@link ResearchTool}
 *
 * @category Rig
 */
export interface ResearchToolOpts {
  /** System prompt for each spawned research agent */
  systemPrompt: string;
  /** Prompt pair used to extract findings from hard-cut agents */
  reporterPrompt: { system: string; user: string };
  /** Maximum tool-use turns per research agent (default: 20) */
  maxTurns?: number;
  /** Enable trace logging for sub-agent pools */
  trace?: boolean;
  /** Context pressure thresholds for sub-agent pools */
  pressure?: PressureThresholds;
}

/**
 * Spawn parallel research agents for sub-questions (corpus source)
 *
 * Creates a {@link withSharedRoot | shared root} and runs a
 * {@link useAgentPool | pool} of research agents, one per question.
 * Each agent has access to the full toolkit (search, read_file,
 * grep, report). Agents that hit the turn limit without reporting
 * are forced through a reporter pass that extracts partial findings.
 *
 * Call {@link ResearchTool.setToolkit | setToolkit()} before first
 * execution to wire the toolkit into the sub-agent pool.
 *
 * @category Rig
 */
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

  /** Inject the toolkit that sub-agents will use. Must be called before execute. */
  setToolkit(toolkit: Toolkit): void {
    this._toolkit = toolkit;
  }

  *execute(args: { questions: string[] }, context?: ToolContext): Operation<unknown> {
    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return { error: 'questions must be a non-empty array of strings', example: '{"questions": ["q1", "q2"]}' };
    }

    if (!this._toolkit) throw new Error('ResearchTool: setToolkit() must be called before execute');
    const tw = yield* Trace.expect();
    const scope = traceScope(tw, null, 'researchTool', { questionCount: questions.length });
    const toolkit = this._toolkit;
    const systemPrompt = this._systemPrompt;
    const reporterPrompt = this._reporterPrompt;
    const maxTurns = this._maxTurns;
    const trace = this._trace;
    const pressure = this._pressure;

    return yield* withSharedRoot(
      { systemPrompt, tools: toolkit.toolsJson, parent: context?.branch },
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
          pruneOnReport: true,
          maxTurns,
          trace,
          pressure,
          reportPrompt: reporterPrompt,
        });

        const result = {
          findings: pool.agents.map(a => a.findings).filter(Boolean),
          supportingFindings: pool.agents.flatMap(a => a.childFindings ?? []),
          agentCount: pool.agents.length,
          totalTokens: pool.totalTokens,
          totalToolCalls: pool.totalToolCalls,
        };
        scope.close();
        return result;
      },
    );
  }
}
