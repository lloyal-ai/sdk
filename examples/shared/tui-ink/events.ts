/**
 * Event union consumed by the Ink reducer.
 *
 * These mirror the StepEvent variants emitted by examples/deep-research/harness.ts
 * (formerly in examples/deep-research/tui.ts) plus the AgentEvent stream coming
 * from @lloyal-labs/lloyal-agents. The harness continues to emit the same events
 * — only the rendering layer is replaced.
 */

import type { AgentEvent } from '@lloyal-labs/lloyal-agents';
import type { PlanIntent, ResearchTask } from '@lloyal-labs/rig';
import type { OpTiming } from './state';
import type { Config, ConfigOrigin } from './config';

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | {
      type: 'plan';
      intent: PlanIntent;
      tasks: ResearchTask[];
      clarifyQuestions: string[];
      tokenCount: number;
      timeMs: number;
    }
  | { type: 'research:start'; agentCount: number; mode: 'flat' | 'deep' }
  | { type: 'research:done'; totalTokens: number; totalToolCalls: number; timeMs: number }
  | { type: 'fanout:tasks'; tasks: ResearchTask[] }
  | { type: 'spine:task'; taskIndex: number; taskCount: number; description: string }
  | { type: 'spine:source'; taskIndex: number; source: string }
  | { type: 'spine:task:done'; taskIndex: number; stageFindings: number; accumulated: number }
  | { type: 'synthesize:start' }
  | {
      type: 'synthesize:done';
      agentId: number;
      ppl: number;
      tokenCount: number;
      toolCallCount: number;
      timeMs: number;
    }
  | { type: 'verify:start'; count: number; mode: 'flat' | 'deep' }
  | { type: 'verify:done'; count: number; timeMs: number }
  | {
      type: 'eval:done';
      converged: boolean | null;
      tokenCount: number;
      sampleCount: number;
      timeMs: number;
    }
  | { type: 'answer'; text: string }
  | {
      type: 'stats';
      timings: OpTiming[];
      kvLine?: string;
      ctxPct: number;
      ctxPos: number;
      ctxTotal: number;
    }
  | { type: 'complete'; data: Record<string, unknown> }
  // ── UI / config events driven by main.ts ────────────────────────
  | { type: 'config:loaded'; config: Config; origin: ConfigOrigin; path: string }
  | {
      type: 'config:updated';
      config: Config;
      origin: ConfigOrigin;
      savedTo: string;
      gitignored: boolean;
      skipped: string[];
    }
  | { type: 'plan:start'; query: string; mode: 'flat' | 'deep' }
  | { type: 'ui:composer'; prefill?: string }
  | { type: 'ui:plan_review' }
  | { type: 'ui:error'; message: string }
  // ── Boot-phase events: download progress + weight-loading spinner ──
  | { type: 'download:start'; id: string; label: string; sizeBytes: number }
  | { type: 'download:progress'; id: string; got: number; total: number }
  | { type: 'download:complete'; id: string }
  | { type: 'weights:start'; label: string }
  | { type: 'weights:label'; label: string }
  | { type: 'weights:done' };

export type WorkflowEvent = AgentEvent | StepEvent;
