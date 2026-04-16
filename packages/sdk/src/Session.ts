import { Branch } from './Branch';
import type { BranchStore } from './BranchStore';
import type { SessionContext } from './types';
import { buildUserDelta, buildToolResultDelta } from './deltas';

/**
 * Session - Trunk lifecycle + conversation delta helpers
 *
 * Owns the current "trunk" branch and provides promote() to crown a winner,
 * plus delta helpers that centralize the sep + formatChat + tokenize + prefill
 * pattern for injecting new turns into an ongoing conversation.
 *
 * Session does NOT own the SessionContext or BranchStore — the consumer
 * creates those and passes them in. dispose() prunes trunk only.
 *
 * @example
 * ```typescript
 * const session = new Session({ ctx, store });
 * session.trunk = initialBranch;
 *
 * // After verification, promote the best attempt
 * await session.promote(bestAttempt.branch);
 *
 * // Inject a user turn and generate
 * await session.prefillUser('What about X?');
 * for await (const { text } of session.trunk) {
 *   process.stdout.write(text);
 * }
 *
 * // Cleanup
 * await session.dispose();
 * ctx.dispose();
 * ```
 *
 * @category Branching
 */
export class Session {
  private _ctx: SessionContext;
  private _store: BranchStore;
  private _trunk: Branch | null;

  constructor({ ctx, store }: { ctx: SessionContext; store: BranchStore }) {
    this._ctx = ctx;
    this._store = store;
    this._trunk = null;
  }

  /** Current trunk branch */
  get trunk(): Branch | null {
    return this._trunk;
  }

  /** Assign initial trunk (no promote) */
  set trunk(branch: Branch | null) {
    this._trunk = branch;
  }

  /**
   * Promote a winner to trunk — retainOnly + reassign
   *
   * Safe even if winner is the only branch (resets topology, no-op on KV).
   */
  async promote(winner: Branch): Promise<void> {
    await this._store.retainOnly(winner);
    this._trunk = winner;
  }

  /**
   * Dispose trunk only — consumer owns ctx and other resources
   */
  async dispose(): Promise<void> {
    if (this._trunk && !this._trunk.disposed) {
      await this._trunk.prune();
    }
    this._trunk = null;
  }

  /**
   * Prefill a user turn into trunk
   *
   * @param content - User message content
   * @param opts - Optional tools JSON string
   */
  async prefillUser(content: string, opts: { tools?: string } = {}): Promise<void> {
    const tokens = buildUserDelta(this._ctx, content, opts);
    await this._trunk!.prefill(tokens);
  }

  /**
   * Prefill a tool result turn into trunk
   *
   * @param resultStr - JSON-stringified tool result
   * @param callId - Tool call ID
   */
  async prefillToolResult(resultStr: string, callId: string): Promise<void> {
    const tokens = buildToolResultDelta(this._ctx, resultStr, callId);
    await this._trunk!.prefill(tokens);
  }

  /**
   * Commit a query/response turn to the conversation trunk
   *
   * Handles warm/cold internally:
   * - **Warm** (trunk exists): appends turn separator + formatted delta to existing trunk
   * - **Cold** (no trunk): creates branch at position 0, prefills, promotes to trunk
   *
   * @param query - User message
   * @param response - Assistant response
   */
  async commitTurn(query: string, response: string): Promise<void> {
    const messages = [
      { role: 'user', content: query },
      { role: 'assistant', content: response },
    ];
    if (this._trunk) {
      const sep = this._ctx.getTurnSeparator();
      const { prompt } = this._ctx.formatChatSync(
        JSON.stringify(messages), { enableThinking: false },
      );
      const tokens = this._ctx.tokenizeSync(prompt, false);
      await this._trunk.prefill([...sep, ...tokens]);
    } else {
      const { prompt } = this._ctx.formatChatSync(
        JSON.stringify(messages), { enableThinking: false },
      );
      const tokens = this._ctx.tokenizeSync(prompt, false);
      const trunk = Branch.create(this._ctx, 0, {});
      await trunk.prefill(tokens);
      await this.promote(trunk);
    }
  }

  /**
   * Prefill the same content into trunk and a list of expert branches in one
   * batched dispatch.
   *
   * Used to align research agents to a new next-token task (e.g. "write the
   * synthesis report") before contrastive-decode synthesis. After this call,
   * every branch has fresh `logits_snapshot` reflecting its own KV history
   * plus the alignment tokens.
   *
   * @param content - Content to prefill (formatted as a user-role turn)
   * @param experts - Expert branches to align alongside trunk
   * @throws If trunk is not set
   */
  async prefillAligned(content: string, experts: Branch[]): Promise<void> {
    if (!this._trunk) {
      throw new Error('Session.prefillAligned: no trunk');
    }
    const tokens = buildUserDelta(this._ctx, content, {});
    const entries: [Branch, number[]][] = [
      [this._trunk, tokens],
      ...experts.map(e => [e, tokens] as [Branch, number[]]),
    ];
    await this._store.prefill(entries);
  }
}
