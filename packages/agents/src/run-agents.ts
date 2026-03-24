import { scoped } from 'effection';
import type { Operation } from 'effection';
import { useAgentPool } from './agent-pool';
import type { AgentPoolOptions, AgentPoolResult } from './types';

/**
 * Run an agent pool with automatic branch cleanup on return
 *
 * Wraps {@link useAgentPool} in `scoped()` — agent branches are pruned
 * when the scope exits, before this operation returns. Use this when you
 * don't need to fork from agent branches after the pool completes.
 *
 * For multi-level tree topology (forking from agent branches for
 * verification or follow-up), use {@link useAgentPool} directly within
 * your own scope management.
 *
 * @param opts - Pool configuration: tasks, tools, sampling params, max turns
 * @returns Agent pool result (branches already pruned)
 *
 * @example Research agents with shared root
 * ```typescript
 * const pool = yield* withSharedRoot(
 *   { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
 *   function*(root, prefixLen) {
 *     return yield* runAgents({
 *       tasks: questions.map(q => ({
 *         systemPrompt: RESEARCH_PROMPT,
 *         content: q,
 *         tools: toolsJson,
 *         parent: root,
 *       })),
 *       tools: toolMap,
 *       maxTurns: 6,
 *     });
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function* runAgents(opts: AgentPoolOptions): Operation<AgentPoolResult> {
  return yield* scoped(function*() {
    return yield* useAgentPool({ pruneOnReport: true, ...opts });
  });
}
