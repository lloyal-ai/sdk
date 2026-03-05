import type { SessionContext } from './types';

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
 * @param opts - Optional tools JSON for tool-aware formatting
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildUserDelta(
  ctx: SessionContext,
  content: string,
  opts: { tools?: string } = {}
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts = opts.tools ? { tools: opts.tools } : {};
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content }]),
    fmtOpts
  );
  const delta = ctx.tokenizeSync(prompt, false);
  return [...sep, ...delta];
}

/**
 * Build a token delta for a tool result turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. Used by
 * {@link useAgentPool} to inject tool results back into agent context.
 *
 * @param ctx - Active session context
 * @param resultStr - JSON-serialized tool result
 * @param callId - Tool call identifier from the model's parsed output
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildToolResultDelta(
  ctx: SessionContext,
  resultStr: string,
  callId: string
): number[] {
  const sep = ctx.getTurnSeparator();
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: '' },
      { role: 'tool', content: resultStr, tool_call_id: callId },
    ])
  );
  const delta = ctx.tokenizeSync(prompt, false);
  return [...sep, ...delta];
}
