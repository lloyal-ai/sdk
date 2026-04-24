#!/usr/bin/env node
/**
 * Deep Research — CLI entry point
 *
 * TTY mode: mounts an Ink TUI with a persistent Gemini-style composer at
 * the bottom. Settings (Tavily key, corpus path, reasoning mode) live in
 * the composer and persist to `./harness.json` (or `--config <path>`).
 * Env-provided secrets (`TAVILY_API_KEY`) always win at read time and
 * are never written to disk.
 *
 * JSONL / non-TTY mode: bypasses Ink entirely; `handleQuery` composes
 * runPlanner + runResearchBranch and emits the usual event stream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  main,
  ensure,
  createSignal,
  spawn,
  each,
  call,
} from "effection";
import type { Operation } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { initAgents, JsonlTraceWriter } from "@lloyal-labs/lloyal-agents";
import type { Source } from "@lloyal-labs/lloyal-agents";
import {
  c,
  log,
  setJsonlMode,
  setVerboseMode,
  emit,
  isTTY,
} from "../shared/tui/primitives";
// Type-only imports from the kit's barrel are safe (types are erased).
import type { WorkflowEvent, Command, Config } from "../shared/tui-ink";
// Runtime imports ONLY from modules that don't transitively pull Ink (ESM),
// otherwise the top-level await in yoga-wasm-web breaks the CJS loader.
import { loadConfig, saveConfig } from "../shared/tui-ink/config";
import { createBus, type EventBus } from "../shared/tui-ink/event-bus";
import { TavilyProvider } from "@lloyal-labs/rig";
import type {
  PlanResult,
  SourceContext,
  Chunk,
  Reranker,
} from "@lloyal-labs/rig";
import {
  createReranker,
  WebSource,
  CorpusSource,
  loadResources,
  chunkResources,
} from "@lloyal-labs/rig/node";
import type { Resource } from "@lloyal-labs/rig/node";
import {
  handleQuery,
  runPlanner,
  runPassthroughBranch,
  runResearchBranch,
} from "./harness";
import {
  downloadIfMissing,
  resolveModelPath,
  type ModelCatalogEntry,
} from "./models";

// ── CLI args ─────────────────────────────────────────────────────

// Default config path colocates with the example, not the repo root.
const DEFAULT_CONFIG_PATH = path.join(__dirname, "harness.json");

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    query: { type: "string" },
    reranker: { type: "string" },
    corpus: { type: "string" },
    config: { type: "string" },
    "findings-budget": { type: "string" },
    "reasoning-mode": { type: "string" },
    "n-ctx": { type: "string" },
    jsonl: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const reasoningModeFlag = flags["reasoning-mode"];
if (
  reasoningModeFlag !== undefined &&
  reasoningModeFlag !== "flat" &&
  reasoningModeFlag !== "deep"
) {
  process.stderr.write(
    `Invalid --reasoning-mode: ${reasoningModeFlag}. Expected "flat" or "deep".\n`,
  );
  process.exit(1);
}

const cliModelPath = positionals[0] || undefined;
const jsonlMode = flags.jsonl;
const verbose = flags.verbose;
const trace = flags.trace;
const initialQuery = flags.query;
const configPath = flags.config ?? DEFAULT_CONFIG_PATH;

const nCtxFlag = flags["n-ctx"];
if (nCtxFlag !== undefined && !/^\d+$/.test(nCtxFlag)) {
  process.stderr.write(
    `Invalid --n-ctx: ${nCtxFlag}. Expected a positive integer.\n`,
  );
  process.exit(1);
}
const nCtxCli = nCtxFlag !== undefined ? parseInt(nCtxFlag, 10) : undefined;

// Merge: CLI flag > env > harness.json > default.
const loaded = loadConfig(configPath, {
  modelPath: cliModelPath,
  reranker: flags.reranker,
  corpusPath: flags.corpus,
  reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
  nCtx: nCtxCli,
});
let liveConfig: Config = loaded.config;
let liveOrigin = loaded.origin;
const findingsMaxChars = flags["findings-budget"]
  ? parseInt(flags["findings-budget"], 10)
  : undefined;

// Resolve catalog-id / explicit path / catalog-default for each model.
// Downloads happen later, pre-Ink, via ensureFile.
const llmResolved = resolveModelPath(liveConfig.model.path, "llm");
const rerankerResolved = resolveModelPath(liveConfig.model.reranker, "reranker");
const modelPath = llmResolved.path;
const rerankModelPath = rerankerResolved.path;
const nCtx = liveConfig.model.nCtx ?? 32768;

if (jsonlMode) setJsonlMode(true);
if (verbose) setVerboseMode(true);

// Silence llama.cpp stderr in default mode.
const quietMode = !verbose && !jsonlMode && !trace;
if (quietMode) {
  try {
    fs.closeSync(2);
    fs.openSync(process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null", "w");
  } catch {
    // Non-fatal.
  }
}

const VERIFY_COUNT = 3;
const MAX_TOOL_TURNS = 10;

// ── Corpus cache — load resources once per unique corpusPath ─────

const corpusCache = new Map<
  string,
  { resources: Resource[]; chunks: Chunk[] }
>();

function getOrLoadCorpus(corpusPath: string): {
  resources: Resource[];
  chunks: Chunk[];
} {
  const existing = corpusCache.get(corpusPath);
  if (existing) return existing;
  const resources = loadResources(corpusPath);
  const chunks = chunkResources(resources);
  const entry = { resources, chunks };
  corpusCache.set(corpusPath, entry);
  return entry;
}

/** Build a fresh Source[] from the current config. Cheap: WebSource wraps
 *  the Tavily client; CorpusSource wraps cached resources+chunks. */
function buildSources(config: Config): Source<SourceContext, Chunk>[] {
  const sources: Source<SourceContext, Chunk>[] = [];
  if (config.sources.corpusPath) {
    const { resources, chunks } = getOrLoadCorpus(config.sources.corpusPath);
    sources.push(
      new CorpusSource(resources, chunks, {
        grep: { maxResults: 50, lineMaxChars: 200 },
        readFile: { defaultMaxLines: 100 },
      }),
    );
  }
  if (config.sources.tavilyKey) {
    // TavilyProvider takes the key as a positional string argument.
    sources.push(
      new WebSource(new TavilyProvider(config.sources.tavilyKey), {
        topN: 5,
        fetch: { maxChars: 3000, topK: 5, timeout: 10_000, tokenBudget: 1200 },
      }),
    );
  }
  return sources;
}

/** Summarize attached sources for the planner prompt. Includes the corpus
 *  table-of-contents (same pattern as corpus-worker.eta's `it.toc`) so the
 *  planner can decide research vs. clarify vs. passthrough with full
 *  awareness of what's actually available. */
function buildPlannerContext(sources: Source<SourceContext, Chunk>[]): string {
  if (sources.length === 0) return "";
  const lines: string[] = ["Available research sources:"];
  let hasWeb = false;
  for (const s of sources) {
    // `promptData` isn't declared on Source — it's specific to CorpusSource.
    // Duck-type check so the planner prompt gets the corpus TOC.
    const pd = (s as unknown as { promptData?: () => { toc?: string } })
      .promptData;
    if (typeof pd === "function") {
      const data = pd();
      lines.push("", "## Local corpus");
      lines.push(
        "Files and top-level topics (full-text searchable via grep/read/search tools):",
      );
      if (data.toc) lines.push(data.toc);
    } else if (s.name === "web") {
      hasWeb = true;
    }
  }
  if (hasWeb) {
    lines.push("", "## Web search");
    lines.push(
      "web search is available for live web queries (web_search + fetch_page tools).",
    );
  }
  return lines.join("\n");
}

// ── Error helpers ────────────────────────────────────────────────

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  const modelName = path.basename(modelPath).replace(/-Q\w+\.gguf$/, "");
  const rerankName = path
    .basename(rerankModelPath)
    .replace(/-q\w+\.gguf$/i, "");

  const useInk = isTTY && !jsonlMode;

  // Pre-boot logs only in non-Ink mode — Ink mounts ASAP in TTY mode and
  // handles download/loading UI itself.
  if (!useInk) {
    log();
    log(`${c.bold}  Deep Research${c.reset}`);
    log();
  }

  // Replay-to-first-subscriber bus. Events sent between render() and Ink's
  // useEffect attachment get buffered and replayed — no timing assumptions.
  // `send` is synchronous so callbacks like downloadIfMissing.onProgress
  // can push directly.
  const uiChannel: EventBus<WorkflowEvent> = createBus<WorkflowEvent>();
  const commands = createSignal<Command, void>();

  let inkInstance: { unmount: () => void } | null = null;
  if (useInk) {
    const mod = yield* call(
      () =>
        import("../shared/tui-ink/render.js") as Promise<
          typeof import("../shared/tui-ink/render.js")
        >,
    );
    // Seed with config:loaded so uiPhase moves out of 'boot' on first paint.
    const bootstrap: WorkflowEvent[] = [
      {
        type: "config:loaded",
        config: liveConfig,
        origin: liveOrigin,
        path: loaded.path,
      },
    ];
    inkInstance = mod.render(uiChannel, (cmd) => commands.send(cmd), bootstrap);
    yield* ensure(() => { inkInstance?.unmount(); });
  } else {
    // Non-TTY / JSONL: drain the bus to JSONL stdout. Synchronous subscribe
    // replays any already-buffered events immediately.
    uiChannel.subscribe((ev) => {
      emit((ev as { type: string }).type, ev as unknown as Record<string, unknown>);
    });
  }

  // ── Downloads (if needed) ──────────────────────────────────
  const needsDownload =
    (llmResolved.entry !== null && !fs.existsSync(llmResolved.path)) ||
    (rerankerResolved.entry !== null && !fs.existsSync(rerankerResolved.path));

  function* ensureFile(
    r: { path: string; entry: ModelCatalogEntry | null },
  ): Operation<string> {
    if (fs.existsSync(r.path)) return r.path;
    if (!r.entry) {
      throw new Error(
        `Model not found: ${r.path}\n\n` +
          `  Pass --model <path> (or --reranker <path>) to use a local file,\n` +
          `  or leave the value unset to auto-download the default.\n`,
      );
    }
    const entry = r.entry;
    uiChannel.send({
      type: "download:start",
      id: entry.id,
      label: entry.label,
      sizeBytes: entry.sizeBytes,
    });
    yield* call(() =>
      downloadIfMissing(entry, {
        onProgress: (got, total) => {
          uiChannel.send({
            type: "download:progress",
            id: entry.id,
            got,
            total,
          });
        },
      }),
    );
    uiChannel.send({ type: "download:complete", id: entry.id });
    return r.path;
  };

  if (needsDownload) {
    yield* ensureFile(llmResolved);
    yield* ensureFile(rerankerResolved);
  } else {
    yield* ensureFile(llmResolved);
    yield* ensureFile(rerankerResolved);
  }

  // ── Loading weights ───────────────────────────────────────
  uiChannel.send({ type: "weights:start", label: `Loading ${modelName}…` });
  let ctx: SessionContext;
  try {
    ctx = yield* call(() =>
      createContext({
        modelPath,
        nCtx,
        nSeqMax: 64,
        typeK: "q4_0",
        typeV: "q4_0",
      }),
    );
  } catch (err) {
    uiChannel.send({ type: "weights:done" });
    throw err;
  }

  uiChannel.send({ type: "weights:label", label: `Loading ${rerankName}…` });
  let reranker: Reranker;
  try {
    reranker = yield* call(() =>
      createReranker(rerankModelPath, { nSeqMax: 8, nCtx: 16384 }),
    );
  } catch (err) {
    uiChannel.send({ type: "weights:done" });
    throw err;
  }
  yield* ensure(() => {
    reranker.dispose();
  });
  uiChannel.send({ type: "weights:done" });

  // ── Session + event forwarding ─────────────────────────────
  const traceWriter = trace
    ? new JsonlTraceWriter(fs.openSync(`trace-${Date.now()}.jsonl`, "w"))
    : undefined;

  const { session, events } = yield* initAgents<WorkflowEvent>(ctx, {
    traceWriter,
  });

  // Forward all runtime events from initAgents into the UI channel so Ink
  // (or the JSONL drainer) sees the unified stream.
  yield* spawn(function* () {
    for (const ev of yield* each(events)) {
      uiChannel.send(ev);
      yield* each.next();
    }
  });

  // Transition reducer out of 'loading' into 'composer'. (config:loaded was
  // already in the bootstrap; this nudges uiPhase now that boot is complete.)
  uiChannel.send({ type: "ui:composer" });

  const harnessOpts = {
    verifyCount: VERIFY_COUNT,
    maxTurns: MAX_TOOL_TURNS,
    trace,
    findingsMaxChars,
    reasoningMode: liveConfig.defaults.reasoningMode,
  };

  // ── JSONL / --query scripted path ──────────────────────────
  // When Ink isn't mounted, fall back to the existing handleQuery
  // composer. `--query` without a TTY runs exactly one query then exits;
  // otherwise there's nowhere for follow-ups to come from.
  if (!useInk) {
    if (!initialQuery) {
      process.stderr.write("Non-TTY mode requires --query.\n");
      process.exit(2);
    }
    const sources = buildSources(liveConfig);
    if (sources.length === 0) {
      process.stderr.write(
        "No source configured. Set TAVILY_API_KEY, pass --corpus <dir>, or store one in harness.json.\n",
      );
      process.exit(2);
    }
    yield* handleQuery(initialQuery, session, sources, reranker, harnessOpts);
    return;
  }

  // ── Ink TTY command loop ───────────────────────────────────
  // (config is already seeded via the render() bootstrap arg above.)

  let pendingPlan: {
    plan: PlanResult;
    query: string;
    mode: "flat" | "deep";
    wallStartMs: number;
  } | null = null;

  // Auto-submit if --query was passed. Handled inline (not via commands)
  // because the commands Signal isn't yet being drained, and Signals don't
  // buffer — a send before `each(commands)` starts would be lost.
  if (initialQuery) {
    const mode = liveConfig.defaults.reasoningMode;
    const wallStartMs = performance.now();
    yield* events.send({ type: "plan:start", query: initialQuery, mode });
    const plan = yield* runPlanner(initialQuery, session, {
      reasoningMode: mode,
    });
    if (plan.intent === "passthrough") {
      yield* runPassthroughBranch(initialQuery, session, plan, wallStartMs);
      yield* events.send({ type: "ui:composer" });
    } else {
      pendingPlan = { plan, query: initialQuery, mode, wallStartMs };
      yield* events.send({ type: "ui:plan_review" });
    }
  }

  for (const cmd of yield* each(commands)) {
    try {
      if (cmd.type === "quit") break;

      if (cmd.type === "set_tavily_key") {
        liveConfig = {
          ...liveConfig,
          sources: { ...liveConfig.sources, tavilyKey: cmd.key },
        };
        const saved = saveConfig(
          { sources: { tavilyKey: cmd.key } },
          configPath,
        );
        const reloaded = loadConfig(configPath, {
          modelPath: cliModelPath,
          reranker: flags.reranker,
          corpusPath: flags.corpus,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
        });
        liveConfig = reloaded.config;
        liveOrigin = reloaded.origin;
        yield* events.send({
          type: "config:updated",
          config: liveConfig,
          origin: liveOrigin,
          savedTo: saved.path,
          gitignored: saved.gitignored,
          skipped: saved.skipped,
        });
      } else if (cmd.type === "set_corpus_path") {
        const saved = saveConfig(
          { sources: { corpusPath: cmd.path } },
          configPath,
        );
        const reloaded = loadConfig(configPath, {
          modelPath: cliModelPath,
          reranker: flags.reranker,
          corpusPath: flags.corpus,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
        });
        liveConfig = reloaded.config;
        liveOrigin = reloaded.origin;
        yield* events.send({
          type: "config:updated",
          config: liveConfig,
          origin: liveOrigin,
          savedTo: saved.path,
          gitignored: saved.gitignored,
          skipped: saved.skipped,
        });
      } else if (cmd.type === "submit_query") {
        const wallStartMs = performance.now();
        const sources = buildSources(liveConfig);
        if (sources.length === 0) {
          yield* events.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          continue;
        }
        const plannerContext = buildPlannerContext(sources);
        yield* events.send({
          type: "plan:start",
          query: cmd.query,
          mode: cmd.mode,
        });
        const plan = yield* runPlanner(cmd.query, session, {
          reasoningMode: cmd.mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          yield* runPassthroughBranch(cmd.query, session, plan, wallStartMs);
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          // Reducer routes to uiPhase='clarifying' via the plan event —
          // questions stay on screen while the composer takes the answer.
          pendingPlan = { plan, query: cmd.query, mode: cmd.mode, wallStartMs };
        } else {
          pendingPlan = { plan, query: cmd.query, mode: cmd.mode, wallStartMs };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "submit_clarification" && pendingPlan) {
        // Re-run the planner with the original query + the prior questions
        // and the user's answer folded into the context. Sources unchanged.
        const {
          query: origQuery,
          plan: priorPlan,
          mode,
          wallStartMs,
        } = pendingPlan;
        const sources = buildSources(liveConfig);
        const qa = [
          "Prior clarification exchange:",
          ...priorPlan.clarifyQuestions.map((q, i) => `(${i + 1}) ${q}`),
          "",
          `User response: ${cmd.answer}`,
          "",
          "Use this exchange to proceed with research if possible.",
        ].join("\n");
        const plannerContext = [buildPlannerContext(sources), qa]
          .filter(Boolean)
          .join("\n\n");
        yield* events.send({ type: "plan:start", query: origQuery, mode });
        const plan = yield* runPlanner(origQuery, session, {
          reasoningMode: mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          yield* runPassthroughBranch(origQuery, session, plan, wallStartMs);
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          pendingPlan = { plan, query: origQuery, mode, wallStartMs };
          // stays in clarifying via the plan event
        } else {
          pendingPlan = { plan, query: origQuery, mode, wallStartMs };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "change_mode" && pendingPlan) {
        const sources = buildSources(liveConfig);
        const plannerContext = buildPlannerContext(sources);
        yield* events.send({
          type: "plan:start",
          query: pendingPlan.query,
          mode: cmd.mode,
        });
        const plan = yield* runPlanner(pendingPlan.query, session, {
          reasoningMode: cmd.mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          yield* runPassthroughBranch(
            pendingPlan.query,
            session,
            plan,
            pendingPlan.wallStartMs,
          );
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          pendingPlan = { ...pendingPlan, plan, mode: cmd.mode };
          // stays in clarifying via the plan event
        } else {
          pendingPlan = { ...pendingPlan, plan, mode: cmd.mode };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "accept_plan" && pendingPlan) {
        if (pendingPlan.plan.intent === "clarify") {
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
          continue;
        }
        const sources = buildSources(liveConfig);
        if (sources.length === 0) {
          yield* events.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          pendingPlan = null;
          continue;
        }
        yield* runResearchBranch(
          pendingPlan.query,
          pendingPlan.plan,
          session,
          sources,
          reranker,
          {
            ...harnessOpts,
            reasoningMode: pendingPlan.mode,
          },
          pendingPlan.wallStartMs,
        );
        pendingPlan = null;
        yield* events.send({ type: "ui:composer" });
      } else if (cmd.type === "cancel_plan") {
        pendingPlan = null;
        yield* events.send({ type: "ui:composer" });
      } else if (cmd.type === "edit_plan") {
        pendingPlan = null;
        yield* events.send({ type: "ui:composer", prefill: cmd.query });
      }
      yield* each.next();
    } catch (err) {
      pendingPlan = null;
      yield* events.send({ type: "ui:error", message: errorMessage(err) });
    }
  }
}).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorMessage(err)}\n${errorStack(err)}\n`);
  process.exit(1);
});
