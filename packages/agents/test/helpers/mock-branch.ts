/**
 * Minimal Branch stub for unit tests.
 * No real KV — just tracks position, forkHead, disposed state.
 */
export function createMockBranch(opts?: {
  position?: number;
  forkHead?: number;
  disposed?: boolean;
  handle?: number;
}) {
  let disposed = opts?.disposed ?? false;
  let position = opts?.position ?? 0;

  return {
    handle: opts?.handle ?? 1,
    get position() { return position; },
    set position(v: number) { position = v; },
    forkHead: opts?.forkHead ?? 0,
    get disposed() { return disposed; },
    perplexity: 1.0,
    samplingPerplexity: 1.0,
    modelEntropy: () => 0.5,
    modelSurprisal: () => 1.0,
    forkSync() { return createMockBranch({ position, forkHead: position, handle: (opts?.handle ?? 1) + 1000 }); },
    pruneSync() { disposed = true; },
    /** Mock async iterator — yields from a pre-set token sequence, then stops. */
    _tokens: [] as Array<{ token: number; text: string }>,
    async *[Symbol.asyncIterator](): AsyncIterableIterator<{ token: number; text: string }> {
      for (const t of this._tokens) {
        yield t;
      }
    },
  };
}
