import { call } from "effection";
import type { Operation } from "effection";
import { Branch } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import { Ctx, Trace, TraceParent, ScratchpadParent, RootFmt } from "./context";
import { traceScope } from "./trace-scope";
import type { SamplingParams } from "./types";
import type { FormatConfig } from "./Agent";

/**
 * Configuration for {@link withSharedRoot}
 *
 * @category Agents
 */
export interface SharedRootOptions {
  /** Sampling parameters for the root branch */
  params?: SamplingParams;
  /**
   * Set ScratchpadParent context so tools can fork from the shared root
   * for scratchpad extraction (fork-attend-extract-prune pattern).
   * @default false
   */
  enableScratchpad?: boolean;
  /**
   * Fork root from this branch instead of creating at position 0.
   *
   * When provided, the root inherits the parent's full KV state —
   * every tool call, tool result, and generated token the parent
   * accumulated. Sub-agents forking from this root attend over the
   * parent's complete attention state (Continuous Context).
   *
   * When omitted, creates a fresh root at position 0 (cold start).
   */
  parent?: Branch;
  /**
   * When set, prefill the chat-format `[system + tools]` header onto the
   * root once at setup. Every agent forking from the root inherits these
   * tokens via `forkSync`'s metadata-only KV prefix-share — the role and
   * tool schemas appear ONCE in physical KV regardless of how many agents
   * the pool spawns.
   *
   * The resulting `FormatConfig` (parser/grammar/format/triggers) is set
   * on the {@link RootFmt} context so `setupAgent` can detect shared mode,
   * skip its own system+tools formatting, and inherit the dispatch-side
   * fmt from the root.
   *
   * Use this for orchestrators where every agent shares the same role —
   * chain-mode research pools, fanout-style same-role pools, etc. Mixed-
   * role workflows (research → compare → synthesize) keep using per-spec
   * `SpawnSpec.systemPrompt` and don't pass this option.
   */
  systemPrompt?: string;
  /**
   * JSON-serialized tool schemas to embed in the chat-format header
   * prefilled at setup. Format matches `FormatChatOptions.tools` — output
   * of `createToolkit(...).toolsJson`. Only applied when `systemPrompt` is
   * also set; ignored otherwise.
   */
  toolsJson?: string;
}

/**
 * Scoped shared root branch with guaranteed cleanup
 *
 * Creates (or forks) a root branch for the pool's agents to fork from.
 * The root is pruned via try/finally when the body returns or throws,
 * regardless of whether children still exist.
 *
 * Each agent's chat format (system + user + generation prompt) is rendered
 * fresh inside `setupAgent`, so this root carries no chat context itself —
 * it exists as the pool's branching point and as the spine that
 * `ctx.extendRoot` writes onto between tasks.
 *
 * **Cold path** (no `parent`): creates a root at position 0 with no prefill.
 * Agents fork at position 0; their full chat context lives in their own suffix.
 *
 * **Warm path** (`parent` provided): forks from parent and prefills a turn
 * separator so subsequent agent suffixes land on a clean turn boundary.
 * Sub-agents inherit the parent's full KV state via the fork.
 *
 * @param opts - Sampling parameters and optional parent branch
 * @param body - Operation that receives the root branch and prefix length.
 *   Typically calls {@link useAgentPool} inside.
 * @returns The body's return value
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
  try {
    const p = yield* TraceParent.get();
    if (p != null) parentTraceId = p;
  } catch {
    /* no parent — top level */
  }

  const scope = traceScope(tw, parentTraceId, "withSharedRoot", {
    hasParent: !!opts.parent,
  });

  // Warm path: fork from parent branch (inherits full KV state), prefill a
  // turn separator so the next agent's suffix lands on a clean boundary.
  // Cold path: create fresh root at position 0 with no prefill — agents
  // fork at 0 and carry their full chat context in their own suffix.
  let root: Branch;
  let prefillTokens: number[];

  if (opts.parent) {
    root = opts.parent.forkSync();
    prefillTokens = ctx.getTurnSeparator();
  } else {
    root = Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });
    prefillTokens = [];
  }

  tw.write({
    traceId: tw.nextId(),
    parentTraceId: scope.traceId,
    ts: performance.now(),
    type: "branch:create",
    branchHandle: root.handle,
    parentHandle: opts.parent?.handle ?? null,
    position: opts.parent ? opts.parent.position : 0,
    role: "sharedRoot",
  });

  if (prefillTokens.length > 0) {
    yield* call(() => root.prefill(prefillTokens));
    tw.write({
      traceId: tw.nextId(),
      parentTraceId: scope.traceId,
      ts: performance.now(),
      type: "branch:prefill",
      branchHandle: root.handle,
      tokenCount: prefillTokens.length,
      role: "sharedPrefix",
    });
  }

  // Shared role+tools mode: format the chat header once and prefill onto
  // the root. Agents forking from this root inherit system+tools tokens
  // via metadata-only prefix-share (no per-spawn re-prefill). The resulting
  // FormatConfig is stashed on RootFmt so setupAgent can detect shared
  // mode and copy parser/grammar/format/triggers without re-emitting the
  // tool schemas in each agent's suffix.
  let rootFmt: FormatConfig | null = null;
  if (opts.systemPrompt !== undefined) {
    const messages = JSON.stringify([{ role: "system", content: opts.systemPrompt }]);
    const fmtOpts: Record<string, unknown> = {
      enableThinking: false,
      // Header ends at <|im_end|>; agents append <|im_start|>user…assistant
      // markers as their suffix. Without this, the template would emit a
      // trailing assistant generation prompt and corrupt the boundary.
      addGenerationPrompt: false,
    };
    if (opts.toolsJson) fmtOpts.tools = opts.toolsJson;
    const formatted = ctx.formatChatSync(messages, fmtOpts);
    const headerTokens = ctx.tokenizeSync(formatted.prompt, false);
    if (headerTokens.length > 0) {
      yield* call(() => root.prefill(headerTokens));
      tw.write({
        traceId: tw.nextId(),
        parentTraceId: scope.traceId,
        ts: performance.now(),
        type: "branch:prefill",
        branchHandle: root.handle,
        tokenCount: headerTokens.length,
        role: "sharedPrefix",
      });
    }
    rootFmt = {
      format: formatted.format,
      reasoningFormat: formatted.reasoningFormat,
      generationPrompt: formatted.generationPrompt,
      parser: formatted.parser,
      grammar: formatted.grammar,
      grammarLazy: formatted.grammarLazy,
      grammarTriggers: formatted.grammarTriggers,
      enableThinking: false,
    };
  }

  try {
    if (opts.enableScratchpad) yield* ScratchpadParent.set(root);
    if (rootFmt) yield* RootFmt.set(rootFmt);
    return yield* body(root, prefillTokens.length);
  } finally {
    if (!root.disposed) {
      tw.write({
        traceId: tw.nextId(),
        parentTraceId: scope.traceId,
        ts: performance.now(),
        type: "branch:prune",
        branchHandle: root.handle,
        position: 0,
      });
      root.pruneSubtreeSync();
    }
    scope.close();
  }
}
