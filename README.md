# lloyal HDK

[![CI](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![npm agents](https://img.shields.io/npm/v/@lloyal-labs/lloyal-agents.svg?label=lloyal-agents)](https://www.npmjs.com/package/@lloyal-labs/lloyal-agents)
[![npm sdk](https://img.shields.io/npm/v/@lloyal-labs/sdk.svg?label=sdk)](https://www.npmjs.com/package/@lloyal-labs/sdk)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Harness Development Kit — drop-in agentic AI for consumer hardware.**

Most agent stacks are infrastructure: an inference server, an agent runtime, a vector store, glue code — wired together over HTTP and shipped as a Docker compose. lloyal HDK collapses that into a single Node process you can ship: embedded in a desktop app, bundled in a CLI, deployed to a serverless function, anywhere a Node runtime runs.

The unit you build isn't an agent — it's a _harness_: an orchestrated system of agents that share live attention state. You treat it as code, not as infrastructure.

<p>
  <img src="assets/demo-readme.gif" alt="Deep Research: 5 agents researching concurrently inside a shared 32K-token context window, plan → research with tool calls → synthesize" width="100%">
  <br>
  <em>Qwen3.5 4B + Qwen3 0.6B reranker · 5 parallel agents · shared 32K context · fully offline on M2 MacBook Pro 16 GB</em>
</p>

> The demo above is [**reasoning.run**](https://www.npmjs.com/package/reasoning.run), a deep-research CLI built with HDK. Try it in 30 seconds: `npx reasoning.run`.

## Three pillars

- **Zero-dependency drop-in.** No daemon, no Docker, no HTTP boundary between your agent code and the model. `npm i`, point at a GGUF on disk, ship.
- **Continuous Context.** Agents share KV state, not strings. Forks are O(1) metadata; sub-agents inherit the parent's full attention state. Breaks the "runs locally but is a toy" barrier.
- **Retrieval Interleaved Generation.** Retrieval inside the generation loop. Cross-encoder reranking, entailment scoring, explore/exploit gating, default delegation guards.

Full positioning, mechanics, and receipts in the [docs site](https://hdk.lloyal.ai).

## Install

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node @lloyal-labs/rig
```

- `lloyal-agents` — the agent runtime (tick loop, orchestrators, policy).
- [`lloyal.node`](https://github.com/lloyal-ai/lloyal.node) — native binding for [liblloyal](https://github.com/lloyal-ai/liblloyal); prebuilt for macOS, Linux, and Windows with CPU and GPU support.
- `rig` — Retrieval-Interleaved Generation building blocks: pre-built `WebSource` / `CorpusSource`, the `reportTool`, `DelegateTool`. Optional if you're only writing custom tools.

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
    terminalTool: "report",
  });

  // Multiple agents on shared KV
  const tasks = [
    {
      content: "What datasets does the corpus index?",
      systemPrompt: WORKER_PROMPT,
    },
    {
      content: "What's the most-cited reference inside?",
      systemPrompt: WORKER_PROMPT,
    },
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

Swap the orchestrator (`parallel` / `chain` / `fanout` / `dag`) to reshape the harness without changing the call. Full walkthrough: [Quick Start](https://hdk.lloyal.ai/learn/quick-start).

## Public API surface

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

## Why it's different

Most agent frameworks orchestrate **around** a model — prompt, read response, call a tool, prompt again. Each agent is a separate API call with its own context window.

`lloyal-agents` orchestrates **inside** the running inference process. Agents are branches of one live model runtime. They share KV cache state up to a fork point, advance together through batched decode steps, and consume tool results by prefilling tokens directly into their own branches.

When an agent calls a tool, the result is fully prefilled into its KV cache before it generates another token. The model sees the complete result and makes a clean decision — call another tool, refine the query, or report. This produces multi-hop reasoning: later tool calls reference discoveries from earlier ones, because the full chain is physically present in the branch's attention state.

When an agent needs to go deeper, `DelegateTool` spawns sub-agents that fork from the calling agent's branch — same GPU, same KV cache, same event stream. The calling agent's branch stays alive; when sub-agents report back, their findings return as a tool result into the caller's live context.

## Packages

| Package                                                                | Purpose                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@lloyal-labs/lloyal-agents`](packages/agents)                        | Continuous Context agent runtime — five-phase tick loop, tools, orchestrators |
| [`@lloyal-labs/sdk`](packages/sdk)                                     | Inference primitives — `Branch`, `BranchStore`, `Session`, `Rerank`           |
| [`@lloyal-labs/rig`](packages/rig)                                     | Retrieval-Interleaved Generation — sources, reranker, delegation              |
| [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) | Native Node binding for liblloyal (separate repo)                             |

Underneath: **[liblloyal](https://github.com/lloyal-ai/liblloyal)** — the C++ core. Goes wherever C++ runs (desktop OSes, mobile, browser via WASM, game engines, edge).

## Examples

| Example                                        | What it shows                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`examples/react-agent`](examples/react-agent) | Single agent with corpus tools — `useAgent` baseline                                                          |
| [`examples/reflection`](examples/reflection)   | Research → draft → critique → revise via manual branch lifecycle and `diverge`                                |
| [`examples/compare`](examples/compare)         | DAG primer: research two subjects in parallel, compare across axes, synthesize. Playbooks convention applied. |

## Documentation

- **Docs site** — positioning, learn, reference, guides at [docs.lloyal.ai](https://docs.lloyal.ai)
- **API reference** — TypeDoc-generated from source

## Testing

Every PR passes:

- Build + typecheck
- Unit tests
- **GPU integration** against real models on NVIDIA L4 hardware

The GPU gate runs cross-repo: HDK PRs trigger [`lloyal-node`](https://github.com/lloyal-ai/lloyal.node)'s GPU workflow, which builds the PR packages against the native runtime and runs the full agent integration suite before merge.

### Model matrix

GPU integration tests run against six architectures and chat-template families:

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
