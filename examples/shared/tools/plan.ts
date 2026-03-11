import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Ctx, generate } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { Branch, Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';

export interface PlanToolOpts {
  prompt: { system: string; user: string };
  session: Session;
  maxQuestions: number;
}

export interface PlanResult {
  intent: 'decompose' | 'passthrough' | 'clarify';
  questions: string[];
  tokenCount: number;
  timeMs: number;
}

export class PlanTool extends Tool<{ query: string; context?: string }> {
  readonly name = 'plan';
  readonly description = 'Analyze a research query. Return "decompose" with independent sub-questions if the query has multiple facets. Return "passthrough" if the query is specific enough to research directly. Return "clarify" with questions for the user if the query is ambiguous.';
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
        intent: { type: 'string', enum: ['decompose', 'passthrough', 'clarify'] },
        questions: {
          type: 'array',
          items: { type: 'string' },
          maxItems: this._maxQuestions,
        },
      },
      required: ['intent', 'questions'],
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
    const { prompt }: { prompt: string } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

    let output: string;
    let tokenCount: number;

    const parent = this._session.trunk ?? undefined;
    if (parent) {
      const lead: Branch = yield* call(() => parent.fork());
      try {
        lead.setGrammar(grammar);
        const sep = ctx.getTurnSeparator();
        const delta: number[] = yield* call(() => ctx.tokenize(prompt, false));
        yield* call(() => lead.prefill([...sep, ...delta]));

        ({ output, tokenCount } = yield* call(async () => {
          let o = '';
          let tc = 0;
          for await (const { text } of lead) { o += text; tc++; }
          return { output: o, tokenCount: tc };
        }));
      } finally {
        yield* call(() => lead.prune());
      }
    } else {
      const result = yield* generate({ prompt, grammar, params: { temperature: 0.3 } });
      output = result.output;
      tokenCount = result.tokenCount;
    }

    const timeMs = performance.now() - t;

    try {
      const parsed = JSON.parse(output);
      const intent = parsed.intent as string;
      if (intent !== 'decompose' && intent !== 'passthrough' && intent !== 'clarify') {
        return { intent: 'passthrough', questions: [], tokenCount, timeMs } satisfies PlanResult;
      }
      return {
        intent,
        questions: (parsed.questions || []).slice(0, this._maxQuestions),
        tokenCount,
        timeMs,
      } satisfies PlanResult;
    } catch {
      return { intent: 'passthrough', questions: [], tokenCount, timeMs } satisfies PlanResult;
    }
  }
}
