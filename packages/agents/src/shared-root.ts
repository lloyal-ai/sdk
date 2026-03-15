import { call } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ctx, Trace, TraceParent } from './context';
import { traceScope } from './trace-scope';
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
  const tw = yield* Trace.expect();

  // Read parent trace ID — connects nested pools to the outer DISPATCH that spawned them
  let parentTraceId: number | null = null;
  try { const p = yield* TraceParent.get(); if (p != null) parentTraceId = p; } catch { /* no parent — top level */ }

  const scope = traceScope(tw, parentTraceId, 'withSharedRoot', {
    hasTools: !!opts.tools,
    systemPromptLength: opts.systemPrompt.length,
  });

  const messages = [{ role: 'system', content: opts.systemPrompt }];
  const fmtOpts = opts.tools
    ? { tools: opts.tools, addGenerationPrompt: false }
    : { addGenerationPrompt: false };
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  const sharedTokens = ctx.tokenizeSync(fmt.prompt);

  tw.write({
    traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
    type: 'prompt:format', promptText: fmt.prompt, tokenCount: sharedTokens.length,
    messages: JSON.stringify(messages), tools: opts.tools, grammar: fmt.grammar || undefined,
    role: 'sharedRoot',
  });

  const root = Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });

  tw.write({
    traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
    type: 'branch:create', branchHandle: root.handle, parentHandle: null,
    position: 0, role: 'sharedRoot',
  });

  yield* call(() => root.prefill(sharedTokens));

  tw.write({
    traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
    type: 'branch:prefill', branchHandle: root.handle,
    tokenCount: sharedTokens.length, role: 'sharedPrefix',
  });

  try {
    return yield* body(root, sharedTokens.length);
  } finally {
    if (!root.disposed) {
      tw.write({
        traceId: tw.nextId(), parentTraceId: scope.traceId, ts: performance.now(),
        type: 'branch:prune', branchHandle: root.handle, position: 0,
      });
      root.pruneSubtreeSync();
    }
    scope.close();
  }
}
