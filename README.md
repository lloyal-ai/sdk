# lloyal-agents

[![CI](https://github.com/lloyal-ai/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/sdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![npm agents](https://img.shields.io/npm/v/@lloyal-labs/lloyal-agents.svg?label=lloyal-agents)](https://www.npmjs.com/package/@lloyal-labs/lloyal-agents)
[![npm sdk](https://img.shields.io/npm/v/@lloyal-labs/sdk.svg?label=sdk)](https://www.npmjs.com/package/@lloyal-labs/sdk)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**TypeScript framework for local recursive agents, parallel tool calling, and branching inference.**

Run tool-calling agents and sub-agents locally, in parallel, on a shared model runtime.
No API boundary. No serialized message passing between agents. No network required.

<p>
  <img src="assets/demo.gif" alt="Deep Research: 3 agents analyzing DOJ v Apple complaint — plan, research with tool calls, verify, synthesize" width="100%">
  <br>
  <em>Qwen3 4B + 0.6B reranker · 3 agents · 14 tool calls · 98s · fully offline on M2 MacBook Pro</em>
</p>

`lloyal-agents` is for building agent workflows where agents are not separate model calls. They are branches of one live inference process, sharing context and compute, calling tools in parallel, and spawning sub-agents from their own live state.

That gives you a different execution model from conventional agent frameworks:

* **Parallel agents on one running model**
* **Recursive sub-agents** that continue from a parent's live state
* **Shared context and compute** instead of repeated request/response cycles
* **Branch comparison** from a shared computational ancestor
* **Fully local execution** on edge devices, workstations, and air-gapped servers

## Install

```bash
npm i @lloyal-labs/lloyal-agents
```

**Backends:** [lloyal.node](https://github.com/lloyal-ai/lloyal.node) — prebuilt binaries for macOS, Linux, and Windows with CPU/GPU support.

## Use this if

* You want **local tool-calling agents**
* You need **parallel or recursive task execution**
* You want **shared-state efficiency** instead of many isolated model calls
* You care about **inspectable execution** and real runtime control

## Don't use this if

* You just need a chat wrapper
* You only use hosted APIs
* You do not need sub-agents, branching, or runtime-level control

## Quickstart

```typescript
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { initAgents, generate } from "@lloyal-labs/lloyal-agents";

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

  const { session } = yield* initAgents(ctx);

  const result = yield* generate({
    parent: session.trunk,
    prompt: "In one sentence, explain KV cache sharing.",
  });

  console.log(result.text);
});
```

The basic mental model is simple:

* create a backend context
* initialize the runtime
* generate from a branch

From there, you can fork branches, run agents in parallel, attach tools, and promote winning branches into the session trunk.

## Why it's different

Most agent frameworks orchestrate **around** a model:

1. prompt the model
2. read the response
3. maybe call a tool
4. prompt again

`lloyal-agents` orchestrates **inside** the running inference process.

Agents are branches of one live model runtime. They share KV cache state up to a fork point, advance together through batched decode steps, and consume tool results by pre-filling tokens directly into their own branches.

That means:

* agents share computational state, not summaries
* sub-agents can continue from a parent's live frontier
* multiple branches can advance in one GPU dispatch
* branch comparison is meaningful because branches share a real ancestor

## What ships

### `@lloyal-labs/lloyal-agents`

The high-level runtime for recursive agents, tools, and orchestration.

Includes:

* `initAgents`
* `generate`
* `diverge`
* `useAgentPool`
* `runAgents`
* `withSharedRoot`
* `createToolkit`
* `Tool`
* events and Effection contexts

```bash
npm i @lloyal-labs/lloyal-agents
```

### `@lloyal-labs/sdk`

The lower-level branching inference primitives the agent runtime is built on.

Includes:

* `Branch`
* `BranchStore`
* `Session`
* `Rerank`

```bash
npm i @lloyal-labs/sdk
```

## Public API surface

```typescript
import {
  initAgents,
  generate,
  diverge,
  useAgentPool,
  runAgents,
  withSharedRoot,
  createToolkit,
  Ctx,
  Store,
  Events,
} from "@lloyal-labs/lloyal-agents";
```

That is essentially the framework.

# Examples

The repo ships four examples demonstrating canonical agent patterns. All examples share corpus tools, resources, and a reranker via [`examples/shared/`](examples/shared/). Each defines its own `WorkflowEvent = AgentEvent | StepEvent` union — `AgentEvent` is the stable runtime contract, `StepEvent` is example-specific.

## Deep Research (reference architecture)

[`examples/deep-research`](examples/deep-research) — 5-phase structured research: Plan, Research, Verify, Evaluate, Promote. Demonstrates shared-root parallelism, grammar-constrained planning, diverge-based verification, agreement analysis, and session accumulation.

```bash
npx tsx examples/deep-research/main.ts \
  --corpus /path/to/docs \
  --query "How does the KV cache eviction policy work?"
```

## ReAct Agent

[`examples/react-agent`](examples/react-agent) — Single agent with corpus tools answers a question. The simplest workflow, demonstrating `withSharedRoot` + `useAgentPool` with one agent.

```bash
npx tsx examples/react-agent/main.ts \
  --corpus /path/to/docs \
  --query "What is the main argument?"
```

## Reflection

[`examples/reflection`](examples/reflection) — Research, Draft, Critique, Revise. The critic forks from the draft's live branch; the reviser forks from the critic's branch. Demonstrates manual branch lifecycle, `buildUserDelta` for injecting follow-up turns, and `diverge` with parent branch for perplexity selection. No re-prompting — KV continuity across phases.

```bash
npx tsx examples/reflection/main.ts \
  --corpus /path/to/docs \
  --query "Explain the key findings"
```

## Supervisor

[`examples/supervisor`](examples/supervisor) — Classify, Route to specialist agents, Execute in parallel, Synthesize. Demonstrates grammar-constrained routing via `generate()`, dynamic agent count from classifier output, heterogeneous `useAgentPool` tasks, and warm trunk synthesis for multi-turn follow-ups.

```bash
npx tsx examples/supervisor/main.ts \
  --corpus /path/to/docs \
  --query "Compare the two approaches described in the document"
```

All examples run in-process, on local weights, fully offline.

## Shared-root parallelism

```typescript
yield* withSharedRoot(
  { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
  function* (root) {
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

Every task forks from the same prefilled root. Everything before the fork is shared KV state. Everything after the fork is independent reasoning.

## Recursive agents

Sub-agents can fork from an existing agent's live branch and continue from where it left off.

The deep-research example includes a `reportPass`: if a research agent gets cut off before producing findings, the harness forks a reporter sub-agent from that agent's branch and gives it a narrower mandate.

```typescript
function* reportPass(pool: AgentPoolResult, opts: WorkflowOpts) {
  const hardCut = pool.agents.filter((a) => !a.findings && !a.branch.disposed);
  if (hardCut.length === 0) return;

  const reporters = yield* runAgents({
    tasks: hardCut.map((a) => ({
      systemPrompt: REPORT_PROMPT,
      content: "Report your findings.",
      tools: reportOnlyTools,
      parent: a.branch,
    })),
    tools: new Map([["report", reportTool]]),
    terminalTool: "report",
  });

  hardCut.forEach((a, i) => {
    if (reporters.agents[i]?.findings) {
      a.findings = reporters.agents[i].findings;
    }
  });
}
```

This is the key difference: the sub-agent continues from the parent's actual live state, not from a summary pasted back into a prompt.

## Branch comparison

`diverge()` forks multiple branches from a shared frontier, generates independently, and returns the attempts plus the surviving best branch.

```typescript
const result = yield* diverge({
  parent: root,
  attempts: 3,
  params: { temperature: 0.7 },
});
```

Because those branches share a computational ancestor, agreement and disagreement between them are meaningful signals.

## Session accumulation

When a branch wins, it can be promoted into the session trunk.

That means future work starts from accumulated branch state, not from an empty prompt. Over multiple queries, the session compounds what the system has already established.

## Tools

Tools are class-based and expose OpenAI-compatible function schemas:

```typescript
import { Tool } from "@lloyal-labs/lloyal-agents";

class SearchTool extends Tool<{ query: string }> {
  readonly name = "search";
  readonly description = "Semantic search over the corpus";
  readonly parameters = {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  };

  async execute(args: { query: string }) {
    return this.search(args.query);
  }
}
```

`createToolkit(tools)` turns a tool set into:

* `toolMap` for runtime dispatch
* `toolsJson` for prompt formatting

## Events

The runtime emits structured events for TUI, logging, and telemetry:

| Event                 | Payload                                                   |
| --------------------- | --------------------------------------------------------- |
| `agent:spawn`         | `agentId`, `parentAgentId`                                |
| `agent:produce`       | `agentId`, `text`, `tokenCount`, `entropy?`, `surprisal?` |
| `agent:tool_call`     | `agentId`, `tool`, `args`                                 |
| `agent:tool_result`   | `agentId`, `tool`, `result`                               |
| `agent:tool_progress` | `agentId`, `tool`, `filled`, `total`                      |
| `agent:report`        | `agentId`, `findings`                                     |
| `agent:done`          | `agentId`                                                 |

## API Reference

**[lloyal-ai.github.io/lloyal-agents](https://lloyal-ai.github.io/lloyal-agents/)** — generated from source with TypeDoc.

Built on:

* [lloyal.node](https://github.com/lloyal-ai/lloyal.node) — forkable decode state + continuous tree batching over llama.cpp
* [liblloyal](https://github.com/lloyal-ai/liblloyal) — C++20 inference kernel

## Testing

Every pull request must pass:

* **Build**
* **Typecheck**
* **GPU integration tests** against real models on NVIDIA L4 hardware

The GPU gate runs cross-repo: SDK PRs trigger [lloyal.node](https://github.com/lloyal-ai/lloyal.node)'s GPU workflow, which builds the PR packages against the native runtime and runs the full agent integration suite before merge.

### Model matrix

GPU integration tests run against 6 architectures and chat template families:

| Model                 | Params | Quant  | Template |
| --------------------- | ------ | ------ | -------- |
| SmolLM2-1.7B-Instruct | 1.7B   | Q4_K_M | ChatML   |
| Llama-3.2-1B-Instruct | 1B     | Q4_K_M | Llama 3  |
| Phi-3.5-mini-instruct | 3.8B   | Q4_K_M | Phi 3    |
| Qwen3-4B-Thinking     | 4B     | Q4_K_M | ChatML   |
| gemma-3-1b-it         | 1B     | Q4_K_M | Gemma    |
| GLM-Edge              | —      | Q4_K_M | GLM-Edge |

### Distribution matrix

The native backend ships prebuilt binaries for 13 platform/GPU combinations:

| Platform    | arm64             | x64               |
| ----------- | ----------------- | ----------------- |
| **macOS**   | Metal             | CPU               |
| **Linux**   | CPU, CUDA, Vulkan | CPU, CUDA, Vulkan |
| **Windows** | CPU, Vulkan       | CPU, CUDA, Vulkan |

## License

Apache-2.0
