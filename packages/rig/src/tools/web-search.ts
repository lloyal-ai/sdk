import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import type { SearchProvider, SearchResult } from './types';

export type { SearchProvider, SearchResult };

// ── Tavily provider (default) ───────────────────────────

/**
 * {@link SearchProvider} implementation backed by the Tavily search API.
 *
 * Reads the API key from the constructor argument or the
 * `TAVILY_API_KEY` environment variable. Throws at search time
 * if no key is available.
 *
 * @category Rig
 */
export class TavilyProvider implements SearchProvider {
  private _apiKey: string;

  constructor(apiKey?: string) {
    this._apiKey = apiKey || process.env.TAVILY_API_KEY || '';
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this._apiKey) throw new Error('TAVILY_API_KEY not set');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
    const data = await res.json() as { results: { title: string; url: string; content: string }[] };
    return data.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }
}

// ── WebSearchTool ───────────────────────────────────────

/**
 * Web search tool backed by a pluggable {@link SearchProvider}.
 *
 * Delegates to the provider's `search` method and returns an array
 * of {@link SearchResult} objects. Use alongside {@link FetchPageTool}
 * to let agents read full page content from promising results.
 *
 * @category Rig
 */
export class WebSearchTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'Search the web. Returns results with titles, snippets, and URLs. Use fetch_page to read full content of promising results.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  };

  private _provider: SearchProvider;
  private _topN: number;

  constructor(provider: SearchProvider, topN = 8) {
    super();
    this._provider = provider;
    this._topN = topN;
  }

  *execute(args: { query: string }): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: 'query must not be empty' };

    const provider = this._provider;
    const topN = this._topN;
    try {
      return yield* call(() => provider.search(query, topN));
    } catch (err) {
      return { error: `Search failed: ${(err as Error).message}` };
    }
  }
}
