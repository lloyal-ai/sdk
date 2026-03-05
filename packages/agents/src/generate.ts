import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import { Ctx } from './context';
import type { GenerateOptions, GenerateResult } from './types';

/**
 * Single-branch grammar-constrained generation as an Effection operation
 *
 * Creates a fresh branch at position 0, prefills the prompt, generates
 * to EOG, and prunes the branch. Uses {@link Branch}'s async iterator
 * — single-branch generation doesn't need batched commit.
 *
 * The branch is always cleaned up via try/finally, even on error or
 * scope cancellation.
 *
 * @param opts - Generation options (prompt, grammar, params, parse)
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
 * console.log(plan.parsed); // typed result from parse()
 * ```
 *
 * @category Agents
 */
export function* generate<T = unknown>(opts: GenerateOptions): Operation<GenerateResult<T>> {
  const ctx = yield* Ctx.expect();

  const samplerParams = opts.params ?? {};
  const branch = Branch.create(ctx, 0, samplerParams, undefined, opts.grammar);

  try {
    const tokens = ctx.tokenizeSync(opts.prompt);
    yield* call(() => branch.prefill(tokens));

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
