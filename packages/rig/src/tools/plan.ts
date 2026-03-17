import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Ctx, generate } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';

export interface PlanToolOpts {
  prompt: { system: string; user: string };
  session: Session;
  maxQuestions: number;
}

export interface PlanQuestion {
  text: string;
  intent: 'research' | 'clarify';
}

export interface PlanResult {
  questions: PlanQuestion[];
  tokenCount: number;
  timeMs: number;
}

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

  constructor(opts: PlanToolOpts) {
    super();
    this._prompt = opts.prompt;
    this._session = opts.session;
    this._maxQuestions = opts.maxQuestions;
  }

  *execute(args: { query: string; context?: string }): Operation<unknown> {
    const ctx: SessionContext = yield* Ctx.expect();
    const t = performance.now();

    const schema = {
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
    const grammar: string = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));

    let userContent = this._prompt.user
      .replace('{{count}}', String(this._maxQuestions))
      .replace('{{query}}', args.query);
    if (args.context) {
      userContent += `\n\nUser clarification:\n${args.context}`;
    }

    const messages = [
      { role: 'system', content: this._prompt.system },
      { role: 'user', content: userContent },
    ];
    const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages), { enableThinking: false }));

    const parent = this._session.trunk ?? undefined;
    const result = yield* generate({
      prompt,
      grammar,
      params: { temperature: 0.3 },
      parent,
    });
    const { output, tokenCount } = result;

    const timeMs = performance.now() - t;

    try {
      const parsed = JSON.parse(output);
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
