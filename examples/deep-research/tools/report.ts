import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

export class ReportTool extends Tool<{ findings: string }> {
  readonly name = 'report';
  readonly description = 'Submit your final research findings. Call this when you have gathered enough information to answer the question.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { findings: { type: 'string', description: 'Your research findings and answer' } },
    required: ['findings'],
  };

  async execute(): Promise<unknown> { return {}; }
}
