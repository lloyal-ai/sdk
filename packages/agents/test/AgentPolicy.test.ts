import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, defaultToolGuards } from '../src/AgentPolicy';
import type { PolicyConfig } from '../src/AgentPolicy';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

const FMT = {
  format: 0, reasoningFormat: 0, generationPrompt: '',
  parser: '', grammar: '', grammarLazy: false, grammarTriggers: [],
};

const BASE_CONFIG: PolicyConfig = { maxTurns: 20, terminalTool: 'report', hasNonTerminalTools: true };

function makeAgent(overrides?: { toolCallCount?: number; turns?: number; toolHistory?: Array<{ name: string; args: string }> }) {
  const branch = createMockBranch();
  const a = new Agent({ id: 1, parentId: 0, branch: branch as any, fmt: FMT });
  a.transition('active');
  for (let i = 0; i < (overrides?.toolCallCount ?? 0); i++) a.incrementToolCalls();
  for (let i = 0; i < (overrides?.turns ?? 0); i++) a.incrementTurns();
  for (const h of overrides?.toolHistory ?? []) {
    a.recordToolResult({ name: h.name, args: h.args, resultTokenCount: 100, contextAfterPercent: 80, timestamp: 0 });
  }
  return a;
}

function pressure(remaining = 5000, nCtx = 16384) {
  return {
    headroom: remaining - 1024,
    critical: remaining < 128,
    remaining,
    nCtx,
    cellsUsed: nCtx - remaining,
    percentAvailable: nCtx > 0 ? Math.max(0, Math.round((remaining / nCtx) * 100)) : 100,
    canFit: (n: number) => n <= remaining - 1024,
    softLimit: 1024,
    hardLimit: 128,
  };
}

describe('DefaultAgentPolicy', () => {
  const policy = new DefaultAgentPolicy();

  describe('onProduced — no tool call', () => {
    it('returns free_text_report when agent has findings-worthy output', () => {
      const a = makeAgent({ toolCallCount: 2 });
      const action = policy.onProduced(a, { content: 'some text', toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('free_text_report');
    });

    it('returns idle when nothing to capture', () => {
      const a = makeAgent();
      const action = policy.onProduced(a, { content: null, toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('idle');
    });
  });

  describe('onProduced — terminal tool', () => {
    it('extracts findings from report', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'my result' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'report', result: 'my result' });
    });

    it('nudges premature report (< 2 tool calls)', () => {
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('allows report when over budget despite < minToolCalls', () => {
      const a = makeAgent({ toolCallCount: 1, turns: 25 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('report');
    });
  });

  describe('onProduced — JSON parse edge cases', () => {
    it('T7: terminal tool with malformed JSON falls back to raw arguments', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: 'not valid json', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'report', result: 'not valid json' });
    });

    it('T8: tool guard with malformed JSON args proceeds with empty object', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: 'https://example.com' }],
      });
      // Invalid JSON in arguments — guard should still evaluate (with empty args)
      const tc = { name: 'fetch_page', arguments: 'not json', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      // Guard checks url field — with empty args, url is undefined, so guard doesn't reject
      expect(action.type).toBe('tool_call');
    });
  });

  describe('onProduced — over budget', () => {
    it('nudges every time (stateless, no escalation)', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('trailing stop: first over-budget agent nudged, second gets tool_call', () => {
      // Reset trailing stop state by simulating a new tick
      policy.resetTick();
      const a1 = makeAgent({ toolCallCount: 5, turns: 25 });
      const a2 = makeAgent({ toolCallCount: 5, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action1 = policy.onProduced(a1, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      const action2 = policy.onProduced(a2, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
    });
  });

  describe('tool guards', () => {
    it('rejects fetch_page with duplicate URL in lineage', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: JSON.stringify({ url: 'https://example.com' }) }],
      });
      const tc = { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://example.com' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('allows fetch_page with new URL', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: JSON.stringify({ url: 'https://other.com' }) }],
      });
      const tc = { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://example.com' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });

    it('allows web_research without prior tool calls', () => {
      const a = makeAgent({ toolCallCount: 0 });
      const tc = { name: 'web_research', arguments: '{"questions":["q"]}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });
  });

  describe('custom opts', () => {
    it('respects custom minToolCallsBeforeReport', () => {
      const customPolicy = new DefaultAgentPolicy({ minToolCallsBeforeReport: 5 });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: '{"findings":"f"}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('replaces guards with custom guards', () => {
      const customGuard = {
        tools: ['any_tool'],
        reject: () => true,
        message: 'custom rejection',
      };
      const customPolicy = new DefaultAgentPolicy({ guards: [customGuard] });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'any_tool', arguments: '{}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toBe('custom rejection');
    });

    it('appends extraGuards to defaults', () => {
      const extra = {
        tools: ['custom_tool'],
        reject: () => true,
        message: 'extra guard fired',
      };
      const customPolicy = new DefaultAgentPolicy({ extraGuards: [extra] });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'custom_tool', arguments: '{}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toBe('extra guard fired');
    });
  });

  describe('shouldExplore', () => {
    it('returns true when percentAvailable > threshold (default 40)', () => {
      // 5000/16384 ≈ 30.5% → false
      expect(policy.shouldExplore(makeAgent(), pressure(5000))).toBe(false);
      // 8000/16384 ≈ 48.8% → true
      expect(policy.shouldExplore(makeAgent(), pressure(8000))).toBe(true);
    });

    it('respects custom shouldExplore.context threshold', () => {
      const lowThreshold = new DefaultAgentPolicy({ shouldExplore: { context: 0.2 } });
      // 30% > 20% → true
      expect(lowThreshold.shouldExplore(makeAgent(), pressure(5000))).toBe(true);

      const highThreshold = new DefaultAgentPolicy({ shouldExplore: { context: 0.7 } });
      // 48% < 70% → false
      expect(highThreshold.shouldExplore(makeAgent(), pressure(8000))).toBe(false);
    });

    it('setExploitMode(true) overrides to always false', () => {
      const p = new DefaultAgentPolicy();
      const highPressure = pressure(15000); // ~91% available
      expect(p.shouldExplore(makeAgent(), highPressure)).toBe(true);

      p.setExploitMode(true);
      expect(p.shouldExplore(makeAgent(), highPressure)).toBe(false);
    });

    it('setExploitMode(false) reverts to pressure-driven', () => {
      const p = new DefaultAgentPolicy();
      p.setExploitMode(true);
      expect(p.shouldExplore(makeAgent(), pressure(15000))).toBe(false);

      p.setExploitMode(false);
      expect(p.shouldExplore(makeAgent(), pressure(15000))).toBe(true);
    });

    it('nCtx=0 → percentAvailable=100 → explore', () => {
      // When nCtx is 0, remaining=Infinity, percentAvailable=100
      const noLimit = pressure(Infinity, 0);
      expect(noLimit.percentAvailable).toBe(100);
      expect(policy.shouldExplore(makeAgent(), noLimit)).toBe(true);
    });

    it('nCtx=0 → canFit always true (Infinity chain)', () => {
      const noLimit = pressure(Infinity, 0);
      expect(noLimit.headroom).toBe(Infinity);
      expect(noLimit.canFit(999999)).toBe(true);
      expect(noLimit.critical).toBe(false);
    });
  });

  describe('shouldExit', () => {
    it('returns false when pressure not critical', () => {
      expect(policy.shouldExit(makeAgent(), pressure(5000))).toBe(false);
    });

    it('returns true when pressure critical', () => {
      expect(policy.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });

    it('no time budget → only pressure checked', () => {
      const p = new DefaultAgentPolicy(); // no budget
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(false);
      expect(p.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });

    it('time hardLimit exceeded → returns true', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 0 } } }); // 0ms = instant
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(true);
    });

    it('time hardLimit not exceeded → returns false', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 999_999 } } });
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(false);
    });

    it('pressure OK + time exceeded → exit', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 0 } } });
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(true);
    });

    it('pressure critical + time OK → exit', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 999_999 } } });
      expect(p.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });
  });

  describe('onRecovery', () => {
    it('returns skip when no recovery config', () => {
      const result = policy.onRecovery(makeAgent({ toolCallCount: 5 }));
      expect(result).toEqual({ type: 'skip' });
    });

    it('returns skip when tokenCount < minTokens', () => {
      const p = new DefaultAgentPolicy({ recovery: { prompt: { system: 's', user: 'u' }, minTokens: 200 } });
      const a = makeAgent({ toolCallCount: 5 }); // tokenCount=0 < 200
      expect(p.onRecovery(a)).toEqual({ type: 'skip' });
    });

    it('returns skip when toolCallCount < minToolCalls', () => {
      const p = new DefaultAgentPolicy({ recovery: { prompt: { system: 's', user: 'u' }, minToolCalls: 5 } });
      const a = makeAgent({ toolCallCount: 2 }); // 2 < 5
      expect(p.onRecovery(a)).toEqual({ type: 'skip' });
    });

    it('returns extract with prompt when guard passes', () => {
      const prompt = { system: 'extract findings', user: 'report now' };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      const a = makeAgent({ toolCallCount: 3 });
      // Need tokenCount >= 100 — manually set via accumulating tokens
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      // Prompt strings contain no eta tags → render returns them unchanged.
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'extract', prompt });
    });

    it('custom minTokens/minToolCalls respected', () => {
      const prompt = { system: 's', user: 'u' };
      const p = new DefaultAgentPolicy({ recovery: { prompt, minTokens: 10, minToolCalls: 1 } });
      const a = makeAgent({ toolCallCount: 1 });
      for (let i = 0; i < 11; i++) a.accumulateToken('x');
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'extract', prompt });
    });

    it('defaults: minTokens=100, minToolCalls=2', () => {
      const prompt = { system: 's', user: 'u' };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      // toolCallCount=1 < default 2 → skip
      const a = makeAgent({ toolCallCount: 1 });
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'skip' });
    });

    it('renders <%= it.budget %> with the computed word budget', () => {
      const prompt = {
        system: 'Budget: <%= it.budget %> words.',
        user: 'Report within <%= it.budget %>.',
      };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      const a = makeAgent({ toolCallCount: 3 });
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      // pressure(remaining=5000) → budgetTokens = max(50, 5000-150-512) = 4338
      // → words = floor(4338 * 0.7 / 10) * 10 = 3030
      const result = p.onRecovery(a, pressure() as any) as { type: 'extract'; prompt: { system: string; user: string } };
      expect(result.type).toBe('extract');
      expect(result.prompt.system).toBe('Budget: 3030 words.');
      expect(result.prompt.user).toBe('Report within 3030.');
    });
  });

  describe('onSettleReject', () => {
    it('nudges with message when terminal tool + toolCallCount > 0', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const action = policy.onSettleReject(a, 5000, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Tool result too large');
    });

    it('returns idle when no terminal tool', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const config = { maxTurns: 20, hasNonTerminalTools: true };
      const action = policy.onSettleReject(a, 5000, pressure(), config);
      expect(action.type).toBe('idle');
    });

    it('returns idle when toolCallCount === 0', () => {
      const a = makeAgent({ toolCallCount: 0 });
      const action = policy.onSettleReject(a, 5000, pressure(), BASE_CONFIG);
      expect(action.type).toBe('idle');
    });

    it('nudge message matches expected string (includes budget in words)', () => {
      const a = makeAgent({ toolCallCount: 2 });
      // pressure(remaining=5000, hardLimit=128) → budgetTokens = 4872
      // budgetTokens → words: floor(4872 * 0.7 / 10) * 10 = floor(341.04) * 10 = 3410
      const action = policy.onSettleReject(a, 5000, pressure(), BASE_CONFIG);
      expect(action).toEqual({
        type: 'nudge',
        message: 'Tool result too large for remaining KV. Report your findings now within 3410 words.',
      });
    });
  });

  describe('budget + pressureThresholds', () => {
    it('no budget → pressureThresholds returns defaults', () => {
      // hardLimit default is 512 (matches llama.cpp's default nBatch —
      // enforced at pool startup via the hardLimit >= nBatch invariant).
      expect(policy.pressureThresholds).toEqual({ softLimit: 1024, hardLimit: 512 });
    });

    it('budget.context.softLimit overrides default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } });
      expect(p.pressureThresholds.softLimit).toBe(2048);
      expect(p.pressureThresholds.hardLimit).toBe(512); // default
    });

    it('budget.context.hardLimit overrides default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { hardLimit: 1024 } } });
      expect(p.pressureThresholds.hardLimit).toBe(1024);
      expect(p.pressureThresholds.softLimit).toBe(1024); // default
    });

    it('partial budget → other uses default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } });
      expect(p.pressureThresholds).toEqual({ softLimit: 2048, hardLimit: 512 });
    });

    it('pressureThresholds getter returns correct shape', () => {
      const pt = policy.pressureThresholds;
      expect(pt).toHaveProperty('softLimit');
      expect(pt).toHaveProperty('hardLimit');
      expect(typeof pt.softLimit).toBe('number');
      expect(typeof pt.hardLimit).toBe('number');
    });
  });

  describe('onProduced: guard-check before budget-check ordering', () => {
    // Regression for trace-1776819196054 agent 65539: over-budget agent
    // repeatedly emitting a duplicate query only saw turn-limit nudges
    // because `_isOverBudget` was checked before `_checkGuards`. Post-fix,
    // the guard's specific message (e.g. "already searched") wins — giving
    // the model actionable feedback instead of generic "report now".
    it('duplicate query + over maxTurns → guard message wins, not budget nudge', () => {
      const p = new DefaultAgentPolicy({
        terminalTool: 'report',
        extraGuards: [{
          tools: ['web_search'],
          reject: () => true,  // always reject — simulates duplicate-query match
          message: 'This query was already searched. Refine your search or report findings.',
        }],
      });
      // Agent is PAST maxTurns (20 >= 10) — _isOverBudget would fire.
      const a = makeAgent({ toolCallCount: 5, turns: 20 });
      const tc = { name: 'web_search', arguments: '{"query":"same"}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toBe('This query was already searched. Refine your search or report findings.');
      // Specifically NOT the turn-limit message
      expect((action as any).message).not.toContain('Turn limit');
      expect((action as any).message).not.toContain('within');
    });

    it('no guard rejection + over maxTurns → budget nudge fires as before', () => {
      // Sanity: when guards don't reject, the budget path still fires.
      const p = new DefaultAgentPolicy({ terminalTool: 'report' });
      const a = makeAgent({ toolCallCount: 5, turns: 20 });
      const tc = { name: 'web_search', arguments: '{"query":"unique"}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Turn limit');
    });
  });

  describe('time budget in onProduced', () => {
    it('no time budget → overBudget driven by turns/headroom', () => {
      policy.resetTick();
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Turn limit');
    });

    it('time softLimit exceeded → nudge with time message', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } }); // 0ms = instant
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Time limit');
    });

    it('time softLimit not exceeded → no time nudge', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 999_999 } } });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });

    it('time nudge message distinct from pressure/turns (includes budget in words)', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // pressure(remaining=5000, hardLimit=128) → budgetTokens = 4872
      // → words = floor(4872 * 0.7 / 10) * 10 = 3410
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect((action as any).message).toBe('Time limit reached — report your findings now within 3410 words.');
    });
  });

  describe('underPressure / overBudget split', () => {
    it('underPressure + terminal tool → report accepted despite < minToolCalls', () => {
      const a = makeAgent({ toolCallCount: 1, turns: 25 }); // turns >= maxTurns
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('report');
    });

    it('underPressure (time) + terminal tool → report accepted', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } });
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('report');
    });

    it('not underPressure + terminal tool + < minToolCalls → premature nudge', () => {
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('must use tools');
    });

    it('underPressure + non-terminal tool → overBudget → nudge (first agent)', () => {
      // Reset trailing stop state by simulating a new tick
      policy.resetTick();
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });
  });

  describe('trailing stop nudge', () => {
    it('nudges first agent, lets subsequent agents tool_call (no escalation)', () => {
      // Reset state
      policy.resetTick();
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // First agent — nudged
      const a1 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action1 = policy.onProduced(a1, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      // Second agent — tool_call (trailing stop, not killed)
      const a2 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action2 = policy.onProduced(a2, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
      // Third agent — also tool_call
      const a3 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action3 = policy.onProduced(a3, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action3.type).toBe('tool_call');
    });

    it('headroom recovers → tool_call allowed', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 5 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // Over budget (headroom negative) — first nudge
      policy.resetTick(); // reset
      const lowPressure = pressure(500); // headroom = 500 - 1024 = -524
      const action1 = policy.onProduced(a, { content: null, toolCalls: [tc] }, lowPressure, BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      // Headroom recovers
      const highPressure = pressure(5000); // headroom = 3976
      const action2 = policy.onProduced(a, { content: null, toolCalls: [tc] }, highPressure, BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
    });

    it('no nudged/markNudged in agent API', () => {
      const a = makeAgent();
      expect('nudged' in a).toBe(false);
      expect('markNudged' in a).toBe(false);
    });
  });
});
