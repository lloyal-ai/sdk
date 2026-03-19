import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import { Ctx, Trace } from './context';
import { traceScope } from './trace-scope';
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
  const tw = yield* Trace.expect();
  const samplerParams = opts.params ?? {};
  const hasParent = !!opts.parent;
  const role = hasParent ? 'scratchpad' : 'root';

  const scope = traceScope(tw, null, 'generate', { role, hasGrammar: !!opts.grammar });

  let branch: Branch;
  if (opts.parent) {
    branch = yield* call(() => opts.parent!.fork());
  } else {
    branch = Branch.create(ctx, 0, samplerParams, undefined, opts.grammar);
  }

  tw.write({
    traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
    type: 'branch:create', branchHandle: branch.handle,
    parentHandle: opts.parent?.handle ?? null,
    position: 0, role: hasParent ? 'scratchpad' : 'root',
  });

  try {
    let prefillCount: number;
    if (opts.parent) {
      if (opts.grammar) branch.setGrammar(opts.grammar);
      const sep = ctx.getTurnSeparator();
      const delta: number[] = yield* call(() => ctx.tokenize(opts.prompt, false));
      const tokens = [...sep, ...delta];
      prefillCount = tokens.length;
      yield* call(() => branch.prefill(tokens));
    } else {
      const tokens = ctx.tokenizeSync(opts.prompt);
      prefillCount = tokens.length;
      yield* call(() => branch.prefill(tokens));
    }

    tw.write({
      traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
      type: 'prompt:format', promptText: opts.prompt, tokenCount: prefillCount,
      messages: '', role: 'generate', grammar: opts.grammar,
    });
    tw.write({
      traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
      type: 'branch:prefill', branchHandle: branch.handle, tokenCount: prefillCount,
      role: hasParent ? 'scratchpad' : 'sharedPrefix',
    });
    tw.write({
      traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
      type: 'generate:start', branchHandle: branch.handle,
      hasGrammar: !!opts.grammar, hasParent, role,
    });

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

    tw.write({
      traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
      type: 'generate:end', branchHandle: branch.handle, tokenCount, output,
      parsed: parsed !== undefined ? parsed : undefined,
    });

    return { output, tokenCount, parsed };
  } finally {
    if (!branch.disposed) {
      tw.write({
        traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
        type: 'branch:prune', branchHandle: branch.handle, position: 0,
      });
      branch.pruneSync();
    }
    scope.close();
  }
}
