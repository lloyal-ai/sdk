/**
 * Pure event → AppState reducer.
 *
 * Owns: phase transitions, per-agent state machine (<think> boundary
 * detection), timeline item accrual (think / tool_call / tool_result /
 * report), synth buffer.
 *
 * Emits no side effects. Feed it a trace of StepEvent + AgentEvent; it
 * returns the view-ready state.
 */

import type { AppState, AgentRuntime, TimelineItem } from './state';
import { initialState } from './state';
import type { WorkflowEvent } from './events';

const THINK_CLOSE = '</think>';

/** "~/foo/harness.json" when possible. Keeps toasts readable in narrow columns. */
function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

/** First meaningful line of a think-block body, cleaned up for a title. */
function extractTitle(body: string): string {
  const text = body
    .replace(/^\s*\n/, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/, '')
    .trim();
  if (!text) return 'Thinking…';
  const firstLine = text.split('\n')[0].trim();
  const clipped = firstLine.length > 72 ? firstLine.slice(0, 72).trimEnd() + '…' : firstLine;
  return clipped;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Best-effort argsSummary for tool_call rendering. One-liners per tool. */
function formatArgSummary(tool: string, rawArgs: string): string {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawArgs); } catch { parsed = {}; }
  const q = typeof parsed.query === 'string' ? parsed.query
    : typeof parsed.pattern === 'string' ? parsed.pattern
    : typeof parsed.url === 'string' ? parsed.url
    : typeof parsed.filename === 'string' ? parsed.filename
    : '';
  return q ? `"${q.length > 48 ? q.slice(0, 48) + '…' : q}"` : '';
}

/** Best-effort per-tool summary used by the column's ToolResult line. */
function summarizeResult(tool: string, raw: string): {
  summary: string;
  hosts: string[];
  resultCount: number | null;
  preview: string | null;
} {
  // Try JSON parse first — structured tools (web_search, search, grep, plan).
  try {
    const parsed: unknown = JSON.parse(raw);
    if (tool === 'web_search' && Array.isArray(parsed)) {
      const items = parsed as { url?: string; title?: string }[];
      const hosts = Array.from(
        new Set(items.map((i) => (i.url ? hostOf(i.url) : '')).filter(Boolean)),
      ).slice(0, 3);
      return {
        summary: `${items.length} results`,
        hosts,
        resultCount: items.length,
        preview: items[0]?.title ?? null,
      };
    }
    if (tool === 'search' && Array.isArray(parsed)) {
      const items = parsed as { heading?: string }[];
      return {
        summary: `${items.length} results`,
        hosts: [],
        resultCount: items.length,
        preview: items[0]?.heading ?? null,
      };
    }
    if (tool === 'grep' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { totalMatches?: number; matchingLines?: number };
      return {
        summary: `${r.totalMatches ?? 0} matches`,
        hosts: [],
        resultCount: r.totalMatches ?? null,
        preview: null,
      };
    }
    if (tool === 'fetch_page' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { url?: string; title?: string; error?: string };
      if (r.error) return { summary: r.error, hosts: [], resultCount: null, preview: null };
      const hosts = r.url ? [hostOf(r.url)] : [];
      return {
        summary: `${raw.length}b`,
        hosts,
        resultCount: null,
        preview: r.title ?? null,
      };
    }
    if (tool === 'web_fetch' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { url?: string; title?: string };
      const hosts = r.url ? [hostOf(r.url)] : [];
      return {
        summary: `${raw.length}b`,
        hosts,
        resultCount: null,
        preview: r.title ?? null,
      };
    }
  } catch {
    /* fall through to URL-scan fallback */
  }

  // Fallback: scrape hosts from raw URLs in the result payload.
  const urls = Array.from(raw.matchAll(/https?:\/\/[^\s\])>"]+/g)).map((m) => m[0]);
  if (urls.length > 0) {
    const hosts = Array.from(new Set(urls.map(hostOf))).slice(0, 3);
    return {
      summary: `${urls.length} links`,
      hosts,
      resultCount: urls.length,
      preview: null,
    };
  }

  return { summary: `${raw.length}b`, hosts: [], resultCount: null, preview: null };
}

// ── Immutable-update helpers ────────────────────────────────────

function replaceAgent(
  state: AppState,
  id: number,
  patch: (a: AgentRuntime) => AgentRuntime,
): AppState {
  const existing = state.agents.get(id);
  if (!existing) return state;
  const agents = new Map(state.agents);
  agents.set(id, patch(existing));
  return { ...state, agents };
}

function createAgent(state: AppState, id: number, patch: Partial<AgentRuntime> = {}): AppState {
  if (state.agents.has(id)) return state;
  const base: AgentRuntime = {
    id,
    label: `A${state.nextLabelIdx}`,
    phase: 'idle',
    tokenCount: 0,
    toolCallCount: 0,
    taskIndex: null,
    taskDescription: null,
    dependencyHint: null,
    currentThinkId: null,
    pendingToolCallId: null,
    contentBuffer: '',
    timeline: [],
    ...patch,
  };
  const agents = new Map(state.agents);
  agents.set(id, base);
  return { ...state, agents, nextLabelIdx: state.nextLabelIdx + 1 };
}

function pushTimeline(agent: AgentRuntime, item: TimelineItem): AgentRuntime {
  return { ...agent, timeline: [...agent.timeline, item] };
}

function updateTimeline(
  agent: AgentRuntime,
  id: number,
  update: (item: TimelineItem) => TimelineItem,
): AgentRuntime {
  return {
    ...agent,
    timeline: agent.timeline.map((it) => (it.id === id ? update(it) : it)),
  };
}

/** Open a new live think block on this agent. */
function openThink(state: AppState, agentId: number): AppState {
  const id = state.nextTimelineId;
  const next = replaceAgent(state, agentId, (a) =>
    pushTimeline({ ...a, currentThinkId: id, phase: 'thinking' }, {
      kind: 'think',
      id,
      title: 'Thinking…',
      body: '',
      live: true,
      openedAt: Date.now(),
      closedAt: null,
    }),
  );
  return { ...next, nextTimelineId: state.nextTimelineId + 1 };
}

/** Close the agent's currently-live think block with finalBody. */
function closeThink(state: AppState, agentId: number, finalBody: string): AppState {
  const agent = state.agents.get(agentId);
  if (!agent || agent.currentThinkId === null) return state;
  const thinkId = agent.currentThinkId;
  const title = extractTitle(finalBody);
  return replaceAgent(state, agentId, (a) =>
    updateTimeline({ ...a, currentThinkId: null, phase: 'content' }, thinkId, (it) =>
      it.kind === 'think'
        ? { ...it, body: finalBody, title, live: false, closedAt: Date.now() }
        : it,
    ),
  );
}

// ── reducer entry ────────────────────────────────────────────────

export function reduce(state: AppState, ev: WorkflowEvent): AppState {
  switch (ev.type) {
    case 'query':
      // Preserve session-level fields across queries. Notably `mode` — a
      // `query` event fires at the start of every `runPlanner` call
      // (including re-plans on T toggle), and wiping mode would make the
      // PlanReview picker snap back to the default every time.
      return {
        ...initialState,
        config: state.config,
        configOrigin: state.configOrigin,
        uiPhase: state.uiPhase,
        mode: state.mode,
        nextToastId: state.nextToastId,
        toast: state.toast,
        query: ev.query,
        warm: ev.warm,
        phase: 'plan',
        startedAt: Date.now(),
      };

    case 'plan':
      return {
        ...state,
        uiPhase: ev.intent === 'clarify' ? 'clarifying' : state.uiPhase,
        phase: ev.intent === 'research' ? 'plan' : 'done',
        plan: {
          intent: ev.intent,
          tasks: ev.tasks,
          clarifyQuestions: ev.clarifyQuestions,
          tokenCount: ev.tokenCount,
          timeMs: ev.timeMs,
        },
        clarifyContext: ev.intent === 'clarify'
          ? { originalQuery: state.query, questions: ev.clarifyQuestions }
          : null,
      };

    case 'research:start':
      // Resume the pipeline timer — it was paused on ui:plan_review while
      // the user reviewed the plan. Accumulator holds the planning-phase
      // time; now we add research/synth/verify/eval on top.
      return {
        ...state,
        uiPhase: 'research',
        phase: 'research',
        mode: ev.mode === 'flat' ? 'flat' : 'deep',
        pipelineResumedAt: Date.now(),
      };

    case 'research:done':
      return { ...state, phase: 'synth' };

    case 'fanout:tasks':
      return state;

    case 'spine:task':
      return {
        ...state,
        pendingTaskIndex: ev.taskIndex,
        pendingTaskDescription: ev.description,
      };

    case 'spine:source':
    case 'spine:task:done':
      return state;

    case 'synthesize:start':
      return {
        ...state,
        phase: 'synth',
        synth: { open: true, buffer: '', done: false, stats: null },
      };

    case 'synthesize:done':
      return {
        ...state,
        synth: {
          ...state.synth,
          open: false,
          done: true,
          stats: {
            tokens: ev.tokenCount,
            toolCalls: ev.toolCallCount,
            ppl: ev.ppl,
            timeMs: ev.timeMs,
          },
        },
      };

    case 'verify:start':
      return {
        ...state,
        phase: 'verify',
        verify: { active: true, count: ev.count, done: false, timeMs: null },
      };

    case 'verify:done':
      return {
        ...state,
        verify: { active: false, count: ev.count, done: true, timeMs: ev.timeMs },
      };

    case 'eval:done':
      return {
        ...state,
        phase: 'eval',
        evalState: {
          done: true,
          converged: ev.converged,
          sampleCount: ev.sampleCount,
          tokenCount: ev.tokenCount,
          timeMs: ev.timeMs,
        },
      };

    case 'answer':
      return { ...state, answer: ev.text };

    case 'stats':
      return {
        ...state,
        timings: ev.timings,
        pressure: {
          pct: ev.ctxPct,
          cellsUsed: ev.ctxPos,
          nCtx: ev.ctxTotal,
        },
      };

    case 'complete': {
      // Pipeline finished — bank the last active slice into the accumulator
      // and pause. The footer reads this frozen value until the next query
      // submit resets it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        phase: 'done',
        uiPhase: 'done',
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    // ── UI + config events ───────────────────────────────────

    case 'config:loaded':
      return {
        ...state,
        config: ev.config,
        configOrigin: ev.origin,
        uiPhase: state.uiPhase === 'boot' ? 'composer' : state.uiPhase,
      };

    case 'config:updated': {
      const toastId = state.nextToastId + 1;
      const message = ev.skipped.length > 0
        ? `saved → ${shortPath(ev.savedTo)} (skipped: ${ev.skipped.join(', ')} — env active)`
        : ev.gitignored
          ? `saved → ${shortPath(ev.savedTo)} (added to .gitignore)`
          : `saved → ${shortPath(ev.savedTo)}`;
      return {
        ...state,
        config: ev.config,
        configOrigin: ev.origin,
        toast: {
          id: toastId,
          message,
          tone: ev.skipped.length > 0 ? 'warn' : 'success',
        },
        nextToastId: toastId,
      };
    }

    case 'plan:start': {
      // Fresh submission (from composer / done) → reset the pipeline timer
      // to zero. Re-plan from plan_review → keep the accumulator so the
      // displayed elapsed continues past the dwell.
      const freshSubmission =
        state.uiPhase === 'composer' ||
        state.uiPhase === 'done' ||
        state.uiPhase === 'boot';
      const base = freshSubmission
        ? { pipelineElapsedMs: 0, startedAt: Date.now() }
        : {};
      return {
        ...state,
        ...base,
        uiPhase: 'planning',
        phase: 'plan',
        plan: null,
        query: ev.query,
        mode: ev.mode === 'flat' ? 'flat' : 'deep',
        pipelineResumedAt: Date.now(),
      };
    }

    case 'ui:composer': {
      // Cancelled / finished — pause the timer if it was running. Preserve
      // the accumulator so the composer can show "last run took Xs" if we
      // ever want it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        uiPhase: 'composer',
        composerPrefill: ev.prefill ?? '',
        clarifyContext: null,
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    case 'ui:plan_review': {
      // Pause the pipeline timer — user is dwelling on the plan, not the
      // machine doing work. Bank the running slice, clear the resume
      // timestamp. research:start / next plan:start will resume it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        uiPhase: 'plan_review',
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    case 'ui:error': {
      const toastId = state.nextToastId + 1;
      return {
        ...state,
        uiPhase: 'composer',
        toast: { id: toastId, message: ev.message, tone: 'error' },
        nextToastId: toastId,
      };
    }

    // ── Agent events ───────────────────────────────────────────

    case 'agent:spawn': {
      // Non-research phase: track the agent but don't open a timeline.
      if (state.phase !== 'research') {
        return createAgent(state, ev.agentId, { phase: 'idle', taskIndex: null });
      }

      // Research phase: bind taskIndex + description, open the first think block.
      let taskIndex: number;
      let description: string | null;
      let nextPendingIdx: number | null = state.pendingTaskIndex;
      let nextPendingDesc: string | null = state.pendingTaskDescription;
      if (state.mode === 'deep') {
        taskIndex = nextPendingIdx ?? state.researchSpawnCount;
        description = nextPendingDesc
          ?? state.plan?.tasks[taskIndex]?.description
          ?? null;
        nextPendingIdx = null;
        nextPendingDesc = null;
      } else {
        taskIndex = state.researchSpawnCount;
        description = state.plan?.tasks[taskIndex]?.description ?? null;
      }

      const dependencyHint =
        state.mode === 'deep' && taskIndex > 0
          ? `builds on Task ${taskIndex}`
          : null;

      let next = createAgent(state, ev.agentId, {
        phase: 'thinking',
        taskIndex,
        taskDescription: description,
        dependencyHint,
      });
      next = {
        ...next,
        researchAgentIds: [...next.researchAgentIds, ev.agentId],
        researchSpawnCount: state.researchSpawnCount + 1,
        pendingTaskIndex: nextPendingIdx,
        pendingTaskDescription: nextPendingDesc,
      };
      return openThink(next, ev.agentId);
    }

    case 'agent:produce': {
      // Synth phase: accumulate into synth buffer.
      if (state.phase === 'synth' && state.synth.open) {
        return { ...state, synth: { ...state.synth, buffer: state.synth.buffer + ev.text } };
      }
      // Muted phases.
      if (state.phase === 'verify' || state.phase === 'eval') return state;
      if (state.phase !== 'research') return state;

      const agent = state.agents.get(ev.agentId);
      if (!agent || agent.taskIndex === null) return state;

      let working = state;
      let acting = agent;

      // Content-phase tokens (post-</think>, pre-tool_call) — the model is
      // writing tool-call JSON. For the terminal `report` tool, the report
      // body lives inside that JSON. Stream into contentBuffer so it's
      // visible; cleared on tool_call / report when the structured event
      // lands.
      if (acting.phase === 'content') {
        return replaceAgent(working, acting.id, (a) => ({
          ...a,
          tokenCount: ev.tokenCount,
          contentBuffer: a.contentBuffer + ev.text,
        }));
      }

      // Re-enter thinking after tool_result / recovery / initial idle.
      if (acting.phase !== 'thinking' || acting.currentThinkId === null) {
        if (acting.phase === 'tool' || acting.phase === 'idle') {
          working = openThink(working, acting.id);
          acting = working.agents.get(acting.id)!;
        } else {
          // done — drop.
          return replaceAgent(working, acting.id, (a) => ({ ...a, tokenCount: ev.tokenCount }));
        }
      }

      const thinkId = acting.currentThinkId!;
      const item = acting.timeline.find((it) => it.id === thinkId);
      if (!item || item.kind !== 'think') return working;

      const combined = item.body + ev.text;
      const markerIdx = combined.indexOf(THINK_CLOSE);

      if (markerIdx === -1) {
        return replaceAgent(working, acting.id, (a) =>
          updateTimeline({ ...a, tokenCount: ev.tokenCount }, thinkId, (it) =>
            it.kind === 'think' ? { ...it, body: combined } : it,
          ),
        );
      }

      // Close on </think>. Anything AFTER </think> in this same produce event
      // is content-phase prose — seed the contentBuffer with it so no tokens
      // are lost at the boundary.
      const finalBody = combined.slice(0, markerIdx);
      const tail = combined.slice(markerIdx + THINK_CLOSE.length);
      const closed = closeThink(working, acting.id, finalBody);
      return replaceAgent(closed, acting.id, (a) => ({
        ...a,
        tokenCount: ev.tokenCount,
        contentBuffer: tail,
      }));
    }

    case 'agent:tool_call': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      // Force-close any live think block first.
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }

      // Skip timeline entry for non-research agents (synth may also emit tool_calls).
      if (working.agents.get(ev.agentId)?.taskIndex == null) {
        return replaceAgent(working, ev.agentId, (a) => ({
          ...a,
          phase: 'tool',
          toolCallCount: a.toolCallCount + 1,
        }));
      }

      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline(
          {
            ...a,
            phase: 'tool',
            toolCallCount: a.toolCallCount + 1,
            pendingToolCallId: id,
            contentBuffer: '',
          },
          {
            kind: 'tool_call',
            id,
            tool: ev.tool,
            argsSummary: formatArgSummary(ev.tool, ev.args),
          },
        ),
      );
      return { ...next, nextTimelineId: working.nextTimelineId + 1 };
    }

    case 'agent:tool_result': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      if (agent.taskIndex == null) {
        return replaceAgent(state, ev.agentId, (a) => ({ ...a, phase: 'idle' }));
      }

      const summary = summarizeResult(ev.tool, ev.result);
      const id = state.nextTimelineId;
      const hostsUnique = Array.from(new Set(summary.hosts));
      const next = replaceAgent(state, ev.agentId, (a) =>
        pushTimeline(
          { ...a, phase: 'idle', pendingToolCallId: null },
          {
            kind: 'tool_result',
            id,
            tool: ev.tool,
            callId: agent.pendingToolCallId,
            byteLength: ev.result.length,
            preview: summary.preview,
            hosts: hostsUnique,
            resultCount: summary.resultCount,
          },
        ),
      );
      return {
        ...next,
        nextTimelineId: state.nextTimelineId + 1,
        sourceCount: state.sourceCount + hostsUnique.length,
      };
    }

    case 'agent:tool_progress':
      return state;

    case 'agent:report': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      // Force-close any live think (recovery path may bypass </think>).
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }

      if (working.agents.get(ev.agentId)?.taskIndex == null) {
        return replaceAgent(working, ev.agentId, (a) => ({
          ...a,
          phase: 'done',
          contentBuffer: '',
        }));
      }

      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline(
          { ...a, phase: 'done', contentBuffer: '' },
          {
            kind: 'report',
            id,
            body: ev.result,
            tokenCount: a.tokenCount,
          },
        ),
      );
      return { ...next, nextTimelineId: working.nextTimelineId + 1 };
    }

    case 'agent:done': {
      // Do NOT mark the agent `done` here. In the stall-break path,
      // agent:done fires BEFORE recoverInline streams recovery tokens via
      // agent:produce → agent:report. Freezing to `done` would drop those
      // tokens. Force-close any live think (recovery opens a fresh one on
      // its first produce) and step back to `idle` so the produce handler's
      // re-enter-thinking branch fires. Only agent:report marks `done`.
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }
      return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'idle' }));
    }

    case 'agent:tick':
      return {
        ...state,
        pressure: {
          pct: ev.nCtx > 0 ? Math.round((100 * ev.cellsUsed) / ev.nCtx) : 0,
          cellsUsed: ev.cellsUsed,
          nCtx: ev.nCtx,
        },
      };

    default:
      return state;
  }
}
