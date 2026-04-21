import type { SessionContext } from './types';

/**
 * Options common to all delta builders.
 *
 * `enableThinking` controls whether the chat template delimits `<think>`
 * blocks. Despite its name, the flag is about template parsing, not about
 * whether the model reasons: many models (Qwen3 family) emit thinking
 * tokens regardless. Setting it `true` gives the template's generation
 * prompt the `<think>\n` prefix those models expect, so their thoughts
 * are correctly delimited and `parseChatOutput` can extract them from
 * visible response. Setting it `false` tells the template to omit think
 * tokens — appropriate when the downstream agent is expected not to think.
 *
 * **Default: undefined** — the delta builder does NOT pass the flag to
 * `formatChatSync`, and the native template chooses (typically `true`).
 * Callers who want `false` must pass it explicitly.
 *
 * This preserves compatibility with thinking-capable models. Hardcoding
 * `false` at the delta-builder layer caused tool-result prefills to corrupt
 * the KV cache for Qwen3-style models: the template omitted the think
 * generation prompt, the model still emitted think tokens, and those
 * tokens leaked into raw output.
 *
 * @category Agents
 */
export interface DeltaOpts {
  enableThinking?: boolean;
}

/**
 * Build a token delta for a user turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. Usable with any
 * branch — not tied to {@link Session}'s trunk.
 *
 * This is the canonical way to build a user-turn delta for warm prefill
 * in multi-turn conversations.
 *
 * @param ctx - Active session context
 * @param content - User message content
 * @param opts - Optional tools JSON for tool-aware formatting + thinking flag
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildUserDelta(
  ctx: SessionContext,
  content: string,
  opts: { tools?: string } & DeltaOpts = {}
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.tools) fmtOpts.tools = opts.tools;
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content }]),
    fmtOpts
  );
  const delta = ctx.tokenizeSync(prompt, false);
  return [...sep, ...delta];
}

/**
 * Build a token delta for a complete user+assistant conversation turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. The canonical way to
 * extend any branch (trunk, shared root, or spine) with a completed turn.
 *
 * Used by {@link Session.commitTurn} to persist query/response to the trunk,
 * and by `PoolContext.extendRoot` in the agent pool to chain per-task
 * findings onto the research spine.
 *
 * @param ctx - Active session context
 * @param userContent - User message content (the question/task)
 * @param assistantContent - Assistant response content (the answer/findings)
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildTurnDelta(
  ctx: SessionContext,
  userContent: string,
  assistantContent: string,
  opts: DeltaOpts = {},
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ]),
    fmtOpts,
  );
  return [...sep, ...ctx.tokenizeSync(prompt, false)];
}

/**
 * Build a token delta for a tool result turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. Used by
 * {@link useAgentPool} to inject tool results back into agent context.
 *
 * For templates that require a user message (e.g. Qwen 3.5), the native layer
 * (`chat_in::format`) retries with a synthetic user and strips it, so the
 * caller always receives correctly formatted output.
 *
 * @param ctx - Active session context
 * @param resultStr - JSON-serialized tool result
 * @param callId - Tool call identifier from the model's parsed output
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildToolResultDelta(
  ctx: SessionContext,
  resultStr: string,
  callId: string,
  opts: DeltaOpts = {},
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt, generationPrompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: '' },
      { role: 'tool', content: resultStr, tool_call_id: callId },
    ]),
    fmtOpts,
  );
  const delta = ctx.tokenizeSync(prompt, false);
  // Append generation prompt (e.g. "<|im_start|>assistant\n<think>\n" for thinking models).
  // For non-thinking models this is "<|im_start|>assistant\n" which is already
  // included in prompt by formatChatSync. Tokenizing it again would double it,
  // so only append when it's NOT already a suffix of prompt.
  let genTokens: number[] = [];
  if (generationPrompt && !prompt.endsWith(generationPrompt)) {
    genTokens = ctx.tokenizeSync(generationPrompt, false);
  }
  return [...sep, ...delta, ...genTokens];
}
