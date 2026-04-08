import type { Operation } from 'effection';

/**
 * Sequential fold over an array where each iteration is an Effection Operation.
 *
 * Like `Array.reduce` but each step can yield to async operations, spawn
 * agents, or perform any Effection work. Used by harnesses to fold across
 * sources, accumulating findings and threading enriched questions forward.
 *
 * @param items - Array to fold over
 * @param init - Initial accumulator value
 * @param fn - Reducer function returning an Operation that produces the next accumulator
 * @returns Final accumulated value
 *
 * @example Fold across sources
 * ```typescript
 * const findings = yield* reduce(
 *   sources,
 *   { sections: [], questions },
 *   function*(acc, source, i) {
 *     const pool = yield* createAgentPool({ tasks: acc.questions, ... });
 *     return { sections: [...acc.sections, ...collected], questions: enriched };
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function* reduce<T, A>(
  items: T[],
  init: A,
  fn: (acc: A, item: T, i: number) => Operation<A>,
): Operation<A> {
  let acc = init;
  for (let i = 0; i < items.length; i++) {
    acc = yield* fn(acc, items[i], i);
  }
  return acc;
}
