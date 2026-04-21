import * as fs from "node:fs";
import * as path from "node:path";
import type { Operation } from "effection";
import type { Session } from "@lloyal-labs/sdk";
import {
  Ctx,
  Events,
  agent,
  agentPool,
  chain,
  parallel,
  renderTemplate,
  withSharedRoot,
  DefaultAgentPolicy,
  createToolkit,
} from "@lloyal-labs/lloyal-agents";
import type { Source, AgentEvent } from "@lloyal-labs/lloyal-agents";
import type { StepEvent, OpTiming } from "./tui";
import { reportTool, PlanTool, taskToContent } from "@lloyal-labs/rig";
import type {
  PlanResult,
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
  return fs.readFileSync(path.resolve(__dirname, `prompts/${name}.eta`), "utf8");
}

const PLAN = loadPrompt("plan");
const FALLBACK = loadPrompt("fallback");
const VERIFY = loadPrompt("verify");
const EVAL = loadPrompt("eval");
const RECOVERY = loadPrompt("recovery");
const SYNTHESIZE = loadPrompt("synthesize");
const CORPUS_WORKER_TEMPLATE = loadTemplate("corpus-worker");
const WEB_WORKER_TEMPLATE = loadTemplate("web-worker");

function createResearchPolicy(): DefaultAgentPolicy {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      time: { softLimit: 120_000, hardLimit: 180_000 },
    },
    recovery: { prompt: RECOVERY },
    terminalTool: 'report',
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
}

type Route =
  | { type: "clarify"; questions: string[] }
  | { type: "research"; tasks: ResearchTask[]; maxTurns: number };

// ── Helpers ─────────────────────────────────────────────────────

interface WorkerPromptCtx extends Record<string, unknown> {
  tools: { name: string; description: string }[];
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
    return renderTemplate(CORPUS_WORKER_TEMPLATE, { ...source.promptData(), ...ctx });
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

function route(plan: PlanResult, query: string, maxTurns: number): Route {
  const research = plan.tasks.filter((t) => t.intent === "research");
  const clarify = plan.tasks.filter((t) => t.intent === "clarify");
  if (research.length === 0 && clarify.length > 0) {
    return { type: "clarify", questions: clarify.map((t) => t.description) };
  }
  const tasks = research.length > 0
    ? research
    : [{ description: query, intent: "research" as const }];
  return { type: "research", tasks, maxTurns };
}

// ── Entry point ─────────────────────────────────────────────────

export function* handleQuery(
  query: string,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: HarnessOpts,
  context?: string,
): Operation<QueryResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  yield* send({ type: "query", query, warm: !!session.trunk });
  const wallTimer = startTimer();
  const currentDate = today();

  // ── Plan ──────────────────────────────────────────────────
  const planTool = new PlanTool({ prompt: PLAN, session, maxQuestions: 10 });
  const planContext = context
    ? `Today's date: ${currentDate}\n\n${context}`
    : `Today's date: ${currentDate}`;
  const plan = (yield* planTool.execute({ query, context: planContext })) as PlanResult;
  const r = route(plan, query, opts.maxTurns);

  const intent: "clarify" | "passthrough" | "decompose" =
    r.type === "clarify" ? "clarify"
    : plan.tasks.length === 0 ? "passthrough"
    : "decompose";

  yield* send({
    type: "plan", intent,
    questions: plan.questions,
    tokenCount: plan.tokenCount,
    timeMs: plan.timeMs,
  });

  if (r.type === "clarify") return { type: "clarify", questions: r.questions };

  // ── Research with KV-spine chaining ───────────────────────
  yield* send({ type: "research:start", agentCount: r.tasks.length });
  const researchTimer = startTimer();

  for (const source of sources) yield* source.bind({ reranker });
  const scorers = new Map(sources.map((s) => [s, s.createScorer(query)]));

  const allDataTools = sources.flatMap((s) => s.tools);
  const queryToolkit = createToolkit([...allDataTools, reportTool]);
  const primarySource = sources[0];
  const primaryScorer = scorers.get(primarySource)!;
  const workerToolCtx = [...allDataTools, reportTool].map((t) => ({ name: t.name, description: t.description }));

  const baseWorkerPrompt = renderWorkerPrompt(primarySource, {
    tools: workerToolCtx,
    maxTurns: r.maxTurns,
    agentCount: 1,
    siblingTasks: [],
    date: currentDate,
  });

  let synthTimeMs = 0;

  const { answer, totalTokens: researchTotalTokens, totalToolCalls: researchTotalToolCalls, synthTokens: synthTotalTokens } =
    yield* withSharedRoot<{ answer: string; totalTokens: number; totalToolCalls: number; synthTokens: number }>(
      {
        systemPrompt: baseWorkerPrompt,
        tools: queryToolkit.toolsJson,
        parent: session.trunk ?? undefined,
      },
      function* (queryRoot) {
        // ── Research: chain-shaped spine across all tasks ─────
        const research = yield* agentPool({
          tools: [...allDataTools, reportTool],
          systemPrompt: baseWorkerPrompt,
          parent: queryRoot,
          terminalTool: "report",
          maxTurns: r.maxTurns,
          pruneOnReport: true,
          policy: createResearchPolicy(),
          trace: opts.trace,
          scorer: primaryScorer,
          orchestrate: chain(r.tasks, (task, i) => ({
            task: {
              content: taskToContent(task),
              systemPrompt: renderWorkerPrompt(primarySource, {
                tools: workerToolCtx,
                maxTurns: r.maxTurns,
                agentCount: 1,
                siblingTasks: [],
                date: currentDate,
                taskIndex: i,
              }),
            },
            userContent: `Research task: ${task.description}`,
            beforeSpawn: function* () {
              yield* send({ type: "spine:task", taskIndex: i, taskCount: r.tasks.length, description: task.description });
              yield* send({ type: "spine:source", taskIndex: i, source: primarySource.name });
            },
            afterExtend: function* (delta, position) {
              yield* send({ type: "spine:task:done", taskIndex: i, stageFindings: delta, accumulated: position });
            },
          })),
        });

        // ── Synthesis: single agent over the fully-extended spine ───
        yield* send({ type: "synthesize:start" });
        const synthT = startTimer();
        const synthCtx = { query };

        const synth = yield* agentPool({
          orchestrate: parallel([{ content: renderTemplate(SYNTHESIZE.user, synthCtx) }]),
          tools: [reportTool],
          systemPrompt: renderTemplate(SYNTHESIZE.system, synthCtx),
          parent: queryRoot,
          terminalTool: "report",
          maxTurns: opts.maxTurns,
          trace: opts.trace,
        });

        synthTimeMs = synthT();
        const synthAnswer = synth.agents[0]?.result || "";
        yield* send({ type: "synthesize:done", pool: synth, timeMs: synthTimeMs });

        return {
          answer: synthAnswer,
          totalTokens: research.totalTokens,
          totalToolCalls: research.totalToolCalls,
          synthTokens: synth.totalTokens,
        };
      },
    );

  const researchTimeMs = researchTimer();
  yield* send({
    type: "research:done",
    totalTokens: researchTotalTokens,
    totalToolCalls: researchTotalToolCalls,
    timeMs: researchTimeMs,
  });
  yield* send({ type: "answer", text: answer });

  // ── Verify + Eval ─────────────────────────────────────────
  const verifyContent = renderTemplate(VERIFY.user, {
    agentFindings: answer || "(none)",
    sourcePassages: "(spine)",
    query,
  });

  const verifyPool = yield* agentPool({
    orchestrate: parallel(Array.from({ length: opts.verifyCount }, (_, i) => ({ content: verifyContent, seed: 2000 + i }))),
    systemPrompt: VERIFY.system,
  });
  const verifyOutputs = verifyPool.agents.map((a) => a.agent.rawOutput);

  const responsesText = verifyOutputs
    .map((r, i) => `Response ${i + 1}: ${r.trim()}`)
    .join("\n\n");

  const evalTimer = startTimer();
  const evalAgent = yield* agent({
    systemPrompt: EVAL.system,
    task: renderTemplate(EVAL.user, { responses: responsesText }),
    schema: { type: "object", properties: { converged: { type: "boolean" } }, required: ["converged"] },
  });
  const evalTimeMs = evalTimer();

  let evalConverged: boolean | null = null;
  try { evalConverged = JSON.parse(evalAgent.rawOutput).converged; } catch { /* malformed */ }

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
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    { label: "Plan",       tokens: plan.tokenCount,     detail: intent,                                 timeMs: plan.timeMs },
    { label: "Research",   tokens: researchTotalTokens, detail: `${researchTotalToolCalls} tools`,      timeMs: researchTimeMs },
    { label: "Synthesize", tokens: synthTotalTokens,     detail: "spine fork",                            timeMs: synthTimeMs },
    { label: "Eval",       tokens: evalAgent.tokenCount, detail: `converged: ${evalConverged ? "yes" : "no"}`, timeMs: evalTimeMs },
  ];

  yield* send({
    type: "stats", timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });

  yield* send({
    type: "complete",
    data: {
      intent,
      planTokens: plan.tokenCount,
      agentTokens: researchTotalTokens,
      synthTokens: synthTotalTokens,
      evalTokens: evalAgent.tokenCount,
      converged: evalConverged,
      totalToolCalls: researchTotalToolCalls,
      agentCount: r.tasks.length,
      wallTimeMs: Math.round(wallTimer()),
      planMs: Math.round(plan.timeMs),
      researchMs: Math.round(researchTimeMs),
      synthMs: Math.round(synthTimeMs),
      evalMs: Math.round(evalTimeMs),
    },
  });

  return { type: "done" };
}
