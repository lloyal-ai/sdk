import * as fs from "node:fs";
import * as path from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import type { Session } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import {
  Ctx,
  Events,
  createAgent,
  createAgentPool,
  reduce,
  renderTemplate,
  DefaultAgentPolicy,
} from "@lloyal-labs/lloyal-agents";
import type { Source, AgentEvent } from "@lloyal-labs/lloyal-agents";
import type { OpTiming, StepEvent } from "./tui";
import {
  reportTool,
  PlanTool,
  taskToContent,
  DelegateTool,
} from "@lloyal-labs/rig";
import type {
  PlanResult,
  ResearchTask,
  Reranker,
  ScoredChunk,
  Chunk,
  SourceContext,
} from "@lloyal-labs/rig";

// ── Prompts ─────────────────────────────────────────────────────

/** Load a task prompt with --- separator → { system, user }. */
function loadPrompt(name: string): { system: string; user: string } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, `prompts/${name}.eta`), "utf8")
    .trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

/** Load a raw Eta template string for agent system prompts. */
function loadTemplate(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, `prompts/${name}.eta`),
    "utf8",
  );
}

const PLAN = loadPrompt("plan");
const FALLBACK = loadPrompt("fallback");
const VERIFY = loadPrompt("verify");
const EVAL = loadPrompt("eval");
const FINDINGS_EVAL = loadPrompt("findings-eval");
const REPORT = loadPrompt("report");
const SYNTHESIZE = loadPrompt("synthesize");
const CORPUS_WORKER_TEMPLATE = loadTemplate("corpus-worker");
const WEB_WORKER_TEMPLATE = loadTemplate("web-worker");

/** Create a fresh research policy per query — time budget scopes to research, not process lifetime */
function createResearchPolicy() {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 2048 },
      time: { softLimit: 60_000, hardLimit: 120_000 },
    },
    recovery: { prompt: REPORT },
  });
}

// ── Types ───────────────────────────────────────────────────────

export type QueryResult =
  | { type: "done" }
  | { type: "clarify"; questions: string[] };

// ── Helpers ─────────────────────────────────────────────────────

function renderWorkerPrompt(
  source: { name: string; promptData?: () => { toc: string } },
  ctx: {
    tools: { name: string; description: string }[];
    maxTurns: number;
    delegate?: boolean;
    delegateTool?: string;
  },
): string {
  if (source.promptData) {
    return renderTemplate(CORPUS_WORKER_TEMPLATE, {
      ...source.promptData(),
      ...ctx,
      agentCount: 1,
      siblingTasks: [],
    });
  }
  if (source.name === "web") {
    return renderTemplate(WEB_WORKER_TEMPLATE, {
      ...ctx,
      agentCount: 1,
      siblingTasks: [],
    });
  }
  return FALLBACK.system;
}

function createDelegateTool(
  source: Source<SourceContext, Chunk>,
  poolOpts: Parameters<typeof createAgentPool>[0],
) {
  return new DelegateTool({
    name: source.name === "web" ? "worker_web" : "worker_corpus",
    description:
      "Investigate multiple questions in parallel. Pass an array of focused sub-questions.",
    argsSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Sub-questions to investigate in parallel",
        },
      },
      required: ["questions"],
    },
    extractTasks: (args: Record<string, unknown>) => args.questions as string[],
    poolOpts,
    createPolicy: createResearchPolicy,
  });
}

function* rerankChunks(
  chunks: Chunk[],
  query: string,
  reranker: Reranker,
  topN = 10,
  maxChars = 4000,
): Operation<string> {
  if (chunks.length === 0) return "";

  yield* call(() => reranker.tokenizeChunks(chunks));

  let scored: ScoredChunk[] = [];
  yield* call(async () => {
    for await (const { results } of reranker.score(query, chunks)) {
      scored = results;
    }
  });

  const passages: string[] = [];
  let totalChars = 0;
  for (const sc of scored.slice(0, topN)) {
    const chunk = chunks.find(
      (c) => c.resource === sc.file && c.startLine === sc.startLine,
    );
    const passage = `[${sc.heading}](${sc.file})\n${chunk?.text || ""}`;
    if (totalChars + passage.length > maxChars && passages.length > 0) break;
    passages.push(passage);
    totalChars += passage.length;
  }
  return passages.join("\n\n---\n\n");
}

// ── Routing ─────────────────────────────────────────────────────

type Route =
  | { type: "clarify"; questions: string[] }
  | { type: "research"; tasks: ResearchTask[]; maxTurns: number };

function route(plan: PlanResult, query: string, maxTurns: number): Route {
  const research = plan.tasks.filter((t) => t.intent === "research");
  const clarify = plan.tasks.filter((t) => t.intent === "clarify");

  if (research.length === 0 && clarify.length > 0)
    return { type: "clarify", questions: clarify.map((t) => t.description) };

  const tasks =
    research.length > 0
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
  opts: {
    verifyCount: number;
    maxTurns: number;
    trace: boolean;
    findingsMaxChars?: number;
  },
  context?: string,
): Operation<QueryResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent) => events.send(ev as unknown as AgentEvent);

  yield* send({ type: "query", query, warm: !!session.trunk });
  const t0 = performance.now();

  // ── Plan ──────────────────────────────────────────────────
  const planTool = new PlanTool({
    prompt: PLAN,
    session,
    maxQuestions: 10,
  });
  const plan = (yield* planTool.execute({ query, context })) as PlanResult;
  const r = route(plan, query, opts.maxTurns);

  const intent =
    r.type === "clarify"
      ? "clarify"
      : plan.tasks.length === 0
        ? "passthrough"
        : "decompose";
  yield* send({
    type: "plan",
    intent,
    questions: plan.questions,
    tokenCount: plan.tokenCount,
    timeMs: plan.timeMs,
  });

  if (r.type === "clarify") return { type: "clarify", questions: r.questions };

  // ── Research across sources ───────────────────────────────
  yield* send({ type: "research:start", agentCount: r.tasks.length });
  const researchT = performance.now();

  // Bind all sources upfront — WebSource.bind() is not idempotent (clears URL cache)
  for (const source of sources) {
    yield* source.bind({ reranker });
  }
  const scorers = new Map(sources.map((s) => [s, s.createScorer(query)]));

  // Outer: tasks (sequential stages). Inner: sources (cross-source within each stage).
  const findings = yield* reduce(
    r.tasks,
    {
      sections: [] as string[],
      totalTokens: 0,
      totalToolCalls: 0,
      priorFindings: "",
    },
    function* (acc, task, i) {
      yield* send({
        type: "spine:task",
        taskIndex: i,
        taskCount: r.tasks.length,
        description: task.description,
      });

      const stageResult = yield* reduce(
        sources,
        {
          sections: [] as string[],
          totalTokens: 0,
          totalToolCalls: 0,
          stageFindings: "",
        },
        function* (srcAcc, source, j) {
          yield* send({
            type: "spine:source",
            taskIndex: i,
            source: source.name,
          });
          const scorer = scorers.get(source)!;
          const dataTools = [...source.tools, reportTool];

          // Inner prompt (search/fetch/report) — pool-level default, inherited by DelegateTool for sub-agents
          const innerToolCtx = dataTools.map((t) => ({
            name: t.name,
            description: t.description,
          }));
          const innerPrompt = renderWorkerPrompt(source, {
            tools: innerToolCtx,
            maxTurns: r.maxTurns,
          });

          // Pool opts for DelegateTool — inner pools inherit these
          const innerPoolOpts = {
            tasks: [] as { content: string }[],
            tools: dataTools,
            systemPrompt: innerPrompt,
            terminalTool: "report" as const,
            maxTurns: r.maxTurns,
            pruneOnReport: true,
            trace: opts.trace,
            scorer,
            session,
            echoThreshold: 0.8,
          };

          // DelegateTool first — grammar ordering bias makes it the default action
          const delegate = createDelegateTool(source, innerPoolOpts);
          const tools = [delegate, ...dataTools];

          // Outer prompt (decompose, call delegate) — per-task override for the outer agent
          const outerToolCtx = tools.map((t) => ({
            name: t.name,
            description: t.description,
          }));
          const outerPrompt = renderWorkerPrompt(source, {
            tools: outerToolCtx,
            maxTurns: r.maxTurns,
            delegate: true,
            delegateTool: delegate.name,
          });

          // Augment with: prior stage findings + within-stage cross-source findings
          const priorContext = [acc.priorFindings, srcAcc.stageFindings]
            .filter(Boolean)
            .join("\n\n");
          const augmentedContent = priorContext
            ? `${taskToContent(task)}\n\nPrior research findings:\n${priorContext}`
            : taskToContent(task);

          const pool = yield* createAgentPool({
            tasks: [{ content: augmentedContent, systemPrompt: outerPrompt }],
            tools,
            systemPrompt: innerPrompt,
            terminalTool: "report",
            maxTurns: 1,
            pruneOnReport: true,
            trace: opts.trace,
            scorer,
            session,
          });

          const taskFindings = pool.agents
            .map((a) => a.result)
            .filter(Boolean)
            .map((f, k) => `### Agent ${k + 1}\n${f}`)
            .join("\n\n");
          const supporting = pool.agents
            .flatMap((a) => [...a.nestedResults])
            .filter(Boolean)
            .map((f, k) => `### Supporting ${k + 1}\n${f}`)
            .join("\n\n");
          const allStageFindings = [srcAcc.stageFindings, taskFindings]
            .filter(Boolean)
            .join("\n\n");

          return {
            sections: [
              ...srcAcc.sections,
              ...(taskFindings
                ? [`## Task ${i + 1} (${source.name})\n\n${taskFindings}`]
                : []),
              ...(supporting
                ? [
                    `## Task ${i + 1} (${source.name}) supporting\n\n${supporting}`,
                  ]
                : []),
            ],
            totalTokens: srcAcc.totalTokens + pool.totalTokens,
            totalToolCalls: srcAcc.totalToolCalls + pool.totalToolCalls,
            stageFindings: allStageFindings,
          };
        },
      );

      const allFindings = [acc.priorFindings, stageResult.stageFindings]
        .filter(Boolean)
        .join("\n\n");
      yield* send({
        type: "spine:task:done",
        taskIndex: i,
        stageFindings: stageResult.stageFindings.length,
        accumulated: allFindings.length,
      });

      return {
        sections: [...acc.sections, ...stageResult.sections],
        totalTokens: acc.totalTokens + stageResult.totalTokens,
        totalToolCalls: acc.totalToolCalls + stageResult.totalToolCalls,
        priorFindings: allFindings,
      };
    },
  );

  const agentFindings = findings.sections.join("\n\n");

  // Source passages for synthesis — one rerank pass over all accumulated chunks
  const allChunks = sources.flatMap((s) => s.getChunks());
  const sourcePassages = yield* rerankChunks(
    allChunks,
    query,
    reranker,
    10,
    opts.findingsMaxChars,
  );

  const researchTimeMs = performance.now() - researchT;
  yield* send({
    type: "research:done",
    totalTokens: findings.totalTokens,
    totalToolCalls: findings.totalToolCalls,
    timeMs: researchTimeMs,
  });

  // ── Evaluate findings ─────────────────────────────────────
  const findingsEvalSchema = {
    type: "object",
    properties: {
      conflicts: {
        type: "array",
        items: { type: "string" },
        description:
          "Genuine factual contradictions only — mutually exclusive claims about the same topic. Empty array if none.",
      },
      observations: {
        type: "array",
        items: { type: "string" },
        description:
          "Cross-agent analysis: coverage gaps, complementary findings, notable claim comparisons.",
      },
    },
    required: ["conflicts", "observations"],
  };

  const findingsEvalAgent = yield* createAgent({
    systemPrompt: FINDINGS_EVAL.system,
    task: renderTemplate(FINDINGS_EVAL.user, { findings: agentFindings }),
    schema: findingsEvalSchema,
  });

  let findingsEvalParsed: {
    conflicts: string[];
    observations: string[];
  } | null = null;
  try {
    findingsEvalParsed = JSON.parse(findingsEvalAgent.rawOutput);
  } catch {
    /* malformed */
  }

  const conflicts = findingsEvalParsed?.conflicts?.length
    ? findingsEvalParsed.conflicts
    : undefined;
  const observations = findingsEvalParsed?.observations?.length
    ? findingsEvalParsed.observations
    : undefined;

  yield* send({
    type: "findings:eval",
    converged: !conflicts,
    conflicts: findingsEvalParsed?.conflicts ?? [],
    observations: findingsEvalParsed?.observations ?? [],
    tokenCount: findingsEvalAgent.tokenCount,
    timeMs: 0, // TODO: track timing
  });

  // ── Synthesize ────────────────────────────────────────────
  yield* send({ type: "synthesize:start" });
  const synthT = performance.now();

  const synthCtx = {
    agentFindings,
    sourcePassages: sourcePassages || null,
    conflicts: conflicts ?? null,
    observations: observations ?? null,
    query,
  };
  const synthSystem = renderTemplate(SYNTHESIZE.system, synthCtx);
  const synthContent = renderTemplate(SYNTHESIZE.user, synthCtx);

  const groundingTools = conflicts?.length
    ? sources.flatMap((s) => s.tools)
    : [];

  const synth = yield* createAgentPool({
    tasks: [{ content: synthContent }],
    tools: [...groundingTools, reportTool],
    systemPrompt: synthSystem,
    terminalTool: "report",
    maxTurns: opts.maxTurns,
    trace: opts.trace,
  });

  const answer = synth.agents[0]?.result || "";
  const synthTimeMs = performance.now() - synthT;

  yield* send({ type: "synthesize:done", pool: synth, timeMs: synthTimeMs });
  yield* send({ type: "answer", text: answer });

  // ── Verify (N samples, batched) ───────────────────────────
  const verifyContent = renderTemplate(VERIFY.user, {
    agentFindings: agentFindings || "(none)",
    sourcePassages: sourcePassages || "(none)",
    query,
  });

  const verifyPool = yield* createAgentPool({
    tasks: Array.from({ length: opts.verifyCount }, (_, i) => ({
      content: verifyContent,
      seed: 2000 + i,
    })),
    systemPrompt: VERIFY.system,
  });
  const verifyOutputs = verifyPool.agents.map((a) => a.agent.rawOutput);

  // ── Eval ──────────────────────────────────────────────────
  const evalSchema = {
    type: "object",
    properties: { converged: { type: "boolean" } },
    required: ["converged"],
  };
  const responsesText = verifyOutputs
    .map((r, i) => `Response ${i + 1}: ${r.trim()}`)
    .join("\n\n");

  const evalAgent = yield* createAgent({
    systemPrompt: EVAL.system,
    task: renderTemplate(EVAL.user, { responses: responsesText }),
    schema: evalSchema,
  });

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
    timeMs: 0,
  });

  // ── Commit ────────────────────────────────────────────────
  if (answer) {
    yield* call(() => session.commitTurn(query, answer));
  }

  // ── Stats ─────────────────────────────────────────────────
  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: plan.tokenCount,
      detail: intent,
      timeMs: plan.timeMs,
    },
    {
      label: "Research",
      tokens: findings.totalTokens,
      detail: `${findings.totalToolCalls} tools`,
      timeMs: researchTimeMs,
    },
    {
      label: "Findings Eval",
      tokens: findingsEvalAgent.tokenCount,
      detail: !conflicts ? "converged" : `${conflicts.length} conflicts`,
      timeMs: 0,
    },
    {
      label: "Synthesize",
      tokens: synth.totalTokens,
      detail: `(${synth.agents.map((a) => a.tokenCount).join(" + ")})  ${synth.totalToolCalls} tools`,
      timeMs: synthTimeMs,
    },
    {
      label: "Eval",
      tokens: evalAgent.tokenCount,
      detail: `converged: ${evalConverged ? "yes" : "no"}`,
      timeMs: 0,
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
      intent,
      planTokens: plan.tokenCount,
      agentTokens: findings.totalTokens,
      synthTokens: synth.totalTokens,
      synthToolCalls: synth.totalToolCalls,
      evalTokens: evalAgent.tokenCount,
      converged: evalConverged,
      totalToolCalls: findings.totalToolCalls + synth.totalToolCalls,
      agentCount: r.tasks.length,
      synthCount: synth.agents.length,
      wallTimeMs: Math.round(performance.now() - t0),
      planMs: Math.round(plan.timeMs),
      researchMs: Math.round(researchTimeMs),
      synthMs: Math.round(synthTimeMs),
      evalMs: 0,
    },
  });

  return { type: "done" };
}
