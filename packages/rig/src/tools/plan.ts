import type { Operation } from 'effection';
import { Tool, createAgent } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { Session } from '@lloyal-labs/sdk';

/**
 * Configuration for {@link PlanTool}.
 *
 * @category Rig
 */
export interface PlanToolOpts {
  /** System and user prompt templates. User prompt supports `{{count}}` and `{{query}}` placeholders. */
  prompt: { system: string; user: string };
  /** Active session whose trunk is used as the parent branch for generation. */
  session: Session;
  /** Maximum number of sub-questions the planner may produce. */
  maxQuestions: number;
  /** Sampling temperature for plan generation. @default 0.3 */
  temperature?: number;
}

/**
 * A single sub-question produced by the planner with intent classification.
 *
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
  /** Classified sub-questions (may be empty if the query needs no decomposition). */
  questions: PlanQuestion[];
  /** Number of tokens generated during planning. */
  tokenCount: number;
  /** Wall-clock time for the planning pass in milliseconds. */
  timeMs: number;
}

/**
 * Grammar-constrained query decomposition and intent classification.
 *
 * Analyzes a research query and produces an array of {@link PlanQuestion}
 * sub-questions, each classified as `"research"` (answerable via search)
 * or `"clarify"` (needs user input). Uses a JSON grammar to guarantee
 * structured output. Returns an empty array if the query is focused
 * enough to research directly.
 *
 * @category Rig
 */
export class PlanTool extends Tool<{ query: string; context?: string }> {
  readonly name = 'plan';
  readonly description = 'Analyze a research query. Return sub-questions classified as "research" (answerable via web search) or "clarify" (needs user input). Return empty array if the query is focused enough to research directly.';
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
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              intent: { type: 'string', enum: ['research', 'clarify'] },
            },
            required: ['text', 'intent'],
          },
          maxItems: this._maxQuestions,
        },
      },
      required: ['questions'],
    };

    let userContent = this._prompt.user
      .replace('{{count}}', String(this._maxQuestions))
      .replace('{{query}}', args.query);
    if (args.context) {
      userContent += `\n\nUser clarification:\n${args.context}`;
    }

    const agent = yield* createAgent({
      systemPrompt: this._prompt.system,
      task: userContent,
      schema,
      params: { temperature: this._temperature },
      session: this._session,
    });

    const timeMs = performance.now() - t;
    const tokenCount = agent.tokenCount;

    try {
      const parsed = JSON.parse(agent.rawOutput);
      const raw = (parsed.questions || []) as { text?: string; intent?: string }[];
      const questions: PlanQuestion[] = raw
        .slice(0, this._maxQuestions)
        .filter(q => typeof q.text === 'string' && (q.intent === 'research' || q.intent === 'clarify'))
        .map(q => ({ text: q.text!, intent: q.intent as 'research' | 'clarify' }));
      return { questions, tokenCount, timeMs } satisfies PlanResult;
    } catch {
      return { questions: [], tokenCount, timeMs } satisfies PlanResult;
    }
  }
}
