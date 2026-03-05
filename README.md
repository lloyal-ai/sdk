# lloyal-agents

**Multi-agent inference with shared frontier, recursive agents, hallucination detection, and structured concurrency — edge to cloud.**

---

<p>
  <img src="assets/demo.gif" alt="Deep Research: 3 agents analyzing DOJ v Apple complaint — plan, research with tool calls, verify, synthesize" width="100%">
  <br>
  <em>Qwen3 4B + 0.6B reranker · 3 agents · 14 tool calls · 98s · fully offline on M2 MacBook Pro</em>
</p>

`lloyal-agents` runs multi-agent inference inside the decode loop. Agents are branches of a single running process — forked from shared KV cache state, advancing through one GPU forward pass per tick, spawning sub-agents from their own live branches at arbitrary depth. Orchestration is not a layer above inference. It is inference.

Conventional agent frameworks orchestrate _around_ a model — scaffolding on the outside, inference through a request-response boundary. Generate, interpret, call again. `lloyal-agents` removes the boundary. Agents share computational state through the attention mechanism, not serialized messages. Tool results are prefilled directly into the branch's KV cache. The framework and the forward pass are the same thing.

This unlocks orchestration patterns that are impossible across an API boundary: forking a live agent's full reasoning state into sub-agents, comparing divergent branches from a shared computational ancestor for hallucination detection, and accumulating verified context across queries — where each promotion is an epistemic commitment that future agents build on.

```bash
npm i @lloyal-labs/lloyal-agents
```

**Backends:** [lloyal.node](https://github.com/lloyal-ai/lloyal.node) — prebuilt binaries for macOS (Metal, CPU), Linux (CPU, CUDA, Vulkan), and Windows (CPU, CUDA, Vulkan). GPU selection at runtime.

## Generation as the Primitive

The core architectural decision: generation is the primitive, not the API call. Agents are not processes that exchange messages. They are branches of a running inference process — forked from shared KV cache state, generating independently, their outputs comparable because they share a computational origin.

This is built on [lloyal.node](https://github.com/lloyal-ai/lloyal.node), which provides forkable decode state and continuous tree batching over llama.cpp. `lloyal-agents` adds structured concurrency, tool dispatch, and a three-phase tick loop that drives N branches through a single GPU forward pass per step.

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

All active agents advance together in a three-phase tick loop:

**PRODUCE.** Every generating agent calls `produceSync()` — synchronous sampling with no async gap between agents. This matters because it means the entire produce phase is a single uninterrupted pass over the active set.

**COMMIT.** One `store.commit()` call packs all produced tokens into a single `llama_batch` and dispatches once. N branches, one GPU call. No per-agent decode overhead.

**SETTLE.** Tool results that resolved during COMMIT are drained from a buffer. Each result is tokenized into a delta, budget-checked against a fresh `ContextPressure` snapshot, and batch-prefilled into the agent's branch. Grammar state resets. The agent transitions back to `generating`.

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

When no agent is generating and tools are still pending, the loop parks itself via `action()` — an Effection primitive that suspends the generator until a tool resolves and calls `wakeIdle()`. No polling. No sleep loops.

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

If the scope exits — error, cancellation, normal completion — the branch is pruned. Orphaned branches are structurally impossible. Tool dispatch uses `scope.run()` for eager start inside the agent pool scope; if the scope tears down, pending tools are cancelled. The DAG is not imposed on the orchestration. It is intrinsic to the Effection task tree.

`useAgentPool` is an Effection `resource()` — it suspends via `provide()` after all agents complete, but keeps their branches alive. The caller can fork sub-agents from any completed agent's branch. Those sub-agents inherit the parent agent's full KV state — everything it generated, every tool result it consumed, every reasoning step it took. No summarization. No context window management. The sub-agent continues from the parent's frontier.

The deep-research harness ships a concrete example: `reportPass`. Research agents run through the tick loop with tools — search, grep, read_file, report. Some agents get hard-cut by context pressure before they can submit findings. Rather than losing their work, the harness forks a sub-agent from each hard-cut agent's branch with a constrained tool set (report only):

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

The harness decides how to compare. The deep-research example measures semantic equivalence across diverge outputs using bigram Jaccard similarity — where branches agree, the model is confident; where they diverge, hallucination risk is high. No model call required for the comparison itself. Other harnesses can use different equivalence measures over the same `diverge()` primitive.

This directly operationalizes the semantic entropy work from Farquhar et al. ([Nature, 2024](https://www.nature.com/articles/s41586-024-07421-0)) — but as a runtime primitive, not a post-hoc metric. The key constraint: divergence from a common computational ancestor is signal. Divergence from independently-constructed contexts is sampling variance. This measurement is only meaningful because agents share a frontier.

## Session Accumulation

When agents converge — when the entropy gate passes — the winning branch is not returned as output. It is promoted. It becomes the new trunk of the session. The next query starts from ground that was computationally earned by the previous convergence check.

This is the cold/warm session distinction. A cold query runs the full pipeline: plan the decomposition, dispatch research agents, synthesize via `diverge`, evaluate convergence, promote. A warm query — one where a trusted trunk already exists — skips verification entirely. The frontier is already established. Agents fork from it, research, and the session responds directly from findings.

Each promote is an epistemic commitment: this branch survived N-way comparison and convergence evaluation, so it becomes the basis for future reasoning. The session doesn't just carry forward text — it carries forward the KV state of a branch that survived verification. Future agents fork from this state. Their shared frontier is not an empty system prompt. It is the accumulated, verified reasoning of every previous cycle.

Over multiple queries, the session compounds. Early queries establish the foundation. Later queries branch from it, research further, verify further, promote further. The trunk grows. The frontier advances. The model's effective context is not what you put in the prompt — it is what was earned by convergence.

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
import type { ToolContext } from "@lloyal-labs/lloyal-agents";

class SearchTool extends Tool<{ query: string }> {
  readonly name = "search";
  readonly description = "Semantic search over the corpus";
  readonly parameters = {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  };

  async execute(args: { query: string }, context?: ToolContext) {
    const results = await this.reranker.rank(args.query, this.chunks);
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

## What Ships

`lloyal-agents` is the framework. It ships with a working deep-research harness ([`examples/deep-research`](examples/deep-research)) that demonstrates the full pattern:

1. **Plan** — grammar-constrained JSON generation decomposes a query into N sub-questions
2. **Research** — N agents fork from a shared root, each with tools (search, grep, read_file, report), running concurrently through the tick loop
3. **Verify** — `diverge()` synthesizes findings N ways from the same prompt
4. **Evaluate** — grammar-constrained convergence check: did the verifiers agree?
5. **Promote** — winning branch becomes the session trunk

The harness also includes `reportPass` — agents that were hard-cut by context pressure without submitting findings get a second pass with only the report tool available, forked from the parent agent's branch. This forces closure without losing branch state.

```bash
npx tsx examples/deep-research/main.ts \
  --corpus /path/to/docs \
  --query "How does the KV cache eviction policy work?"
```

The deep-research harness running a 4B parameter model correctly identified a false premise in a question about a dense technical specification — three concurrent tool-using agents, verification, convergence evaluation, 10% context utilization, under three minutes on a single machine.

The entire system runs in-process, on local weights, fully offline. Edge devices. Developer workstations. Air-gapped servers. No API calls. No network boundary.

## Packages

### [`@lloyal-labs/lloyal-agents`](packages/agents)

The agent runtime. `initAgents`, `generate`, `diverge`, `useAgentPool`, `runAgents`, `withSharedRoot`, `createToolkit`, the `Tool` base class, `AgentEvent` observability, and the Effection contexts (`Ctx`, `Store`, `Events`).

```bash
npm i @lloyal-labs/lloyal-agents
```

### [`@lloyal-labs/sdk`](packages/sdk)

The inference primitives that agents are built on. Backend-agnostic — the SDK defines the `SessionContext` contract; backend bindings ([lloyal.node](https://github.com/lloyal-ai/lloyal.node), [nitro-llama](https://github.com/lloyal-ai/nitro-llama)) provide `createContext()`.

- **`Branch`** — forkable decode handle. Shares KV prefix on fork, keeps independent sampler chain, grammar, logits snapshot, perplexity tracker. Async iterable for single-branch generation.
- **`BranchStore`** — continuous tree batching. Packs N branches into a single `llama_batch` — `commit()` for 1-token-per-branch lockstep, `prefill()` for variable-length scatter injection, `retainOnly()` for winner-takes-all promotion.
- **`Session`** — conversation trunk management. Accumulates verified context across queries via `promote()`.
- **`Rerank`** — backend-agnostic reranker over any `SessionContext`.

```bash
npm i @lloyal-labs/sdk
```

## API Reference

**[lloyal-ai.github.io/lloyal-agents](https://lloyal-ai.github.io/lloyal-agents/)** — generated from source with TypeDoc.

Built on [lloyal.node](https://github.com/lloyal-ai/lloyal.node) (forkable decode state + continuous tree batching over llama.cpp) and [liblloyal](https://github.com/lloyal-ai/liblloyal) (C++20 inference kernel).

## License

Apache-2.0
