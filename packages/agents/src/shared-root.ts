import { call } from "effection";
import type { Operation } from "effection";
import { Branch } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import { Ctx, Trace, TraceParent, ScratchpadParent } from "./context";
import { traceScope } from "./trace-scope";
import type { SamplingParams } from "./types";

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
   * accumulated. The system prompt is prefilled as a delta on top.
   * Sub-agents forking from this root attend over the parent's
   * complete attention state (Continuous Context).
   *
   * When omitted, creates a fresh root at position 0 (cold start).
   */
  parent?: Branch;
}

/**
 * Scoped shared root branch with guaranteed cleanup
 *
 * Creates (or forks) a root branch, prefills the system prompt, and passes
 * it to the body function. The root is pruned via try/finally when the body
 * returns or throws, regardless of whether children still exist.
 *
 * **Cold path** (no `parent`): creates root at position 0, prefills system
 * prompt. Use for top-level research where no prior context exists.
 *
 * **Warm path** (`parent` provided): forks from parent branch, prefills
 * system prompt as a delta. Sub-agents inherit the parent's full KV state.
 * Use for recursive tools (web_research, research) where sub-agents should
 * attend over the calling agent's accumulated evidence.
 *
 * @param opts - System prompt, tools, sampling parameters, and optional parent branch
 * @param body - Operation that receives the root branch and prefix length.
 *   Typically calls {@link runAgents} or {@link useAgentPool} inside.
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
    hasTools: !!opts.tools,
    systemPromptLength: opts.systemPrompt.length,
    hasParent: !!opts.parent,
  });

  const messages = [{ role: "system", content: opts.systemPrompt }];
  const fmtOpts: Record<string, unknown> = {
    addGenerationPrompt: false,
    enableThinking: false,
  };
  if (opts.tools) fmtOpts.tools = opts.tools;
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  const sharedTokens = ctx.tokenizeSync(fmt.prompt);

  tw.write({
    traceId: tw.nextId(),
    parentTraceId: scope.traceId,
    ts: performance.now(),
    type: "prompt:format",
    promptText: fmt.prompt,
    tokenCount: sharedTokens.length,
    messages: JSON.stringify(messages),
    tools: opts.tools,
    grammar: fmt.grammar || undefined,
    role: "sharedRoot",
  });

  // Warm path: fork from parent branch (inherits full KV state)
  // Cold path: create fresh root at position 0
  let root: Branch;
  let prefillTokens: number[];

  if (opts.parent) {
    root = opts.parent.forkSync();
    // Warm path: parent already has system prompt + tools in KV.
    // Only prefill turn separator — the prompt is inherited via fork.
    // This saves ~760 tokens per recursive fork.
    const sep = ctx.getTurnSeparator();
    prefillTokens = sep;
  } else {
    root = Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });
    prefillTokens = sharedTokens;
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

  try {
    if (opts.enableScratchpad) yield* ScratchpadParent.set(root);
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
