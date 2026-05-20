/**
 * Tests for the framework-injected scope-guard — RFC §3.2 M2 / §5.3c.
 *
 * The scope-guard runs inside `DefaultAgentPolicy.onProduced` ahead of
 * the dedup guards and rejects any tool call whose name is not in the
 * spawn's `agent.allowedTools` list. Tests verify:
 *
 * 1. **In-scope calls pass through.** A `tool_call` action emerges
 *    unmodified when the call's name is in `allowedTools`.
 * 2. **Out-of-scope calls reject with `guard: 'scope_reject'`.** The
 *    returned `nudge` action carries the canonical scope-reject message
 *    and the `guard` discriminant used by the pool to route the
 *    `tool:scopeReject` trace event.
 * 3. **Unscoped spawns (`allowedTools: null`) are unaffected.** Legacy
 *    harness-internal spawns whose `Agent.allowedTools` is `null`
 *    receive the existing pre-scope-guard behavior.
 * 4. **Scope-guard fires BEFORE the dedup guards.** A duplicate
 *    `web_search` call from an agent whose contract excludes
 *    `web_search` returns the scope-reject message, NOT the dedup
 *    message — security observability over dedup observability.
 * 5. **`'*'` ToolGuard matches every call.** Confirms the new
 *    `tools: '*'` matcher works alongside the legacy `string[]` path.
 *
 * Together these lock the M2 invariant: dispatch-time scope rejection
 * is OBSERVABLE (distinct `guard` value) and STRICT (no
 * silent-passthrough fallback even if the call would also be rejected
 * by a dedup guard).
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, type PolicyConfig, type ToolGuard } from '../src/AgentPolicy';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

const FMT = {
  format: 0,
  reasoningFormat: 0,
  generationPrompt: '',
  parser: '',
  grammar: '',
  grammarLazy: false,
  grammarTriggers: [],
};

const BASE_CONFIG: PolicyConfig = {
  maxTurns: 20,
  terminalToolName: 'report',
  hasNonTerminalTools: true,
};

function makeAgent(opts: {
  allowedTools?: readonly string[] | null;
  assignedApp?: string | null;
  toolHistory?: Array<{ name: string; args: string }>;
}) {
  const branch = createMockBranch();
  const agent = new Agent({
    id: 1,
    parentId: 0,
    branch: branch as never,
    fmt: FMT,
    allowedTools: opts.allowedTools ?? null,
    assignedApp: opts.assignedApp ?? null,
  });
  agent.transition('active');
  for (const h of opts.toolHistory ?? []) {
    agent.recordToolResult({
      name: h.name,
      args: h.args,
      resultTokenCount: 100,
      contextAfterPercent: 80,
      timestamp: 0,
    });
  }
  return agent;
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

function tc(name: string, args: Record<string, unknown> = {}) {
  return { name, arguments: JSON.stringify(args) };
}

describe('scope-guard (default ToolGuard)', () => {
  it('lets in-scope tool calls through as tool_call actions', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({
      allowedTools: ['web_search', 'fetch_page'],
      assignedApp: 'web',
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('web_search', { query: 'hello' })] },
      pressure(),
      BASE_CONFIG,
    );
    expect(action.type).toBe('tool_call');
  });

  it('rejects out-of-scope tool calls with guard=scope_reject', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({
      allowedTools: ['web_search', 'fetch_page'],
      assignedApp: 'web',
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('bank_transfer', { to: 'attacker' })] },
      pressure(),
      BASE_CONFIG,
    );
    expect(action).toMatchObject({
      type: 'nudge',
      guard: 'scope_reject',
    });
    expect((action as { message: string }).message).toMatch(/not in scope/i);
  });

  it('is a no-op for unscoped spawns (Agent.allowedTools === null)', () => {
    const policy = new DefaultAgentPolicy();
    const unscoped = makeAgent({ allowedTools: null });
    const action = policy.onProduced(
      unscoped,
      { content: null, toolCalls: [tc('arbitrary_tool', {})] },
      pressure(),
      BASE_CONFIG,
    );
    // No scope means the scope-guard does not fire — call proceeds as
    // tool_call. (Other guards may still reject for unrelated reasons,
    // but no scope_reject nudge.)
    expect(action.type).toBe('tool_call');
  });

  it('fires BEFORE dedup guards — duplicate out-of-scope call reports scope_reject, not dup', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({
      allowedTools: ['fetch_page'],
      assignedApp: 'web',
      // Prior duplicate web_search in history would dedup-reject if scope
      // didn't fire first.
      toolHistory: [{ name: 'web_search', args: JSON.stringify({ query: 'foo' }) }],
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('web_search', { query: 'foo' })] },
      pressure(),
      BASE_CONFIG,
    );
    expect(action).toMatchObject({ type: 'nudge', guard: 'scope_reject' });
  });

  it('empty allowedTools rejects every non-terminal call', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({
      allowedTools: [],
      assignedApp: 'locked',
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('web_search', { query: 'x' })] },
      pressure(),
      BASE_CONFIG,
    );
    expect(action).toMatchObject({ type: 'nudge', guard: 'scope_reject' });
  });

  it('terminal tool call still routes to return regardless of scope', () => {
    const policy = new DefaultAgentPolicy({ minToolCallsBeforeReturn: 0 });
    // Note: terminal tool dispatch is checked before _checkGuards in
    // onProduced, so the scope-guard doesn't gate report. This locks the
    // ordering: agents can always submit findings even if their contract
    // doesn't include `report` (the harness-orchestrated terminal tool
    // is owned by the framework, not the App).
    const agent = makeAgent({
      allowedTools: ['web_search'],
      assignedApp: 'web',
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('report', { result: 'findings' })] },
      pressure(),
      BASE_CONFIG,
    );
    expect(action.type).toBe('return');
  });
});

describe('ToolGuard "*" matcher', () => {
  it('a tools: "*" guard sees every tool call', () => {
    const seen: string[] = [];
    const allCallsGuard: ToolGuard = {
      name: 'audit',
      tools: '*',
      reject: (_args, _hist, _agent, toolName) => {
        seen.push(toolName);
        return false;
      },
      message: 'unused',
    };
    const policy = new DefaultAgentPolicy({
      extraGuards: [allCallsGuard],
    });
    const agent = makeAgent({ allowedTools: null });
    policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('alpha')] },
      pressure(),
      BASE_CONFIG,
    );
    policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('beta')] },
      pressure(),
      BASE_CONFIG,
    );
    expect(seen).toEqual(['alpha', 'beta']);
  });

  it('a tools: "*" guard can reject any call', () => {
    const policy = new DefaultAgentPolicy({
      extraGuards: [
        {
          name: 'blanket',
          tools: '*',
          reject: () => true,
          message: 'all calls blocked',
        },
      ],
    });
    const agent = makeAgent({ allowedTools: null });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('whatever')] },
      pressure(),
      BASE_CONFIG,
    );
    // The default scope-guard is no-op (allowedTools=null), so this
    // extra guard wins.
    expect(action).toMatchObject({
      type: 'nudge',
      guard: 'blanket',
      message: 'all calls blocked',
    });
  });
});
