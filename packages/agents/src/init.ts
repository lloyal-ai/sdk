import { ensure, createChannel, call } from 'effection';
import type { Operation, Channel } from 'effection';
import { BranchStore } from '@lloyal-labs/sdk';
import { Session } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ctx, Store, Events } from './context';
import type { AgentEvent } from './types';

/**
 * Handle returned by {@link initAgents} containing all agent resources
 *
 * @category Agents
 */
export interface AgentHandle<E = AgentEvent> {
  /** The session context (model, tokenizer, KV cache) */
  ctx: SessionContext;
  /** Branch store for batched commit/prefill across branches */
  store: BranchStore;
  /** Session managing conversation trunk and branch lifecycle */
  session: Session;
  /** Channel for subscribing to agent events */
  events: Channel<E, void>;
}

/**
 * Bootstrap the agent infrastructure and register structured cleanup
 *
 * Creates {@link BranchStore}, {@link Session}, and an event channel, then
 * sets all three Effection contexts ({@link Ctx}, {@link Store},
 * {@link Events}) in the caller's scope. Cleanup runs on scope exit
 * (Ctrl-C, error, normal completion) via `ensure()`.
 *
 * Context values are set in the caller's scope — visible to all subsequent
 * operations. This is why `initAgents` uses `ensure()` rather than
 * `resource()`: a resource creates a child scope where `Ctx.set()` would
 * be invisible to sibling operations.
 *
 * The caller creates the {@link SessionContext} (model path, nCtx, KV types
 * are harness-specific decisions) and passes it in.
 *
 * @param ctx - Session context created via `createContext()`
 * @returns Agent handle with session, store, and event channel
 *
 * @example Canonical bootstrap
 * ```typescript
 * main(function*() {
 *   const ctx = yield* call(() => createContext({
 *     modelPath, nCtx: 16384,
 *     nSeqMax: 4, typeK: 'q4_0', typeV: 'q4_0',
 *   }));
 *
 *   const { session, events } = yield* initAgents(ctx);
 *   // Ctx, Store, Events are now set — generate(), diverge(),
 *   // useAgentPool() will find them automatically.
 *   // Cleanup runs on scope exit.
 * });
 * ```
 *
 * @category Agents
 */
export function* initAgents<E = AgentEvent>(
  ctx: SessionContext,
): Operation<AgentHandle<E>> {
  const store = new BranchStore(ctx);
  const session = new Session({ ctx, store });
  const events: Channel<E, void> = createChannel<E, void>();

  yield* Ctx.set(ctx);
  yield* Store.set(store);
  yield* Events.set(events as unknown as Channel<AgentEvent, void>);

  yield* ensure(function*() {
    yield* call(() => session.dispose());
    ctx.dispose();
  });

  return { ctx, store, session, events };
}
