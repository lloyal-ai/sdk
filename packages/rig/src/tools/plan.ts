import type { Operation } from 'effection';
import { Tool, agent, renderTemplate } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { Session } from '@lloyal-labs/sdk';

/**
 * Configuration for {@link PlanTool}.
 *
 * @category Rig
 */
export interface PlanToolOpts {
  /** System prompt + user template. User template is rendered via Eta with `{ query, count, context? }`. */
  prompt: { system: string; user: string };
  /** Active session whose trunk is used as the parent branch for generation. */
  session: Session;
  /** Maximum number of tasks the planner may produce. */
  maxQuestions: number;
  /** Sampling temperature for plan generation. @default 0.3 */
  temperature?: number;
}

/**
 * A structured research task produced by the planner.
 *
 * Intent is a plan-level decision (see {@link PlanIntent}), not a per-task
 * attribute — a task is always a research assignment when emitted.
 *
 * @category Rig
 */
export interface ResearchTask {
  /** What to find out — a specific, actionable research assignment. */
  description: string;
}

/**
 * Convert a ResearchTask to agent content string.
 *
 * @category Rig
 */
export function taskToContent(task: ResearchTask): string {
  return task.description;
}

/**
 * Plan-level disposition for the user's query.
 *
 * - **clarify** — query is genuinely ambiguous; planner emits `clarifyQuestions`,
 *   harness returns to REPL for user input.
 * - **passthrough** — query is a follow-up answerable from session.trunk's prior
 *   Q&A turns; harness skips research pipeline, streams answer from trunk, commits turn.
 * - **research** — query needs full decomposition; planner emits `tasks`, harness
 *   runs the chain → synth → verify pipeline.
 *
 * @category Rig
 */
export type PlanIntent = 'clarify' | 'passthrough' | 'research';

/**
 * Output returned by {@link PlanTool} execution.
 *
 * @category Rig
 */
export interface PlanResult {
  /** Plan-level disposition: how should the harness route this query? */
  intent: PlanIntent;
  /** Research tasks (non-empty when intent === 'research'; empty otherwise). */
  tasks: ResearchTask[];
  /** Clarification questions for the user (non-empty when intent === 'clarify'; empty otherwise). */
  clarifyQuestions: string[];
  /** Number of tokens generated during planning. */
  tokenCount: number;
  /** Wall-clock time for the planning pass in milliseconds. */
  timeMs: number;
}

/**
 * Grammar-constrained query planner.
 *
 * Analyzes the user's query (with prior conversation in KV via warm session fork)
 * and produces a {@link PlanResult} that commits to one disposition: clarify /
 * passthrough / research. Uses a JSON grammar to guarantee structured output;
 * the planner must choose one of the three intents and populate the matching
 * fields (tasks for research, clarifyQuestions for clarify, neither for passthrough).
 *
 * @category Rig
 */
export class PlanTool extends Tool<{ query: string; context?: string }> {
  readonly name = 'plan';
  readonly description = 'Analyze a user query and decide how to handle it: ask for clarification, pass through for direct answer from conversation history, or decompose into research tasks.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research query to analyze' },
      context: { type: 'string', description: 'Optional context from prior clarification' },
    },
    required: ['query'],
  };

  private _prompt: { system: string; user: string };
  private _session: Session;
  private _maxQuestions: number;
  private _temperature: number;

  constructor(opts: PlanToolOpts) {
    super();
    this._prompt = opts.prompt;
    this._temperature = opts.temperature ?? 0.3;
    this._session = opts.session;
    this._maxQuestions = opts.maxQuestions;
  }

  *execute(args: { query: string; context?: string }): Operation<unknown> {
    const t = performance.now();

    const schema: JsonSchema = {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['clarify', 'passthrough', 'research'] },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
            },
            required: ['description'],
          },
          maxItems: this._maxQuestions,
        },
        clarifyQuestions: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['intent'],
    };

    const userContent = renderTemplate(this._prompt.user, {
      query: args.query,
      count: this._maxQuestions,
      context: args.context || null,
    });

    const planAgent = yield* agent({
      systemPrompt: this._prompt.system,
      task: userContent,
      schema,
      params: { temperature: this._temperature },
      session: this._session,
    });

    const timeMs = performance.now() - t;
    const tokenCount = planAgent.tokenCount;

    try {
      const parsed = JSON.parse(planAgent.rawOutput) as {
        intent?: string;
        tasks?: { description?: string }[];
        clarifyQuestions?: string[];
      };

      const intent: PlanIntent =
        parsed.intent === 'clarify' || parsed.intent === 'passthrough' || parsed.intent === 'research'
          ? parsed.intent
          : 'research';

      const tasks: ResearchTask[] = (parsed.tasks ?? [])
        .slice(0, this._maxQuestions)
        .filter(t => typeof t.description === 'string')
        .map(t => ({ description: t.description! }));

      const clarifyQuestions = (parsed.clarifyQuestions ?? []).filter(q => typeof q === 'string');

      return { intent, tasks, clarifyQuestions, tokenCount, timeMs } satisfies PlanResult;
    } catch {
      // Grammar should prevent this; fall through to passthrough on malformed output
      // so the harness routes to a direct trunk-stream answer rather than running a
      // research pipeline with no real plan.
      return {
        intent: 'passthrough',
        tasks: [],
        clarifyQuestions: [],
        tokenCount,
        timeMs,
      } satisfies PlanResult;
    }
  }
}
