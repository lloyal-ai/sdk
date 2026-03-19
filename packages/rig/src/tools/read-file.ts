import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Resource } from '../resources/types';

/**
 * Subtract previously-covered ranges from a target range
 *
 * Given a target half-open interval `[s, e)` and an array of
 * already-covered intervals, returns the sub-ranges of `[s, e)`
 * that have not yet been covered. Used by {@link ReadFileTool}
 * to avoid re-reading lines the agent has already seen.
 *
 * @param range - Target range `[start, end)` (0-indexed)
 * @param covered - Array of previously-covered `[start, end)` ranges
 * @returns Uncovered sub-ranges of the target
 *
 * @category Rig
 */
export function subtractRanges(
  [s, e]: [number, number],
  covered: [number, number][],
): [number, number][] {
  let ranges: [number, number][] = [[s, e]];
  for (const [cs, ce] of covered) {
    ranges = ranges.flatMap(([a, b]): [number, number][] => {
      if (ce <= a || cs >= b) return [[a, b]];
      const result: [number, number][] = [];
      if (a < cs) result.push([a, cs]);
      if (ce < b) result.push([ce, b]);
      return result;
    });
  }
  return ranges;
}

/**
 * Merge overlapping or adjacent half-open ranges into a minimal set
 *
 * Sorts the input ranges by start position, then collapses any
 * overlapping or touching intervals. Used by {@link ReadFileTool}
 * to maintain a compact record of lines already read per agent.
 *
 * @param ranges - Array of `[start, end)` ranges to merge
 * @returns Merged non-overlapping ranges sorted by start
 *
 * @category Rig
 */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/**
 * Read content from corpus files by line range
 *
 * Tracks which lines each agent has already read and returns only
 * the unread portions, preventing redundant context inflation.
 * Line ranges typically come from {@link SearchTool} results.
 *
 * Uses {@link subtractRanges} and {@link mergeRanges} internally
 * to maintain per-agent read tracking keyed by `agentId:filename`.
 *
 * @category Rig
 */
export class ReadFileTool extends Tool<{ filename: string; startLine?: number; endLine?: number }> {
  readonly name = 'read_file';
  readonly description = 'Read content from a file at specific line ranges. Use startLine/endLine from search results.';
  readonly parameters: JsonSchema;

  private _resources: Resource[];
  private _readRanges = new Map<string, [number, number][]>();

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

  *execute(
    args: { filename: string; startLine?: number; endLine?: number } & Record<string, unknown>,
    context?: ToolContext,
  ): Operation<unknown> {
    const filename = args.filename || (args.path as string) || '';
    const file = this._resources.find(r => r.name === filename);
    if (!file) {
      return { error: `File not found: ${filename}. Available: ${this._resources.map(r => r.name).join(', ')}` };
    }

    const lines = file.content.split('\n');
    const s = Math.max(0, (args.startLine ?? 1) - 1);
    const e = Math.min(lines.length, args.endLine ?? Math.min(100, lines.length));

    const key = context ? `${context.agentId}:${filename}` : filename;
    const prev = this._readRanges.get(key) ?? [];
    const unread = subtractRanges([s, e], prev);

    if (unread.length === 0) {
      return { file: file.name, note: `Lines ${s + 1}-${e} already read` };
    }

    this._readRanges.set(key, mergeRanges([...prev, [s, e]]));

    const content = unread
      .map(([a, b]) => lines.slice(a, b).join('\n'))
      .join('\n...\n');

    return { file: file.name, content, lines: unread.map(([a, b]) => `${a + 1}-${b}`) };
  }
}
