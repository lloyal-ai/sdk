import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import { Ctx, Trace } from './context';
import { traceScope } from './trace-scope';
import type { GenerateOptions, GenerateResult } from './types';

/**
 * Prepare a branch for generation — create/fork, set grammar, prefill prompt
 *
 * Returns the prepared Branch ready for token production. The caller owns the
 * branch and decides how to consume it:
 *
 * - **Manual loop** — call `produceSync()` / `commit()` for per-token control,
 *   streaming UI updates, or integration into a batched tick loop
 * - **Async iterator** — `for await (const { text } of branch)` for convenience
 * - **Pass to `generate()`** — which calls `prepare()` internally
 *
 * The caller is responsible for pruning the branch when done.
 *
 * When `parent` is provided, forks from it and prefills the prompt as a delta
 * (with turn separator). Otherwise creates a fresh root branch.
 *
 * @param opts - Generation options (prompt, grammar, params, parent)
 * @returns Prepared Branch with prompt prefilled, ready for produce/commit
 *
 * @example Stream tokens to UI
 * ```typescript
 * const branch = yield* prepare({ prompt, grammar });
 * try {
 *   let output = '';
 *   while (true) {
 *     const { token, text, isStop } = branch.produceSync();
 *     if (isStop) break;
 *     yield* call(() => branch.commit(token));
 *     output += text;
 *     updateUI(text);  // per-token streaming
 *   }
 * } finally {
 *   if (!branch.disposed) branch.pruneSync();
 * }
 * ```
 *
 * @example Batch multiple prepared branches
 * ```typescript
 * const branches = [];
 * for (const task of tasks) {
 *   branches.push(yield* prepare({ prompt: task.prompt, grammar, parent: root }));
 * }
 * // Caller batches via BranchStore.commit() for continuous tree batching
 * ```
 *
 * @category Agents
 */
export function* prepare(opts: GenerateOptions): Operation<Branch> {
  const ctx = yield* Ctx.expect();
  const tw = yield* Trace.expect();
  const samplerParams = opts.params ?? {};
  const hasParent = !!opts.parent;

  const scope = traceScope(tw, null, 'prepare', { role: hasParent ? 'scratchpad' : 'root', hasGrammar: !!opts.grammar });

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

  scope.close();
  return branch;
}

/**
 * Single-branch grammar-constrained generation as an Effection operation
 *
 * Convenience wrapper over {@link prepare} — creates/forks a branch, prefills
 * the prompt, generates to EOG, parses the output, and prunes the branch.
 *
 * For per-token streaming or batched generation, use {@link prepare} directly
 * and run your own produce/commit loop.
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
 * @category Agents
 */
export function* generate<T = unknown>(opts: GenerateOptions): Operation<GenerateResult<T>> {
  const tw = yield* Trace.expect();
  const scope = traceScope(tw, null, 'generate', { hasGrammar: !!opts.grammar, hasParent: !!opts.parent });

  const branch = yield* prepare(opts);

  tw.write({
    traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
    type: 'generate:start', branchHandle: branch.handle,
    hasGrammar: !!opts.grammar, hasParent: !!opts.parent,
    role: opts.parent ? 'scratchpad' : 'root',
  });

  try {
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
