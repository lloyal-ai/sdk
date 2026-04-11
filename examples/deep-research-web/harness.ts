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
import { reportTool, PlanTool, taskToContent } from "@lloyal-labs/rig";
import type {
  PlanResult,
  ResearchTask,
  Reranker,
  ScoredChunk,
  Chunk,
  SourceContext,
} from "@lloyal-labs/rig";

// ── Prompts ─────────────────────────────────────────────────────

function loadTask(name: string): { system: string; user: string } {
  const etaPath = path.resolve(__dirname, `tasks/${name}.eta`);
  const mdPath = path.resolve(__dirname, `tasks/${name}.md`);
  const raw = fs.existsSync(etaPath)
    ? fs.readFileSync(etaPath, "utf8").trim()
    : fs.readFileSync(mdPath, "utf8").trim();
  const sep = raw.indexOf("\n---\n");
  if (sep === -1) return { system: raw, user: "" };
  return { system: raw.slice(0, sep).trim(), user: raw.slice(sep + 5).trim() };
}

function loadEtaTemplate(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, `tasks/${name}.eta`), "utf8");
}

const PLAN = loadTask("plan");
const FALLBACK = loadTask("fallback");
const BRIDGE = loadTask("bridge");
const VERIFY = loadTask("verify");
const EVAL = loadTask("eval");
const FINDINGS_EVAL = loadTask("findings-eval");
const REPORT = loadTask("report");
const SYNTHESIZE_TEMPLATE = loadEtaTemplate("synthesize");
const CORPUS_RESEARCH_TEMPLATE = loadEtaTemplate("corpus-research");
const WEB_RESEARCH_TEMPLATE = loadEtaTemplate("web-research");

/** Create a fresh research policy per query — time budget scopes to research, not process lifetime */
function createResearchPolicy() {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 2048 },
      time: { softLimit: 600_000, hardLimit: 900_000 },
    },
    recovery: { prompt: REPORT },
  });
}

// ── Types ───────────────────────────────────────────────────────

export type Strategy = "deep" | "wide";

export type QueryResult =
  | { type: "done" }
  | { type: "clarify"; questions: string[] };

// ── Helpers ─────────────────────────────────────────────────────

interface ResearchContext {
  strategy: Strategy;
  tools: { name: string; description: string }[];
  agentCount: number;
  siblingTasks: string[];
  maxTurns: number;
}

function sourcePromptFor(
  source: { name: string; promptData?: () => { toc: string } },
  ctx: ResearchContext,
): string {
  if (source.promptData) {
    return renderTemplate(CORPUS_RESEARCH_TEMPLATE, {
      ...source.promptData(),
      ...ctx,
    });
  }
  if (source.name === "web") {
    return renderTemplate(WEB_RESEARCH_TEMPLATE, ctx);
  }
  return FALLBACK.system;
}

function recursiveOpts(source: Source<SourceContext, Chunk>) {
  return {
    name: source.name === "web" ? "web_research" : "research",
    description: "Spawn parallel sub-agents — one per question. Each sub-agent inherits your full context and can search and fetch independently.",
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
  };
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

function route(
  plan: PlanResult,
  query: string,
  maxTurns: number,
): Route {
  const research = plan.tasks.filter((t) => t.intent === "research");
  const clarify = plan.tasks.filter((t) => t.intent === "clarify");

  if (research.length === 0 && clarify.length > 0)
    return { type: "clarify", questions: clarify.map((t) => t.description) };

  const tasks = research.length > 0
    ? research
    : [{ description: query, intent: "research" as const }];
  const effectiveMaxTurns = tasks.length === 1 ? maxTurns * 2 : maxTurns;
  return { type: "research", tasks, maxTurns: effectiveMaxTurns };
}

// ── Entry point ─────────────────────────────────────────────────

export function* handleQuery(
  query: string,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: {
    agentCount: number;
    verifyCount: number;
    maxTurns: number;
    strategy: Strategy;
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
    maxQuestions: opts.agentCount,
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

  const findings = yield* reduce(
    sources,
    {
      sections: [] as string[],
      tasks: r.tasks,
      totalTokens: 0,
      totalToolCalls: 0,
    },
    function* (acc, source, i) {
      yield* source.bind({ reranker });
      const scorer = source.createScorer(query);

      const tools = [...source.tools, reportTool];
      const recOpts = recursiveOpts(source);
      const toolCtx = [
        ...tools.map((t) => ({ name: t.name, description: t.description })),
        { name: recOpts.name, description: recOpts.description },
      ];
      const pool = yield* createAgentPool({
        tasks: acc.tasks.map((task, idx) => ({
          content: taskToContent(task),
          systemPrompt: sourcePromptFor(source, {
            strategy: opts.strategy,
            tools: toolCtx,
            agentCount: acc.tasks.length,
            siblingTasks: acc.tasks.filter((_, j) => j !== idx).map(t => t.description),
            maxTurns: r.maxTurns,
          }),
        })),
        tools,
        systemPrompt: sourcePromptFor(source, {
          strategy: opts.strategy,
          tools: toolCtx,
          agentCount: acc.tasks.length,
          siblingTasks: [],
          maxTurns: r.maxTurns,
        }),
        terminalTool: "report",
        recursive: recursiveOpts(source),
        maxTurns: r.maxTurns,
        policy: createResearchPolicy(),
        pruneOnReport: true,
        trace: opts.trace,
        scorer,
        session,
      });

      const totalTokens = acc.totalTokens + pool.totalTokens;
      const totalToolCalls = acc.totalToolCalls + pool.totalToolCalls;

      const agentFindings = pool.agents
        .map((a) => a.result)
        .filter(Boolean)
        .map((f, j) => `### Agent ${j + 1}\n${f}`)
        .join("\n\n");
      const supporting = pool.agents
        .flatMap((a) => [...a.nestedResults])
        .filter(Boolean)
        .map((f, j) => `### Supporting finding ${j + 1}\n${f}`)
        .join("\n\n");

      const sections = [
        ...acc.sections,
        ...(agentFindings
          ? [`## ${source.name} research\n\n${agentFindings}`]
          : []),
        ...(supporting
          ? [`## ${source.name} supporting research\n\n${supporting}`]
          : []),
      ];

      // Bridge to next source
      if (i < sources.length - 1 && agentFindings) {
        const sourceChunks = source.getChunks();
        const passages = yield* rerankChunks(
          sourceChunks,
          query,
          reranker,
          10,
          opts.findingsMaxChars,
        );

        yield* send({ type: "bridge:start" });
        const bt = performance.now();

        const bridgeContent = BRIDGE.user
          .replace("{{agentFindings}}", agentFindings)
          .replace("{{sourcePassages}}", passages)
          .replace("{{query}}", query);

        const bridge = yield* createAgentPool({
          tasks: [{ content: bridgeContent }],
          tools: [reportTool],
          systemPrompt: BRIDGE.system,
          terminalTool: "report",
          maxTurns: 2,
          trace: opts.trace,
        });

        const discoveries = bridge.agents[0]?.result || "";
        yield* send({
          type: "bridge:done",
          findings: discoveries,
          timeMs: performance.now() - bt,
        });

        if (discoveries) {
          return {
            sections,
            tasks: acc.tasks.map((t) => ({
              ...t,
              description: `${t.description}\n\nPrior research discoveries:\n${discoveries}`,
            })),
            totalTokens: totalTokens + bridge.totalTokens,
            totalToolCalls: totalToolCalls + bridge.totalToolCalls,
          };
        }
      }

      return {
        sections,
        tasks: acc.tasks,
        totalTokens,
        totalToolCalls,
      };
    },
  );

  const allChunks = sources.flatMap((s) => s.getChunks());
  const agentFindings = findings.sections.join("\n\n");
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
        description: "Genuine factual contradictions only — mutually exclusive claims about the same topic. Empty array if none.",
      },
      observations: {
        type: "array",
        items: { type: "string" },
        description: "Cross-agent analysis: coverage gaps, complementary findings, notable claim comparisons.",
      },
    },
    required: ["conflicts", "observations"],
  };

  const findingsEvalAgent = yield* createAgent({
    systemPrompt: FINDINGS_EVAL.system,
    task: FINDINGS_EVAL.user.replace("{{findings}}", agentFindings),
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

  const conflicts =
    findingsEvalParsed?.conflicts?.length
      ? findingsEvalParsed.conflicts
      : undefined;
  const observations =
    findingsEvalParsed?.observations?.length
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

  const rendered = renderTemplate(SYNTHESIZE_TEMPLATE, {
    agentFindings,
    sourcePassages: sourcePassages || null,
    conflicts: conflicts ?? null,
    observations: observations ?? null,
    query,
  });
  const sepIdx = rendered.indexOf("\n---\n");
  const synthSystem =
    sepIdx >= 0 ? rendered.slice(0, sepIdx).trim() : rendered.trim();
  const synthContent = sepIdx >= 0 ? rendered.slice(sepIdx + 5).trim() : "";

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
  const verifyContent = VERIFY.user
    .replace("{{agentFindings}}", agentFindings || "(none)")
    .replace("{{sourcePassages}}", sourcePassages || "(none)")
    .replace("{{query}}", query);

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
    task: EVAL.user.replace("{{responses}}", responsesText),
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
      detail: !conflicts
        ? "converged"
        : `${conflicts.length} conflicts`,
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
