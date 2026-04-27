# compare — DAG framework primer

A 6-node DAG with explicit edges drawn between live streaming agent cards. The example exists to make `dag(...)` from `@lloyal-labs/lloyal-agents` *visceral*: spawn waves, multi-parent dependencies, and Continuous Context spine extension are all things you can point at as they happen.

```
  research_web_X ──┐                          ┌──▶ compare_axis_1 ──┐
  (WebSource)      │                          │                     │
                   ├──────────────────────────┼──▶ compare_axis_2 ──┼──▶ synthesize
  research_corp_Y ─┘                          │                     │
  (CorpusSource)                              └──▶ compare_axis_3 ──┘

       roots                       fan-in / fan-out                  sink
   (parallel, no deps)          (3 siblings sharing deps)
```

Why this DAG matters pedagogically:

- **Multi-parent dependencies.** Each `compare_axis_*` node depends on TWO research nodes simultaneously — `chain` and `fanout` can't express this.
- **Sibling parallelism with shared deps.** The three compare nodes fire the moment both research nodes complete, then run concurrently.
- **Multi-child convergence.** `synthesize` waits on all three siblings before spawning.
- **Spine extension is causal, not just sequential.** Each node's `userContent` is prefilled onto the shared root via `ctx.extendRoot`. The compare nodes don't merely *follow* the research nodes — they *attend to* them. The edge in the diagram is the spine.

## Run it

```sh
export TAVILY_API_KEY=tvly-…

npx tsx examples/compare/main.ts \
  --x "Rust's ownership model" \
  --y "Swift's automatic reference counting" \
  --corpus ~/Documents/swift-docs \
  --reranker ~/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf \
  ~/.cache/lloyal/models/Qwen3.5-4B-Q4_K_M.gguf
```

Or via the workspace script:

```sh
npm run examples:compare -- --x "…" --y "…" --corpus … --reranker … <model>
```

## What you'll see

In a TTY, an Ink TUI renders the topology with cards laid out in topological layers connected by orthogonal box-drawing edges. Cards stream tokens live; pending cards show a dotted background; completed cards collapse to a one-line summary.

```
╭ DAG · Rust ownership vs Swift ARC · 0:32 ────────────────────────╮
│ 1840 tok · 18 tools                                              │
╰──────────────────────────────────────────────────────────────────╯

╭─ research_web_X · web · ●12 ───╮  ╭─ research_corp_Y · corpus · ●8 ─╮
│ "The borrow checker enforces…" │  │ Reading examples/lifetimes.md   │
│ Fetched 3 pages                │  │ Found Box<T> at line 42         │
│ ▮ analyzing…                   │  │ ▮ ARC at compile time…          │
╰──────────────┬─────────────────╯  ╰────────────┬────────────────────╯
               │                                 │
               ╭─────────────┬────────┬──────────╯
                             │        │          │
       ╭─────────────────────┴──╮ ╭───┴──────╮ ╭─┴─────────────────╮
       │ compare_axis_1         │ │ axis_2   │ │ axis_3            │
       │ ····················   │ │ pending  │ │ pending           │
       ╰────────────┬───────────╯ ╰─────┬────╯ ╰────┬──────────────╯
                    │                   │           │
                    ╰───────────────────┼───────────╯
                                        │
                          ╭─────────────┴───────╮
                          │ synthesize          │
                          │ pending             │
                          ╰─────────────────────╯
```

Outside a TTY (pipe, CI, `--jsonl`), the same harness runs with stderr line events and a plain stdout final answer:

```sh
npm run examples:compare -- --x "…" --y "…" --corpus … --reranker … <model> > report.md
# stderr:
# [compare] +0.0s agent#1 spawned (parent agent#root)
# [compare] +0.0s agent#2 spawned (parent agent#root)
# [compare] +0.1s agent#1 → web_search
# …
# stdout: the synthesized markdown report
```

`--jsonl` streams the full event union (`dag:topology`, `dag:node:spawn`, all `agent:*` events, plus a `compare:done` payload) on stdout for piping into other tools.

## Reading the code

- `harness.ts` — DAG declaration + custom orchestrator (`dagWithEvents`) that mirrors `dag()` from `packages/agents/src/orchestrators.ts:209` but emits per-node lifecycle events. ~190 LOC.
- `main.ts` — CLI args, model load, source build, TUI mount or non-TTY fallback. ~210 LOC.
- `tui/` — self-contained Ink TUI:
  - `DagCanvas.tsx` — topo sort into layers, layout cards, draw `EdgeRow` between layers
  - `EdgeRow.tsx` + `edge-router.ts` — pure orthogonal box-drawing router (drop · bus · drop)
  - `AgentCard.tsx` — fixed-width card with status header, streaming body, summary
  - `state.ts` + `reducer.ts` + `events.ts` — pure reducer over `dag:*` and `agent:*` events
  - `App.tsx` + `render.ts` — mount + header + canvas + final answer panel
- `prompts/research-web.eta`, `prompts/research-corpus.eta`, `prompts/compare.eta`, `prompts/synthesize.eta` — system + user prompts for each node type.

## Smoke tests

```sh
# Reducer + edge router (pure unit-style; no Ink imports):
npx tsx examples/compare/tui/__reducer-smoke.ts

# Visual: drives synthetic events through the TUI to render three frozen states.
# Best viewed in a real terminal — when piped, terminal width detection is
# imperfect and edges may wrap.
npx tsx examples/compare/tui/__visual-smoke.tsx
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--x <subject>` | required | Subject researched on the live web |
| `--y <subject>` | required | Subject researched in the local corpus |
| `--corpus <dir>` | required | Local corpus directory (markdown files) |
| `--reranker <path>` | required | Reranker GGUF path |
| `<model>` (positional) | required | LLM GGUF path |
| `--axes <a,b,c>` | `accuracy,performance,complexity` | Three comma-separated axes |
| `--max-turns <n>` | `10` | Max tool calls per agent |
| `--n-ctx <n>` | `32768` | LLM context window |
| `--jsonl` | off | Stream events as JSONL on stdout (skips TUI) |
| `--trace` | off | Dump full agent trace to `trace-<ts>.jsonl` |

`TAVILY_API_KEY` must be set in the environment.
