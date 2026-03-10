# Concurrency

The agent pool runs multiple agents on shared GPU compute through a single `llama_context`. This document covers the execution model, how it enables multi-hop reasoning, how resources are shared across nested pools, and how tools can spawn sub-agents recursively.

## Four-Phase Tick Loop

The agent pool runs a four-phase tick loop:

```
PRODUCE  — sample all active agents, collect tool calls
COMMIT   — batch-decode produced tokens (single GPU call)
SETTLE   — drain settled tool results, batch prefill, reset grammars
DISPATCH — execute collected tool calls sequentially via scoped() + call()
```

**PRODUCE** samples one token per agent per tick via `produceSync()`. Each token is accumulated into `rawOutput` and pushed to `entries` for COMMIT. When `produceSync()` returns `isStop: true`, `parseChatOutput()` extracts tool calls. Terminal tools (e.g. `report`) are intercepted immediately — findings extracted, agent marked done, never dispatched. Non-terminal tool calls are collected for the DISPATCH phase.

**COMMIT** batch-decodes all produced tokens in a single `store.commit(entries)` call — one GPU dispatch for all agents.

**SETTLE** drains the `settledBuffer` — tool results from the previous tick's DISPATCH. Each result is pressure-gated: if it exceeds headroom, the result is rejected and the agent is marked done. Surviving results are batch-prefilled via `store.prefill()`, then agents transition back to `generating` with grammar state reset.

**DISPATCH** executes collected tool calls sequentially. Each tool runs inside `scoped()` + `call()`:

```typescript
try {
  const result: unknown = yield* scoped(function*() {
    return yield* call(() => tool.execute(toolArgs, toolContext));
  });
  settledBuffer.push({ agentId, prefillTokens, toolName });
} catch (err) {
  agent.state = 'done';
  agent.findings = `Tool error: ${err.message}`;
}
```

`call()` handles Promises, Operations, and plain values uniformly. A tool that does synchronous work returns a plain value. A tool that spawns sub-agents `yield*`s into framework primitives — `call()` detects the Operation and delegates.

`scoped()` creates an error boundary. If the tool throws (inner pool crash, KV exhaustion, malformed args), the error is caught at the dispatch level. The outer pool's agent transitions to `done` with an error finding. Other agents survive. `scoped()` also ensures all inner effects (branches, samplers, forwarders) are cleaned up when the scope exits.

> ["Try/catch works normally for operations you yield directly"][errors]
>
> — [Effection Error Guide][errors]

DISPATCH is sequential because `llama_context` is not thread-safe. When a tool spawns an inner pool, that pool has its own tick loop creating its own async workers. Sequential DISPATCH ensures only one pool's workers are in flight at a time — exclusive `llama_context` access is a correctness requirement, not a performance tradeoff.

## The Decision Boundary

The sequential DISPATCH model produces a specific class of agent behavior: iterative hypothesis refinement through tool call sequences. This is not prompted or engineered — it emerges from the concurrency semantics.

### How it works

When an agent generates a tool call, the tick loop creates a clean boundary between "I have new information" and "what do I do next":

1. Agent generates tokens → hits stop token → tool call extracted
2. COMMIT batch-decodes the final tokens
3. DISPATCH executes the tool — the agent is suspended, the tool runs to completion
4. Tool result lands in `settledBuffer`
5. Next tick's SETTLE prefills the complete result into the agent's KV cache
6. Grammar state resets
7. Agent resumes generating — the tool result is the last thing in its context

Step 7 is the critical moment. The model's next-token prediction operates on a context where the tool result is fully present and the grammar is clean. The model makes a fresh decision: call another tool, call the same tool with different arguments, or report findings. This decision is informed by everything the agent has seen so far — all prior tool results are physically present in the branch's KV cache.

### What this produces

Agents with a prescribed process like "grep first, then search, then read" naturally iterate within those steps:

```
grep(/narrow pattern/)        → 0 matches
search("broad query")         → finds relevant section
read_file(L83-100)            → reads section, identifies a connection
grep(/broader|OR|pattern/)    → 20 matches across 7 lines
read_file(L25-55)             → reads 30-line span for full context
search("specific hypothesis formed from reading")  → confirms thesis
report(findings)
```

The last search query is the signature behavior. The agent read a section, identified a structural connection the original query didn't mention, and constructed a natural-language search specifically targeting that connection. This is multi-hop reasoning — not "search and report" but "search, form hypothesis, search for confirmation."

An agent that greps with a narrow pattern and gets 0 matches will broaden the pattern on its next grep — not because it's prompted to retry, but because the 0-match result is in its context and the model's next-token prediction naturally adjusts. An agent that reads a section and discovers an unexpected connection will construct a search query targeting that specific connection — the read result is in context, and the model forms a hypothesis from it.

### Why concurrency semantics matter

The decision boundary exists because DISPATCH is sequential and SETTLE is complete. The agent cannot start generating its next action while a tool is still executing, and the tool result is fully prefilled before the agent produces another token. There is no interleaving between "process result" and "decide next action."

Under a concurrent dispatch model, tool results arrive mid-generation — the agent is already producing tokens when the result gets prefilled. The result is incorporated, but the agent doesn't get a clean decision point. The generation that was already in flight continues, and the next tool call reflects whatever the model was already committed to before seeing the result. The result is single-hop retrieval: search → read → report, without the iterative refinement that comes from a pause between "here is what I found" and "here is what I'll do next."

The difference is observable in tool call inputs. Under sequential dispatch, later search queries reference concepts discovered in earlier reads — the queries get progressively more specific as the agent builds understanding. Under concurrent dispatch, search queries tend to be variations on the original question — the agent doesn't form intermediate hypotheses because it never gets the clean context boundary that hypothesis formation requires.

### Controlling depth

This behavior scales with `maxTurns`. At `maxTurns: 2`, agents do single-shot retrieval. At `maxTurns: 6`, agents do 3-4 rounds of iterative refinement. The quality difference is in the tool call inputs — later queries are informed by earlier results. The cost is wall time: each tool call round-trips through DISPATCH → SETTLE → PRODUCE, and the agent is suspended for the full duration of each tool execution.

## Shared Resources

### KV Cache

Inner and outer agents share a single `BranchStore` and a single KV cache. `ContextPressure` snapshots `remaining = nCtx - cellsUsed` on every tick. Inner agent prefills consume the same budget as outer agent prefills. When the inner pool runs, it reduces headroom for the outer pool's remaining agents.

KV pressure governs agent lifecycle at four points:

1. **Prefill gate** — at pool setup, the pool computes the total suffix cost (formatted chat tokens) for all agents. If the total exceeds headroom, agents are dropped from the end until the remaining suffixes fit. Dropped agents are marked `done` before generating a single token. This is the primary mechanism that limits sub-agent count in nested pools — outer agents' live branches consume headroom that the inner pool's prefill gate measures against.

2. **PRODUCE hard-cut** — agents are killed before `produceSync()` when remaining drops below `hardLimit`. Pure safety net.

3. **PRODUCE soft-cut** — non-terminal tool calls are denied when headroom is negative. Terminal tools (e.g. `report`) always pass.

4. **SETTLE rejection** — tool results that would cross the `softLimit` floor are rejected and the agent is marked done.

### Event Channel

Inner agent events flow through the same `Events` channel. The TUI or event collector sees `agent:spawn`, `agent:produce`, `agent:tool_call`, `agent:tool_result`, `agent:done` from both outer and inner agents. The `parentAgentId` field on `agent:spawn` distinguishes inner from outer — inner agents have a `parentAgentId` that matches an inner pool's root branch handle, not the outer root.

### Grammar Isolation

Each pool level runs its own `formatChatSync()` call, producing its own grammar, lazy grammar triggers, and parser spec. The inner pool's agents have their own tool schemas. `parseChatOutput()` uses the per-agent format stored at setup time. There is no cross-contamination between inner and outer tool parsing.

### `ContextPressure` Across Nested Pools

Both inner and outer pools create `ContextPressure` snapshots from the same `SessionContext`. `cellsUsed` is a monotonic counter — it increments on every decode and prefill but does not decrement on individual branch prune (only resets on bulk ops like `retainOnly`). This means `remaining` is a conservative lower bound that becomes increasingly pessimistic as branches are pruned during a run. An inner pool's SETTLE consumes KV that the outer pool's next SETTLE will see as reduced headroom. Two thresholds govern behavior:

- **`softLimit`** (default 1024) — remaining KV floor for new work. SETTLE rejects tool results that would cross this floor. PRODUCE hard-cuts non-terminal tool calls when headroom is negative. Set to account for downstream pool needs (reporters, verification).

- **`hardLimit`** (default 128) — crash-prevention floor. Agents killed immediately before `produceSync()`. Pure safety net.

For recursive pipelines, the outer pool's `softLimit` must account for the inner pool's KV consumption. An inner pool with 3 agents, each consuming ~500 tokens of shared prefix + tool results, needs ~1500 tokens of headroom. Set the outer pool's `softLimit` accordingly.

## Recursive Agents

Tools can spawn sub-agents. A tool's `execute()` method returns an Effection [`Operation<unknown>`][ops], which means it can [`yield*`][ops] into any framework primitive — `withSharedRoot`, `useAgentPool`, `runAgents`, `generate`, `diverge`. The inner pipeline shares the same GPU compute, KV cache, and event channel as the outer pool. No separate process. No serialization boundary.

### Scope tree

When a tool spawns sub-agents, the scope tree looks like this:

```
run()
 └─ initAgents()                            ← sets Ctx, Store, Events
     └─ withSharedRoot (outer)              ← outer shared prefix
         └─ useAgentPool (resource)         ← outer pool scope
             ├─ setupAgent ensure()         ← outer branch cleanup
             ├─ scoped(call(tool.execute))  ← DISPATCH phase, error boundary
             │   └─ withSharedRoot (inner)     ← inner shared prefix
             │       └─ useAgentPool (inner)   ← inner pool resource
             │           ├─ setupAgent ensure() ← inner branch cleanup
             │           └─ ...inner agents...
             └─ ...other outer agents...
```

Every node is an Effection [scope][scope]. Effection enforces one rule: ["no operation may outlive its scope"][scope]. Everything else follows from that.

### Context propagation

`Ctx`, `Store`, and `Events` are Effection [Contexts][context] — set once at `initAgents()`, inherited by every child scope automatically:

```typescript
export const Ctx    = createContext<SessionContext>('lloyal.ctx');
export const Store  = createContext<BranchStore>('lloyal.store');
export const Events = createContext<Channel<AgentEvent, void>>('lloyal.events');
```

When the inner `useAgentPool` does `yield* Ctx.expect()`, it gets the same `SessionContext`. Same `BranchStore`. Same event `Channel`. No argument drilling. A child scope can override context locally without affecting ancestors.

### Inner pool execution

The inner `withSharedRoot` formats the inner system prompt and tools, creates a root branch, prefills the shared tokens, then calls the body. The inner `useAgentPool` runs the same four-phase tick loop as the outer pool. Inner agents share the same `BranchStore` and compete for the same KV cache slots.

```typescript
*execute(args: { questions: string[] }): Operation<unknown> {
  const { toolMap, toolsJson } = this._toolkit;

  return yield* withSharedRoot(
    { systemPrompt, tools: toolsJson },
    function*(root) {
      const pool = yield* useAgentPool({
        tasks: args.questions.map(q => ({
          systemPrompt,
          content: q,
          tools: toolsJson,
          parent: root,
        })),
        tools: toolMap,
        terminalTool: 'report',
        maxTurns: 6,
      });

      // Hard-cut recovery — agents with no findings get a reporter pass
      const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
      if (hardCut.length > 0) {
        const reporters = yield* runAgents({
          tasks: hardCut.map(a => ({
            systemPrompt: reporterPrompt,
            content: 'Report your findings.',
            parent: a.branch,
          })),
          tools: new Map([['report', reportTool]]),
          terminalTool: 'report',
        });
        // ...merge reporter findings back...
      }

      return { findings: pool.agents.map(a => a.findings).filter(Boolean) };
    },
  );
}
```

### Result propagation

When the inner pool completes, `runAgents` exits its scope — inner branches are pruned via their `ensure()` callbacks. The inner `withSharedRoot` exits — the inner root is pruned via `try/finally`. Control returns to the tool's `execute()` generator, which returns the result. Back in DISPATCH, the result is JSON-stringified, wrapped in a tool result delta, and pushed to `settledBuffer`. On the next tick's SETTLE phase, the outer agent's branch is prefilled with the tool result, grammar state resets, and the outer agent resumes generating.

### Teardown

Effection defines [three ways an operation exits][scope]: return (completes with a value), error (fails with an exception), or halt (stopped by a parent or related operation). In all three cases, child operations are torn down and cleanup runs.

**Normal completion.** Inner pool finishes → `scoped()` exits → inner branches pruned → inner root pruned → tool returns → result pushed to `settledBuffer` → SETTLE prefills outer agent → outer pool eventually finishes → outer branches pruned → outer root pruned.

**Error in inner pool.** Inner pool errors → `scoped()` error boundary catches it → inner scope tears down → outer agent marked `done` with `findings: "Tool error: ..."` → outer pool continues with remaining agents.

**Outer scope cancelled.** Parent of the outer pool exits → outer pool's resource scope tears down → `scoped()` child is halted → inner pool halted → all inner branches pruned. No dangling branches. No orphaned GPU state.

### Model-level vs harness-level recursion

Harness-level recursion is prescribed — the developer writes the pipeline stages:

```typescript
// Harness decides when to recurse
const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
if (hardCut.length > 0) {
  const reporters = yield* runAgents({
    tasks: hardCut.map(a => ({
      systemPrompt: reporterPrompt,
      content: 'Report your findings.',
      parent: a.branch,
    })),
    tools: new Map([['report', reportTool]]),
    terminalTool: 'report',
  });
}
```

Model-level recursion is emergent — the model calls a tool that spawns sub-agents when it needs deeper investigation, calls it again if the first pass was insufficient, or skips it entirely if it can answer directly. The structured concurrency guarantees are identical in both cases — the difference is who controls the workflow.

A tool that spawns agents is not special. It's a regular `Tool` subclass whose `execute()` method calls framework primitives — the same primitives the harness uses. The tool doesn't know it's being called by an agent. The inner agents don't know they were spawned by a tool. Each level sees its own task prompt and its own set of tools.

Same tools at every level — the **prompt** is the differentiator, not the toolkit:

```
Level 0: Entry agent
         Prompt: "Decompose the question, call research, synthesize, report"
         Tools: [grep, search, read_file, report, research]

Level 1: Research agents (spawned by research tool)
         Prompt: "Grep first, then search, then read, then report"
         Tools: [grep, search, read_file, report, research]

Level 2: Deeper research agents (if a level-1 agent calls research)
         Same prompt. Same tools. Same prescribed process.
```

One toolkit at every level:

```typescript
const toolkit = createToolkit([
  new SearchTool(chunks, reranker),
  new ReadFileTool(resources),
  new GrepTool(resources),
  new ReportTool(),
]);
researchTool.setToolkit(toolkit);
```

## Depth

Nothing in the framework limits recursion to two levels. An inner tool can itself spawn sub-agents that spawn sub-agents. Each level creates its own `withSharedRoot` + `useAgentPool` scope, registers its own `ensure()` callbacks, and participates in the same `BranchStore`. On teardown, Effection halts children when the parent scope exits — ["it is impossible for this task to outlive its parent"][spawn]. The guarantees compose at every depth.

### KV as the natural bound

The practical limit is KV cache capacity. Each nested pool consumes shared prefix tokens per inner agent, drawn from the same budget as the outer pool. Depth is bounded naturally by KV pressure — the prefill gate at pool setup determines how many agents fit, PRODUCE and SETTLE enforce headroom during generation, and `cellsUsed` monotonicity means the pressure estimate is conservative after branch pruning.

### Sizing `softLimit` for recursion

The outer pool's `softLimit` must reserve enough headroom for the inner pool's full lifecycle:

- **Inner shared prefix**: system prompt + tool schemas + generation prompt (~300-500 tokens, model-dependent)
- **Inner agent suffixes**: per-agent formatted chat templates (~250-400 tokens each)
- **Inner tool results**: search results, file contents, grep matches (variable — largest KV consumers)
- **Inner generation**: agent output tokens before reporting

For a single-level recursive tool with up to 3 inner agents and `maxTurns: 6`, a `softLimit` of 2048-3072 on the outer pool provides adequate headroom. Monitor with `trace: true` — the `[SETTLE]` and `[PRODUCE]` pressure logs show remaining/headroom at each tick.

[ops]: https://frontside.com/effection/guides/v4/operations/
[scope]: https://frontside.com/effection/guides/v4/scope/
[spawn]: https://frontside.com/effection/guides/v4/spawn/
[context]: https://frontside.com/effection/guides/v4/context/
[resources]: https://frontside.com/effection/guides/v4/resources/
[errors]: https://frontside.com/effection/guides/v4/errors/
[call]: https://github.com/thefrontside/effection/blob/v4/lib/call.ts
