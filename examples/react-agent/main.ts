#!/usr/bin/env node
/**
 * ReAct Agent — CLI entry point
 *
 * Single agent with corpus tools answers a question using the ReAct pattern.
 *
 * Usage:
 *   npx tsx examples/react-agent/main.ts [model-path] --corpus <path> [--query <text>] [options]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  main,
  ensure,
  createSignal,
  spawn,
  each,
  call,
  action,
} from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { initAgents } from "@lloyal-labs/lloyal-agents";
import { c, log, setJsonlMode, setVerboseMode, fmtSize, createView } from "./tui";
import type { WorkflowEvent } from "./tui";
import { loadResources, chunkResources, createReranker, createTools } from "@lloyal-labs/rig";
import { handleQuery } from "./harness";
import type { HarnessOpts } from "./harness";

// ── CLI args ─────────────────────────────────────────────────────

const DEFAULT_MODEL = path.resolve(
  __dirname,
  "../../models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
);
const DEFAULT_RERANKER = path.resolve(
  __dirname,
  "../../models/qwen3-reranker-0.6b-q4_k_m.gguf",
);

const args = process.argv.slice(2);
const jsonlMode = args.includes("--jsonl");
const verbose = args.includes("--verbose");
const trace = args.includes("--trace");

function argVal(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const flagIndices = new Set(
  ["--reranker", "--corpus", "--query"].flatMap((f) => {
    const i = args.indexOf(f);
    return i !== -1 ? [i, i + 1] : [];
  }),
);

const rerankModelPath = argVal("--reranker") || DEFAULT_RERANKER;
const corpusDir = argVal("--corpus");
const initialQuery = argVal("--query");
const modelPath =
  args.find((a, i) => !a.startsWith("--") && !flagIndices.has(i)) ||
  DEFAULT_MODEL;

if (!corpusDir) {
  process.stdout.write(
    `Usage: npx tsx examples/react-agent/main.ts [model-path] --corpus <path> [--query <text>] [--reranker <path>]\nMissing: --corpus\n`,
  );
  process.exit(1);
}

if (jsonlMode) setJsonlMode(true);
if (verbose) setVerboseMode(true);
if (!verbose && !jsonlMode && !trace) {
  try {
    fs.closeSync(2);
    fs.openSync(process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null", "w");
  } catch {
    /* non-fatal */
  }
}

const MAX_TOOL_TURNS = 20;

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  const resources = loadResources(corpusDir!);
  const chunks = chunkResources(resources);

  const modelName = path.basename(modelPath).replace(/-Q\w+\.gguf$/, "");
  const rerankName = path
    .basename(rerankModelPath)
    .replace(/-q\w+\.gguf$/i, "");

  log();
  log(
    `${c.bold}  ReAct Agent${c.reset} ${c.dim}\u2014 Single Agent with Tools${c.reset}`,
  );
  log();
  log(
    `  ${c.green}\u25cf${c.reset} Loading ${c.bold}${modelName}${c.reset} ${c.dim}(${fmtSize(fs.statSync(modelPath).size)}, KV: Q4_0)${c.reset}`,
  );

  const nCtx = parseInt(process.env.LLAMA_CTX_SIZE || "16384", 10);
  const ctx: SessionContext = yield* call(() =>
    createContext({
      modelPath,
      nCtx,
      nSeqMax: 16,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  log(
    `  ${c.green}\u25cf${c.reset} Loading ${c.bold}${rerankName}${c.reset} ${c.dim}(${fmtSize(fs.statSync(rerankModelPath).size)}, reranker)${c.reset}`,
  );

  const reranker = yield* call(() =>
    createReranker(rerankModelPath, { nSeqMax: 8, nCtx: 4096 }),
  );
  yield* ensure(() => {
    reranker.dispose();
  });
  yield* call(() => reranker.tokenizeChunks(chunks));

  const corpusIsFile =
    resources.length === 1 && fs.statSync(corpusDir!).isFile();
  const corpusLabel = corpusIsFile
    ? path.basename(corpusDir!)
    : `${path.basename(corpusDir!)}/ \u2014 ${resources.length} files`;
  log(
    `  ${c.dim}  Corpus: ${corpusLabel} \u2192 ${chunks.length} chunks${c.reset}`,
  );

  const { toolMap, toolsJson } = createTools({ resources, chunks, reranker });
  const { session, events } = yield* initAgents<WorkflowEvent>(ctx);

  const view = createView({
    model: path.basename(modelPath),
    reranker: path.basename(rerankModelPath),
    chunkCount: chunks.length,
  });
  yield* spawn(function* () {
    yield* view.subscribe(events);
  });

  const harnessOpts: HarnessOpts = {
    session,
    toolMap,
    toolsJson,
    events,
    maxTurns: MAX_TOOL_TURNS,
    trace,
  };

  // Initial query
  if (initialQuery) {
    yield* handleQuery(initialQuery, harnessOpts);
    if (jsonlMode) return;
  }

  // REPL
  log(
    `  ${c.dim}Enter your question or /quit to exit${c.reset}`,
  );
  log();

  const inputSignal = createSignal<string, void>();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.setPrompt(`  ${c.dim}>${c.reset} `);

  yield* spawn(function* () {
    yield* action<void>((resolve) => {
      rl.on("line", (line: string) => inputSignal.send(line.trim()));
      rl.on("close", () => {
        inputSignal.close();
        resolve();
      });
      return () => rl.close();
    });
  });

  rl.prompt();
  for (const input of yield* each(inputSignal)) {
    if (!input || input === "/quit") break;
    try {
      yield* handleQuery(input, harnessOpts);
    } catch (err) {
      log(`  ${c.red}Error: ${(err as Error).message}${c.reset}`);
    }
    yield* each.next();
    try {
      rl.prompt();
    } catch {
      break;
    }
  }
}).catch((err: unknown) => {
  process.stdout.write(
    `Error: ${(err as Error).message}\n${(err as Error).stack}\n`,
  );
  process.exit(1);
});
