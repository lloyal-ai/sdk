import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import type { Resource } from '../resources/types';

export class ReadFileTool extends Tool<{ filename: string; startLine?: number; endLine?: number }> {
  readonly name = 'read_file';
  readonly description = 'Read content from a file at specific line ranges. Use startLine/endLine from search results.';
  readonly parameters: JsonSchema;

  private _resources: Resource[];

  constructor(resources: Resource[]) {
    super();
    this._resources = resources;
    this.parameters = {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename from search results',
          enum: resources.map(r => r.name),
        },
        startLine: { type: 'number', description: 'Start line (1-indexed, from search results)' },
        endLine: { type: 'number', description: 'End line (1-indexed, from search results)' },
      },
      required: ['filename'],
    };
  }

  async execute(args: { filename: string; startLine?: number; endLine?: number } & Record<string, unknown>): Promise<unknown> {
    const filename = args.filename || (args.path as string) || '';
    const file = this._resources.find(r => r.name === filename);
    if (!file) {
      return { error: `File not found: ${filename}. Available: ${this._resources.map(r => r.name).join(', ')}` };
    }
    const lines = file.content.split('\n');
    const s = Math.max(0, (args.startLine ?? 1) - 1);
    const e = Math.min(lines.length, args.endLine ?? Math.min(100, lines.length));
    return { file: file.name, content: lines.slice(s, e).join('\n') };
  }
}
