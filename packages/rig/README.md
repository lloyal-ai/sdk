# @lloyal-labs/rig

Retrieval-Interleaved Generation for [lloyal-agents](../agents).

```bash
npm i @lloyal-labs/rig @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node
```

## RIG vs RAG

RAG retrieves first, then generates. A retrieval step runs upfront — query the vector DB, get top-k passages, inject them into the prompt, call the model once. The model sees static context. Retrieval and generation are separate phases.

RIG interleaves retrieval and generation inside the decode loop. Agents generate reasoning, decide to search, process results, reason further, fetch a page, form hypotheses from the content, search again with refined queries. Retrieval decisions emerge from ongoing generation — each search query is informed by everything the agent has already discovered.

The difference is observable in tool call inputs. A RAG system constructs search queries from the original user question. A RIG agent constructs queries from hypotheses formed during generation:

```
grep(/memory leak/)            → 3 matches in 2 files
read_file(pool.ts L40-80)      → reads allocation logic, spots missing cleanup
search("resource cleanup on connection close")  → finds teardown handler
read_file(server.ts L120-155)  → discovers close handler never calls pool.drain()
grep(/drain|dispose|cleanup/)  → 8 matches, confirms drain exists but is unused
search("pool drain connection lifecycle interaction")  → targets the gap
report(findings)
```

The last search — `"pool drain connection lifecycle interaction"` — is the signature behavior. The agent read the allocation logic, discovered the drain method existed but was never called on connection close, and constructed a search specifically targeting that interaction. This is multi-hop reasoning: not "search and report" but "search, form hypothesis, search for confirmation."

### Why it's emergent

This behavior is not prompted or engineered. It emerges from the concurrency semantics of `lloyal-agents`.

The four-phase tick loop creates a clean decision boundary between each tool call and the next generation step:

1. Agent generates tokens, hits stop token, tool call extracted
2. Tool executes to completion — agent is suspended
3. Tool result fully prefilled into the agent's KV cache
4. Grammar state resets — clean slate for next decision
5. Agent resumes generating with the complete result as the last thing in context

Step 5 is the critical moment. The model's next-token prediction operates on a context where the tool result is fully present and the grammar is clean. The model makes a fresh decision: call another tool, call the same tool with different arguments, or report findings. This decision is informed by everything the agent has seen — all prior tool results are physically present in the branch's KV cache.

An agent that greps with a narrow pattern and gets 0 matches will broaden the pattern on its next grep — not because it's prompted to retry, but because the 0-match result is in context and the model naturally adjusts. An agent that reads a section and discovers an unexpected connection will construct a search query targeting that specific connection — the read result is in context, and the model forms a hypothesis from it.

Under a concurrent dispatch model where tool results arrive mid-generation, the agent is already producing tokens when results land. The result gets incorporated, but there's no clean pause for hypothesis formation. The observable effect: sequential dispatch produces progressively more specific queries; concurrent dispatch produces variations on the original question.

Depth scales with `maxTurns`. At 2 turns, agents do single-shot retrieval. At 6 turns, agents do 3-4 rounds of iterative refinement. At 20 turns, agents go deep — following citation chains, cross-referencing claims, building evidence maps. The quality difference is in the later tool call inputs.

## Sources

`@lloyal-labs/rig` provides two `Source` implementations (extending the base class from `lloyal-agents`):

**CorpusSource** — local files with grep, semantic search, read_file, and recursive research tools. Agents investigate a knowledge base by pattern matching, reading sections in context, and spawning sub-agents for deeper investigation.

**WebSource** — web search via [Tavily](https://tavily.com), page fetching with attention-based content extraction, and recursive web_research tools. `BufferingFetchPage` wraps fetch results — full content goes to the agent for reasoning, while a parallel buffer stores content for post-research reranking. Content extraction uses `generate({ parent })` to attend over the fetched page and extract summary + links via grammar-constrained generation, then prunes the fork — zero net KV cost per extraction.

Sources are composable. A pipeline can use one source, both, or custom implementations:

```typescript
import {
  CorpusSource,
  WebSource,
  TavilyProvider,
  loadResources,
  chunkResources,
} from "@lloyal-labs/rig";

const sources = [];

// Local knowledge base
if (corpusDir) {
  const resources = loadResources(corpusDir);
  const chunks = chunkResources(resources);
  sources.push(new CorpusSource(resources, chunks));
}

// Web search
if (process.env.TAVILY_API_KEY) {
  sources.push(new WebSource(new TavilyProvider()));
}
```

When multiple sources are used, they run sequentially — each source gets the full KV budget. After source N completes, its inner branches are pruned and KV is freed for source N+1.

### Bridge

Between sources, a bridge exit gate structures discoveries from the completed source as durable context for the next source's investigation:

```
Corpus research → Bridge → Web research → Synthesize
```

The bridge extracts three tiers of discovery:

1. **What was established** — specific data points, study details, statistics, quotes. Evidence preserved verbatim.
2. **Where evidence is incomplete** — acknowledged limitations, absent study designs, uncertain mechanisms. These are well-researched claims with identified evidence gaps.
3. **What was not covered** — topics mentioned but not substantiated, or entirely absent.

The distinction between (2) and (3) is critical. A topic with six sections of evidence but no experimental validation is not a gap — it is a well-researched claim with an identified evidence limitation. The bridge flags the limitation, not the topic. This prevents the next source from re-investigating what the previous source already covered, and directs it toward genuine gaps.

Bridge discoveries condition the next source's questions:

```typescript
activeQuestions = questions.map(
  (q) => `${q}\n\nPrior research discoveries:\n${discoveries}`,
);
```

## Pipeline

A typical RIG pipeline:

```
Plan → Research → [Bridge →] Synthesize → Eval
```

**Plan.** Grammar-constrained decomposition of the user query into sub-questions with intent classification (`research` vs `clarify`). If the query is focused enough to investigate directly, produces an empty array (passthrough). Uses `generate()` with a JSON schema grammar — the model outputs structured `{ questions: [{ text, intent }] }` in a single generation pass.

**Research.** Each source's research tool spawns a pool of agents that investigate sub-questions. Agents interleave retrieval and generation — searching, reading, forming hypotheses, searching again. Within each source, all agents run concurrently on shared GPU compute via `useAgentPool`. Sources run sequentially, each getting the full KV budget.

Agents that get cut by context pressure (their tool results exceeded KV headroom) are recovered via scratchpad extraction — `generate({ parent: agent.branch })` with a grammar-constrained reporter prompt attends over the agent's accumulated KV and extracts findings. The agent paid the KV cost of reasoning; the extraction recovers the value.

**Bridge.** Runs between sources when multiple sources are configured. A single agent with report-only tools structures discoveries from the completed source. The bridge output conditions the next source's sub-questions, directing investigation toward gaps rather than re-covering established ground.

**Synthesize.** A synthesis agent integrates findings from all sources into a structured report with source attribution. Research notes provide analytical structure; reranked source passages provide ground truth for citation. The synthesizer cross-references both — using research notes to identify what matters, and source passages for evidence.

**Eval.** Multi-branch semantic comparison via `diverge()`. Fork N branches from a shared frontier, generate independently with the same verify prompt, check convergence. Where branches agree, the model is confident. Where they diverge, the answer needs refinement.

## Tools

### Corpus tools

| Tool           | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `SearchTool`   | Semantic search over corpus chunks via reranker scoring                 |
| `GrepTool`     | Exhaustive regex pattern matching across all files                      |
| `ReadFileTool` | Read file content at specified line ranges, tracks per-agent read state |
| `ResearchTool` | Spawn sub-agent pool for deeper investigation of sub-questions          |
| `ReportTool`   | Terminal tool — agents call this to submit findings                     |

### Web tools

| Tool              | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `WebSearchTool`   | Web search via configurable provider (Tavily included)          |
| `FetchPageTool`   | Fetch URL, extract article text via Readability                 |
| `WebResearchTool` | Spawn sub-agent pool with web tools for recursive investigation |

### Pipeline tools

| Tool                        | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `PlanTool`                  | Grammar-constrained query decomposition with intent classification |
| `createTools(opts)`         | Build corpus toolkit from resources, chunks, and reranker          |
| `createReranker(modelPath)` | Semantic reranker for chunk scoring and passage selection          |

## Custom Sources

Extend `Source` from `lloyal-agents` to create custom sources:

```typescript
import { Source } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";

class DatabaseSource extends Source<SourceContext, Row> {
  readonly name = "database";

  get researchTool(): Tool {
    return this._researchTool;
  }

  *bind(ctx: SourceContext) {
    // Set up tools with access to ctx.parent (for generate({ parent })),
    // ctx.reranker, ctx.reporterPrompt, ctx.reportTool
    this._researchTool = new DatabaseResearchTool(/* ... */);
  }

  getChunks(): Row[] {
    return this._results; // buffered for post-research reranking
  }
}
```

The `bind()` lifecycle receives a `SourceContext` with the parent branch (for forking), reranker, reporter prompt, and report tool. Your research tool calls `useAgentPool` or `runAgents` internally — same primitives the built-in sources use.

## License

Apache-2.0
