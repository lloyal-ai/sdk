# @lloyal-labs/lloyal-agents

Continuous Context agent runtime.

`lloyal-agents` runs multi-agent inference inside the decode loop. Instead of N independent model calls rebuilding the prompt each step, all agents advance inside one continuous decode process — forked from shared KV cache state, driven through a single GPU forward pass per tick, spawning sub-agents from their own live branches at arbitrary depth.

Built on [lloyal.node](https://github.com/lloyal-ai/lloyal.node), which provides forkable decode state and continuous tree batching over llama.cpp. `lloyal-agents` adds structured concurrency, tool dispatch, and a four-phase tick loop. Orchestration is not a layer above inference. It is inference.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lloyal-ai/sdk/main/assets/continuous-context-dark.svg">
  <img src="https://raw.githubusercontent.com/lloyal-ai/sdk/main/assets/continuous-context.svg" alt="API Agents vs Continuous Context — shared KV prefix, tool prefill, sub-agent spawning" width="100%">
</picture>

```bash
npm i @lloyal-labs/lloyal-agents
```

**Backends:** [lloyal.node](https://github.com/lloyal-ai/lloyal.node) — prebuilt binaries for macOS (Metal, CPU), Linux (CPU, CUDA, Vulkan), and Windows (CPU, CUDA, Vulkan). GPU selection at runtime.

The public API surface:

```typescript
import {
  initAgents, // bootstrap: session, store, event channel
  generate, // single-branch grammar-constrained generation
  diverge, // multi-branch perplexity selection
  useAgentPool, // concurrent agents as an Effection resource
  runAgents, // same, with automatic branch cleanup
  withSharedRoot, // scoped shared KV prefix with guaranteed teardown
  createToolkit, // tool registry from Tool[] → toolMap + toolsJson
  Ctx,
  Store,
  Events, // Effection contexts — implicit dependency resolution
} from "@lloyal-labs/lloyal-agents";
```

That is essentially the entire framework.

### Bootstrap

```typescript
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { initAgents } from "@lloyal-labs/lloyal-agents";

main(function* () {
  const ctx = yield* call(() =>
    createContext({
      modelPath: "model.gguf",
      nCtx: 16384,
      nSeqMax: 8,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  const { session, events } = yield* initAgents(ctx);
  // Ctx, Store, Events now set — generate(), diverge(),
  // useAgentPool() find them automatically.
  // Session + context disposed on scope exit.
});
```

## Shared Frontier

When agents fork from a common branch, they inherit its KV cache — the full attention state up to the fork point. This boundary is the shared frontier: the last position where all agents had identical computational state.

Everything before the frontier is shared context. Everything after is independent reasoning. The model doesn't need to be told what the other agents know — it already attended over the same prefix. Communication happened at prefill time, through the attention mechanism, with zero serialization overhead.

```typescript
yield *
  withSharedRoot(
    { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
    function* (root, prefixLen) {
      // root is a prefilled branch — system prompt already in KV cache.
      // Every agent forked from root shares that prefix.
      // KV saved = prefixLen × (agentCount - 1)
      return yield* runAgents({
        tasks: questions.map((q) => ({
          systemPrompt: RESEARCH_PROMPT,
          content: q,
          tools: toolsJson,
          parent: root,
        })),
        tools: toolMap,
      });
    },
  );
```

`withSharedRoot` creates the prefix, passes it to the body, and guarantees cleanup via `try/finally` — the root branch cannot leak out of the block. Effection enforces the lifetime.

## In-Loop Orchestration

All active agents advance together in a four-phase tick loop:

**PRODUCE.** Every generating agent calls `produceSync()` — synchronous sampling with no async gap between agents. This matters because it means the entire produce phase is a single uninterrupted pass over the active set.

**COMMIT.** One `store.commit()` call packs all produced tokens into a single `llama_batch` and dispatches once. N branches, one GPU call. No per-agent decode overhead.

**SETTLE.** Tool results that resolved during COMMIT are drained from a buffer. Each result is tokenized into a delta, budget-checked against a fresh `ContextPressure` snapshot, and batch-prefilled into the agent's branch. Grammar state resets. The agent transitions back to `generating`.

**DISPATCH.** Tool calls collected during PRODUCE are executed sequentially via `scoped()` + `call()`. Each tool runs to completion before the next begins — no concurrent `llama_decode` during dispatch. Tools return `Operation<unknown>`, so they can `yield*` into framework primitives like `useAgentPool` or `runAgents`, spawning recursive sub-agents within the calling agent's scope.

```typescript
// From the tick loop — Phase 1
const entries: [Branch, number][] = [];
for (const a of agents) {
  if (a.state !== "generating") continue;
  if (pressure.critical) {
    a.state = "done";
    continue;
  }

  const { token, text, isStop } = a.branch.produceSync();
  if (isStop) {
    /* parse tool calls, dispatch or finalize */ continue;
  }
  entries.push([a.branch, token]);
}

// Phase 2 — single GPU dispatch
if (entries.length > 0) {
  yield * call(() => store.commit(entries));
}
```

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

If the scope exits — error, cancellation, normal completion — the branch is pruned. Orphaned branches are structurally impossible. Tool dispatch uses `scoped()` + `call()` — each tool executes inside a scoped error boundary within the agent pool scope. If the scope tears down, pending tools are cancelled. The DAG is not imposed on the orchestration. It is intrinsic to the Effection task tree.

`useAgentPool` is an Effection `resource()` — it suspends via `provide()` after all agents complete, but keeps their branches alive. The caller can fork sub-agents from any completed agent's branch. Those sub-agents inherit the parent agent's full KV state — everything it generated, every tool result it consumed, every reasoning step it took. No summarization. No context window management. The sub-agent continues from the parent's frontier.

Recursive agents work at two levels. At the **harness level**, a completed pool's branches can be forked into follow-up pools — the deep-research example does this with `reportPass`, forking sub-agents from hard-cut agents to extract findings they couldn't submit before context pressure terminated them. At the **model level**, a tool's `execute()` method returns `Operation<unknown>`, so it can `yield*` directly into `useAgentPool` or `runAgents`. An agent that calls such a tool spawns sub-agents mid-generation — inside its own scope, inheriting its KV state, with cleanup guaranteed by structured concurrency.

The deep-research harness ships a concrete example of harness-level recursion: `reportPass`. Research agents run through the tick loop with tools — search, grep, read_file, report. Some agents get hard-cut by context pressure before they can submit findings. Rather than losing their work, the harness forks a sub-agent from each hard-cut agent's branch with a constrained tool set (report only):

```typescript
function* reportPass(pool: AgentPoolResult, opts: WorkflowOpts) {
  const hardCut = pool.agents.filter((a) => !a.findings && !a.branch.disposed);
  if (hardCut.length === 0) return;

  const reporters = yield* runAgents({
    tasks: hardCut.map((a) => ({
      systemPrompt: REPORT_PROMPT,
      content: "Report your findings.",
      tools: reportOnlyTools,
      parent: a.branch, // fork from the parent agent's branch
    })),
    tools: new Map([["report", reportTool]]),
    terminalTool: "report",
  });

  hardCut.forEach((a, i) => {
    if (reporters.agents[i]?.findings)
      a.findings = reporters.agents[i].findings;
  });
}
```

The sub-agent sees everything the parent saw — its system prompt, its tool calls, its partial reasoning — because that state is already in the KV cache at the fork point. The sub-agent just continues from where the parent was cut off, with a tighter mandate.

This is the DAG in practice: parent agents form the first level, reporter sub-agents form the second. `runAgents` wraps `useAgentPool` in `scoped()`, so the reporter branches are pruned when it returns. The parent branches are still alive in the outer scope. When that outer scope exits, every `ensure()` callback fires and prunes the parents. Teardown propagates top-down. Cleanup is guaranteed bottom-up.

There is nothing in the framework that limits this to two levels. Agents can spawn sub-agents that spawn sub-agents. An agent pool can run inside another agent pool's scope. The structured concurrency guarantees compose at every depth.

## Hallucination Detection

The framework provides hallucination detection at two levels.

**Per-token observables.** Every branch exposes runtime-accessible signals on every step: `branch.modelEntropy()` (Shannon entropy of the full vocabulary distribution), `branch.modelSurprisal(token)` (surprisal of the chosen token: -log2(p)), `branch.perplexity` (model-level, from raw logits), and `branch.samplingPerplexity` (sampling-level, from the filtered distribution). The delta between model and sampling perplexity is itself a hallucination indicator — high sampling perplexity relative to model perplexity means the sampler is working against the model's probability mass.

Enable `trace: true` on agent pools to capture entropy and surprisal on every `agent:produce` event.

**Multi-branch semantic comparison.** `diverge()` forks N branches from a shared frontier, generates independently, and returns all outputs with their perplexity scores:

```typescript
const result =
  yield *
  diverge({
    parent: root, // shared frontier
    attempts: 3, // fork 3 branches
    params: { temperature: 0.7 },
  });
// result.best — lowest-perplexity branch, still alive
// result.attempts — all branches with output, ppl, token count
// Losers already pruned. Winner's branch is caller's responsibility.
```

The harness decides how to compare. `diverge()` returns all outputs with their perplexity scores — the harness can apply any equivalence measure: bigram overlap, embedding similarity, or model-based evaluation. Where branches agree, the model is confident; where they diverge, hallucination risk is high.

This directly operationalizes the semantic entropy work from Farquhar et al. ([Nature, 2024](https://www.nature.com/articles/s41586-024-07421-0)) — but as a runtime primitive, not a post-hoc metric. The key constraint: divergence from a common computational ancestor is signal. Divergence from independently-constructed contexts is sampling variance. This measurement is only meaningful because agents share a frontier.

## Session Accumulation

After synthesis and verification, the harness promotes a branch to the session trunk. `Session.promote(branch)` retains only that branch and makes it the basis for future queries. The next query forks from this trunk — its KV cache already contains the prior verified answer.

This is the cold/warm session distinction. A cold query starts from position 0 — plan, research, synthesize, verify, promote. A warm query starts from an existing trunk — agents fork from it directly, research further, and the session responds from new findings appended to the existing state.

Each promote is an epistemic commitment. The promoted branch becomes the basis for future reasoning. The session carries forward not just text but the full KV state of a branch that survived the verification pipeline. Future agents fork from this state. Their shared frontier is the accumulated, verified reasoning of every previous cycle.

Over multiple queries, the session compounds. Early queries establish the foundation. Later queries branch from it, research further, verify further, promote further. The trunk grows. The frontier advances.

## Context Pressure

KV cache is finite. `ContextPressure` snapshots the remaining budget on every tick and enforces two thresholds:

- **softLimit** (default 1024 tokens remaining): SETTLE rejects tool results that would cross this floor. PRODUCE hard-cuts agents requesting non-terminal tool calls. Terminal tools (e.g. `report`) still pass — agents can always submit findings. INIT drops agents that don't fit above this floor.
- **hardLimit** (default 128 tokens remaining): agents killed immediately before `produceSync()`. No decode call is made below this line — it would crash.

Tool result prefill in the SETTLE phase is budget-gated against a fresh pressure snapshot. If a tool result doesn't fit, the agent is terminated rather than risking a context overflow mid-generation. The softLimit reserves space for downstream work — reporter sub-agents, verification passes.

```typescript
yield *
  useAgentPool({
    tasks,
    tools: toolMap,
    terminalTool: "report",
    pressure: { softLimit: 2048 }, // reserve 2K for reporters + verify
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
    context?.onProgress?.({
      filled: results.length,
      total: this.chunks.length,
    });
    return results.slice(0, 10);
  }
}
```

`createToolkit(tools)` aggregates tools into a `{ toolMap, toolsJson }` pair — `toolMap` for runtime dispatch, `toolsJson` for prompt formatting.

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

## License

Apache-2.0
