import { createContext } from 'effection';
import type { SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore, Branch } from '@lloyal-labs/sdk';
import type { Channel } from 'effection';
import type { AgentEvent } from './types';
import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';
import type { Agent, FormatConfig } from './Agent';
import type { Reranker } from './chunk';
import type { AppRegistry } from './app-types';
import type { AppConfigStore } from './app-config';

/**
 * Effection context holding the active {@link SessionContext}
 *
 * Set by {@link initAgents} in the caller's scope. All agent operations
 * (`useAgent`, `agentPool`, `useAgentPool`, `withSpine`, `diverge`) read from this
 * context via `yield* Ctx.expect()`.
 *
 * @category Agents
 */
export const Ctx = createContext<SessionContext>('lloyal.ctx');

/**
 * Effection context holding the active {@link BranchStore}
 *
 * Set by {@link initAgents}. Used by {@link diverge} and {@link useAgentPool}
 * for batched commit/prefill across multiple branches.
 *
 * @category Agents
 */
export const Store = createContext<BranchStore>('lloyal.store');

/**
 * Effection context holding the agent event channel
 *
 * Set by {@link initAgents}. {@link useAgentPool} emits {@link AgentEvent}
 * values through this channel via `yield* channel.send()`.
 *
 * @category Agents
 */
export const Events = createContext<Channel<AgentEvent, void>>('lloyal.events');

/**
 * Effection context holding the trace writer
 *
 * Set by {@link initAgents}. Defaults to {@link NullTraceWriter} (zero cost).
 * All agent operations read from this context to emit structured trace events.
 *
 * @category Agents
 */
export const Trace = createContext<TraceWriter>('lloyal.trace');

/**
 * Effection context carrying the current trace scope ID
 *
 * Used to build parent-child relationships across nested agent pools.
 * Set in DISPATCH before tool execution so inner pools inherit the
 * correct parent trace ID.
 *
 * @category Agents
 */
export const TraceParent = createContext<TraceId>('lloyal.traceParent');

/**
 * Effection context holding the scratchpad fork parent branch
 *
 * Set by {@link withSpine} to the current spine branch. Tools that
 * need scratchpad extraction (e.g. BufferingFetchPage, BufferingWebSearch)
 * read this via `yield* ScratchpadParent.expect()` to fork from the
 * innermost active spine — never a stale reference from a prior scope.
 *
 * @category Agents
 */
export const ScratchpadParent = createContext<Branch>('lloyal.scratchpadParent');

/**
 * Effection context holding the calling agent during DISPATCH
 *
 * Set by the pool before each tool execution in `scoped()`. Tools and
 * recursive `withSpine` calls read this to access the calling
 * agent's branch (for Continuous Context forking) and tool history
 * (for deduplication guards).
 *
 * Scope-isolated: each `scoped()` DISPATCH sees only its own agent.
 * Nested pools (web_research) shadow the parent's context correctly.
 *
 * @category Agents
 */
export const CallingAgent = createContext<Agent>('lloyal.callingAgent');

/**
 * Effection context holding the spine's pre-computed {@link FormatConfig}
 * when shared system+tools mode is active.
 *
 * Set by {@link withSpine} when its `systemPrompt` option is provided.
 * The chat-format header (system + tools) is prefilled onto the spine once at
 * setup; agents forking from the spine inherit those tokens via prefix-share
 * and need the matching parser/grammar/format/triggers to dispatch tool calls
 * correctly. Storing it here lets `setupAgent` detect shared mode and copy
 * the fmt without re-emitting tool schemas in each agent's suffix.
 *
 * Defaults to `null` so non-shared `withSpine` scopes leave it unset and
 * `setupAgent` falls back to formatting per-agent system+tools+user as today.
 *
 * @category Agents
 */
export const SpineFmt = createContext<FormatConfig | null>('lloyal.spineFmt', null);

/**
 * Effection context holding the harness-wide {@link Reranker}.
 *
 * Set by the harness once via `RerankerCtx.set(reranker)` after
 * `createReranker(...)`. App factories (`createWebApp`, `createCorpusApp`,
 * third-party apps) read this via `yield* RerankerCtx.expect()` at
 * construction time and pass it to their `Source` / search tools.
 *
 * Replaces the per-source `source.bind({reranker})` pattern — chunks
 * tokenized by one reranker can't be re-bound to another without
 * re-tokenization (RFC §6.3, §6.8), so one cross-encoder per harness
 * is the invariant.
 *
 * @category Contract
 */
export const RerankerCtx = createContext<Reranker>('lloyal.reranker');

/**
 * Effection context holding the {@link AppRegistry}.
 *
 * Set by `createAppRegistry(...)` (lives in `@lloyal-labs/rig`). The
 * scope-guard (RFC §5.3c) reads this at tool-dispatch time to resolve
 * the allowed-tools set for an App-assigned spawn — looking up
 * `registry.byName(spawn.assignedApp)` and matching the dispatched
 * `toolName` against `manifest.contract.tools`.
 *
 * The spine renderer also reads this to compose the catalog in
 * registration order.
 *
 * @category Contract
 */
export const AppRegistryCtx = createContext<AppRegistry>('lloyal.appRegistry');

/**
 * Effection context holding the harness's {@link AppConfigStore}.
 *
 * Set by `createAppRegistry({ configStore })` from its `configStore`
 * option, and seeded into each app's detached scope so factories can
 * read it. App factories read their own config via
 * `(yield* AppConfigStoreCtx.expect()).get(manifest.name)` at
 * construction time. The framework validates the stored config against
 * `app.manifest.configSchema` when the app is enabled.
 *
 * Whole-replace semantics on `set`; last-write-wins on concurrent
 * writes (RFC §5.6).
 *
 * @category Contract
 */
export const AppConfigStoreCtx = createContext<AppConfigStore>('lloyal.appConfigStore');
