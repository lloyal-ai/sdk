import type { Operation } from "effection";
import {
  Tool,
  Trace,
  useAgentPool,
  withSharedRoot,
  traceScope,
} from "@lloyal-labs/lloyal-agents";
import type {
  JsonSchema,
  Toolkit,
  ToolContext,
  PressureThresholds,
} from "@lloyal-labs/lloyal-agents";

/**
 * Configuration for {@link WebResearchTool}.
 *
 * @category Rig
 */
export interface WebResearchToolOpts {
  /** Override the tool name exposed to the model. @defaultValue "research" */
  name?: string;
  /** Override the tool description exposed to the model. */
  description?: string;
  /** System prompt given to each spawned web-research sub-agent. */
  systemPrompt: string;
  /** Prompts used for grammar-constrained scratchpad extraction on hard-cut agents. */
  reporterPrompt: { system: string; user: string };
  /** Maximum tool-use turns per sub-agent before hard cut. @defaultValue 20 */
  maxTurns?: number;
  /** Enable trace output for sub-agent execution. @defaultValue false */
  trace?: boolean;
  /** Context pressure thresholds for the sub-agent pool. */
  pressure?: PressureThresholds;
}

/**
 * Spawn parallel web-research sub-agents for a set of questions.
 *
 * Similar to {@link ResearchTool} but designed for web-source pipelines.
 * Each question gets its own agent in a shared-root pool with access
 * to web_search, fetch_page, and report tools. Hard-cut agents that
 * exhaust their turns without reporting get a grammar-constrained
 * scratchpad extraction via {@link generate} to recover partial findings.
 *
 * Must call {@link setToolkit} before the tool is executed.
 *
 * @category Rig
 */
export class WebResearchTool extends Tool<{ questions: string[] }> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "string" },
        description: "Sub-questions to research in parallel",
      },
    },
    required: ["questions"],
  };

  private _systemPrompt: string;
  private _reporterPrompt: { system: string; user: string };
  private _maxTurns: number;
  private _trace: boolean;
  private _pressure?: PressureThresholds;
  private _toolkit: Toolkit | null = null;

  constructor(opts: WebResearchToolOpts) {
    super();
    this.name = opts.name ?? "research";
    this.description =
      opts.description ??
      "Spawn parallel research agents to investigate sub-questions. Each question gets its own agent.";
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
      return {
        error: "questions must be a non-empty array of strings",
        example: '{"questions": ["q1", "q2"]}',
      };
    }

    if (!this._toolkit)
      throw new Error(
        "WebResearchTool: setToolkit() must be called before execute",
      );

    const tw = yield* Trace.expect();
    const scope = traceScope(tw, null, 'webResearchTool', { questionCount: questions.length });
    const toolkit = this._toolkit;
    const systemPrompt = this._systemPrompt;
    const reporterPrompt = this._reporterPrompt;
    const maxTurns = this._maxTurns;
    const trace = this._trace;
    const pressure = this._pressure;

    return yield* withSharedRoot(
      { systemPrompt, tools: toolkit.toolsJson, parent: context?.branch },
      function* (root) {
        const pool = yield* useAgentPool({
          tasks: questions.map((q) => ({
            systemPrompt,
            content: q,
            tools: toolkit.toolsJson,
            parent: root,
          })),
          tools: toolkit.toolMap,
          terminalTool: "report",
          pruneOnReport: true,
          maxTurns,
          trace,
          pressure,
          reportPrompt: reporterPrompt,
        });

        const result = {
          findings: pool.agents.map((a) => a.findings).filter(Boolean),
          supportingFindings: pool.agents.flatMap((a) => a.childFindings ?? []),
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
