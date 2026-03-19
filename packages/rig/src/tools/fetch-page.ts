import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

/**
 * Fetch a web page and extract readable article content.
 *
 * Uses the Fetch API with a 10-second timeout, then extracts the
 * article body via linkedom + Readability. Content is truncated to
 * `maxChars` (default 6000). PDF URLs are rejected early since
 * binary content cannot be extracted as readable text.
 *
 * @category Rig
 */
export class FetchPageTool extends Tool<{ url: string }> {
  readonly name = 'fetch_page';
  readonly description = 'Fetch a web page and extract its article content. Returns readable text with title and excerpt. Use to read search results or follow links discovered in pages.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL to fetch' } },
    required: ['url'],
  };

  private _maxChars: number;

  constructor(maxChars = 6000) {
    super();
    this._maxChars = maxChars;
  }

  *execute(args: { url: string }): Operation<unknown> {
    const url = args.url?.trim();
    if (!url) return { error: 'url must not be empty' };

    // Early reject PDF URLs — can't extract readable content from binary PDF
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?') || lowerUrl.includes('.pdf#')) {
      return { error: 'PDF documents cannot be extracted. Try searching for an HTML version of this content.', url };
    }

    const maxChars = this._maxChars;
    return yield* call(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lloyal-agents/1.0)' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return { error: `Fetch failed: ${(err as Error).message}`, url };
      }

      if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}`, url };

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/pdf')) {
        return { error: 'PDF documents cannot be extracted. Try searching for an HTML version of this content.', url };
      }

      const html = await res.text();

      const { parseHTML } = await import('linkedom');
      const { document } = parseHTML(html);

      const { Readability } = await import('@mozilla/readability');
      const article = new Readability(document).parse();

      if (!article) return { url, content: '[Could not extract article content]' };

      let content = article.textContent ?? '';
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + '\n\n[truncated]';
      }

      return { url, title: article.title, content, excerpt: article.excerpt };
    });
  }
}
