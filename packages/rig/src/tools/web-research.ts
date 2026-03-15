import { call } from "effection";
import type { Operation } from "effection";
import {
  Tool,
  Ctx,
  Trace,
  generate,
  useAgentPool,
  withSharedRoot,
  traceScope,
} from "@lloyal-labs/lloyal-agents";
import type {
  JsonSchema,
  Toolkit,
  PressureThresholds,
} from "@lloyal-labs/lloyal-agents";

export interface WebResearchToolOpts {
  name?: string;
  description?: string;
  systemPrompt: string;
  reporterPrompt: { system: string; user: string };
  maxTurns?: number;
  trace?: boolean;
  pressure?: PressureThresholds;
}

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

  setToolkit(toolkit: Toolkit): void {
    this._toolkit = toolkit;
  }

  *execute(args: { questions: string[] }): Operation<unknown> {
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
      { systemPrompt, tools: toolkit.toolsJson },
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
          maxTurns,
          trace,
          pressure,
        });

        // Scratchpad extraction for hard-cut agents — works under pressure
        const hardCut = pool.agents.filter(
          (a) => !a.findings && !a.branch.disposed,
        );
        if (hardCut.length > 0) {
          for (const a of pool.agents) {
            if (a.findings && !a.branch.disposed) a.branch.pruneSync();
          }

          const ctx = yield* Ctx.expect();
          const schema = {
            type: "object",
            properties: { findings: { type: "string" } },
            required: ["findings"],
          };
          const grammar: string = yield* call(() =>
            ctx.jsonSchemaToGrammar(JSON.stringify(schema)),
          );
          const msgs = [
            { role: "system", content: reporterPrompt.system },
            { role: "user", content: reporterPrompt.user },
          ];
          const { prompt } = ctx.formatChatSync(JSON.stringify(msgs));

          for (const a of hardCut) {
            try {
              const result = yield* generate<{ findings: string }>({
                prompt,
                grammar,
                parse: (o: string) => JSON.parse(o),
                parent: a.branch,
              });
              if (result.parsed?.findings) a.findings = result.parsed.findings;
            } catch {
              /* extraction failure non-fatal */
            }
            if (!a.branch.disposed) a.branch.pruneSync();
          }
        }

        const result = {
          findings: pool.agents.map((a) => a.findings).filter(Boolean),
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
