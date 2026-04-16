#!/usr/bin/env node
/**
 * Deep Research — CLI entry point
 *
 * Source-agnostic deep research: web (Tavily), local corpus, or both.
 *
 * Usage:
 *   TAVILY_API_KEY=tvly-... npx tsx examples/deep-research-web/main.ts [model] [--query <text>] [--reranker <path>] [options]
 *   npx tsx examples/deep-research-web/main.ts [model] --corpus <dir> [--query <text>] [options]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";
import { main, ensure, createSignal, spawn, each, call, action } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { initAgents, JsonlTraceWriter } from "@lloyal-labs/lloyal-agents";
import type { Source } from "@lloyal-labs/lloyal-agents";
import {
  c, log, setJsonlMode, setVerboseMode, fmtSize, createView,
} from "./tui";
import type { WorkflowEvent } from "./tui";
import { TavilyProvider } from "@lloyal-labs/rig";
import type { SourceContext, Chunk } from "@lloyal-labs/rig";
import {
  createReranker, WebSource, CorpusSource, loadResources, chunkResources,
} from "@lloyal-labs/rig/node";
import { handleQuery } from "./harness";

// ── CLI args ─────────────────────────────────────────────────────

const DEFAULT_MODEL = path.resolve(
  __dirname, "../../models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
);
const DEFAULT_RERANKER = path.resolve(
  __dirname, "../../models/qwen3-reranker-0.6b-q4_k_m.gguf",
);

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    query:            { type: "string" },
    reranker:         { type: "string" },
    corpus:           { type: "string" },
    "findings-budget": { type: "string" },
    jsonl:            { type: "boolean", default: false },
    verbose:          { type: "boolean", default: false },
    trace:            { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const modelPath = positionals[0] || DEFAULT_MODEL;
const rerankModelPath = flags.reranker || DEFAULT_RERANKER;
const corpusDir = flags.corpus;
const initialQuery = flags.query;
const findingsMaxChars = flags["findings-budget"]
  ? parseInt(flags["findings-budget"], 10)
  : undefined;
const jsonlMode = flags.jsonl;
const verbose = flags.verbose;
const trace = flags.trace;

// ── Validate sources ─────────────────────────────────────────────

const hasTavily = !!process.env.TAVILY_API_KEY;
if (!hasTavily && !corpusDir) {
  process.stdout.write(
    `At least one source required.\n\n` +
    `  Web:    TAVILY_API_KEY=tvly-... npx tsx examples/deep-research-web/main.ts\n` +
    `  Corpus: npx tsx examples/deep-research-web/main.ts --corpus <dir>\n` +
    `  Both:   TAVILY_API_KEY=tvly-... npx tsx examples/deep-research-web/main.ts --corpus <dir>\n`,
  );
  process.exit(1);
}

if (jsonlMode) setJsonlMode(true);
if (verbose) setVerboseMode(true);

// Silence llama.cpp stderr in default mode (verbose/jsonl/trace need the output)
const quietMode = !verbose && !jsonlMode && !trace;
if (quietMode) {
  try {
    fs.closeSync(2);
    fs.openSync(process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null", "w");
  } catch {
    // Non-fatal: failing to redirect stderr leaves llama.cpp's logs visible,
    // which is cosmetic noise, not a runtime error.
  }
}

const AGENT_COUNT = 3;
const VERIFY_COUNT = 3;
const MAX_TOOL_TURNS = 10;

// ── Error helpers ────────────────────────────────────────────────

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  const modelName = path.basename(modelPath).replace(/-Q\w+\.gguf$/, "");
  const mode = hasTavily && corpusDir ? "Web + Corpus"
    : hasTavily ? "Web"
    : "Corpus";

  log();
  log(`${c.bold}  Deep Research${c.reset} ${c.dim}\u2014 ${mode} + Structured Concurrency${c.reset}`);
  log();
  log(`  ${c.green}\u25cf${c.reset} Loading ${c.bold}${modelName}${c.reset} ${c.dim}(${fmtSize(fs.statSync(modelPath).size)}, KV: Q4_0)${c.reset}`);

  const nCtx = parseInt(process.env.LLAMA_CTX_SIZE || "16384", 10);
  const ctx: SessionContext = yield* call(() =>
    createContext({ modelPath, nCtx, nSeqMax: 64, typeK: "q4_0", typeV: "q4_0" }),
  );

  const rerankName = path.basename(rerankModelPath).replace(/-q\w+\.gguf$/i, "");
  log(`  ${c.green}\u25cf${c.reset} Loading ${c.bold}${rerankName}${c.reset} ${c.dim}(${fmtSize(fs.statSync(rerankModelPath).size)}, reranker)${c.reset}`);

  const reranker = yield* call(() => createReranker(rerankModelPath, { nSeqMax: 8, nCtx: 16384 }));
  yield* ensure(() => { reranker.dispose(); });

  // ── Source composition ────────────────────────────────────
  const sources: Source<SourceContext, Chunk>[] = [];

  if (corpusDir) {
    const resources = loadResources(corpusDir);
    const chunks = chunkResources(resources);
    sources.push(new CorpusSource(resources, chunks, {
      grep: { maxResults: 50, lineMaxChars: 200 },
      readFile: { defaultMaxLines: 100 },
    }));
    log(`  ${c.dim}  Corpus: ${resources.length} files, ${chunks.length} chunks${c.reset}`);
  }

  if (hasTavily) {
    sources.push(new WebSource(new TavilyProvider(), {
      topN: 5,
      fetch: { maxChars: 3000, topK: 5, timeout: 10_000, tokenBudget: 1200 },
    }));
    log(`  ${c.dim}  Tavily web search enabled${c.reset}`);
  }

  const traceWriter = trace
    ? new JsonlTraceWriter(fs.openSync(`trace-${Date.now()}.jsonl`, "w"))
    : undefined;
  if (traceWriter) log(`  ${c.dim}  Trace: trace-*.jsonl${c.reset}`);

  const { session, events } = yield* initAgents<WorkflowEvent>(ctx, { traceWriter });

  // ── View subscriber — all presentation lives here ─────────
  const view = createView({
    model: path.basename(modelPath),
    reranker: path.basename(rerankModelPath),
    agentCount: AGENT_COUNT,
    verifyCount: VERIFY_COUNT,
  });
  yield* spawn(function* () { yield* view.subscribe(events); });

  const harnessOpts = {
    verifyCount: VERIFY_COUNT,
    maxTurns: MAX_TOOL_TURNS,
    trace,
    findingsMaxChars,
  };

  // ── Initial query — clarify falls through to passthrough in non-interactive mode
  if (initialQuery) {
    const result = yield* handleQuery(initialQuery, session, sources, reranker, harnessOpts);
    if (result.type === "clarify" && !jsonlMode) {
      log(`  ${c.dim}Clarification needed but running in --query mode, treating as passthrough${c.reset}`);
    }
    if (jsonlMode) return;
  }

  // ── REPL — Signal bridges readline into Effection scope ──
  log(`  ${c.dim}${session.trunk ? "Ask a follow-up question" : "Enter your research question"} or /quit to exit${c.reset}`);
  log();

  const inputSignal = createSignal<string, void>();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`  ${c.dim}>${c.reset} `);

  yield* spawn(function* () {
    yield* action<void>((resolve) => {
      rl.on("line", (line: string) => inputSignal.send(line.trim()));
      rl.on("close", () => { inputSignal.close(); resolve(); });
      return () => rl.close();
    });
  });

  let pendingClarify: string | null = null;
  rl.prompt();

  for (const input of yield* each(inputSignal)) {
    if (!input || input === "/quit") break;
    try {
      const queryText = pendingClarify ?? input;
      const clarification = pendingClarify ? input : undefined;
      const result = yield* handleQuery(queryText, session, sources, reranker, harnessOpts, clarification);
      pendingClarify = result.type === "clarify" ? queryText : null;
    } catch (err) {
      pendingClarify = null;
      log(`  ${c.red}Error: ${errorMessage(err)}${c.reset}`);
    }
    yield* each.next();
    try { rl.prompt(); } catch { break; }
  }
}).catch((err: unknown) => {
  process.stdout.write(`Error: ${errorMessage(err)}\n${errorStack(err)}\n`);
  process.exit(1);
});
