import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import type { Resource } from '../resources/types';

/**
 * Exhaustive regex search across all corpus resources
 *
 * Scans every line of every loaded {@link Resource} for matches
 * against a regular expression. Returns matching lines with file
 * names and line numbers, capped at 50 results. Complements
 * {@link SearchTool} which ranks by semantic relevance -- grep
 * finds exact patterns exhaustively.
 *
 * @category Rig
 */
export class GrepTool extends Tool<{ pattern: string; ignoreCase?: boolean }> {
  readonly name = 'grep';
  readonly description = 'Search the entire corpus for a regex pattern. Returns every matching line with line numbers and total match count. Complements search() which ranks by relevance — grep scans exhaustively.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (e.g. "\\bshor\\b" for whole-word, "hidden_secret" for literal)' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive matching (default: true)' },
    },
    required: ['pattern'],
  };

  private _resources: Resource[];
  private _maxResults: number;
  private _lineMaxChars: number;

  constructor(resources: Resource[], opts?: { maxResults?: number; lineMaxChars?: number }) {
    super();
    this._resources = resources;
    this._maxResults = opts?.maxResults ?? 50;
    this._lineMaxChars = opts?.lineMaxChars ?? 200;
  }

  *execute(args: { pattern: string; ignoreCase?: boolean }): Operation<unknown> {
    const pattern = args.pattern?.trim();
    if (!pattern) return { error: 'pattern must not be empty' };
    const flags = (args.ignoreCase === false) ? 'g' : 'gi';
    let re: RegExp;
    try { re = new RegExp(pattern, flags); }
    catch { return { error: `Invalid regex: ${pattern}` }; }

    const matches: { file: string; line: number; text: string }[] = [];
    let totalMatches = 0;

    for (const res of this._resources) {
      const lines = res.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hits = lines[i].match(re);
        if (hits) {
          totalMatches += hits.length;
          const raw = lines[i].trim();
          let text: string;
          const maxChars = this._lineMaxChars;
          if (raw.length <= maxChars) {
            text = raw;
          } else {
            const idx = raw.search(re);
            const start = Math.max(0, idx - 40);
            const end = Math.min(raw.length, start + maxChars);
            text = (start > 0 ? '\u2026' : '') + raw.slice(start, end) + (end < raw.length ? '\u2026' : '');
          }
          matches.push({ file: res.name, line: i + 1, text });
        }
      }
    }

    if (totalMatches === 0) {
      return {
        totalMatches: 0, matchingLines: 0, matches: [],
        note: 'Zero matches does NOT mean the topic is absent \u2014 only that this exact pattern was not found. Try search() for semantic matching or a broader/simpler regex.',
      };
    }

    const limit = this._maxResults;
    const truncated = matches.length > limit;
    return { totalMatches, matchingLines: matches.length, truncated, matches: matches.slice(0, limit) };
  }
}
