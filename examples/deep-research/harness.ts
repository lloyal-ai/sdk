import * as fs from "node:fs";
import * as path from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import type { Session, SessionContext } from "@lloyal-labs/sdk";
import { buildTurnDelta } from "@lloyal-labs/sdk";
import {
  Ctx,
  Events,
  agent,
  agentPool,
  createToolkit,
  useAgent,
  chain,
  parallel,
  renderTemplate,
  withSharedRoot,
  DefaultAgentPolicy,
} from "@lloyal-labs/lloyal-agents";
import type { Source, AgentEvent } from "@lloyal-labs/lloyal-agents";
import type { StepEvent, OpTiming } from "../shared/tui-ink";
import { reportTool, PlanTool, taskToContent } from "@lloyal-labs/rig";
import type {
  PlanResult,
  PlanIntent,
  ResearchTask,
  Reranker,
  Chunk,
  SourceContext,
} from "@lloyal-labs/rig";

// ── Prompts ─────────────────────────────────────────────────────

/** Load a task prompt file with `---` separator → `{ system, user }`. */
function loadPrompt(name: string): { system: string; user: string } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, `prompts/${name}.eta`), "utf8")
    .trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

/** Load a raw Eta template string for runtime rendering. */
function loadTemplate(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, `prompts/${name}.eta`),
    "utf8",
  );
}

const PLAN_DEEP = loadPrompt("plan");
const PLAN_FLAT = loadPrompt("plan-flat");
const FALLBACK = loadPrompt("fallback");
const VERIFY = loadPrompt("verify");
const EVAL = loadPrompt("eval");
const RECOVERY = loadPrompt("recovery");
const SYNTHESIZE_DEEP = loadPrompt("synthesize");
const SYNTHESIZE_FLAT = loadPrompt("synthesize-flat");
const CORPUS_WORKER_TEMPLATE = loadTemplate("corpus-worker");
const WEB_WORKER_TEMPLATE = loadTemplate("web-worker");
const SKILL_CATALOG_TEMPLATE = loadTemplate("skill-catalog");

function createResearchPolicy(): DefaultAgentPolicy {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      time: { softLimit: 240_000, hardLimit: 360_000 },
    },
    recovery: { prompt: RECOVERY },
    terminalTool: "report",
  });
}

// ── Types ───────────────────────────────────────────────────────

export type QueryResult =
  | { type: "done" }
  | { type: "clarify"; questions: string[] };

export interface HarnessOpts {
  verifyCount: number;
  maxTurns: number;
  trace: boolean;
  findingsMaxChars?: number;
  reasoningMode: "flat" | "deep";
}

// ── Helpers ─────────────────────────────────────────────────────

interface WorkerPromptCtx extends Record<string, unknown> {
  maxTurns: number;
  agentCount: number;
  siblingTasks: string[];
  date: string;
  taskIndex?: number;
}

function renderWorkerPrompt(
  source: { name: string; promptData?: () => { toc: string } },
  ctx: WorkerPromptCtx,
): string {
  if (source.promptData) {
    return renderTemplate(CORPUS_WORKER_TEMPLATE, {
      ...source.promptData(),
      ...ctx,
    });
  }
  if (source.name === "web") {
    return renderTemplate(WEB_WORKER_TEMPLATE, ctx);
  }
  return FALLBACK.system;
}

/** Current date as ISO YYYY-MM-DD — threaded into prompts so recency-sensitive
 *  searches anchor on the current year, not the model's training-cutoff default. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

/**
 * Passthrough handler — stream a direct answer from session.trunk after
 * appending the user's query as a fresh user turn. No research pool runs;
 * the answer comes from the prior Q&A already in trunk's KV via commitTurn.
 *
 * The trunk's KV already contains the prior conversation (system prompt,
 * tool schemas, earlier user+assistant pairs). We append the new user turn,
 * then iterate produceSync+commit until stop. Finally session.commitTurn
 * persists the full query+answer pair for the next follow-up.
 */
function* runPassthrough(
  query: string,
  session: Session,
): Operation<{ answer: string; tokenCount: number; timeMs: number }> {
  const trunk = session.trunk;
  if (!trunk) {
    throw new Error(
      "runPassthrough: session has no trunk — passthrough requires a warm session",
    );
  }

  const ctx: SessionContext = yield* Ctx.expect();
  const sep = ctx.getTurnSeparator();
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: "user", content: query }]),
    { addGenerationPrompt: true, enableThinking: false },
  );
  const userTurnTokens = [...sep, ...ctx.tokenizeSync(prompt, false)];
  yield* call(() => trunk.prefill(userTurnTokens));

  const t = performance.now();
  let tokenCount = 0;
  const pieces: string[] = [];
  for (;;) {
    const { token, text, isStop } = trunk.produceSync();
    if (isStop) break;
    yield* call(() => trunk.commit(token));
    tokenCount++;
    pieces.push(text);
  }
  return { answer: pieces.join(""), tokenCount, timeMs: performance.now() - t };
}

// ── Entry points ────────────────────────────────────────────────

export interface PlannerOpts {
  reasoningMode: "flat" | "deep";
  /** Optional extra context (e.g. clarification response) threaded into
   *  the planner prompt. Appended under "Today's date: …". */
  context?: string;
}

/**
 * Run the planner. Emits a `query` event and a `plan` event. Returns the
 * raw PlanResult so callers can route based on intent (main.ts drives a
 * plan-review dialog in TTY mode; handleQuery dispatches automatically).
 */
export function* runPlanner(
  query: string,
  session: Session,
  opts: PlannerOpts,
): Operation<PlanResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  yield* send({ type: "query", query, warm: !!session.trunk });

  const currentDate = today();
  const planPrompt = opts.reasoningMode === "flat" ? PLAN_FLAT : PLAN_DEEP;
  const planTool = new PlanTool({
    prompt: planPrompt,
    session,
    maxQuestions: 10,
  });
  const planContext = opts.context
    ? `Today's date: ${currentDate}\n\n${opts.context}`
    : `Today's date: ${currentDate}`;
  const plan = (yield* planTool.execute({
    query,
    context: planContext,
  })) as PlanResult;

  yield* send({
    type: "plan",
    intent: plan.intent,
    tasks: plan.tasks,
    clarifyQuestions: plan.clarifyQuestions,
    tokenCount: plan.tokenCount,
    timeMs: plan.timeMs,
  });

  return plan;
}

/**
 * Direct-answer branch (passthrough intent): stream the response from the
 * warm trunk. Emits `answer`, `stats`, `complete`.
 */
export function* runPassthroughBranch(
  query: string,
  session: Session,
  plan: PlanResult,
  wallStartMs: number,
): Operation<void> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const pt = yield* runPassthrough(query, session);
  yield* send({ type: "answer", text: pt.answer });

  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;
  yield* send({
    type: "stats",
    timings: [
      {
        label: "Plan",
        tokens: plan.tokenCount,
        detail: plan.intent,
        timeMs: plan.timeMs,
      },
      {
        label: "Passthrough",
        tokens: pt.tokenCount,
        detail: "trunk stream",
        timeMs: pt.timeMs,
      },
    ],
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });
  yield* send({
    type: "complete",
    data: {
      intent: plan.intent,
      planTokens: plan.tokenCount,
      passthroughTokens: pt.tokenCount,
      wallTimeMs: Math.round(performance.now() - wallStartMs),
      planMs: Math.round(plan.timeMs),
      passthroughMs: Math.round(pt.timeMs),
    },
  });
  // NOTE: we do NOT call session.commitTurn here. The trunk already contains
  // the streamed user+assistant pair from produceSync+commit.
}

/**
 * Research branch: spawns research agents, runs synth, verify, eval, and
 * commits the warm spine. Emits the full research→complete event sequence.
 *
 * Safe to call directly from main.ts after a plan-review dialog confirms
 * the plan; handleQuery also composes this for the JSONL path.
 */
export function* runResearchBranch(
  query: string,
  plan: PlanResult,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: HarnessOpts,
  wallStartMs: number,
): Operation<void> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  if (plan.intent !== "research") {
    throw new Error(
      `runResearchBranch: expected plan.intent=research, got ${plan.intent}`,
    );
  }
  const tasks = plan.tasks;
  const currentDate = today();

  yield* send({
    type: "research:start",
    agentCount: tasks.length,
    mode: opts.reasoningMode,
  });
  const researchTimer = startTimer();

  for (const source of sources) yield* source.bind({ reranker });
  const scorers = new Map(sources.map((s) => [s, s.createScorer(query)]));

  const allDataTools = sources.flatMap((s) => s.tools);
  const primarySource = sources[0];
  const primaryScorer = scorers.get(primarySource)!;

  // Detect enabled sources for the skill catalog. Web is identified by name;
  // corpus is identified by the presence of a promptData() method (matches
  // renderWorkerPrompt's routing).
  const hasWeb = sources.some((s) => s.name === "web");
  const hasCorpus = sources.some(
    (s) =>
      typeof (s as unknown as { promptData?: () => unknown }).promptData ===
      "function",
  );
  const skillCatalog = renderTemplate(SKILL_CATALOG_TEMPLATE, {
    hasWeb,
    hasCorpus,
  });
  const researchToolkit = createToolkit([...allDataTools, reportTool]);

  let synthTimeMs = 0;
  let researchTimeMs = 0;

  const {
    answer,
    totalTokens: researchTotalTokens,
    totalToolCalls: researchTotalToolCalls,
    synthTokens: synthTotalTokens,
  } = yield* withSharedRoot<{
    answer: string;
    totalTokens: number;
    totalToolCalls: number;
    synthTokens: number;
  }>(
    // Skill catalog + tools live on queryRoot (the harness-owned shared
    // root) so chain extensions (extendRoot) accumulate on the SAME root
    // synth forks from later. Putting systemPrompt on agentPool would
    // route the spine onto agentPool's transient nested root, which gets
    // pruned at pool exit — synth would fork an empty queryRoot.
    {
      parent: session.trunk ?? undefined,
      systemPrompt: skillCatalog,
      toolsJson: researchToolkit.toolsJson,
    },
    function* (queryRoot) {
      // Emit fanout:tasks once upfront for flat mode so the TUI frames the
      // section with the task list before agents start streaming.
      if (opts.reasoningMode === "flat") {
        yield* send({ type: "fanout:tasks", tasks: tasks });
      }

      // ── Research: chain (deep) or parallel-with-extend (flat) ─────
      const research = yield* agentPool({
        tools: [...allDataTools, reportTool],
        parent: queryRoot,
        terminalTool: "report",
        maxTurns: opts.maxTurns,
        pruneOnReport: true,
        policy: createResearchPolicy(),
        trace: opts.trace,
        scorer: primaryScorer,
        enableThinking: true,
        orchestrate:
          opts.reasoningMode === "flat"
            ? // Flat: pure parallel — agents run concurrently and independently.
              // No spine extension (findings reach synth via prompt injection,
              // not KV attention). `taskIndex: 0` keeps web-worker.eta's
              // BUILD_ON_PRIOR block off (no priors in parallel); `siblingTasks`
              // + `agentCount > 1` activates sibling awareness so each agent
              // stays in its lane.
              parallel(
                tasks.map((task, i) => ({
                  content: taskToContent(task),
                  systemPrompt: renderWorkerPrompt(primarySource, {
                    maxTurns: opts.maxTurns,
                    agentCount: tasks.length,
                    siblingTasks: tasks
                      .filter((_, j) => j !== i)
                      .map((t) => t.description),
                    date: currentDate,
                    taskIndex: 0,
                  }),
                  seed: 1000 + i,
                })),
              )
            : // Deep: chain-shaped spine that extends between each task.
              chain(tasks, (task, i) => ({
                task: {
                  content: taskToContent(task),
                  systemPrompt: renderWorkerPrompt(primarySource, {
                    maxTurns: opts.maxTurns,
                    agentCount: 1,
                    siblingTasks: [],
                    date: currentDate,
                    taskIndex: i,
                  }),
                },
                userContent: `Research task: ${task.description}`,
                beforeSpawn: function* () {
                  yield* send({
                    type: "spine:task",
                    taskIndex: i,
                    taskCount: tasks.length,
                    description: task.description,
                  });
                  yield* send({
                    type: "spine:source",
                    taskIndex: i,
                    source: primarySource.name,
                  });
                },
                afterExtend: function* (delta, position) {
                  yield* send({
                    type: "spine:task:done",
                    taskIndex: i,
                    stageFindings: delta,
                    accumulated: position,
                  });
                },
              })),
      });

      // Emit research:done HERE — before synth starts — so the flat-mode
      // panel's finalize happens while the cursor is still directly below
      // the panel. If we emit it outside the withSharedRoot body (after
      // synth has streamed 100+ lines), panel.finish's cursor-up lands
      // mid-synth and overwrites a chunk of the synthesis output.
      researchTimeMs = researchTimer();
      yield* send({
        type: "research:done",
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        timeMs: researchTimeMs,
      });

      // ── Synthesis ────────────────────────────────────────────
      // Deep: synth forks from queryRoot where chain's extendRoot has
      // accumulated findings as conversation turns. SYNTHESIZE_DEEP reads
      // them from prior turns via KV attention.
      //
      // Flat: no spine extension happened (parallel agents are independent);
      // findings are concatenated into a single text block and injected
      // into SYNTHESIZE_FLAT's user prompt. Synth still forks from queryRoot
      // (which carries only session context, if any), but its task prompt
      // carries the fan-in directly.
      yield* send({ type: "synthesize:start" });
      const synthT = startTimer();

      const synthPrompt =
        opts.reasoningMode === "flat" ? SYNTHESIZE_FLAT : SYNTHESIZE_DEEP;
      const findings =
        opts.reasoningMode === "flat"
          ? research.agents
              .map((a, i) => {
                const desc = tasks[i]?.description ?? `task ${i + 1}`;
                const body = a.result?.trim() || "(no findings)";
                return `### Agent ${i + 1}: ${desc}\n\n${body}`;
              })
              .join("\n\n")
          : undefined;
      const synthCtx = {
        query,
        findings,
        agentCount: tasks.length,
      };

      const synth = yield* useAgent({
        systemPrompt: renderTemplate(synthPrompt.system, synthCtx),
        task: renderTemplate(synthPrompt.user, synthCtx),
        tools: [reportTool],
        parent: queryRoot,
        terminalTool: "report",
        maxTurns: opts.maxTurns,
        trace: opts.trace,
      });

      synthTimeMs = synthT();
      const synthAnswer = synth.result || "";
      yield* send({
        type: "synthesize:done",
        agentId: synth.id,
        // Defensive: recovery (end-of-pool scratchpad extraction for
        // free-text-stop agents) prunes the branch at agent-pool.ts:269.
        // Matches the pattern in AgentPoolResult construction.
        ppl: synth.branch.disposed ? 0 : synth.branch.perplexity,
        tokenCount: synth.tokenCount,
        toolCallCount: synth.toolCallCount,
        timeMs: synthTimeMs,
      });

      return {
        answer: synthAnswer,
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        synthTokens: synth.tokenCount,
      };
    },
  );

  // research:done already fired inside the withSharedRoot body (before synth)
  // so the flat-mode panel's finalize landed at the right cursor position.
  yield* send({ type: "answer", text: answer });

  // ── Verify + Eval ─────────────────────────────────────────
  const verifyContent = renderTemplate(VERIFY.user, {
    agentFindings: answer || "(none)",
    sourcePassages: "(spine)",
    query,
  });

  const verifyTimer = startTimer();
  yield* send({
    type: "verify:start",
    count: opts.verifyCount,
    mode: opts.reasoningMode,
  });
  const verifyPool = yield* agentPool({
    orchestrate: parallel(
      Array.from({ length: opts.verifyCount }, (_, i) => ({
        content: verifyContent,
        systemPrompt: VERIFY.system,
        seed: 2000 + i,
      })),
    ),
  });
  yield* send({
    type: "verify:done",
    count: opts.verifyCount,
    timeMs: verifyTimer(),
  });
  const verifyOutputs = verifyPool.agents.map((a) => a.agent.rawOutput);

  const responsesText = verifyOutputs
    .map((r, i) => `Response ${i + 1}: ${r.trim()}`)
    .join("\n\n");

  const evalTimer = startTimer();
  const evalAgent = yield* agent({
    systemPrompt: EVAL.system,
    task: renderTemplate(EVAL.user, { responses: responsesText }),
    schema: {
      type: "object",
      properties: { converged: { type: "boolean" } },
      required: ["converged"],
    },
  });
  const evalTimeMs = evalTimer();

  let evalConverged: boolean | null = null;
  try {
    evalConverged = JSON.parse(evalAgent.rawOutput).converged;
  } catch {
    /* malformed */
  }

  yield* send({
    type: "eval:done",
    converged: evalConverged,
    tokenCount: evalAgent.tokenCount,
    sampleCount: opts.verifyCount,
    timeMs: evalTimeMs,
  });

  // ── Commit warm spine ─────────────────────────────────────
  if (answer) yield* call(() => session.commitTurn(query, answer));

  // ── Stats ─────────────────────────────────────────────────
  const statsCtx: SessionContext = yield* Ctx.expect();
  const p = statsCtx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: plan.tokenCount,
      detail: plan.intent,
      timeMs: plan.timeMs,
    },
    {
      label: "Research",
      tokens: researchTotalTokens,
      detail: `${researchTotalToolCalls} tools`,
      timeMs: researchTimeMs,
    },
    {
      label: "Synthesize",
      tokens: synthTotalTokens,
      detail: "spine fork",
      timeMs: synthTimeMs,
    },
    {
      label: "Eval",
      tokens: evalAgent.tokenCount,
      detail: `converged: ${evalConverged ? "yes" : "no"}`,
      timeMs: evalTimeMs,
    },
  ];

  yield* send({
    type: "stats",
    timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });

  yield* send({
    type: "complete",
    data: {
      intent: plan.intent,
      planTokens: plan.tokenCount,
      agentTokens: researchTotalTokens,
      synthTokens: synthTotalTokens,
      evalTokens: evalAgent.tokenCount,
      converged: evalConverged,
      totalToolCalls: researchTotalToolCalls,
      agentCount: tasks.length,
      wallTimeMs: Math.round(performance.now() - wallStartMs),
      planMs: Math.round(plan.timeMs),
      researchMs: Math.round(researchTimeMs),
      synthMs: Math.round(synthTimeMs),
      evalMs: Math.round(evalTimeMs),
    },
  });
}

/**
 * End-to-end composer used by the non-TTY / JSONL path. The TTY path in
 * main.ts drives runPlanner → plan-review dialog → runResearchBranch
 * directly so the user can review the plan before committing.
 */
export function* handleQuery(
  query: string,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: HarnessOpts,
  context?: string,
): Operation<QueryResult> {
  const wallStartMs = performance.now();
  const plan = yield* runPlanner(query, session, {
    reasoningMode: opts.reasoningMode,
    context,
  });
  if (plan.intent === "clarify") {
    return { type: "clarify", questions: plan.clarifyQuestions };
  }
  if (plan.intent === "passthrough") {
    yield* runPassthroughBranch(query, session, plan, wallStartMs);
    return { type: "done" };
  }
  yield* runResearchBranch(
    query,
    plan,
    session,
    sources,
    reranker,
    opts,
    wallStartMs,
  );
  return { type: "done" };
}
