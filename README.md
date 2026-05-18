# lloyal HDK

[![CI](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![npm agents](https://img.shields.io/npm/v/@lloyal-labs/lloyal-agents.svg?label=lloyal-agents)](https://www.npmjs.com/package/@lloyal-labs/lloyal-agents)
[![npm sdk](https://img.shields.io/npm/v/@lloyal-labs/sdk.svg?label=sdk)](https://www.npmjs.com/package/@lloyal-labs/sdk)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Full-stack agentic AI for llama.cpp. One Node process — no inference server, no Docker, no vector DB, no glue code.**

Most agent stacks are infrastructure: an inference server, an agent runtime, a vector store, embedding pipelines, glue code — wired together over HTTP and shipped as a Docker compose. HDK collapses that into a single Node process you can embed in a desktop app, bundle in a CLI, deploy to a serverless function, or anywhere Node runs.

Agents are branches of a live llama.cpp KV cache, scheduled under structured concurrency, with tools that prefill results directly into the model's attention state — same process, same memory, same data structures as the rest of your code.

<p>
  <img src="assets/demo-readme.gif" alt="Deep Research: 5 agents researching concurrently inside a shared 32K-token context window, plan → research with tool calls → synthesize" width="100%">
  <br>
  <em>Qwen3.5 4B + Qwen3 0.6B reranker · 5 parallel agents · shared 32K context · fully offline on M2 MacBook Pro 16 GB</em>
</p>

> The demo above is [**reasoning.run**](https://www.npmjs.com/package/reasoning.run), a deep-research CLI built with HDK. Try it in 30 seconds: `npx reasoning.run`.

## Stack vs. imports

The honest comparison is full stack against full stack. Each row of the right column is a service to install, configure, version, secure, and orchestrate. Each row of the left column is an import.

| Typical agent stack | HDK |
| --- | --- |
| Inference server (vLLM / Ollama / llama-server) | `@lloyal-labs/lloyal.node` |
| Agent runtime (LangChain / LangGraph / AutoGen / CrewAI) | `@lloyal-labs/lloyal-agents` |
| Vector DB (Pinecone / Weaviate / pgvector) + embedding pipeline | `Source` contract — sources are tools |
| Retrieval orchestration (Haystack / LlamaIndex) | `@lloyal-labs/rig` |
| Process orchestrator (Docker compose / Kubernetes / Airflow) | TypeScript scopes (Effection) |
| Glue code | `npm i` |

## What you get

- **Structured Concurrency.** Agents bind to parent scopes via [Effection](https://frontside.com/effection); cancellation propagates, teardown runs in reverse. The model that powers Kotlin coroutines, Swift Tasks, Java Project Loom, and C++26 — applied to GPU-native agents.
- **Continuous-Context Agents.** Agents share GPU state, not strings. Forks are O(1), zero tensor copy — sub-agents inherit the parent's full attention state instead of re-encoding lossy summaries. **4.4× fewer tokens processed** than a prompt-rebuilding approach.
- **Retrieval-Interleaved Generation.** Agents assemble context *during* generation — searching, reading, and reranking across your app's own data. One `Source` shape for files, SQL, the web, or user records. A cross-encoder focal lens admits only verbatim top-K chunks — never summarized.

Mechanics, receipts, and the case for the architecture at [hdk.lloyal.ai](https://hdk.lloyal.ai).

## Requirements

- **Node 22+**
- **A GGUF model file on disk** — any model supported by llama.cpp
- macOS / Linux / Windows on x64 or arm64. CPU works; CUDA / Metal / Vulkan supported via prebuilt native binaries.

## Install

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node @lloyal-labs/rig
```

| Package | Role |
| --- | --- |
| `lloyal-agents` | Agent runtime — tick loop, orchestrators, policy, tools |
| `lloyal.node` | Native binding for llama.cpp ([liblloyal](https://github.com/lloyal-ai/liblloyal)); prebuilt for 13 platform/GPU combinations |
| `rig` | Retrieval-Interleaved Generation — `WebSource`, `CorpusSource`, `reportTool`, `DelegateTool`. Optional if you write your own tools |

## Quickstart

```typescript
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import {
  initAgents,
  useAgent,
  agentPool,
  parallel,
  withSpine,
} from "@lloyal-labs/lloyal-agents";
import { reportTool } from "@lloyal-labs/rig";

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

  // Single agent
  const a = yield* useAgent({
    systemPrompt: "You are a research assistant.",
    task: "Summarize this corpus.",
    tools: [...corpusTools, reportTool],
    terminalToolName: "report",
  });

  // Multiple agents on shared KV
  const tasks = [
    { content: "What datasets does the corpus index?", systemPrompt: WORKER_PROMPT },
    { content: "What's the most-cited reference inside?", systemPrompt: WORKER_PROMPT },
    { content: "Summarize the main thesis.", systemPrompt: WORKER_PROMPT },
  ];
  const tools = [...corpusTools, reportTool];
  yield* withSpine(
    { systemPrompt: playbooks, tools },
    function* (spine) {
      return yield* agentPool({
        orchestrate: parallel(tasks), // or chain(...), fanout(...), dag(...)
        tools,
        parent: spine,
        terminalToolName: "report",
      });
    },
  );
});
```

Swap the orchestrator (`parallel` / `chain` / `fanout` / `dag`) to reshape the harness without changing the call.

## Public API

```typescript
import {
  initAgents,
  useAgent,
  agent,
  agentPool,
  useAgentPool,
  diverge,
  parallel,
  chain,
  fanout,
  dag,
  reduce,
  withSpine,
  createToolkit,
  Tool,
  Source,
  DefaultAgentPolicy,
  Ctx,
  Store,
  Events,
} from "@lloyal-labs/lloyal-agents";
```

That is essentially the framework.

## Repo layout

```
packages/
  agents/   @lloyal-labs/lloyal-agents — agent runtime (the public framework)
  sdk/      @lloyal-labs/sdk           — inference primitives (Branch, Session, Rerank)
  rig/      @lloyal-labs/rig           — sources, reranker, delegation

examples/
  react-agent/   Single agent with corpus tools — `useAgent` baseline
  reflection/    Research → draft → critique → revise via `diverge`
  compare/       DAG primer: parallel research → compare → synthesize
```

The native binding [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) lives in a separate repo and is pulled in as a dependency.

## Compatibility

GPU integration tests run against six architectures and chat-template families on every PR:

| Model | Params | Quant | Template |
| --- | --- | --- | --- |
| SmolLM2-1.7B-Instruct | 1.7B | Q4_K_M | ChatML |
| Llama-3.2-1B-Instruct | 1B | Q4_K_M | Llama 3 |
| Phi-3.5-mini-instruct | 3.8B | Q4_K_M | Phi 3 |
| Qwen3-4B-Thinking | 4B | Q4_K_M | ChatML |
| gemma-3-1b-it | 1B | Q4_K_M | Gemma |
| GLM-Edge | — | Q4_K_M | GLM-Edge |

The native backend ships prebuilt binaries across 13 platform/GPU combinations:

| Platform | arm64 | x64 |
| --- | --- | --- |
| **macOS** | Metal | CPU |
| **Linux** | CPU, CUDA, Vulkan | CPU, CUDA, Vulkan |
| **Windows** | CPU, Vulkan | CPU, CUDA, Vulkan |

## Development

```bash
git clone https://github.com/lloyal-ai/hdk
cd hdk
npm install
npm run build       # tsc -b across workspace
npm test            # unit tests
```

Every PR runs build, typecheck, and unit tests on CI, plus a cross-repo GPU integration job: HDK PRs trigger [`lloyal-node`](https://github.com/lloyal-ai/lloyal.node)'s GPU workflow, which builds the PR's packages against the native runtime on NVIDIA L4 hardware and runs the full agent integration suite before merge.

## Docs

- **What HDK is and why** → [hdk.lloyal.ai](https://hdk.lloyal.ai)
- **Learn, reference, guides** → [docs.lloyal.ai](https://docs.lloyal.ai)
- **API reference** — TypeDoc-generated from source

## License

Apache-2.0
