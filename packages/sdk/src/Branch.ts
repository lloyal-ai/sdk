import type { SessionContext, SamplingParams, Produced, GrammarTrigger } from './types';
import { GrammarTriggerType } from './types';

/**
 * Forkable inference handle for covalent generation
 *
 * A Branch owns everything needed for independent generation: a KV cache
 * sequence, sampler chain, logits snapshot, and perplexity tracker.
 *
 * Forking is cheap — the KV prefix is shared in memory (metadata-only operation under unified KV —
 * no KV tensor buffers are copied), so sibling branches read from the same physical KV entries.
 * Only tokens decoded after the fork point are exclusive to each branch.
 *
 * Branches form trees, not just flat lists. Fork from root for best-of-N,
 * fork from children for tree search/beam search, fork from a draft for speculative
 * decoding.
 *
 * The produce/commit protocol separates sampling from state advancement:
 * produce() samples without writing to KV, letting you inspect the result
 * before deciding to commit().
 *
 * @example Best-of-N with perplexity selection
 * ```typescript
 * const root = Branch.create(ctx, tokens.length, { temperature: 0.8 });
 * await root.prefill(tokens);
 *
 * const results = [];
 * for (let i = 0; i < 5; i++) {
 *   const branch = await root.fork();
 *   branch.reseedSampler(1000 + i);
 *   const tokens = [];
 *   for await (const { token } of branch) tokens.push(token);
 *   results.push({ branch, tokens, ppl: branch.perplexity });
 * }
 *
 * const best = results.reduce((a, b) => a.ppl < b.ppl ? a : b);
 * for (const r of results) { if (r !== best) await r.branch.prune(); }
 * ```
 *
 * @category Branching
 */
export class Branch {
  private _ctx: SessionContext;
  private _handle: number;
  private _disposed: boolean;

  constructor(ctx: SessionContext, handle: number) {
    this._ctx = ctx;
    this._handle = handle;
    this._disposed = false;
  }

  /**
   * Create a root branch at the given position
   *
   * The branch takes ownership of the sequence and creates its own sampler
   * chain from the provided params. Call prefill() to decode prompt tokens
   * and capture the logit distribution before forking.
   *
   * @param ctx - SessionContext to create branch on
   * @param position - Starting position (typically prompt token count)
   * @param params - Sampling parameters (temperature, topP, etc.)
   * @param nBatch - Per-branch batch size override (defaults to context nBatch).
   *   Controls chunk size for prefill(). Has no effect on
   *   single-token commit() which uses a zero-allocation fast path.
   * @param grammar - GBNF grammar string for constrained generation.
   *   When provided, sample() returns only grammar-valid tokens. The grammar state
   *   is cloned on fork(), so sibling branches can diverge independently.
   * @returns New Branch instance
   */
  static create(
    ctx: SessionContext,
    position: number,
    params?: SamplingParams,
    nBatch?: number,
    grammar?: string
  ): Branch {
    const handle = ctx._branchCreate(position, params, nBatch, grammar);
    return new Branch(ctx, handle);
  }

  /**
   * Fork this branch to a new sequence (async)
   *
   * Async contract: local branches resolve immediately; cloud branches
   * may perform an HTTP round-trip. Use {@link forkSync} when you know
   * the branch is local and want zero-overhead forking.
   *
   * @returns New forked Branch
   */
  async fork(): Promise<Branch> {
    return this.forkSync();
  }

  /**
   * Fork this branch to a new sequence (sync)
   *
   * The child shares the parent's KV prefix in memory (metadata-only under unified KV, no KV buffer copy).
   * Logits, sampler state, and perplexity tracker are cloned so the child
   * can diverge independently. Fork from any branch — root or intermediate —
   * to build arbitrarily deep trees.
   *
   * Call reseedSampler() on each child for stochastic diversity.
   *
   * @returns New forked Branch
   */
  forkSync(): Branch {
    this._ensureNotDisposed();
    const newHandle = this._ctx._branchFork(this._handle);
    return new Branch(this._ctx, newHandle);
  }

  /**
   * Get a copy of this branch's captured logits snapshot.
   *
   * Returns n_vocab floats — the raw logit distribution from the last
   * prefill() or commit() call.
   *
   * Returns an independent copy of the branch's internal snapshot.
   * The returned Float32Array is safe to hold across async boundaries
   * and is not affected by subsequent decode operations.
   *
   * @returns Independent copy of the logits snapshot (n_vocab elements)
   * @throws If no logits have been captured yet
   */
  getLogits(): Float32Array {
    this._ensureNotDisposed();
    return this._ctx._branchGetLogits(this._handle);
  }

  /**
   * Bulk-decode tokens into the branch's KV cache and capture logits.
   *
   * `tokens.length` is the total count to process; the branch's `nBatch`
   * (set at `Branch.create`) controls how many are sent per `llama_decode`
   * call. E.g. 500 tokens with `nBatch=64` → 8 calls (7×64 + 1×52).
   *
   * Advances `position` by `tokens.length`. Stores final logits into the
   * branch's internal snapshot — the next `produce()`/`sample()` reads
   * from it.
   *
   * Does NOT accept tokens into the repeat-penalty window — for external
   * tokens (user input between turns), not model-generated tokens.
   * For model output, use `commit()` which does accept + decode.
   *
   * The primary way to feed tokens into a branch's KV cache.
   *
   * @param tokens - Token IDs to decode
   */
  async prefill(tokens: number[]): Promise<void> {
    this._ensureNotDisposed();
    await this._ctx._branchPrefill(this._handle, tokens);
  }

  /**
   * Sample next token from branch's logits snapshot
   *
   * Applies the branch's full sampler chain (top-k, top-p, temperature,
   * repeat/presence penalties) to the captured logits.
   *
   * @returns Sampled token ID
   */
  sample(): number {
    this._ensureNotDisposed();
    return this._ctx._branchSample(this._handle);
  }

  /**
   * Record token in the sampler's repeat/presence penalty window
   *
   * @param token - Token to accept
   */
  accept(token: number): void {
    this._ensureNotDisposed();
    this._ctx._branchAccept(this._handle, token);
  }

  /**
   * Discard this branch (async)
   *
   * Async contract: local branches resolve immediately; cloud branches
   * may perform an HTTP round-trip. Use {@link pruneSync} when you know
   * the branch is local.
   *
   * RESTRICT mode: throws if children exist. Use {@link pruneSubtree} to
   * cascade-delete an entire subtree.
   */
  async prune(): Promise<void> {
    this.pruneSync();
  }

  /**
   * Discard this branch — remove its divergent KV entries and free the handle (sync)
   *
   * Only removes KV entries divergent from the shared prefix; sibling branches
   * are unaffected. The disposed flag is set synchronously — any call to
   * produce(), commit(), etc. after prune() will throw immediately.
   *
   * RESTRICT mode: throws if children exist. Use {@link pruneSubtreeSync} to
   * cascade-delete an entire subtree.
   */
  pruneSync(): void {
    if (this._disposed) return;
    const kids = this.children;
    if (kids.length > 0) {
      throw new Error(
        `Branch.prune(): branch ${this._handle} has ${kids.length} active child(ren) ` +
        `[${kids.join(', ')}]. Prune children first or use pruneSubtree().`,
      );
    }
    this._ctx._branchPrune(this._handle);
    this._disposed = true;
  }

  /**
   * Discard this branch and all its descendants (async)
   *
   * Async contract: local branches resolve immediately; cloud branches
   * may perform an HTTP round-trip. Use {@link pruneSubtreeSync} when you know
   * the branch is local.
   */
  async pruneSubtree(): Promise<void> {
    this.pruneSubtreeSync();
  }

  /**
   * Discard this branch and all its descendants — CASCADE delete (sync)
   *
   * Iterative post-order traversal: prunes children first, then this branch.
   * Use when tearing down an entire subtree (e.g. abandoned search path).
   * Sets disposed synchronously.
   */
  pruneSubtreeSync(): void {
    if (this._disposed) return;
    this._ctx._branchPruneSubtree(this._handle);
    this._disposed = true;
  }

  /**
   * Reseed the sampler's PRNG for diversity after fork()
   *
   * CRITICAL for parallel generation: Without reseeding, all forked branches
   * produce identical outputs because they share the same PRNG state.
   *
   * Only affects stochastic samplers (temperature > 0). Greedy samplers are unchanged.
   *
   * @param seed - New seed for the PRNG
   */
  reseedSampler(seed: number): void {
    this._ensureNotDisposed();
    this._ctx._branchSamplerChainReseed(this._handle, seed);
  }

  /**
   * Apply dynamic logit adjustments for this branch only
   *
   * Unlike `logit_bias` in sampling params (which is cloned on fork), steer biases
   * are NOT inherited by child branches. Each branch manages its own steer state
   * independently. This makes steer ideal for path-dependent constraints.
   *
   * **Use cases:**
   * - **tsampler**: Block tokens that would create repeated N-grams based on
   *   this branch's specific generation history
   * - **Diverse beam search**: Penalize tokens already chosen by sibling beams
   *   to encourage output diversity across the beam
   * - **Dynamic constraints**: Apply token restrictions that change per-step
   *
   * **Sampling order:** Grammar → Logit Bias → Steer → Sampler Chain
   *
   * @param biases - Array of token adjustments. Use `-Infinity` to completely
   *   block a token, positive values to boost probability, negative to reduce.
   *
   * @example Block tokens for N-gram deduplication (tsampler pattern)
   * ```ts
   * // Compute which tokens would create repeated 4-grams
   * const blocked = computeNgramBlocks(generatedTokens, n=4);
   *
   * // Block those tokens for this sample only
   * branch.steer(blocked.map(t => ({ token: t, bias: -Infinity })));
   *
   * const { token } = await branch.produce();  // Blocked tokens won't be sampled
   * await branch.commit(token);
   *
   * // Clear for next iteration (recompute based on new history)
   * branch.clearSteer();
   * ```
   *
   * @example Diverse beam search
   * ```ts
   * // Each beam penalizes tokens chosen by siblings this step
   * for (const beam of beams) {
   *   // Collect tokens chosen by other beams
   *   const siblingTokens = beams
   *     .filter(b => b !== beam && b.lastToken !== undefined)
   *     .map(b => b.lastToken);
   *
   *   // Penalize sibling choices to encourage diversity
   *   beam.branch.steer(siblingTokens.map(t => ({ token: t, bias: -2.0 })));
   *
   *   const { token } = await beam.branch.produce();
   *   await beam.branch.commit(token);
   *   beam.lastToken = token;
   *   beam.branch.clearSteer();
   * }
   * ```
   *
   * @example Boost specific tokens
   * ```ts
   * // Boost "yes" and "no" tokens for a yes/no question
   * branch.steer([
   *   { token: yesTokenId, bias: 5.0 },
   *   { token: noTokenId, bias: 5.0 }
   * ]);
   * ```
   */
  steer(biases: Array<{ token: number; bias: number }>): void {
    this._ensureNotDisposed();
    this._ctx._branchSteer(this._handle, biases);
  }

  /**
   * Clear all steer biases from this branch
   *
   * Removes any dynamic logit adjustments set by `steer()`. Call this after
   * each generation step if your steer constraints are computed per-step
   * (e.g., N-gram blocking where the blocked set changes as text grows).
   *
   * @example Per-step steer pattern
   * ```ts
   * for (let i = 0; i < maxTokens; i++) {
   *   // Compute constraints based on current state
   *   const blocked = computeConstraints(generatedTokens);
   *   branch.steer(blocked.map(t => ({ token: t, bias: -Infinity })));
   *
   *   const { token, isStop } = await branch.produce();
   *   if (isStop) break;
   *
   *   await branch.commit(token);
   *   branch.clearSteer();  // Reset for next iteration
   *   generatedTokens.push(token);
   * }
   * ```
   */
  clearSteer(): void {
    this._ensureNotDisposed();
    this._ctx._branchClearSteer(this._handle);
  }

  /**
   * Replace the sampler chain with new parameters (memoized)
   *
   * If the new params match the current chain's params, this is a no-op.
   * Otherwise the old chain is freed and a new one is created. Use for
   * Entropy-Driven Temperature (EDT) and other adaptive sampling strategies
   * that adjust parameters per-step.
   *
   * @param params - New sampling parameters
   *
   * @example Entropy-Driven Temperature
   * ```typescript
   * const entropy = branch.modelEntropy('nats');
   * branch.setSamplerParams({ temperature: edtTemperature(entropy) });
   * const { token } = await branch.produce();
   * await branch.commit(token);
   * ```
   */
  setSamplerParams(params: SamplingParams): void {
    this._ensureNotDisposed();
    this._ctx._branchSetSamplerParams(this._handle, params);
  }

  /**
   * Replace or remove the grammar constraint
   *
   * Pass a GBNF grammar string to constrain generation. Pass empty string
   * or undefined to remove the constraint. The grammar state is cloned on
   * fork(), so sibling branches can diverge independently after hot-swap.
   *
   * @param grammarStr - GBNF grammar string, or empty/undefined to remove
   *
   * @example Hot-swap grammar mid-generation
   * ```typescript
   * // Start unconstrained, then switch to JSON after detecting tool call
   * branch.setGrammar(jsonGrammar);
   * const { token } = await branch.produce();
   * ```
   */
  setGrammar(grammarStr?: string): void {
    this._ensureNotDisposed();
    this._ctx._branchSetGrammar(this._handle, grammarStr || '');
  }

  /**
   * Set lazy grammar — unconstrained until trigger, then grammar-constrained
   *
   * Generation runs freely until a trigger pattern or token fires, at which
   * point the grammar activates and constrains subsequent tokens. Used for
   * tool-call generation: model writes freely until `<tool_call>`, then
   * grammar forces valid XML structure.
   *
   * The grammar state is cloned on fork(), so sibling branches can diverge
   * independently. Call again after a tool result prefill to reset.
   *
   * @param grammar - GBNF grammar string
   * @param triggers - Trigger conditions from formatChat().grammarTriggers
   */
  setGrammarLazy(grammar: string, triggers: GrammarTrigger[]): void {
    this._ensureNotDisposed();
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns: string[] = [];
    const tokens: number[] = [];
    for (const t of triggers) {
      switch (t.type) {
        case GrammarTriggerType.WORD:
          patterns.push(escapeRegex(t.value));
          break;
        case GrammarTriggerType.PATTERN:
          patterns.push(t.value);
          break;
        case GrammarTriggerType.PATTERN_FULL: {
          const p = t.value;
          patterns.push((p[0] !== '^' ? '^' : '') + p + (p[p.length - 1] !== '$' ? '$' : ''));
          break;
        }
        case GrammarTriggerType.TOKEN:
          tokens.push(t.token);
          break;
      }
    }
    this._ctx._branchSetGrammarLazy(this._handle, grammar, patterns, tokens);
  }

  /**
   * Sample next token without advancing state (async)
   *
   * Async contract: local branches resolve immediately; cloud branches
   * may perform an HTTP round-trip. Use {@link produceSync} when you know
   * the branch is local and want zero-overhead sampling.
   */
  async produce(): Promise<Produced> {
    return this.produceSync();
  }

  /**
   * Sample next token without advancing state (sync)
   *
   * Same as {@link produce} but synchronous. Use when you know the branch
   * is local and want to avoid the microtick overhead of a promise.
   */
  produceSync(): Produced {
    this._ensureNotDisposed();
    const token = this.sample();
    return {
      token,
      text: this._ctx.tokenToText(token),
      isStop: this._ctx.isStopToken(token),
    };
  }

  /**
   * Accept and decode — update branch state, then write token to KV
   *
   * Accepts the token into the sampler penalty window (for correct PPL
   * measurement), then decodes (writing to KV cache via AsyncWorker on
   * the libuv thread pool) and captures the resulting logits for the next
   * produce() call. Accept-first ordering with rollback: if decode throws,
   * sampler/grammar/metrics are restored from clones.
   *
   * @param token Token to commit (from produce())
   */
  async commit(token: number): Promise<void> {
    this._ensureNotDisposed();
    await this._ctx._storeCommit([this._handle], [token]);
  }

  // ===== METRICS =====

  /**
   * Compute entropy of the branch's logits distribution
   *
   * Measures model uncertainty from the branch's captured logits snapshot:
   * - Low entropy: Model is confident (peaked distribution)
   * - High entropy: Model is uncertain (flat distribution)
   *
   * Operates directly on `state->logits_snapshot` — no JS round-trip.
   *
   * @param base - Logarithm base: "nats" (default) or "bits"
   * @returns Entropy value in specified base
   *
   * COST: O(n_vocab) - must sum over all token probabilities
   */
  modelEntropy(base: 'nats' | 'bits' = 'nats'): number {
    this._ensureNotDisposed();
    return this._ctx._branchModelEntropy(this._handle, base);
  }

  /**
   * Compute surprisal (negative log-likelihood) for a specific token
   *
   * Measures how "surprising" the model finds the given token from
   * the branch's captured logits snapshot:
   * - Low surprisal: Model expected this token (high probability)
   * - High surprisal: Model didn't expect this token (low probability)
   *
   * Operates directly on `state->logits_snapshot` — no JS round-trip.
   *
   * @param token - Token ID to compute surprisal for
   * @param base - Logarithm base: "nats" (default) or "bits"
   * @returns Surprisal value in specified base
   *
   * COST: O(n_vocab) - softmax normalization required
   */
  modelSurprisal(token: number, base: 'nats' | 'bits' = 'nats'): number {
    this._ensureNotDisposed();
    return this._ctx._branchModelSurprisal(this._handle, token, base);
  }

  /**
   * Sampling-level perplexity (from filtered distribution)
   *
   * Returns perplexity from the distribution actually sampled from
   * (after top-k/p/temp/penalties). Useful for policy priors and
   * monitoring sampler chain impact.
   *
   * Compare with {@link perplexity} which is model-level (raw logits).
   */
  get samplingPerplexity(): number {
    this._ensureNotDisposed();
    return this._ctx._branchGetSamplingPerplexity(this._handle);
  }

  /**
   * Set static logit biases on this branch
   *
   * Unlike {@link steer} (which is NOT inherited on fork), logit biases
   * ARE cloned when forking. Use for persistent constraints that should
   * propagate to child branches.
   *
   * Applied during sample() in order: Grammar -> Logit Bias -> Steer -> Sampler Chain
   *
   * @param biases - Array of token adjustments. Use `-Infinity` to block,
   *   positive to boost, negative to reduce.
   */
  setLogitBias(biases: Array<{ token: number; bias: number }>): void {
    this._ensureNotDisposed();
    this._ctx._branchSetLogitBias(this._handle, biases);
  }

  /**
   * Clear all static logit biases from this branch
   */
  clearLogitBias(): void {
    this._ensureNotDisposed();
    this._ctx._branchClearLogitBias(this._handle);
  }

  // ===== ACCESSORS =====

  /** Branch's current position (number of tokens decoded) */
  get position(): number {
    this._ensureNotDisposed();
    return this._ctx._branchGetPosition(this._handle);
  }

  /** Branch's perplexity (exp of mean surprisal) */
  get perplexity(): number {
    this._ensureNotDisposed();
    return this._ctx._branchGetPerplexity(this._handle);
  }

  /** Internal handle (for debugging) */
  get handle(): number {
    return this._handle;
  }

  /** Whether this branch has been disposed */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Parent branch handle, or null if root */
  get parent(): number | null {
    this._ensureNotDisposed();
    const h = this._ctx._branchParent(this._handle);
    return h === 0 ? null : h;
  }

  /** Child branch handles */
  get children(): number[] {
    this._ensureNotDisposed();
    return this._ctx._branchChildren(this._handle);
  }

  /** True if this branch has no children */
  get isLeaf(): boolean {
    this._ensureNotDisposed();
    return this._ctx._branchIsLeaf(this._handle);
  }

  /** True if this branch holds a KV lease */
  get isActive(): boolean {
    this._ensureNotDisposed();
    return this._ctx._branchIsActive(this._handle);
  }

  // ===== ASYNC ITERATION =====

  /**
   * Async iterator — generate tokens until EOG
   *
   * Commit-before-yield semantics: every yielded token is already written
   * to KV and accepted into the sampler. Breaking out of the loop is clean —
   * no orphaned uncommitted tokens, perplexity reflects all yielded tokens.
   *
   * For inspect-before-commit (speculative decoding, tree search), use
   * the {@link produce}/{@link commit} protocol directly.
   *
   * @example Generate to completion
   * ```typescript
   * for await (const { token, text } of branch) {
   *   process.stdout.write(text);
   * }
   * ```
   *
   * @example Generate with consumer-side bound
   * ```typescript
   * const tokens = [];
   * for await (const { token } of branch) {
   *   tokens.push(token);
   *   if (tokens.length >= limit) break;
   * }
   * ```
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<{ token: number; text: string }> {
    while (!this._disposed) {
      const { token, text, isStop } = await this.produce();
      if (isStop) return;
      await this.commit(token);
      yield { token, text };
    }
  }

  // ===== INTERNAL =====

  private _ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('Branch has been disposed');
    }
  }
}
