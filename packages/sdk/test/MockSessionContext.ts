/**
 * Type-safe in-memory SessionContext mock for testing.
 *
 * Implements the full {@link SessionContext} interface with a branch-tracking
 * state machine. All SDK classes ({@link Branch}, {@link BranchStore},
 * {@link Session}) work against this mock — only the native layer is
 * simulated.
 *
 * **What it provides:**
 * - Branch lifecycle: create, fork, prune with correct parent/child tracking
 * - Position tracking: advances on commit/prefill, forkHead set at fork time
 * - KV pressure: cellsUsed grows on commit/prefill, decrements on prune
 *   by `position - forkHead` (matching C++ BranchStore::release semantics)
 * - Chat formatting: simple stubs returning a format value > 1
 *   (passes the tool-calling support check in agent-pool.ts)
 * - Tokenization: deterministic ~1 token per 4 chars
 *
 * **Extension points (override in subclass or on instance):**
 * - `_branchSample(handle)` — control what tokens the "model" produces
 * - `parseChatOutput(output, format, opts)` — control parsed tool calls / content
 * - `tokenToText(token)` — control token-to-text mapping
 *
 * @example Direct usage
 * ```typescript
 * const { ctx, store, root } = createMockSdk({ nCtx: 8192 });
 * const child = root.forkSync();
 * const { token, text, isStop } = child.produceSync();
 * ```
 *
 * @example Override _branchSample for programmable output
 * ```typescript
 * const { ctx } = createMockSdk();
 * const tokens = [1, 2, 3, 999]; // 999 = stop
 * let i = 0;
 * ctx._branchSample = () => tokens[i++] ?? 999;
 * ```
 *
 * @category Testing
 */
import type {
  SessionContext,
  SamplingParams,
  ChatFormat,
  FormattedChatResult,
  FormatChatOptions,
  ParseChatOutputResult,
  ParseChatOutputOptions,
} from '../src/types';
import { Branch } from '../src/Branch';
import { BranchStore } from '../src/BranchStore';
import { Session } from '../src/Session';

/** Internal branch state tracked by the mock */
interface BranchState {
  position: number;
  forkHead: number;
  parentHandle: number;
  children: Set<number>;
  disposed: boolean;
}

export interface MockSessionContextOpts {
  /** Total KV cache capacity. Default: 16384 */
  nCtx?: number;
  /** Initial cells used. Default: 0 */
  cellsUsed?: number;
  /** Token ID treated as stop token. Default: 999 */
  stopToken?: number;
}

export class MockSessionContext implements SessionContext {
  // ── KV pressure state (mutable — configure before test run) ───
  nCtx: number;
  cellsUsed: number;

  /** Token ID that isStopToken returns true for */
  readonly stopToken: number;

  // ── Branch state machine ──────────────────────────────────────
  /** @internal exposed for subclass access */
  protected _nextHandle = 1;
  /** @internal exposed for subclass access */
  protected _branches = new Map<number, BranchState>();

  // ── Properties ────────────────────────────────────────────────
  readonly vocabSize = 32000;
  readonly memorySize = 0;

  constructor(opts?: MockSessionContextOpts) {
    this.nCtx = opts?.nCtx ?? 16384;
    this.cellsUsed = opts?.cellsUsed ?? 0;
    this.stopToken = opts?.stopToken ?? 999;
  }

  // ── Branch lifecycle ──────────────────────────────────────────

  _branchCreate(position: number, _params?: SamplingParams, _nBatch?: number, _grammar?: string): number {
    const handle = this._nextHandle++;
    this._branches.set(handle, {
      position,
      forkHead: 0,
      parentHandle: 0,
      children: new Set(),
      disposed: false,
    });
    return handle;
  }

  _branchFork(parentHandle: number): number {
    const parent = this._branches.get(parentHandle);
    if (!parent) throw new Error(`MockSessionContext._branchFork: unknown handle ${parentHandle}`);

    const handle = this._nextHandle++;
    parent.children.add(handle);
    this._branches.set(handle, {
      position: parent.position,
      forkHead: parent.position,
      parentHandle,
      children: new Set(),
      disposed: false,
    });
    return handle;
  }

  _branchPrune(handle: number): void {
    const b = this._branches.get(handle);
    if (!b) return;
    // Decrement cellsUsed by unique cells (matches C++ BranchStore::release)
    const unique = Math.max(0, b.position - b.forkHead);
    this.cellsUsed = Math.max(0, this.cellsUsed - unique);
    b.disposed = true;
    // Remove from parent's children
    if (b.parentHandle) {
      const parent = this._branches.get(b.parentHandle);
      if (parent) parent.children.delete(handle);
    }
  }

  _branchPruneSubtree(handle: number): void {
    const b = this._branches.get(handle);
    if (!b) return;
    const kids = Array.from(b.children);
    for (const child of kids) {
      this._branchPruneSubtree(child);
    }
    this._branchPrune(handle);
  }

  _branchChildren(handle: number): number[] {
    const b = this._branches.get(handle);
    if (!b) return [];
    return Array.from(b.children).filter(h => {
      const child = this._branches.get(h);
      return child && !child.disposed;
    });
  }

  // ── Produce/commit protocol ───────────────────────────────────

  /**
   * Sample next token. Override in subclass to control token production.
   * Default: always returns stopToken (immediate stop).
   */
  _branchSample(_handle: number): number {
    return this.stopToken;
  }

  _branchAccept(_handle: number, _token: number): void {}

  async _storeCommit(handles: number[], _tokens: number[]): Promise<void> {
    for (const h of handles) {
      const b = this._branches.get(h);
      if (b && !b.disposed) {
        b.position++;
        this.cellsUsed++;
      }
    }
  }

  async _storePrefill(handles: number[], tokenArrays: number[][]): Promise<void> {
    for (let i = 0; i < handles.length; i++) {
      const b = this._branches.get(handles[i]);
      if (b && !b.disposed) {
        b.position += tokenArrays[i].length;
        this.cellsUsed += tokenArrays[i].length;
      }
    }
  }

  // ── Branch state accessors ────────────────────────────────────

  _branchGetPosition(handle: number): number {
    return this._branches.get(handle)?.position ?? 0;
  }

  _branchGetPerplexity(_handle: number): number { return 1.0; }
  _branchGetSamplingPerplexity(_handle: number): number { return 1.0; }
  _branchModelEntropy(_handle: number, _base?: string): number { return 0.5; }
  _branchModelSurprisal(_handle: number, _token: number, _base?: string): number { return 1.0; }
  _branchGetLogits(_handle: number): Float32Array { return new Float32Array(1); }

  _branchForkHead(handle: number): number {
    return this._branches.get(handle)?.forkHead ?? 0;
  }

  _branchParent(handle: number): number {
    return this._branches.get(handle)?.parentHandle ?? 0;
  }

  _branchIsLeaf(handle: number): boolean {
    return this._branchChildren(handle).length === 0;
  }

  _branchIsActive(handle: number): boolean {
    const b = this._branches.get(handle);
    return b ? !b.disposed : false;
  }

  // ── KV pressure ───────────────────────────────────────────────

  _storeKvPressure(): { nCtx: number; cellsUsed: number; remaining: number } {
    return {
      nCtx: this.nCtx,
      cellsUsed: this.cellsUsed,
      remaining: this.nCtx - this.cellsUsed,
    };
  }

  _storeRetainOnly(_handle: number): void {}
  _storeAvailable(): number { return 15; }

  // ── Sampler / grammar (no-ops) ────────────────────────────────

  _branchSamplerChainReseed(_handle: number, _seed: number): void {}
  _branchSetSamplerParams(_handle: number, _params: SamplingParams): void {}
  _branchSetGrammar(_handle: number, _grammar: string): void {}
  _branchSetGrammarLazy(_handle: number, _grammar: string, _patterns: string[], _tokens: number[]): void {}
  _branchSetLogitBias(_handle: number, _biases: Array<{ token: number; bias: number }>): void {}
  _branchClearLogitBias(_handle: number): void {}
  _branchSteer(_handle: number, _biases: Array<{ token: number; bias: number }>): void {}
  _branchClearSteer(_handle: number): void {}

  // ── Token utilities ───────────────────────────────────────────

  isStopToken(token: number): boolean { return token === this.stopToken; }
  tokenToText(token: number): string { return `t${token}`; }
  getEogToken(): number { return this.stopToken; }
  getTurnSeparator(): number[] { return [0]; }

  // ── Tokenization ──────────────────────────────────────────────

  tokenizeSync(text: string, _addSpecial?: boolean): number[] {
    const len = Math.max(1, Math.ceil(text.length / 4));
    return Array.from({ length: len }, (_, i) => i + 1);
  }

  async tokenize(text: string, addSpecial?: boolean): Promise<number[]> {
    return this.tokenizeSync(text, addSpecial);
  }

  async detokenize(_tokens: number[]): Promise<string> {
    return 'detokenized';
  }

  // ── Chat formatting ───────────────────────────────────────────

  formatChatSync(msgs: string, _opts?: FormatChatOptions | string): FormattedChatResult {
    return {
      prompt: `<formatted>${msgs}</formatted>`,
      format: 2 as ChatFormat, // >1 to pass tool-calling support check
      reasoningFormat: 0,
      generationPrompt: '',
      parser: 'default',
      grammar: '',
      grammarLazy: false,
      grammarTriggers: [],
      stopTokens: [],
      preservedTokens: [],
    };
  }

  async formatChat(msgs: string, opts?: FormatChatOptions | string): Promise<FormattedChatResult> {
    return this.formatChatSync(msgs, opts);
  }

  parseChatOutput(output: string, _format: ChatFormat, _opts?: ParseChatOutputOptions): ParseChatOutputResult {
    return {
      content: output || '',
      reasoningContent: '',
      toolCalls: [],
    };
  }

  async jsonSchemaToGrammar(_schema: string): Promise<string> { return '{}'; }
  jsonSchemaToGrammarSync(_schema: string): string { return '{}'; }
  async validateChatTemplate(_template: string): Promise<boolean> { return true; }

  // ── Embeddings (stubs) ────────────────────────────────────────

  async encode(_tokens: number[]): Promise<void> {}
  getEmbeddings(_normalize?: boolean): Float32Array { return new Float32Array(0); }
  getEmbeddingDimension(): number { return 0; }
  hasPooling(): boolean { return false; }

  // ── KV cache operations (stubs) ───────────────────────────────

  kvCacheSize(_seqId?: number): number { return 0; }
  kvSeqPosMax(_seqId: number): number { return 0; }
  async kvCacheRemove(_seqId: number, _start: number, _end: number): Promise<void> {}
  async kvCacheClear(): Promise<void> {}
  kvSeqCopy(_src: number, _dst: number, _p0?: number, _p1?: number): void {}
  kvSeqKeep(_seqId: number): void {}
  async kvCacheSave(_seqId?: number): Promise<Buffer> { return Buffer.alloc(0); }
  async kvCacheLoad(_seqId: number, _state: Buffer): Promise<void> {}
  async kvCacheWriteFile(_seqId: number, _path: string, _tokens: number[]): Promise<number> { return 0; }
  async kvCacheReadFile(_seqId: number, _path: string): Promise<{ tokens: number[]; bytesRead: number }> {
    return { tokens: [], bytesRead: 0 };
  }
  async clearAndReseed(_sinks: number[], _tail: number[]): Promise<void> {}

  // ── Lifecycle ─────────────────────────────────────────────────

  dispose(): void {}

  // ── Scoring (stub) ────────────────────────────────────────────

  async _scoreGroup(_tokenArrays: number[][]): Promise<Float32Array[]> { return []; }

  // Unused by Branch but required by the interface
  _branchPrefill(_handle: number, _tokens: number[]): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Pre-wired SDK test environment.
 *
 * Returns real {@link Branch}, {@link BranchStore}, and {@link Session}
 * backed by a {@link MockSessionContext}. Override methods on `ctx` to
 * control behavior (e.g. `ctx._branchSample`, `ctx.parseChatOutput`).
 *
 * @example
 * ```typescript
 * const { ctx, store, session, root } = createMockSdk({ nCtx: 8192 });
 * const child = root.forkSync();
 * // override what "model" produces
 * let i = 0;
 * const tokens = [1, 2, 3, ctx.stopToken];
 * ctx._branchSample = () => tokens[i++] ?? ctx.stopToken;
 * ```
 *
 * @category Testing
 */
export interface MockSdk {
  ctx: MockSessionContext;
  store: BranchStore;
  session: Session;
  /** Root branch at position 0, ready for forking */
  root: Branch;
}

export function createMockSdk(opts?: MockSessionContextOpts): MockSdk {
  const ctx = new MockSessionContext(opts);
  const store = new BranchStore(ctx);
  const session = new Session({ ctx, store });
  const root = Branch.create(ctx, 0);
  return { ctx, store, session, root };
}
