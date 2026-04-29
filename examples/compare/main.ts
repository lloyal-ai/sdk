#!/usr/bin/env node
/**
 * Compare — DAG-centric framework primer for the lloyal SDK.
 *
 * Visualizes a 6-node DAG that:
 *   1. researches X on the live web (WebSource: web_search + fetch_page)
 *   2. researches Y in a local corpus (CorpusSource: grep + read_file + search)
 *   3. compares X vs Y along three axes in parallel (after BOTH research
 *      lanes complete — the multi-parent edge is what makes this a DAG and
 *      not a chain or fanout)
 *   4. synthesizes the three axis comparisons into a single argument
 *
 * In a TTY, mounts an Ink TUI that draws the topology as agent cards
 * connected by orthogonal box-drawing edges. Cards stream tokens live;
 * dependent cards light up the moment their parents report.
 *
 * Outside a TTY (pipe / `--jsonl`), falls back to one-line stderr events
 * and a plain stdout final answer so it stays scriptable.
 *
 *   export TAVILY_API_KEY=tvly-…
 *   npx tsx examples/compare/main.ts \
 *     --x "Rust's ownership model" \
 *     --y "Swift's automatic reference counting" \
 *     --corpus ~/Documents/swift-docs \
 *     --reranker ~/.cache/lloyal/models/Qwen3-Reranker-0.6B-Q8_0.gguf \
 *     ~/.cache/lloyal/models/Qwen3.5-4B-Q4_K_M.gguf
 */

import * as fs from "node:fs";
import { parseArgs } from "node:util";
import {
  call,
  each,
  ensure,
  main,
  sleep,
  spawn,
} from "effection";
import type { Operation } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import {
  initAgents,
  JsonlTraceWriter,
} from "@lloyal-labs/lloyal-agents";
import type { AgentEvent, Source } from "@lloyal-labs/lloyal-agents";
import { TavilyProvider } from "@lloyal-labs/rig";
import type { Chunk, SourceContext } from "@lloyal-labs/rig";
import {
  CorpusSource,
  WebSource,
  chunkResources,
  createReranker,
  loadResources,
} from "@lloyal-labs/rig/node";
import { handleCompare, type DagEvent } from "./harness";

// ── CLI args ─────────────────────────────────────────────────────

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    x: { type: "string" },
    y: { type: "string" },
    corpus: { type: "string" },
    reranker: { type: "string" },
    axes: { type: "string" },
    "max-turns": { type: "string" },
    "n-ctx": { type: "string" },
    jsonl: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const modelPath = positionals[0];
const x = flags.x;
const y = flags.y;
const corpusDir = flags.corpus;
const rerankerPath = flags.reranker;
const tavilyKey = process.env.TAVILY_API_KEY;
const trace = flags.trace;
const jsonlMode = flags.jsonl;

const missing: string[] = [];
if (!modelPath) missing.push("positional model path");
if (!x) missing.push("--x <subject>");
if (!y) missing.push("--y <subject>");
if (!corpusDir) missing.push("--corpus <dir>");
if (!rerankerPath) missing.push("--reranker <path>");
if (!tavilyKey) missing.push("TAVILY_API_KEY env");
if (missing.length) {
  process.stderr.write(`Missing required: ${missing.join(", ")}\n`);
  process.exit(2);
}

const axesStr = flags.axes ?? "accuracy,performance,complexity";
const axesArr = axesStr.split(",").map((a) => a.trim()).filter(Boolean);
if (axesArr.length !== 3) {
  process.stderr.write(
    `--axes must be exactly three comma-separated values; got ${axesArr.length}\n`,
  );
  process.exit(2);
}
const axes: [string, string, string] = [axesArr[0], axesArr[1], axesArr[2]];

const maxTurns = flags["max-turns"] ? parseInt(flags["max-turns"], 10) : 10;
const nCtx = flags["n-ctx"] ? parseInt(flags["n-ctx"], 10) : 32768;

const useTui = process.stdout.isTTY === true && !jsonlMode;

// ── Source labels — fixed for the compare topology ───────────────

const SOURCE_LABELS: Record<string, string> = {
  research_web_X: "web",
  research_corp_Y: "corpus",
  compare_axis_1: `axis: ${axes[0]}`,
  compare_axis_2: `axis: ${axes[1]}`,
  compare_axis_3: `axis: ${axes[2]}`,
  synthesize: "sink",
};

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  // Silence llama.cpp stderr in TUI mode so it doesn't tear the layout.
  if (useTui) {
    try {
      fs.closeSync(2);
      fs.openSync(process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null", "w");
    } catch {
      // non-fatal
    }
  }

  process.stderr.write(`[compare] loading model…\n`);
  const ctx = yield* call(() =>
    createContext({
      modelPath: modelPath!,
      nCtx,
      nSeqMax: 64,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  const reranker = yield* call(() =>
    createReranker(rerankerPath!, { nSeqMax: 8, nCtx: 16384 }),
  );
  yield* ensure(() => {
    reranker.dispose();
  });

  const traceWriter = trace
    ? new JsonlTraceWriter(fs.openSync(`trace-${Date.now()}.jsonl`, "w"))
    : undefined;

  const { session, events } = yield* initAgents<AgentEvent>(ctx, { traceWriter });

  // Either the TUI bus or the stderr forwarder consumes `events`. We pick
  // exactly one based on `useTui`.
  let emitDagEvent: (ev: DagEvent) => void;
  let renderTuiUnmount: (() => void) | null = null;

  if (useTui) {
    // Dynamic import of the Ink-side modules — they're ESM (yoga-wasm-web
    // top-level await) and we need to load them only when actually mounting.
    const tuiMod = yield* call(
      () =>
        import("./tui/render.js") as Promise<typeof import("./tui/render.js")>,
    );
    const busMod = yield* call(
      () =>
        import("./tui/event-bus.js") as Promise<typeof import("./tui/event-bus.js")>,
    );

    const bus = busMod.createBus<unknown>();
    const instance = tuiMod.render(bus as never, {
      x: x!,
      y: y!,
      sourceLabels: SOURCE_LABELS,
    });
    renderTuiUnmount = () => instance.unmount();
    yield* ensure(() => { renderTuiUnmount?.(); });

    emitDagEvent = (ev) => bus.send(ev);

    // Forward all agent events from initAgents into the bus so the cards
    // stream live. Spawn so we don't block the main pipeline.
    yield* spawn(function* (): Operation<void> {
      for (const ev of yield* each(events)) {
        bus.send(ev);
        yield* each.next();
      }
    });
  } else {
    // Non-TTY: stderr line per lifecycle event + JSONL on stdout if --jsonl.
    const t0 = performance.now();
    const elapsed = (): string => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
    let agentSeq = 0;
    const seqByAgentId = new Map<number, number>();

    emitDagEvent = (ev) => {
      if (jsonlMode) {
        process.stdout.write(JSON.stringify(ev) + "\n");
      } else if (ev.type === "dag:topology") {
        process.stderr.write(
          `[compare] dag · ${ev.nodes.length} nodes · ${ev.nodes.filter((n) => n.dependsOn.length === 0).length} roots\n`,
        );
      }
    };

    yield* spawn(function* (): Operation<void> {
      for (const ev of yield* each(events)) {
        if (jsonlMode) {
          process.stdout.write(JSON.stringify(ev) + "\n");
        } else if (ev.type === "agent:spawn") {
          const seq = ++agentSeq;
          seqByAgentId.set(ev.agentId, seq);
          process.stderr.write(
            `[compare] +${elapsed()} agent#${seq} spawned (parent agent#${seqByAgentId.get(ev.parentAgentId) ?? "root"})\n`,
          );
        } else if (ev.type === "agent:report") {
          const seq = seqByAgentId.get(ev.agentId) ?? "?";
          process.stderr.write(
            `[compare] +${elapsed()} agent#${seq} reported (${ev.result.length} chars)\n`,
          );
        } else if (ev.type === "agent:tool_call") {
          const seq = seqByAgentId.get(ev.agentId) ?? "?";
          process.stderr.write(`[compare] +${elapsed()} agent#${seq} → ${ev.tool}\n`);
        }
        yield* each.next();
      }
    });
  }

  // ── Build sources ──────────────────────────────────────────────
  process.stderr.write(`[compare] loading corpus from ${corpusDir}…\n`);
  const resources = loadResources(corpusDir!);
  const chunks = chunkResources(resources);
  const sources: Source<SourceContext, Chunk>[] = [
    new WebSource(new TavilyProvider(tavilyKey!), {
      topN: 5,
      fetch: { maxChars: 3000, topK: 5, timeout: 10_000, tokenBudget: 1200 },
    }),
    new CorpusSource(resources, chunks, {
      grep: { maxResults: 50, lineMaxChars: 200 },
      readFile: { defaultMaxLines: 100 },
    }),
  ];

  // ── Run the DAG ────────────────────────────────────────────────
  // Isolate the failable computation in a child scope. Without this, an
  // assertion or decode error inside `handleCompare` propagates to main's
  // .catch handler and tears the TUI down before the user can read the
  // failure state. The pattern: try/catch the inner generator, emit a
  // `compare:error` event so the reducer paints an error panel, and (in
  // TUI mode) hold the screen for a few seconds before scope exit fires
  // `ensure(unmount)` cleanups in LIFO order.
  process.stderr.write(
    `[compare] starting 6-node DAG · X="${x}" · Y="${y}" · axes=${axes.join("/")}\n`,
  );

  let result: { answer: string; totalTokens: number; totalToolCalls: number } | null = null;
  let fatalError: Error | null = null;

  try {
    result = yield* handleCompare(session, sources, reranker, {
      x: x!,
      y: y!,
      axes,
      maxTurns,
      trace,
      emitDagEvent,
    });
  } catch (err) {
    fatalError = err instanceof Error ? err : new Error(String(err));
    emitDagEvent({
      type: "compare:error",
      message: fatalError.message,
      stack: fatalError.stack,
    });
    process.exitCode = 1;
  }

  if (fatalError && useTui) {
    // Hold the error frame visible — Ink doesn't yet support waiting for
    // a keypress in our tooling, so we sleep. Three seconds is enough to
    // read the panel; users impatient to dismiss can ^C.
    yield* sleep(3000);
  }

  // Final-answer routing only fires on success.
  if (result && !useTui && !jsonlMode) {
    process.stdout.write(result.answer);
    if (!result.answer.endsWith("\n")) process.stdout.write("\n");
  } else if (result && jsonlMode) {
    process.stdout.write(
      JSON.stringify({ type: "compare:done", answer: result.answer }) + "\n",
    );
  }
}).catch((err: unknown) => {
  // Reachable only on errors that escape the inner try/catch — i.e. boot
  // failures (model load, reranker, source binding). Don't `process.exit`
  // synchronously; let pending `ensure` cleanups drain first.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = 1;
});
