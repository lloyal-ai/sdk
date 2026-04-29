# @lloyal-labs/lloyal-agents

Continuous Context agent runtime for the [lloyal HDK](https://github.com/lloyal-ai/hdk).

`lloyal-agents` runs multi-agent inference inside the decode loop. Instead of N independent model calls rebuilding the prompt each step, all agents advance inside one continuous decode process — forked from shared KV cache state, driven through a single GPU forward pass per tick, spawning sub-agents from their own live branches at arbitrary depth.

Built on [lloyal.node](https://github.com/lloyal-ai/lloyal.node), which provides forkable decode state and continuous tree batching over llama.cpp. `lloyal-agents` adds structured concurrency, tool dispatch, and a five-phase tick loop. Orchestration is not a layer above inference — it is inference.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lloyal-ai/hdk/main/assets/continuous-context-dark.svg">
  <img src="https://raw.githubusercontent.com/lloyal-ai/hdk/main/assets/continuous-context.svg" alt="Traditional Agents vs Continuous Context Agents — shared KV prefix, tool prefill, sub-agent spawning" width="100%">
</picture>

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node
```

`lloyal-agents` provides the agent runtime. [`lloyal.node`](https://github.com/lloyal-ai/lloyal.node) provides the native inference backend — prebuilt binaries for macOS (Metal, CPU), Linux (CPU, CUDA, Vulkan), and Windows (CPU, CUDA, Vulkan). Both are required. GPU selection at runtime.

## Public API

```typescript
import {
  initAgents,        // bootstrap: session, store, event channel
  useAgent, agent,   // single-agent helpers
  agentPool,         // multi-agent pool with a swappable orchestrator
  useAgentPool,      // lower-level Effection resource (advanced)
  diverge,           // multi-branch perplexity selection
  parallel, chain, fanout, dag, reduce,  // orchestrators / combinators
  withSharedRoot,    // scoped shared KV prefix with guaranteed teardown
  createToolkit,     // tool registry from Tool[] → toolMap + toolsJson
  Tool, Source,
  DefaultAgentPolicy,
  Ctx, Store, Events,
} from "@lloyal-labs/lloyal-agents";
```

## Bootstrap

```typescript
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { initAgents } from "@lloyal-labs/lloyal-agents";

main(function* () {
  const ctx = yield* call(() =>
    createContext({
      modelPath: "model.gguf",
      nCtx: 32768,
      nSeqMax: 8,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  yield* initAgents(ctx);
  // Ctx, Store, Events now set — useAgent(), agentPool(), diverge()
  // find them automatically. Session + context disposed on scope exit.
});
```

## Shared Frontier

When agents fork from a common branch, they inherit its KV cache — the full attention state up to the fork point. This boundary is the shared frontier: the last position where all agents had identical computational state.

Everything before the frontier is shared context. Everything after is independent reasoning. The model doesn't need to be told what the other agents know — it already attended over the same prefix. Communication happened at prefill time, through the attention mechanism, with zero serialization overhead.

```typescript
yield* withSharedRoot(
  { systemPrompt: SKILL_CATALOG, toolsJson: toolkit.toolsJson },
  function* (root) {
    // root is a prefilled branch — system prompt + tool schemas already in KV.
    // Every agent forked from root shares that prefix.
    return yield* agentPool({
      orchestrate: parallel(
        questions.map((q) => ({
          content: q,
          systemPrompt: WORKER_PROMPT,
        })),
      ),
      tools: [...sourceTools, reportTool],
      parent: root,
      terminalTool: "report",
    });
  },
);
```

`withSharedRoot` creates the prefix, passes it to the body, and guarantees cleanup via `try/finally` — the root branch cannot leak out of the block. Effection enforces the lifetime.

## Orchestrators

`agentPool` accepts an orchestrator that determines how agents are spawned and sequenced:

- **`parallel(specs[])`** — agents run concurrently from the shared root.
- **`chain(specs[], factory)`** — sequential, with `extendRoot` writing each task's findings onto the spine before the next forks.
- **`fanout(landscapeSpec, domainSpecs[])`** — landscape pass that informs N parallel domain agents.
- **`dag(nodes[])`** — arbitrary acyclic graph with multi-parent edges (Task-as-Future pattern).

Same `agentPool` call shape; the orchestrator argument changes the topology.

## In-Loop Orchestration

All active agents advance together in a five-phase tick loop:

**SPAWN+EXTEND.** The rendezvous point with the orchestrator fiber. Pending agent spawns and `extendRoot` calls are queued via Effection `action()` and drained at the start of each tick — batched into a single `store.prefill()`. Single-fiber discipline preserved across concurrent orchestrator extends.

**PRODUCE.** Every generating agent calls `produceSync()` — synchronous sampling with no async gap between agents. The entire produce phase is a single uninterrupted pass over the active set.

**COMMIT.** One `store.commit()` call packs all produced tokens into a single `llama_batch` and dispatches once. N branches, one GPU call.

**SETTLE.** Tool results that resolved during the prior DISPATCH are drained from a buffer. Each result is tokenized into a delta, budget-checked against a fresh `ContextPressure` snapshot, and batch-prefilled into the agent's branch. Grammar state resets. The agent transitions back to `generating`.

**DISPATCH.** Tool calls collected during PRODUCE are executed sequentially via `scoped()` + `call()`. Each tool runs to completion before the next begins. Tools return `Operation<unknown>`, so they can `yield*` into framework primitives like `useAgent` or `agentPool`, spawning recursive sub-agents within the calling agent's scope.

When no agent is generating and tools are still pending, the loop yields control until the next tool resolves. No polling. No sleep loops.

## Structured Concurrency DAG

Agent lifecycles are managed by [Effection](https://github.com/thefrontside/effection), a structured concurrency library for JavaScript. This is not optional sugar — it is load-bearing infrastructure. It is what makes recursive agents possible.

Every branch registers an `ensure()` callback at fork time:

```typescript
function* setupAgent(parent, task, ctx) {
  const branch = parent.forkSync();
  yield* ensure(() => {
    if (!branch.disposed) branch.pruneSync();
  });
  // ...
}
```

If the scope exits — error, cancellation, normal completion — the branch is pruned. Orphaned branches are structurally impossible. Tool dispatch uses `scoped()` + `call()`; each tool executes inside a scoped error boundary within the agent pool scope. If the scope tears down, pending tools are cancelled. The DAG is not imposed on the orchestration. It is intrinsic to the Effection task tree.

`useAgentPool` is an Effection `resource()` — it suspends via `provide()` after all agents complete, but keeps their branches alive. The caller can fork sub-agents from any completed agent's branch. Those sub-agents inherit the parent agent's full KV state — every tool result it consumed, every reasoning step it took. No summarization. No context window management. The sub-agent continues from the parent's frontier.

Recursive agents work at two levels. At the **harness level**, a completed pool's branches can be forked into follow-up pools. At the **model level**, a tool's `execute()` returns `Operation<unknown>`, so it can `yield*` directly into `useAgent` or `agentPool`. An agent that calls such a tool spawns sub-agents mid-generation — inside its own scope, inheriting its KV state, with cleanup guaranteed by structured concurrency. `DelegateTool` (from [`@lloyal-labs/rig`](../rig)) is the canonical implementation.

There is nothing in the framework that limits depth. Agents can spawn sub-agents that spawn sub-agents. An agent pool can run inside another agent pool's scope. The structured concurrency guarantees compose at every level.

## Hallucination Detection

The framework provides hallucination detection at two levels.

**Per-token observables.** Every branch exposes runtime-accessible signals on every step: `branch.modelEntropy()` (Shannon entropy of the full vocabulary distribution), `branch.modelSurprisal(token)` (surprisal of the chosen token: -log2(p)), `branch.perplexity` (model-level, from raw logits), and `branch.samplingPerplexity` (sampling-level, from the filtered distribution). The delta between model and sampling perplexity is itself a hallucination indicator — high sampling perplexity relative to model perplexity means the sampler is working against the model's probability mass.

Enable `trace: true` on agent pools to capture entropy and surprisal on every `agent:produce` event.

**Multi-branch semantic comparison.** `diverge()` forks N branches from a shared frontier, generates independently, and returns all outputs with their perplexity scores:

```typescript
const result = yield* diverge({
  parent: root,            // shared frontier
  attempts: 3,             // fork 3 branches
  params: { temperature: 0.7 },
});
// result.best — lowest-perplexity branch, still alive
// result.attempts — all branches with output, ppl, token count
// Losers already pruned. Winner's branch is the caller's responsibility.
```

The harness decides how to compare. `diverge()` returns all outputs with their perplexity scores — the harness can apply any equivalence measure: bigram overlap, embedding similarity, or model-based evaluation. Where branches agree, the model is confident; where they diverge, hallucination risk is high.

This directly operationalizes the semantic entropy work from Farquhar et al. ([Nature, 2024](https://www.nature.com/articles/s41586-024-07421-0)) — but as a runtime primitive, not a post-hoc metric. The key constraint: divergence from a common computational ancestor is signal. Divergence from independently-constructed contexts is sampling variance. This measurement is only meaningful because agents share a frontier.

## Session Accumulation

`Session.commitTurn(query, answer)` extends the trunk with a new query–answer pair. Future queries fork from this trunk — its KV cache already contains everything the prior turn established.

A cold query starts from position 0. A warm query starts from an existing trunk. Over multiple queries, the session compounds — each turn advances the frontier, and future agents inherit the accumulated state via attention.

The lower-level building blocks (`prefillUser`, `prefillToolResult`, `promote`) are also exposed for harnesses that orchestrate the trunk lifecycle directly.

## Context Pressure

KV cache is finite. `ContextPressure` snapshots the remaining budget on every tick and `DefaultAgentPolicy` enforces two thresholds:

- **softLimit** (default 1024 tokens remaining): SETTLE rejects tool results that would cross this floor. PRODUCE hard-cuts agents requesting non-terminal tool calls. Terminal tools (e.g. `report`) still pass — agents can always submit findings. INIT drops agents that don't fit above this floor.
- **hardLimit** (default 128 tokens remaining): agents killed immediately before `produceSync()`. No decode call is made below this line — it would crash.

Tool result prefill in the SETTLE phase is budget-gated against a fresh pressure snapshot. If a tool result doesn't fit, the agent is terminated rather than risking a context overflow mid-generation. The softLimit reserves space for downstream work — synthesis passes, verification.

```typescript
yield* agentPool({
  orchestrate: parallel(tasks),
  tools, terminalTool: "report",
  policy: new DefaultAgentPolicy({
    budget: { context: { softLimit: 2048 } }, // reserve 2K for downstream
  }),
});
```

## Tools

Tools are class-based with OpenAI-compatible function schemas:

```typescript
import { Tool } from "@lloyal-labs/lloyal-agents";
import { call } from "effection";
import type { Operation } from "effection";
import type { ToolContext } from "@lloyal-labs/lloyal-agents";

class SearchTool extends Tool<{ query: string }> {
  readonly name = "search";
  readonly description = "Semantic search over the corpus";
  readonly parameters = {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  };

  *execute(args: { query: string }, context?: ToolContext): Operation<unknown> {
    const results = yield* call(() => this.reranker.rank(args.query, this.chunks));
    return results.slice(0, 10);
  }
}
```

`createToolkit(tools)` aggregates tools into a `{ toolMap, toolsJson }` pair — `toolMap` for runtime dispatch, `toolsJson` for prompt formatting. With `withSharedRoot({ systemPrompt, toolsJson })`, the schemas are decoded once at the root and inherited by every fork — see the [skill catalog](https://docs.lloyal.ai/reference/skill-catalog) convention for mixed-role pools.

## Events

The runtime emits structured events for TUI, logging, or telemetry:

| Event                 | Payload                                                   |
| --------------------- | --------------------------------------------------------- |
| `agent:spawn`         | `agentId`, `parentAgentId`                                |
| `agent:produce`       | `agentId`, `text`, `tokenCount`, `entropy?`, `surprisal?` |
| `agent:tool_call`     | `agentId`, `tool`, `args`                                 |
| `agent:tool_result`   | `agentId`, `tool`, `result`                               |
| `agent:tool_progress` | `agentId`, `tool`, `filled`, `total`                      |
| `agent:report`        | `agentId`, `findings`                                     |
| `agent:done`          | `agentId`                                                 |

## Documentation

Full positioning, mechanics, learn pages, and reference at [docs.lloyal.ai](https://docs.lloyal.ai).

## License

Apache-2.0
