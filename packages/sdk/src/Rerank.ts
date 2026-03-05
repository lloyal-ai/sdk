import type { SessionContext, RerankResult, RerankProgress } from './types';

const SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query ' +
  'and the Instruct provided. Note that the answer can only be "yes" or "no".';

const USER_PREFIX =
  '<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n\n' +
  '<Query>: ';

interface ScoringRequest {
  tokenArrays: number[][];
  cursor: number;
  scores: number[];
  filled: number;
  topK: number | undefined;
  total: number;
  push: (progress: RerankProgress) => void;
  finish: () => void;
  error: (err: Error) => void;
}

/** Simple async channel — _drain pushes, consumer pulls via for-await */
function channel<T>(): {
  push: (value: T) => void;
  finish: () => void;
  error: (err: Error) => void;
  iterable: AsyncIterable<T>;
} {
  const buffer: T[] = [];
  let done = false;
  let err: Error | null = null;
  let notify: (() => void) | null = null;

  const wait = () => new Promise<void>((r) => { notify = r; });

  return {
    push(value: T) {
      buffer.push(value);
      notify?.();
      notify = null;
    },
    finish() {
      done = true;
      notify?.();
      notify = null;
    },
    error(e: Error) {
      err = e;
      notify?.();
      notify = null;
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            while (buffer.length === 0 && !done && !err) await wait();
            if (err) throw err;
            if (buffer.length > 0) return { value: buffer.shift()!, done: false };
            return { value: undefined as unknown as T, done: true };
          },
        };
      },
    },
  };
}

export class Rerank {
  private _ctx: SessionContext;
  private _nSeqMax: number;
  private _nCtx: number;
  private _yesId: number;
  private _noId: number;
  private _prefixTokens: number[];
  private _midTokens: number[];
  private _suffixTokens: number[];
  private _pending: ScoringRequest[] = [];
  private _draining = false;
  private _disposed = false;

  private constructor(
    ctx: SessionContext,
    nSeqMax: number,
    nCtx: number,
    yesId: number,
    noId: number,
    prefixTokens: number[],
    midTokens: number[],
    suffixTokens: number[],
  ) {
    this._ctx = ctx;
    this._nSeqMax = nSeqMax;
    this._nCtx = nCtx;
    this._yesId = yesId;
    this._noId = noId;
    this._prefixTokens = prefixTokens;
    this._midTokens = midTokens;
    this._suffixTokens = suffixTokens;
  }

  /**
   * Create a Rerank instance from a pre-created SessionContext
   *
   * The caller is responsible for creating the context with appropriate
   * settings (nSeqMax, nCtx, typeK, typeV). Rerank takes ownership of
   * the context and will dispose it on `dispose()`.
   *
   * @param ctx - SessionContext configured for reranking
   * @param opts - Capacity hints (nSeqMax, nCtx) — must match context creation params
   */
  static async create(ctx: SessionContext, opts?: { nSeqMax?: number; nCtx?: number }): Promise<Rerank> {
    const nSeqMax = opts?.nSeqMax ?? 8;
    const nCtx = opts?.nCtx ?? ctx._storeKvPressure().nCtx;

    const [yesId] = await ctx.tokenize('yes', false);
    const [noId] = await ctx.tokenize('no', false);

    const SENTINEL_Q = '\x00QUERY\x00';
    const SENTINEL_D = '\x00DOC\x00';
    const probe = await ctx.formatChat(JSON.stringify([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${USER_PREFIX}${SENTINEL_Q}\n\n<Document>: ${SENTINEL_D}` },
    ]), { addGenerationPrompt: true, enableThinking: false });

    const p = probe.prompt;
    const qi = p.indexOf(SENTINEL_Q);
    const di = p.indexOf(SENTINEL_D);
    const prefixTokens = await ctx.tokenize(p.slice(0, qi), true);
    const midTokens = await ctx.tokenize(p.slice(qi + SENTINEL_Q.length, di), false);
    const suffixTokens = await ctx.tokenize(p.slice(di + SENTINEL_D.length), false);

    return new Rerank(ctx, nSeqMax, nCtx, yesId, noId, prefixTokens, midTokens, suffixTokens);
  }

  score(query: string, documents: number[][], topK?: number): AsyncIterable<RerankProgress> {
    if (this._disposed) throw new Error('Rerank disposed');

    const self = this;
    const ch = channel<RerankProgress>();

    (async () => {
      try {
        const queryTokens = await self._ctx.tokenize(query, false);
        const shared = [...self._prefixTokens, ...queryTokens, ...self._midTokens];
        const maxDoc = Math.floor(self._nCtx / self._nSeqMax) - shared.length - self._suffixTokens.length;

        const tokenArrays = documents.map((doc) => {
          const trimmed = doc.length > maxDoc ? doc.slice(0, maxDoc) : doc;
          return [...shared, ...trimmed, ...self._suffixTokens];
        });

        self._enqueue(tokenArrays, topK, ch.push, ch.finish, ch.error);
      } catch (err) {
        ch.error(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return ch.iterable;
  }

  async tokenize(text: string): Promise<number[]> {
    return this._ctx.tokenize(text, false);
  }

  dispose(): void {
    this._disposed = true;
    const err = new Error('Rerank disposed');
    for (const req of this._pending) req.error(err);
    this._pending.length = 0;
    this._ctx.dispose();
  }

  // ── Queue internals ──────────────────────────────────────────

  private _sortResults(scores: number[], topK: number | undefined): RerankResult[] {
    const sorted = scores
      .map((score, index) => ({ score: Math.round(score * 1000) / 1000, index }))
      .sort((a, b) => b.score - a.score);
    return topK != null ? sorted.slice(0, topK) : sorted;
  }

  private _enqueue(
    tokenArrays: number[][],
    topK: number | undefined,
    push: (progress: RerankProgress) => void,
    finish: () => void,
    error: (err: Error) => void,
  ): void {
    this._pending.push({
      tokenArrays, cursor: 0,
      scores: new Array(tokenArrays.length),
      filled: 0,
      topK,
      total: tokenArrays.length,
      push, finish, error,
    });
    this._drain();
  }

  private _fillGroup(): { reqIdx: number; promptIdx: number; tokens: number[] }[] {
    const group: { reqIdx: number; promptIdx: number; tokens: number[] }[] = [];
    let added = true;
    while (group.length < this._nSeqMax && added) {
      added = false;
      for (let r = 0; r < this._pending.length && group.length < this._nSeqMax; r++) {
        const req = this._pending[r];
        if (req.cursor < req.tokenArrays.length) {
          group.push({ reqIdx: r, promptIdx: req.cursor, tokens: req.tokenArrays[req.cursor] });
          req.cursor++;
          added = true;
        }
      }
    }
    return group;
  }

  private async _drain(): Promise<void> {
    if (this._draining) return;
    this._draining = true;

    try {
      while (this._pending.length > 0) {
        const group = this._fillGroup();
        if (group.length === 0) break;

        let logits: Float32Array[];
        try {
          logits = await this._ctx._scoreGroup(group.map((g) => g.tokens));
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const req of this._pending) req.error(error);
          this._pending.length = 0;
          return;
        }

        // Track which requests got new scores this group
        const touched = new Set<number>();
        for (let i = 0; i < group.length; i++) {
          const req = this._pending[group[i].reqIdx];
          req.scores[group[i].promptIdx] = this._rerankScore(logits[i]);
          req.filled++;
          touched.add(group[i].reqIdx);
        }

        // Push progress for each request that advanced, finish completed ones
        for (let r = this._pending.length - 1; r >= 0; r--) {
          const req = this._pending[r];
          if (!touched.has(r)) continue;

          const results = this._sortResults(req.scores, req.topK);
          req.push({ filled: req.filled, total: req.total, results });

          if (req.filled === req.total) {
            req.finish();
            this._pending.splice(r, 1);
          }
        }
      }
    } finally {
      this._draining = false;
    }
  }

  private _rerankScore(logits: Float32Array): number {
    const max = Math.max(logits[this._yesId], logits[this._noId]);
    const yesExp = Math.exp(logits[this._yesId] - max);
    const noExp = Math.exp(logits[this._noId] - max);
    return yesExp / (yesExp + noExp);
  }
}
