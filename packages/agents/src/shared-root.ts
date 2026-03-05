import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ctx } from './context';
import type { SamplingParams } from './types';

/**
 * Configuration for {@link withSharedRoot}
 *
 * @category Agents
 */
export interface SharedRootOptions {
  /** System prompt to tokenize and prefill into the shared root */
  systemPrompt: string;
  /** JSON-serialized tool schemas for tool-aware prompt formatting */
  tools?: string;
  /** Sampling parameters for the root branch */
  params?: SamplingParams;
}

/**
 * Scoped shared root branch with guaranteed cleanup
 *
 * Creates a root branch, prefills the system prompt, and passes it to
 * the body function. The root is pruned via try/finally when the body
 * returns or throws, regardless of whether children still exist.
 *
 * Use this for the cold-path pattern where multiple agents share a
 * tokenized system prompt prefix. The `sharedPrefixLength` passed to
 * the body enables KV savings calculation.
 *
 * @param opts - System prompt, tools, and sampling parameters
 * @param body - Operation that receives the root branch and prefix length.
 *   Typically calls {@link runAgents} or {@link useAgentPool} inside.
 * @returns The body's return value
 *
 * @example Cold-path research with shared prefix
 * ```typescript
 * const { result, prefixLen } = yield* withSharedRoot(
 *   { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
 *   function*(root, prefixLen) {
 *     const result = yield* runAgents({
 *       tasks: questions.map(q => ({
 *         systemPrompt: RESEARCH_PROMPT,
 *         content: q,
 *         tools: toolsJson,
 *         parent: root,
 *       })),
 *       tools: toolMap,
 *     });
 *     return { result, prefixLen };
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function* withSharedRoot<T>(
  opts: SharedRootOptions,
  body: (root: Branch, sharedPrefixLength: number) => Operation<T>,
): Operation<T> {
  const ctx: SessionContext = yield* Ctx.expect();

  const messages = [{ role: 'system', content: opts.systemPrompt }];
  const fmtOpts = opts.tools
    ? { tools: opts.tools, addGenerationPrompt: false }
    : { addGenerationPrompt: false };
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  const sharedTokens = ctx.tokenizeSync(fmt.prompt);

  const root = Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });
  yield* call(() => root.prefill(sharedTokens));

  try {
    return yield* body(root, sharedTokens.length);
  } finally {
    if (!root.disposed) root.pruneSubtreeSync();
  }
}
