/**
 * Tests for rig-resident tool construction.
 *
 * Tools are plain synchronous classes constructed with `new` (no factory
 * wrappers — those would be `new` synonyms). `reportTool` is a shared
 * stateless singleton used as the conventional terminal. Deep execution
 * (`DelegateTool` spawns a pool; `PlanTool` generates against a Session)
 * is model-dependent and covered by the §10.3 routing-equivalence gate,
 * not here — these tests lock construction + identity + schema shape.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { ReportTool } from '../src/tools/report';
import { DelegateTool } from '../src/tools/delegate';
import { PlanTool } from '../src/tools/plan';
import { reportTool } from '../src/tools';

describe('reportTool singleton', () => {
  it('is a ReportTool named "report" with a required result param', () => {
    expect(reportTool).toBeInstanceOf(ReportTool);
    expect(reportTool.name).toBe('report');
    expect(reportTool.parameters.required).toEqual(['result']);
    expect(reportTool.parameters.properties).toHaveProperty('result');
  });

  it('is a shared instance (reused across pools)', async () => {
    const again = (await import('../src/tools')).reportTool;
    expect(again).toBe(reportTool);
  });
});

describe('new ReportTool(opts)', () => {
  it('honors description overrides for the custom case', () => {
    const tool = new ReportTool({
      description: 'custom report desc',
      resultDescription: 'custom result desc',
    });
    expect(tool.description).toBe('custom report desc');
    const props = tool.parameters.properties as { result: { description: string } };
    expect(props.result.description).toBe('custom result desc');
  });
});

describe('new DelegateTool(opts)', () => {
  it('defaults to name "delegate" with a tasks schema', () => {
    const tool = new DelegateTool({ poolOpts: {}, systemPrompt: 'sys' });
    expect(tool.name).toBe('delegate');
    expect(tool.parameters.required).toEqual(['tasks']);
  });

  it('honors a custom name', () => {
    const tool = new DelegateTool({ name: 'fanout', poolOpts: {}, systemPrompt: 'sys' });
    expect(tool.name).toBe('fanout');
  });
});

describe('new PlanTool(opts)', () => {
  const fakeSession = {} as never;

  it('is named "plan" with a required query param', () => {
    const tool = new PlanTool({
      prompt: { system: 's', user: 'u' },
      session: fakeSession,
      maxQuestions: 5,
    });
    expect(tool.name).toBe('plan');
    expect(tool.parameters.required).toEqual(['query']);
  });

  it('accepts availableApps without throwing (grammar-constrained task.app)', () => {
    const apps = [
      { manifest: { contract: { name: 'web_research' } } },
      { manifest: { contract: { name: 'corpus_search' } } },
    ] as never[];
    const tool = new PlanTool({
      prompt: { system: 's', user: 'u' },
      session: fakeSession,
      maxQuestions: 5,
      availableApps: apps,
    });
    expect(tool).toBeInstanceOf(PlanTool);
  });
});
