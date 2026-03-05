import type { Branch } from './Branch';
import type { SessionContext } from './types';

/**
 * High-throughput multi-branch decode operations
 *
 * The naive approach to N-branch generation is N sequential llama_decode()
 * calls — each paying full GPU kernel launch overhead, memory barrier, and
 * PCIe round-trip. BranchStore eliminates this by packing all branches into
 * a single llama_batch and dispatching once: O(1) GPU round-trips regardless
 * of branch count. The GPU parallelizes across sequences within the batch,
 * so N branches approach the wall-time cost of 1.
 *
 * Two operations, two packing strategies:
 *
 * **commit()** — Generation step. Each branch contributes exactly 1 token.
 * Packs N tokens into a single batch via `decode_each` (one row per sequence,
 * all at their respective positions). Single `llama_decode()` call. Logits
 * captured per-branch at batch index `i`. O(N) total work, O(1) GPU
 * dispatches, O(1) amortized dispatch overhead per branch. Accept-first
 * ordering with rollback: accepts each token into its branch's repeat-penalty
 * window before decode, restores from clones if decode throws.
 *
 * **prefill()** — Bulk token injection. Each branch contributes a
 * variable-length token array. Uses a two-pass bin-packing algorithm:
 *
 * - *Pass 1 (planning)*: Greedy first-fit packs items into chunks ≤ nBatch.
 *   Items larger than nBatch get a dedicated chunk and fall through to
 *   decode_many's internal auto-chunking (ceil(nTokens / nBatch) calls).
 * - *Pass 2 (dispatch)*: Normal chunks dispatch via `decode_scatter` (one
 *   `llama_decode` per chunk). Logits are indexed by flattened cursor
 *   position: for item k in a chunk, logits live at `cursor + nTokens[k] - 1`.
 *
 * For T total tokens across N branches with batch capacity B:
 * - Best case (T ≤ B): 1 GPU dispatch, all branches in one batch.
 * - Worst case: ceil(T / B) dispatches. Each dispatch is fully packed.
 * - Amortized per-token GPU overhead: O(1/B) — vanishes as batch fills.
 *
 * Does NOT accept tokens into the sampler penalty window — use for
 * external/replayed tokens where repeat-penalty tracking is unwanted.
 * For model-generated tokens, use {@link commit} instead.
 *
 * Both methods take `[branch, token(s)]` tuples — the branch-to-token
 * binding is structural, not positional. After either call, each branch's
 * logits snapshot is updated with the output distribution from its decoded
 * token(s), ready for the next `produce()`/`sample()` call.
 *
 * @example 32-branch generation step — one GPU dispatch
 * ```typescript
 * const store = new BranchStore(ctx);
 * const entries = await Promise.all(branches.map(async b => [b, (await b.produce()).token] as [Branch, number]));
 * await store.commit(entries);  // 32 tokens, 1 llama_decode()
 * ```
 *
 * @example Best-of-N with batched commit
 * ```typescript
 * const store = new BranchStore(ctx);
 * const branches = [];
 * for (const _ of [1, 2, 3]) branches.push(await root.fork());
 *
 * for (let step = 0; step < 50; step++) {
 *   const produced = await Promise.all(branches.map(async b => [b, await b.produce()] as const));
 *   const live = produced.filter(([, p]) => !p.isStop);
 *   if (!live.length) break;
 *   await store.commit(live.map(([b, p]) => [b, p.token]));
 * }
 * ```
 *
 * @example Asymmetric prefill — variable-length injections, auto-chunked
 * ```typescript
 * await store.prefill([
 *   [branchA, systemPromptTokens],   // 200 tokens
 *   [branchB, shortQueryTokens],     //  12 tokens
 *   [branchC, longDocumentTokens],   // 800 tokens
 * ]);
 * // Bin-packed into ceil(1012 / nBatch) GPU dispatches
 * ```
 *
 * @category Branching
 */
export class BranchStore {
  private _ctx: SessionContext;

  constructor(ctx: SessionContext) {
    this._ctx = ctx;
  }

  /**
   * Batched single-token commit for model-generated tokens
   *
   * Each tuple `[branch, token]` binds one token to one branch.
   * Accepts each token into its branch's repeat-penalty window (for correct
   * PPL measurement), then decodes all N tokens in a single llama_decode()
   * call via decode_each and captures logits per-branch. Accept-first
   * ordering with rollback: if decode throws, sampler/grammar/metrics are
   * restored from clones taken before the accept.
   *
   * @param entries - Array of `[branch, token]` tuples (branches must not be disposed)
   * @throws If any branch is disposed
   */
  async commit(entries: [Branch, number][]): Promise<void> {
    const handles: number[] = [];
    const tokens: number[] = [];
    for (const [branch, token] of entries) {
      if (branch.disposed) throw new Error('BranchStore.commit: branch is disposed');
      handles.push(branch.handle);
      tokens.push(token);
    }
    await this._ctx._storeCommit(handles, tokens);
  }

  /**
   * Batched variable-length prefill for external tokens
   *
   * Each tuple `[branch, tokens]` binds a token array to one branch.
   * Each branch can receive a different number of tokens — decode_scatter
   * handles variable-length runs and auto-chunks to fit nBatch.
   *
   * Does NOT call accept_token — use for external/replayed tokens where
   * repeat-penalty tracking is unwanted. For model-generated tokens,
   * use {@link commit} instead.
   *
   * @param entries - Array of `[branch, tokens]` tuples (branches must not be disposed)
   * @throws If any branch is disposed
   */
  async prefill(entries: [Branch, number[]][]): Promise<void> {
    const handles: number[] = [];
    const tokenArrays: number[][] = [];
    for (const [branch, tokens] of entries) {
      if (branch.disposed) throw new Error('BranchStore.prefill: branch is disposed');
      handles.push(branch.handle);
      tokenArrays.push(tokens);
    }
    await this._ctx._storePrefill(handles, tokenArrays);
  }

  /**
   * Retain only the winner branch — evict all other leases and free their slots.
   *
   * Nuclear operation: calls `kv::seq_keep` on the winner's seq_id (stripping all
   * other sequences from KV cache in a single pass), then frees all loser slots
   * and rebuilds the vacancy list. The winner's topology is reset (no parent, no children).
   *
   * @param winner - The branch to keep (must not be disposed, must hold a lease)
   * @throws If winner is disposed or has no lease
   */
  async retainOnly(winner: Branch): Promise<void> {
    if (winner.disposed) throw new Error('BranchStore.retainOnly: winner is disposed');
    this._ctx._storeRetainOnly(winner.handle);
  }

  get available(): number {
    return this._ctx._storeAvailable();
  }
}
