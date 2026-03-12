import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import { Ctx } from './context';
import type { GenerateOptions, GenerateResult } from './types';

/**
 * Single-branch grammar-constrained generation as an Effection operation
 *
 * Creates a fresh branch (or forks from `opts.parent`), prefills the prompt,
 * generates to EOG, and prunes the branch. Uses {@link Branch}'s async
 * iterator — single-branch generation doesn't need batched commit.
 *
 * When `parent` is provided, the prompt is prefilled as a delta (with turn
 * separator) on a fork of the parent. This is the attention scratchpad
 * pattern: the fork sees the parent's context, attends to the prompt
 * content, generates a result, and is pruned — zero net KV cost.
 *
 * The branch is always cleaned up via try/finally, even on error or
 * scope cancellation.
 *
 * @param opts - Generation options (prompt, grammar, params, parse, parent)
 * @returns Generated text, token count, and optionally parsed result
 *
 * @example Grammar-constrained JSON generation
 * ```typescript
 * const plan = yield* generate({
 *   prompt: planPrompt,
 *   grammar: planGrammar,
 *   params: { temperature: 0.3 },
 *   parse: output => JSON.parse(output),
 * });
 * ```
 *
 * @example Attention scratchpad — fork, attend, extract, prune
 * ```typescript
 * const extracted = yield* generate({
 *   prompt: contentToAttend,
 *   grammar: extractionGrammar,
 *   parse: output => JSON.parse(output),
 *   parent: agentBranch,
 * });
 * // Fork is pruned — parent's KV unchanged
 * ```
 *
 * @category Agents
 */
export function* generate<T = unknown>(opts: GenerateOptions): Operation<GenerateResult<T>> {
  const ctx = yield* Ctx.expect();
  const samplerParams = opts.params ?? {};

  let branch: Branch;
  if (opts.parent) {
    branch = yield* call(() => opts.parent!.fork());
    if (opts.grammar) branch.setGrammar(opts.grammar);
    const sep = ctx.getTurnSeparator();
    const delta: number[] = yield* call(() => ctx.tokenize(opts.prompt, false));
    yield* call(() => branch.prefill([...sep, ...delta]));
  } else {
    branch = Branch.create(ctx, 0, samplerParams, undefined, opts.grammar);
    const tokens = ctx.tokenizeSync(opts.prompt);
    yield* call(() => branch.prefill(tokens));
  }

  try {
    // Consume async iterator inside call() — generators can't use for-await
    const { output, tokenCount } = yield* call(async () => {
      let output = '';
      let tokenCount = 0;
      for await (const { text } of branch) {
        output += text;
        tokenCount++;
      }
      return { output, tokenCount };
    });

    const parsed = opts.parse ? opts.parse(output) as T : undefined;
    return { output, tokenCount, parsed };
  } finally {
    if (!branch.disposed) branch.pruneSync();
  }
}
