#!/usr/bin/env node
/**
 * Deep Research Web — CLI entry point
 *
 * Web-only deep research using Tavily search + page fetching + reranker.
 *
 * Usage:
 *   TAVILY_API_KEY=tvly-... npx tsx examples/deep-research-web/main.ts [model-path] [--query <text>] [--reranker <path>] [options]
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
import { createReranker } from "../shared/reranker";
import { handleQuery } from "./harness";
import type { WorkflowOpts } from "./harness";

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
  ["--reranker", "--query", "--findings-budget"].flatMap((f) => {
    const i = args.indexOf(f);
    return i !== -1 ? [i, i + 1] : [];
  }),
);

const rerankModelPath = argVal("--reranker") || DEFAULT_RERANKER;
const initialQuery = argVal("--query");
const findingsMaxChars = argVal("--findings-budget") ? parseInt(argVal("--findings-budget")!, 10) : undefined;
const modelPath =
  args.find((a, i) => !a.startsWith("--") && !flagIndices.has(i)) ||
  DEFAULT_MODEL;

// ── Validate TAVILY_API_KEY ──────────────────────────────────────

if (!process.env.TAVILY_API_KEY) {
  process.stdout.write(
    `Missing TAVILY_API_KEY environment variable.\n\n` +
    `Get a key at https://tavily.com and run:\n` +
    `  TAVILY_API_KEY=tvly-... npx tsx examples/deep-research-web/main.ts [model-path] [--query <text>]\n`,
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

const AGENT_COUNT = 3;
const VERIFY_COUNT = 3;
const MAX_TOOL_TURNS = 20;

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  const modelName = path.basename(modelPath).replace(/-Q\w+\.gguf$/, "");

  log();
  log(
    `${c.bold}  Deep Research Web${c.reset} ${c.dim}\u2014 Web Search + Structured Concurrency${c.reset}`,
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
      nSeqMax: Math.max(AGENT_COUNT, VERIFY_COUNT) * 4 + 3,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  const rerankName = path
    .basename(rerankModelPath)
    .replace(/-q\w+\.gguf$/i, "");
  log(
    `  ${c.green}\u25cf${c.reset} Loading ${c.bold}${rerankName}${c.reset} ${c.dim}(${fmtSize(fs.statSync(rerankModelPath).size)}, reranker)${c.reset}`,
  );

  const reranker = yield* call(() =>
    createReranker(rerankModelPath, { nSeqMax: 8, nCtx: 4096 }),
  );
  yield* ensure(() => {
    reranker.dispose();
  });

  log(
    `  ${c.dim}  Tavily web search enabled${c.reset}`,
  );

  const { session, events } = yield* initAgents<WorkflowEvent>(ctx);

  // View subscriber — all presentation lives here
  const view = createView({
    model: path.basename(modelPath),
    reranker: path.basename(rerankModelPath),
    agentCount: AGENT_COUNT,
    verifyCount: VERIFY_COUNT,
  });
  yield* spawn(function* () {
    yield* view.subscribe(events);
  });

  const harnessOpts: WorkflowOpts = {
    session,
    reranker,
    events,
    agentCount: AGENT_COUNT,
    verifyCount: VERIFY_COUNT,
    maxTurns: MAX_TOOL_TURNS,
    trace,
    findingsMaxChars,
  };

  // Initial query — clarify falls through to passthrough in non-interactive mode
  if (initialQuery) {
    const result = yield* handleQuery(initialQuery, harnessOpts);
    if (result.type === 'clarify' && !jsonlMode) {
      log(`  ${c.dim}Clarification needed but running in --query mode, treating as passthrough${c.reset}`);
    }
    if (jsonlMode) return;
  }

  // REPL — Signal bridges readline into Effection scope
  log(
    `  ${c.dim}${session.trunk ? "Ask a follow-up question" : "Enter your research question"} or /quit to exit${c.reset}`,
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

  let pendingClarify: { query: string } | null = null;

  rl.prompt();
  for (const input of yield* each(inputSignal)) {
    if (!input || input === "/quit") break;
    try {
      const result = pendingClarify
        ? yield* handleQuery(pendingClarify.query, harnessOpts, input)
        : yield* handleQuery(input, harnessOpts);
      pendingClarify = result.type === 'clarify'
        ? { query: pendingClarify?.query || input }
        : null;
    } catch (err) {
      pendingClarify = null;
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
