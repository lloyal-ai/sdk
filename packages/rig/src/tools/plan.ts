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
 * @category Rig
 */
export interface ResearchTask {
  /** What to find out — a specific, actionable research assignment. */
  description: string;
  /** Whether the task is answerable via research or needs user clarification. */
  intent: 'research' | 'clarify';
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
 * A single sub-question produced by the planner with intent classification.
 *
 * @deprecated Use {@link ResearchTask} instead.
 * @category Rig
 */
export interface PlanQuestion {
  /** The sub-question text. */
  text: string;
  /** Whether the question can be answered via research or needs user clarification. */
  intent: 'research' | 'clarify';
}

/**
 * Output returned by {@link PlanTool} execution.
 *
 * @category Rig
 */
export interface PlanResult {
  /** Structured research tasks with optional entry points. */
  tasks: ResearchTask[];
  /** @deprecated Use tasks. Adapter — maps tasks to the old PlanQuestion shape. */
  questions: PlanQuestion[];
  /** Number of tokens generated during planning. */
  tokenCount: number;
  /** Wall-clock time for the planning pass in milliseconds. */
  timeMs: number;
}

/**
 * Grammar-constrained query decomposition and intent classification.
 *
 * Analyzes a research query and produces an array of {@link ResearchTask}
 * tasks, each classified as `"research"` (answerable via search)
 * or `"clarify"` (needs user input). Uses a JSON grammar to guarantee
 * structured output.
 *
 * @category Rig
 */
export class PlanTool extends Tool<{ query: string; context?: string }> {
  readonly name = 'plan';
  readonly description = 'Analyze a research query. Return research tasks classified as "research" (answerable via web search) or "clarify" (needs user input). Return empty array if the query is focused enough to research directly.';
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
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              intent: { type: 'string', enum: ['research', 'clarify'] },
            },
            required: ['description', 'intent'],
          },
          maxItems: this._maxQuestions,
        },
      },
      required: ['tasks'],
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
      const parsed = JSON.parse(planAgent.rawOutput);
      const raw = (parsed.tasks || []) as {
        description?: string;
        intent?: string;
      }[];
      const tasks: ResearchTask[] = raw
        .slice(0, this._maxQuestions)
        .filter(t => typeof t.description === 'string' && (t.intent === 'research' || t.intent === 'clarify'))
        .map(t => ({
          description: t.description!,
          intent: t.intent as 'research' | 'clarify',
        }));
      // Adapter: populate deprecated questions from tasks
      const questions: PlanQuestion[] = tasks.map(t => ({ text: t.description, intent: t.intent }));
      return { tasks, questions, tokenCount, timeMs } satisfies PlanResult;
    } catch {
      return { tasks: [], questions: [], tokenCount, timeMs } satisfies PlanResult;
    }
  }
}
