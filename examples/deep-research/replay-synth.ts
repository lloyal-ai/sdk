#!/usr/bin/env node
/**
 * Deep Research — synth replay
 *
 * Deterministic replay of the synthesis stage against a fixed research
 * corpus captured in a prior trace file. Lets you iterate on the synth
 * prompt (or any other synth-stage configuration) without re-running the
 * research phase.
 *
 * Uses the framework's replay primitives — `extractSpineCheckpoint` +
 * `reconstructBranch` from @lloyal-labs/lloyal-agents — to rebuild the
 * KV spine the original synth agent forked from. The deep-research-specific
 * logic here is only: query extraction from the planner's prompt (a
 * research-harness convention, not a framework one).
 *
 * Usage:
 *   npx tsx examples/deep-research/replay-synth.ts \
 *     --trace trace-NNN.jsonl \
 *     [--prompt path/to/synthesize.eta] \
 *     [--model path/to/model.gguf] \
 *     [--out synth-report.md]
 *
 * Requires a trace produced by an SDK version that emits `spine:extend`
 * events (added alongside the replay primitives). Traces captured before
 * that can't be replayed with this script.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { main, call, spawn, each } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import {
  initAgents, agentPool, parallel, renderTemplate, JsonlTraceWriter,
  extractSpineCheckpoint, reconstructBranch,
} from "@lloyal-labs/lloyal-agents";
import type { TraceEvent } from "@lloyal-labs/lloyal-agents";
import { reportTool } from "@lloyal-labs/rig";

// ── CLI ─────────────────────────────────────────────────────────

const DEFAULT_MODEL = path.resolve(
  __dirname, "../../models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
);
const DEFAULT_PROMPT = path.resolve(__dirname, "prompts/synthesize.eta");

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    trace:              { type: "string",  short: "t" },
    prompt:             { type: "string",  short: "p" },
    model:              { type: "string",  short: "m" },
    out:                { type: "string",  short: "o" },
    "allow-empty-spine": { type: "boolean", default: false },
  },
});

if (!flags.trace) {
  process.stderr.write("Usage: replay-synth.ts --trace <trace.jsonl> [--prompt path] [--model path] [--out path]\n");
  process.exit(1);
}

const tracePath = path.resolve(flags.trace);
const promptPath = path.resolve(flags.prompt ?? DEFAULT_PROMPT);
const modelPath = path.resolve(flags.model ?? DEFAULT_MODEL);
const outPath = flags.out ? path.resolve(flags.out) : undefined;

// ── Deep-research-specific: extract query from planner's taskContent ──

function extractQuery(events: TraceEvent[]): string {
  const planner = events.find(
    (e): e is Extract<TraceEvent, { type: 'prompt:format' }> =>
      e.type === "prompt:format" &&
      e.role === "agentSuffix" &&
      typeof e.taskContent === "string" &&
      e.taskContent.startsWith("The query:"),
  );
  if (planner) {
    const m = /The query:\s*"([^"]+)"/.exec(planner.taskContent ?? "");
    if (m) return m[1];
  }
  // Fallback: synth's taskContent uses `Research question: "..."`
  const synth = events.find(
    (e): e is Extract<TraceEvent, { type: 'prompt:format' }> =>
      e.type === "prompt:format" &&
      e.role === "agentSuffix" &&
      typeof e.taskContent === "string" &&
      e.taskContent.startsWith("Research question:"),
  );
  if (synth) {
    const m = /Research question:\s*"([^"]+)"/.exec(synth.taskContent ?? "");
    if (m) return m[1];
  }
  throw new Error("replay-synth: could not extract query from planner or synth prompts in trace");
}

// ── Prompt loader (matches harness.ts convention) ──────────────

function loadPromptFile(filePath: string): { system: string; user: string } {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

// ── Main ───────────────────────────────────────────────────────

main(function* () {
  const raw = fs.readFileSync(tracePath, "utf-8");
  const events: TraceEvent[] = raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as TraceEvent);

  const query = extractQuery(events);
  const checkpoint = extractSpineCheckpoint(events);

  process.stdout.write(
    `replay-synth\n` +
    `  trace:  ${tracePath}\n` +
    `  prompt: ${promptPath}\n` +
    `  model:  ${modelPath}\n` +
    `  query:  ${query}\n` +
    `  spine turns: ${checkpoint.turns.length}\n\n`,
  );

  if (checkpoint.turns.length === 0) {
    if (!flags["allow-empty-spine"]) {
      process.stderr.write(
        "\nError: trace has no spine:extend events — synth would fork from the root prompt\n" +
        "with no research findings in KV and produce garbage from priors.\n\n" +
        "This usually means one of:\n" +
        "  (a) the trace was captured by an SDK version before spine:extend events existed\n" +
        "      → recapture with a current build of main.ts, then replay against that\n" +
        "  (b) the run used a parallel-only orchestration with no ctx.extendRoot calls\n" +
        "      → synth-replay expects a chain-shaped research spine; use replay-agent (TBD)\n" +
        "        for pool-start replay of parallel orchestrations\n\n" +
        "Pass --allow-empty-spine to override and run synth against empty context anyway\n" +
        "(useful only for testing the harness itself).\n",
      );
      process.exit(2);
    }
    process.stderr.write(
      "Warning: trace has no spine:extend events but --allow-empty-spine was passed.\n" +
      "Synth will fork from the root prompt with no research context.\n\n",
    );
  }

  const SYNTHESIZE = loadPromptFile(promptPath);

  const nCtx = parseInt(process.env.LLAMA_CTX_SIZE || "16384", 10);
  const ctx: SessionContext = yield* call(() =>
    createContext({ modelPath, nCtx, nSeqMax: 64, typeK: "q4_0", typeV: "q4_0" }),
  );

  const replayTraceFile = `replay-synth-${Date.now()}.jsonl`;
  const traceFd = fs.openSync(replayTraceFile, "w");
  const traceWriter = new JsonlTraceWriter(traceFd);
  // Flush and close the trace file even on abnormal exit — otherwise a timeout
  // or crash during model load leaves an empty trace with no way to know how
  // far the replay got.
  const closeTrace = () => {
    try { traceWriter.flush(); } catch { /* non-fatal */ }
    try { fs.closeSync(traceFd); } catch { /* non-fatal */ }
  };
  process.on("exit", closeTrace);
  process.on("SIGINT", () => { closeTrace(); process.exit(130); });
  process.on("SIGTERM", () => { closeTrace(); process.exit(143); });
  process.stdout.write(`  trace output: ${replayTraceFile}\n`);

  const { events: broadcast } = yield* initAgents(ctx, { traceWriter });

  // Drain the broadcast channel so pool sends don't block.
  yield* spawn(function* () {
    for (const _ of yield* each(broadcast)) {
      yield* each.next();
    }
  });

  const queryRoot = yield* reconstructBranch(checkpoint);
  process.stdout.write(
    `  spine reconstructed: ${queryRoot.position} tokens across ${checkpoint.turns.length} task turns\n` +
    `  running synth...\n\n`,
  );

  const synthCtx = { query };
  const synth = yield* agentPool({
    orchestrate: parallel([{ content: renderTemplate(SYNTHESIZE.user, synthCtx) }]),
    tools: [reportTool],
    systemPrompt: renderTemplate(SYNTHESIZE.system, synthCtx),
    parent: queryRoot,
    terminalTool: "report",
    maxTurns: 20,
  });

  const answer = synth.agents[0]?.result ?? "(no report produced)";

  if (outPath) {
    fs.writeFileSync(outPath, answer);
    process.stdout.write(`  synth written to ${outPath}\n`);
  } else {
    process.stdout.write(`${answer}\n`);
  }
}).catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`replay-synth error: ${msg}\n`);
  process.exit(1);
});
