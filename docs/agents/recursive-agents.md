# Recursive Agents

Tools can spawn sub-agents. A tool's `execute()` method returns an Effection [`Operation<unknown>`][ops], which means it runs inside the agent pool's structured concurrency scope and can [`yield*`][ops] into any framework primitive — `withSharedRoot`, `runAgents`, `generate`, `diverge`. The inner pipeline shares the same GPU compute ([`BranchStore`][branch.hpp] dispatches all branches through a single `llama_context`), KV cache, and event channel as the outer pool. No separate process. No serialization boundary.

This is the mechanism behind research-as-a-tool, verification passes, and composable agent pipelines.

## Scope Tree

When a tool spawns sub-agents, the scope tree looks like this:

```
run()
 └─ initAgents()                          ← sets Ctx, Store, Events
     └─ withSharedRoot (outer)            ← outer shared prefix
         └─ useAgentPool (resource)       ← outer pool scope
             ├─ setupAgent ensure()       ← outer branch cleanup
             ├─ scope.run(tool.execute)   ← tool runs as child of pool scope
             │   └─ withSharedRoot (inner)   ← inner shared prefix
             │       └─ useAgentPool (inner) ← inner pool resource
             │           ├─ setupAgent ensure() ← inner branch cleanup
             │           └─ ...inner agents...
             └─ ...other outer agents...
```

Every node in this tree is an Effection [scope][scope]. Effection enforces one rule: ["no operation may outlive its scope"][scope]. Everything else follows from that.

## Lifecycle

### 1. Tool dispatch

`produceSync()` samples one token per call (`agent-pool.ts:404`). Each token is accumulated into `rawOutput` and committed via `store.commit()` (`agent-pool.ts:491`) to get the next logits. This produce→commit cycle repeats until `produceSync()` returns `isStop: true`. At that point — and only then — `parseChatOutput()` runs on the accumulated `rawOutput` to extract tool calls (`agent-pool.ts:406-410`). If a tool call is found, `dispatchTool()` fires it via `scope.run()` (`agent-pool.ts:356`) — the scope is captured via [`useScope()`][scope] (`agent-pool.ts:231`), which ["allows you to capture a reference to the current Scope"][scope] so tasks can be created as children of the pool's resource scope:

```typescript
// agent-pool.ts — dispatchTool
scope.run(function*() {
  const result: unknown = yield* call(() =>
    tool.execute(toolArgs, toolContext)
  );
  const prefillTokens = buildToolResultDelta(ctx, JSON.stringify(result), callId);
  settledBuffer.push({ agentId: agent.id, prefillTokens, toolName: tc.name });
});
```

[`call()`][call] is Effection's ["uniform integration point for calling async functions, generator functions, and plain functions"][call]. It invokes the callable, then checks the return: if it's a Promise (`isPromise`), it wraps it in an `action()`; if it's an Operation (`isOperation` — has `[Symbol.iterator]`), it delegates directly; otherwise it wraps in `constant()`. A tool that does synchronous work returns a plain value from its generator body. A tool that spawns sub-agents `yield*`s into framework primitives — `call()` detects the Operation and delegates.

### 2. Context propagation

`Ctx`, `Store`, and `Events` are Effection [Contexts][context] — set once at `initAgents()` (`init.ts:68-70`), inherited by every child scope automatically:

```typescript
// context.ts
export const Ctx    = createContext<SessionContext>('lloyal.ctx');
export const Store  = createContext<BranchStore>('lloyal.store');
export const Events = createContext<Channel<AgentEvent, void>>('lloyal.events');
```

When the inner `useAgentPool` does `yield* Ctx.expect()`, it gets the same `SessionContext`. Same `BranchStore`. Same event `Channel`. No argument drilling. Effection's rule: ["Context is attached to the scope of the parent operation. That means that the operation and _all of its children_ will see that same context."][context] A child scope can override context locally without affecting ancestors — ["if a child operation sets its own value for the context, it will _not_ affect the value of any of its ancestors"][context].

### 3. Inner pool execution

The inner `withSharedRoot` calls `formatChatSync()` with the inner system prompt and tools (`shared-root.ts:69`) — producing grammar, lazy grammar triggers, and parser spec. The inner `useAgentPool` is an Effection [resource][resources] (`agent-pool.ts:227`) — it meets both criteria: ["they are long running" and "we want to be able to interact with them while they are running"][resources]. It runs the same three-phase tick loop (PRODUCE → COMMIT → SETTLE) as the outer pool. Inner agents share the same `BranchStore` and compete for the same KV cache slots.

```typescript
class ResearchTool extends Tool<{ query: string }> {
  readonly name = 'research';
  readonly description = 'Spawn sub-agents to research a question in depth';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Research question' },
    },
    required: ['query'],
  };

  *execute(args: { query: string }): Operation<unknown> {
    const { toolMap, toolsJson } = createToolkit([
      new SearchTool(this.chunks, this.reranker),
      new ReadFileTool(this.resources),
      new ReportTool(),
    ]);

    const result = yield* withSharedRoot(
      { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
      function*(root) {
        return yield* runAgents({
          tasks: [{
            systemPrompt: RESEARCH_PROMPT,
            content: args.query,
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          terminalTool: 'report',
          maxTurns: 6,
        });
      },
    );

    return { findings: result.agents[0]?.findings };
  }
}
```

### 4. Result propagation

When the inner pool completes, `runAgents` exits its scope — inner branches are pruned via their `ensure()` callbacks. The inner `withSharedRoot` exits — the inner root is pruned via `try/finally`. Control returns to the tool's `execute()` generator, which returns the result. Back in `dispatchTool`, the result is serialized and pushed into `settledBuffer`. On the next SETTLE phase, the outer agent's branch is prefilled with the tool result delta, grammar state resets, and the outer agent resumes generating.

### 5. Teardown

Effection defines [three ways an operation exits][scope]: return (completes with a value), error (fails with an exception), or halt (stopped by a parent or related operation). In all three cases, child operations are torn down and cleanup runs.

**Normal completion.** Inner pool finishes → `scoped()` exits → inner branches pruned via `ensure()` (`agent-pool.ts:149`) → `withSharedRoot`'s `finally` calls `pruneSubtreeSync()` (`shared-root.ts:78`) → tool returns → result pushed to `settledBuffer` (`agent-pool.ts:373`) → SETTLE prefills outer agent (`agent-pool.ts:534`) → outer pool eventually finishes → outer branches pruned → outer root pruned.

**Error in inner pool.** Inner agent throws or inner pool errors → inner scope tears down (all inner `ensure()` callbacks fire) → error caught by `dispatchTool`'s `try/catch` (`agent-pool.ts:374`) → outer agent marked `done` with `findings: "Tool error: ..."` (`agent-pool.ts:375-376`) → outer pool continues with remaining agents.

**Outer scope cancelled.** Parent of the outer pool exits → outer pool's [resource][resources] scope tears down (["The `provide()` operation will remain suspended until the resource passes out of scope, thus making sure that cleanup is guaranteed"][resources]) → `scope.run()` child is [halted][scope] → inner `withSharedRoot` is halted → inner pool is halted → all inner `ensure()` callbacks fire → all inner branches pruned. No dangling branches. No orphaned GPU state.

## Shared Resources

### KV Cache

Inner and outer agents share a single `BranchStore` and a single KV cache. `ContextPressure` snapshots `remaining = nCtx - cellsUsed` on every tick. Inner agent prefills consume the same budget as outer agent prefills. When the inner pool runs, it reduces headroom for the outer pool's remaining agents.

This means recursive depth is bounded by KV capacity. The outer pool's SETTLE phase may reject tool results for other agents if headroom drops below `softLimit`.

### Event Channel

Inner agent events flow through the same `Events` channel. The TUI or event collector sees `agent:spawn`, `agent:produce`, `agent:tool_call`, `agent:tool_result`, `agent:done` from both outer and inner agents. The `parentAgentId` field on `agent:spawn` distinguishes inner from outer — inner agents have a `parentAgentId` that matches an inner pool's root branch handle, not the outer root.

### Grammar and Tool Parsing

Each pool level runs its own `formatChatSync()` call, producing its own grammar, lazy grammar triggers, and parser spec. The inner pool's agents have their own tool schemas. `parseChatOutput()` uses the per-agent `fmt` stored at setup time. There is no cross-contamination between inner and outer tool parsing.

## Depth

Nothing in the framework limits recursion to two levels. An inner tool can itself spawn sub-agents that spawn sub-agents. Each level creates its own `withSharedRoot` + `useAgentPool` scope, registers its own `ensure()` callbacks, and participates in the same `BranchStore`. On teardown, Effection halts children when the parent scope exits — ["it is impossible for this task to outlive its parent"][spawn] — and each child's `ensure()` callbacks fire as part of being torn down. The guarantees compose at every depth.

The practical limit is KV cache capacity. Each nested pool consumes shared prefix tokens (system prompt + tool schemas + generation prompt) per inner agent, drawn from the same `BranchStore` budget as the outer pool. How many inner agents are alive at once depends on how many outer agents call the tool concurrently — each outer agent in `awaiting_tool` state has its inner pool running as a child of `scope.run()`. Design recursive pipelines with `ContextPressure` thresholds that account for the worst-case concurrent inner agent count.

## Compared to Harness-Level Recursion

The existing `reportPass` pattern in the deep-research example is harness-level recursion — the harness code explicitly forks sub-agents from completed agent branches after the pool returns:

```typescript
// Harness-level: orchestrator decides when to recurse
const pool = yield* runAgents({ tasks, tools: toolMap, maxTurns: 6 });
const hardCut = pool.agents.filter(a => !a.findings && !a.branch.disposed);
yield* runAgents({
  tasks: hardCut.map(a => ({ ..., parent: a.branch })),
  tools: reportOnlyTools,
  terminalTool: 'report',
});
```

Research-as-a-tool is model-level recursion — the model decides when to recurse by calling a tool:

```typescript
// Model-level: agent decides when to recurse via tool call
class ResearchTool extends Tool<{ query: string }> {
  *execute(args: { query: string }): Operation<unknown> {
    const result = yield* withSharedRoot(
      { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
      function*(root) {
        return yield* runAgents({ ... });
      },
    );
    return { findings: result.agents[0]?.findings };
  }
}
```

Harness-level recursion is prescribed: the developer writes the pipeline stages. Model-level recursion is emergent: the model calls the research tool when it needs deeper investigation, calls it again if the first pass was insufficient, or skips it entirely if it can answer directly. The structured concurrency guarantees are identical in both cases — the difference is who controls the workflow.

[ops]: https://frontside.com/effection/guides/v4/operations/
[scope]: https://frontside.com/effection/guides/v4/scope/
[spawn]: https://frontside.com/effection/guides/v4/spawn/
[context]: https://frontside.com/effection/guides/v4/context/
[resources]: https://frontside.com/effection/guides/v4/resources/
[call]: https://github.com/thefrontside/effection/blob/v4/lib/call.ts
[branch.hpp]: https://github.com/lloyal-ai/liblloyal/blob/main/include/lloyal/branch.hpp
