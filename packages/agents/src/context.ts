import { createContext } from 'effection';
import type { SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore, Branch } from '@lloyal-labs/sdk';
import type { Channel } from 'effection';
import type { AgentEvent } from './types';
import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';
import type { Agent, FormatConfig } from './Agent';

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
