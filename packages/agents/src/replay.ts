import { call, ensure } from 'effection';
import type { Operation } from 'effection';
import { Branch, buildTurnDelta } from '@lloyal-labs/sdk';
import { Ctx, Store } from './context';
import type { TraceEvent } from './trace-types';

/**
 * Serialized state needed to reconstruct a Branch deterministically.
 *
 * `seedPrompt` is the tokenized prompt that initialized a spine — the
 * full formatted chat template including system prompt and any tool schemas.
 * Captured from `prompt:format` events with `role: 'spine'`.
 *
 * `turns` is an ordered list of user/assistant turn pairs that were prefilled
 * on top of the spine via {@link extendSpine}. Empty for pool-start replay
 * (any orchestration shape that doesn't extend the spine — e.g. `parallel`);
 * populated for spine-extending orchestrations (`chain`, `fanout`, `dag`).
 *
 * @category Agents
 */
export interface BranchCheckpoint {
  seedPrompt: string;
  turns: Array<{ userContent: string; assistantContent: string }>;
}

/**
 * Extract the spine seed prompt from a trace, with no spine extensions.
 *
 * Useful for replaying parallel orchestrations, or for forking a fresh
 * agent off the same pool-start state for A/B experiments.
 *
 * @param events - parsed JSONL trace events, in emission order
 * @throws If no `prompt:format` event with `role: 'spine'` is found.
 *
 * @category Agents
 */
export function extractSpineSeed(events: TraceEvent[]): BranchCheckpoint {
  const seed = events.find(
    (e): e is Extract<TraceEvent, { type: 'prompt:format' }> =>
      e.type === 'prompt:format' && e.role === 'spine',
  );
  if (!seed) {
    throw new Error(
      'extractSpineSeed: no prompt:format event with role=spine found in trace',
    );
  }
  return { seedPrompt: seed.promptText, turns: [] };
}

/**
 * Extract a full spine checkpoint — spine seed prompt plus every
 * `spine:extend` event in emission order.
 *
 * When `opts.poolTraceId` is set, only spine extensions under that pool's
 * scope are included (useful when a trace contains multiple nested or
 * sequential pools with independent spines — typically the research pool
 * vs. a later synthesis pool, both extending their own spines).
 *
 * @param events - parsed JSONL trace events, in emission order
 * @param opts.poolTraceId - filter extensions to this pool's scope
 * @throws If no spine seed prompt is found.
 *
 * @category Agents
 */
export function extractSpineCheckpoint(
  events: TraceEvent[],
  opts: { poolTraceId?: number } = {},
): BranchCheckpoint {
  const seed = extractSpineSeed(events);
  const turns: BranchCheckpoint['turns'] = [];
  for (const e of events) {
    if (e.type !== 'spine:extend') continue;
    if (opts.poolTraceId != null && e.parentTraceId !== opts.poolTraceId) continue;
    turns.push({ userContent: e.userContent, assistantContent: e.assistantContent });
  }
  return { seedPrompt: seed.seedPrompt, turns };
}

/**
 * Materialize a Branch reflecting the checkpointed state.
 *
 * Creates a fresh spine at position 0 in the active `SessionContext`, prefills
 * the tokenized seed prompt, then applies each turn delta via `buildTurnDelta`
 * + `store.prefill`. Registers an `ensure()` so the subtree is pruned when
 * the caller's scope exits — lifetime follows the enclosing `scoped()` or
 * `resource()`, matching how `withSpine` manages its own spine.
 *
 * Pass the returned branch as `parent` to `agentPool` to run a replacement
 * stage (synth re-run, single-agent replay with modified prompt, etc.) against
 * the reconstructed KV state.
 *
 * @example Replay a pool-start (parallel orchestration) with a modified task
 * ```ts
 * const events = parseTrace(tracePath);
 * const checkpoint = extractSpineSeed(events);
 * const spine = yield* reconstructBranch(checkpoint);
 * yield* agentPool({
 *   parent: spine,
 *   orchestrate: parallel([{ content: modifiedTask, systemPrompt: modifiedSys }]),
 *   ...
 * });
 * ```
 *
 * @example Replay a spine-chain (research) state with a different synth prompt
 * ```ts
 * const events = parseTrace(tracePath);
 * const checkpoint = extractSpineCheckpoint(events);
 * const spine = yield* reconstructBranch(checkpoint);
 * yield* agentPool({
 *   parent: spine,
 *   orchestrate: parallel([{ content: SYNTHESIZE.user }]),
 *   systemPrompt: SYNTHESIZE.system,
 *   ...
 * });
 * ```
 *
 * @category Agents
 */
export function* reconstructBranch(checkpoint: BranchCheckpoint): Operation<Branch> {
  const ctx = yield* Ctx.expect();
  const store = yield* Store.expect();

  const spine = Branch.create(ctx, 0, {});
  yield* ensure(() => { if (!spine.disposed) spine.pruneSubtreeSync(); });

  const seedTokens = ctx.tokenizeSync(checkpoint.seedPrompt, false);
  yield* call(() => spine.prefill(seedTokens));

  for (const turn of checkpoint.turns) {
    const delta = buildTurnDelta(ctx, turn.userContent, turn.assistantContent);
    yield* call(() => store.prefill([[spine, delta]]));
  }

  return spine;
}
