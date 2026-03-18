# Prefix Sharing

Agent pools amortize prompt tokenization across multiple agents by sharing a common KV cache prefix. This document covers how it works at every layer of the stack — from the TypeScript API through the C++ branch store to GPU decode — and explains why the apparent duplication in `setupAgent` is by design.

## How `withSharedRoot` + `useAgentPool` works

```
withSharedRoot({ systemPrompt, tools })
  │
  ├── Branch.create(ctx, 0, params)    ← root branch at position 0
  ├── prefill(sharedTokens)            ← GPU decode: positions 0..N-1
  │
  └── useAgentPool({ tasks, tools })
        │
        ├── setupAgent(root, task)
        │     ├── forkSync()           ← O(1) metadata: child at position N
        │     └── prefill(suffix)      ← GPU decode: positions N..N+M
        │
        ├── setupAgent(root, task)     ← same: fork at N, decode from N
        └── setupAgent(root, task)     ← same: fork at N, decode from N
```

The shared root prefills the system prompt and tool schemas once. Each agent forks from the root and prefills only its unique suffix — the user message and generation prompt. The system+tools tokens are never re-decoded.

## KV cache: physical sharing, not copying

When `forkSync()` calls `llama_kv_self_seq_cp()` under the hood, it does not copy KV tensors. It tags existing KV cells (which hold the shared root's key/value vectors) with a new sequence ID. Multiple branches can read the same physical memory at positions 0..N-1 while writing their own unique cells at positions N and beyond.

```
KV cache layout after 3 forks:

Position:  0 ─────────── N ──────── N+M₀
           │ shared root │ agent 0  │
           │ (seq 0,1,2,3)│ (seq 1)  │
           └──────────────┘          │
                          │ agent 1  │ N+M₁
                          │ (seq 2)  │
                          └──────────┘
                          │ agent 2  │ N+M₂
                          │ (seq 3)  │
                          └──────────┘
```

Cells at positions 0..N-1 are tagged with all four seq_ids (root + 3 agents). They occupy one set of physical memory. Each agent's cells at N+ are unique to that agent's seq_id.

## Position-aware decode

The key to understanding why suffix prefill doesn't re-decode shared tokens is position inheritance:

### 1. Fork inherits parent position

```cpp
// branch.hpp — fork implementation
dst->position = src->position;  // Child starts where parent left off
```

After `withSharedRoot` prefills 866 tokens, `root->position = 866`. When an agent calls `forkSync()`, the child branch starts at position 866 — not 0.

### 2. Prefill starts from current position

```cpp
// branch.hpp — prefill()
decode::many(state->ctx, tokens, n_tokens,
             state->position,    // ← 866, not 0
             state->n_batch, state->seq_id);
state->position += n_tokens;    // ← advances to 866 + suffix_length
```

### 3. GPU batch uses inherited positions

```cpp
// decode.hpp — building the llama_batch
const int32_t pos = n_past + i;  // n_past = 866, i = 0,1,2,...
```

The suffix tokens are placed at positions 866, 867, 868, etc. The GPU attends to prior KV entries at positions 0-865 (already in cache from the shared root) and computes new KV entries only for the suffix positions. The shared root's tokens are never re-processed.

## Why `setupAgent` formats the full message array

Looking at `setupAgent` in `agent-pool.ts`, the agent calls `formatChatSync` with `[{system, systemPrompt}, {user, content}]` — which includes the system prompt and tools even though the shared root already has them. This looks like duplication, but it's intentional:

```typescript
const messages = [
  { role: 'system', content: task.systemPrompt },
  { role: 'user', content: task.content },
];
const fmtOpts = { enableThinking: false };
if (task.tools) fmtOpts.tools = task.tools;
const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
```

The full format call serves two purposes that cannot be separated:

1. **Format detection.** `formatChatSync` returns `fmt.format`, `fmt.grammar`, `fmt.grammarLazy`, `fmt.grammarTriggers`, and `fmt.parser`. These control how the agent's output is parsed and grammar-constrained. Format detection requires the complete message context — the template may produce different grammar rules depending on whether tools are present, what the system prompt says, and how many messages exist.

2. **Root-agnostic setup.** Agents within the same pool can have different system prompts. The evaluator agent uses a different system prompt from the research agent, which differs from the synthesis agent. Each `setupAgent` call independently formats its own messages so the format/grammar is correct for that agent's specific configuration.

The CPU cost of tokenizing the system+tools text (~866 tokens) once per agent is negligible — a few milliseconds. The GPU cost of decoding those tokens is zero because the prefill starts at the fork position.

## Measuring prefix savings

The shared root's contribution is visible in trace events:

```json
{"type": "prompt:format", "role": "sharedRoot", "tokenCount": 866}
{"type": "prompt:format", "role": "agentSuffix", "tokenCount": 896}
{"type": "prompt:format", "role": "agentSuffix", "tokenCount": 903}
{"type": "prompt:format", "role": "agentSuffix", "tokenCount": 895}
```

The suffix `tokenCount` includes the shared root content (for format detection), but the `branch:prefill` event shows the actual GPU decode cost:

```json
{"type": "branch:prefill", "role": "sharedPrefix", "tokenCount": 866}
{"type": "branch:prefill", "role": "agentSuffix", "tokenCount": 896}
```

The agent suffix `branch:prefill` reports the tokenized length of the full formatted prompt. However, because `state->position` starts at 866 (from the fork), the GPU only decodes the delta — approximately 30 tokens of unique content per agent.

The KV savings from prefix sharing:

```
Without sharing: 3 agents × 896 tokens = 2,688 GPU decode ops
With sharing:    866 shared + 3 × 30 unique = 956 GPU decode ops
Savings:         1,732 decode ops (64% reduction)
```

## Nested prefix sharing

Research tools spawn inner agent pools via `withSharedRoot` inside their `execute()` method. The inner shared root creates a new branch at position 0, independent of the outer pool. Inner agents fork from the inner root and share its prefix.

```
Outer pool:
  withSharedRoot (outer root, pos 0..866)
    ├── Agent A0 (fork at 866, suffix 866..896)
    │     └── [tool dispatch: research]
    │           └── withSharedRoot (inner root, pos 0..750)
    │                 ├── Agent A0.0 (fork at 750, suffix 750..780)
    │                 ├── Agent A0.1 (fork at 750, suffix 750..785)
    │                 └── Agent A0.2 (fork at 750, suffix 750..778)
    ├── Agent A1 (fork at 866, suffix 866..903)
    └── Agent A2 (fork at 866, suffix 866..895)
```

Inner and outer pools share the same `BranchStore` and the same physical KV cache. `ContextPressure` snapshots `cells_used` across all branches to enforce headroom limits. See [Concurrency](concurrency.md) for details on how nested pools interact with KV pressure.

## `cells_used` accounting

`cells_used` is incremented on every decode operation (`decode_each`, `decode_scatter`) and decremented on branch prune. After the inner `withSharedRoot` exits and its root is pruned, `cells_used` drops by the inner root's unique cells — freeing headroom for the outer pool's remaining agents.

The shared root's cells are not freed until the outer `withSharedRoot` exits. This is correct — they're still needed by any surviving outer agents that forked from the root.

## What this means for tools

Tool schemas are the largest contributor to the shared prefix. A corpus toolkit with 5 tools (`search`, `read_file`, `grep`, `report`, `research`) serializes to ~2,000 characters of JSON. After chat template formatting, the system prompt + tool schemas produce ~800-900 tokens. Without prefix sharing, every agent would decode those tokens independently.

### Prefix sharing eliminates per-agent tool cost

The tool schemas are decoded into the root branch's KV once. Every agent inherits them via fork. The per-agent GPU cost is the user message delta (~30 tokens), not the full toolkit (~900 tokens):

```
Corpus pool (5 tools, 3 agents):
  Shared root:  866 tokens decoded once (system + 5 tool schemas)
  Agent suffix:  30 tokens decoded per agent (user question + generation prompt)
  Total GPU decode: 866 + 90 = 956 tokens
  Savings vs per-agent rebuild: 64% fewer decode ops (956 vs 2,688)

Web pool (4 tools, 3 agents):
  Shared root:  ~700 tokens decoded once (system + 4 tool schemas)
  Agent suffix:  ~30 tokens per agent
  Total GPU decode: 700 + 90 = 790 tokens
  Savings vs per-agent rebuild: 64% fewer decode ops (790 vs 2,190)
```

For recursive pools (research tool spawning sub-agents), the savings compound. An inner pool with 3 sub-agents sharing a root with 5 tools saves another ~1,700 decode operations.

### How cloud APIs and orchestration frameworks handle tools

To understand the value of prefix sharing, it helps to see what happens without it.

**Cloud APIs rebuild per request.** Both the Anthropic Messages API and OpenAI Chat Completions API require the full `tools` array on every request. Each API call re-processes all tool schemas as input tokens. The Anthropic API charges input tokens for the tool definitions plus a fixed system prompt overhead (~346 tokens for Claude Opus/Sonnet). In a 6-turn tool-using conversation with 5 tools, the tool schemas are re-processed 6 times.

Anthropic's prompt caching mitigates this: marking the last tool with `cache_control: { type: "ephemeral" }` caches the tool definitions server-side. Subsequent requests with identical tools get cache hits at 10% of the input token price. However, prompt caching is a billing optimization — the tokens still count toward context length, and the model still attends to them on every turn. The KV computation may be accelerated server-side, but the client has no control over or visibility into this.

**MCP adds a discovery layer, not a caching layer.** MCP (Model Context Protocol) provides a `tools/list` RPC for discovering available tools from servers. The client receives tool schemas, then includes them in LLM API requests — which are standard API calls with the full tool array. MCP itself does not cache tool schemas in the model's context or share them across calls. The caching (if any) depends on the underlying API provider's prompt caching support.

**Orchestration frameworks rebuild the prompt per step.** Frameworks like LangChain's AgentExecutor and LangGraph construct the full prompt (system + tools + conversation history) on every agent step, then send it as a single API call. Each step re-serializes and re-sends the complete tool list. There is no cross-step KV sharing — each API call is independent.

### How prefix sharing differs

Prefix sharing operates at the KV cache level, below the API layer:

| Aspect | API-based (Anthropic, OpenAI, MCP clients) | Prefix sharing |
|--------|---------------------------------------------|----------------|
| Tool schema cost per agent | Full input token cost per request | Decoded once, forked O(1) |
| Multi-agent (3 agents, 5 tools) | 3× full schema processing | 1× decode + 3× ~30-token delta |
| Multi-turn (6 turns per agent) | 6× full schema as input tokens | 1× decode, tool results as deltas on branch |
| Grammar enforcement | None — client validates JSON post-hoc | Lazy GBNF constrains generation at token level |
| Malformed tool calls | Possible — client retries on parse error | Structurally impossible while grammar is active |
| Prompt caching | Server-side, billing only (Anthropic: 10% cost) | Physical KV sharing, zero re-decode |
| Progressive disclosure | Client filters tool list per-request | Not supported — all tools visible from fork |
| Cross-agent KV sharing | Not possible — each request is independent | Fork inherits parent KV at O(1) cost |

**Grammar enforcement** is the layer that cloud APIs lack entirely. MCP and cloud APIs rely on the model to produce valid tool call JSON. If the model emits malformed JSON, the client catches a parse error and must retry or fail. Anthropic's `strict: true` structured outputs provide schema validation but still operate at the response level — the model generates freely and the output is validated after the fact. With prefix sharing, the lazy GBNF grammar activates when the model starts a tool call (trigger token detected) and constrains every subsequent token to valid structure. Invalid tokens are masked from the sampler before they can be produced.

**The tradeoff is deployment flexibility vs compute efficiency.** Cloud APIs and MCP are stateless — each request is independent, tool lists can change between requests, and there's no shared state to manage. Prefix sharing requires a branch lifecycle (create root, fork agents, prune on exit) and a local model with KV cache access. For single-request use cases the difference is negligible. For multi-agent pipelines with 10-30 agents across nested pools, prefix sharing eliminates tens of thousands of redundant token decodes that cloud APIs would re-process on every call.
