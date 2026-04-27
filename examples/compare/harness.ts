/**
 * Compare harness — a 6-node DAG over two sources.
 *
 * This is the SDK's framework primer for `dag(...)`. The DAG below is the
 * smallest topology that genuinely needs DAG (rather than chain or fanout):
 * three siblings depend on TWO root nodes simultaneously, and a final node
 * depends on all three siblings.
 *
 *      research_web_X ──┐                   ┌──▶ compare_axis_1 ──┐
 *      (WebSource)      │                   │                     │
 *                       ├───────────────────┼──▶ compare_axis_2 ──┼──▶ synthesize
 *      research_corp_Y ─┘                   │                     │
 *      (CorpusSource)                       └──▶ compare_axis_3 ──┘
 *
 * The orchestrator lazily spawns each node when its dependencies clear.
 * Each node's `userContent` is prefilled onto the shared root via
 * `ctx.extendRoot`, so dependent nodes see prior findings as conversation
 * turns in their KV attention — that's why the compare nodes can read
 * "Research findings on X" / "Research findings on Y" above their task.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "effection";
import type { Operation, Task } from "effection";
import type { Session } from "@lloyal-labs/sdk";
import {
  agentPool,
  renderTemplate,
  withSharedRoot,
} from "@lloyal-labs/lloyal-agents";
import type {
  DAGNode,
  Orchestrator,
  Source,
  AgentResult,
} from "@lloyal-labs/lloyal-agents";
import { reportTool } from "@lloyal-labs/rig";
import type { Chunk, Reranker, SourceContext } from "@lloyal-labs/rig";

// ── Prompt loading ──────────────────────────────────────────────

function loadTemplate(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, `prompts/${name}.eta`),
    "utf8",
  );
}

const RESEARCH_WEB = loadTemplate("research-web");
const RESEARCH_CORPUS = loadTemplate("research-corpus");
const COMPARE = loadTemplate("compare");
const SYNTHESIZE = loadTemplate("synthesize");

// ── Types ───────────────────────────────────────────────────────

/**
 * Events the harness emits. Two are produced by the orchestrator
 * (topology + per-node spawn) so a TUI can map agent ids back to DAG
 * node ids; the third is a fatal-error notice main.ts uses to render
 * an error panel without tearing the TUI down.
 */
export type DagEvent =
  | { type: 'dag:topology'; nodes: { id: string; dependsOn: string[] }[]; t0Ms: number }
  | { type: 'dag:node:spawn'; id: string; agentId: number; tMs: number }
  | { type: 'compare:error'; message: string; stack?: string };

export interface CompareOpts {
  x: string;
  y: string;
  axes: [string, string, string];
  maxTurns: number;
  trace: boolean;
  /** Optional: receive `dag:topology` + `dag:node:spawn` so a TUI can route
   *  subsequent `agent:*` events to the right card. No-op by default. */
  emitDagEvent?: (ev: DagEvent) => void;
}

export interface CompareResult {
  answer: string;
  totalTokens: number;
  totalToolCalls: number;
  agents: readonly AgentResult[];
}

// ── Helpers ─────────────────────────────────────────────────────

function getCorpusToc(sources: Source<SourceContext, Chunk>[]): string {
  const corpus = sources.find(
    (s) =>
      typeof (s as unknown as { promptData?: () => { toc: string } })
        .promptData === "function",
  );
  if (!corpus) {
    throw new Error(
      "compare: requires a CorpusSource (one of the two research lanes is corpus-backed)",
    );
  }
  return (corpus as unknown as { promptData: () => { toc: string } })
    .promptData().toc;
}

// ── Entry point ─────────────────────────────────────────────────

/**
 * Inline orchestrator that mirrors the framework's `dag()` (after its
 * Task-as-Future refactor) but ALSO emits per-node lifecycle events. We
 * inline rather than import because `dag()` doesn't expose a per-spawn
 * event hook — replicating ~25 LOC is cheaper than threading a callback
 * through the package API.
 *
 * Pattern (canonical Effection): each node runs as a child Task. The
 * dependency edge "A depends on B" is encoded as `yield* tasks.get(B)`
 * inside A's task body — Task<T> extends Future<T> extends Operation<T>,
 * so awaiting another task IS the cross-task rendezvous primitive. No
 * mutable Sets, no race window. Failure in any node halts the rest via
 * structured concurrency.
 *
 * Validation is skipped — the topology is hardcoded so cycles aren't
 * possible by construction.
 */
function dagWithEvents(
  nodes: DAGNode[],
  emit: (ev: DagEvent) => void,
): Orchestrator {
  return function* (ctx) {
    emit({
      type: 'dag:topology',
      t0Ms: performance.now(),
      nodes: nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn ?? [] })),
    });

    const tasks = new Map<string, Task<void>>();

    function* runNode(n: DAGNode): Operation<void> {
      // Gate: await every declared dep's task. Roots (no deps) start
      // immediately; descendants unblock as their deps complete.
      for (const depId of n.dependsOn ?? []) {
        yield* tasks.get(depId)!;
      }
      const agent = yield* ctx.spawn({
        ...n.task,
        parent: n.task.parent ?? ctx.root,
      });
      emit({
        type: 'dag:node:spawn',
        id: n.id,
        agentId: agent.id,
        tMs: performance.now(),
      });
      yield* ctx.waitFor(agent);
      if (agent.result && n.userContent) {
        yield* ctx.extendRoot(n.userContent, agent.result);
      }
    }

    // Spawn every node up front (synchronous between iterations — the
    // task bodies don't run until we yield below). Each spawned task
    // immediately suspends on its first dep await (or runs, if it's a
    // root). The Map is fully populated before any node body executes.
    for (const n of nodes) {
      tasks.set(n.id, yield* spawn(() => runNode(n)));
    }
    for (const t of tasks.values()) yield* t;
  };
}

const SYNTH_NODE_ID = 'synthesize';

export function* handleCompare(
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: CompareOpts,
): Operation<CompareResult> {
  const { x, y, axes, maxTurns, trace } = opts;

  // Capture the synth node's agent id from the orchestrator's spawn event
  // so we can look it up in pool.agents at the end. The pool may include
  // recovery agents beyond the 6 declared nodes, so spawn-order indexing
  // doesn't work — agents are looked up by their stable agent.id.
  let synthAgentId: number | null = null;
  const emitOuter = opts.emitDagEvent ?? (() => {});
  const emit = (ev: DagEvent): void => {
    if (ev.type === 'dag:node:spawn' && ev.id === SYNTH_NODE_ID) {
      synthAgentId = ev.agentId;
    }
    emitOuter(ev);
  };

  // Bind sources, gather tools, pick primary scorer (mirrors deep-research:296-305).
  for (const source of sources) yield* source.bind({ reranker });
  const allDataTools = sources.flatMap((s) => s.tools);
  const tools = [...allDataTools, reportTool];
  const toolCtx = tools.map((t) => ({
    name: t.name,
    description: t.description,
  }));
  const primaryScorer = sources[0].createScorer(`${x} vs ${y}`);

  const date = new Date().toISOString().slice(0, 10);
  const corpusToc = getCorpusToc(sources);

  // ── DAG topology ──────────────────────────────────────────────
  const nodes: DAGNode[] = [
    {
      id: "research_web_X",
      task: {
        content: `Research subject: ${x}`,
        systemPrompt: renderTemplate(RESEARCH_WEB, {
          subject: x,
          counterpart: y,
          axes,
          tools: toolCtx,
          maxTurns,
          date,
        }),
        seed: 1001,
      },
      userContent: `Research findings on ${x}:`,
    },
    {
      id: "research_corp_Y",
      task: {
        content: `Research subject: ${y}`,
        systemPrompt: renderTemplate(RESEARCH_CORPUS, {
          subject: y,
          counterpart: x,
          axes,
          toc: corpusToc,
          tools: toolCtx,
          maxTurns,
        }),
        seed: 1002,
      },
      userContent: `Research findings on ${y}:`,
    },
    ...axes.map<DAGNode>((axis, i) => ({
      id: `compare_axis_${i + 1}`,
      dependsOn: ["research_web_X", "research_corp_Y"],
      task: {
        content: `Compare ${x} vs ${y} on: ${axis}`,
        systemPrompt: renderTemplate(COMPARE, {
          x,
          y,
          axis,
          tools: toolCtx,
        }),
        seed: 2000 + i,
      },
      userContent: `Comparison along axis "${axis}":`,
    })),
    {
      id: "synthesize",
      dependsOn: ["compare_axis_1", "compare_axis_2", "compare_axis_3"],
      task: {
        content: `Write the final compare-and-contrast report on ${x} vs ${y}.`,
        systemPrompt: renderTemplate(SYNTHESIZE, {
          x,
          y,
          axes,
          tools: toolCtx,
        }),
        seed: 3000,
      },
      // No userContent — synthesize is terminal; nothing reads from its extension.
    },
  ];

  // ── Run the pool ──────────────────────────────────────────────
  // One pool, one shared root. The DAG declares the topology; the pool's
  // tick loop batches decode across whatever agents are currently active.
  const pool = yield* withSharedRoot(
    { parent: session.trunk ?? undefined },
    function* (queryRoot) {
      return yield* agentPool({
        orchestrate: dagWithEvents(nodes, emit),
        tools,
        parent: queryRoot,
        terminalTool: "report",
        maxTurns,
        pruneOnReport: true,
        scorer: primaryScorer,
        trace,
      });
    },
  );

  // Find the synth agent by its captured id. The pool's agents array may
  // include recovery agents beyond the declared nodes, so we can't rely on
  // a fixed length or spawn-order index.
  const synth = synthAgentId !== null
    ? pool.agents.find((a) => a.agent.id === synthAgentId)
    : undefined;

  return {
    answer: synth?.result ?? "(no synthesis)",
    totalTokens: pool.totalTokens,
    totalToolCalls: pool.totalToolCalls,
    agents: pool.agents,
  };
}
