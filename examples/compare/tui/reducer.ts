/**
 * Pure reducer over compare TUI events.
 *
 * Topology is seeded once on `dag:topology`. Subsequent events route to a
 * specific node either by id (`dag:node:spawn`) or by `agentId → nodeId`
 * lookup (all `agent:*` events).
 *
 * Tail buffer is bounded — the latest line gets appended/extended; once
 * we exceed TAIL_MAX_LINES we drop from the front.
 */

import type { WorkflowEvent } from './events';
import type { AppState, NodeRuntime, Topology } from './state';
import { initialState } from './state';

const TAIL_MAX_LINES = 6;
/** Hard cap on tail line length so a long tool result chip can't blow out the card. */
const TAIL_LINE_MAX = 240;

export function reduce(state: AppState, ev: WorkflowEvent): AppState {
  switch (ev.type) {
    case 'dag:topology':
      return seedTopology(state, ev.nodes, ev.t0Ms);

    case 'dag:node:spawn': {
      const node = state.nodes.get(ev.id);
      if (!node) return state;
      const next = new Map(state.nodes);
      next.set(ev.id, {
        ...node,
        status: 'running',
        agentId: ev.agentId,
        startMs: ev.tMs,
      });
      const agentToNode = new Map(state.agentToNode);
      agentToNode.set(ev.agentId, ev.id);
      return { ...state, nodes: next, agentToNode, nowMs: ev.tMs };
    }

    case 'agent:produce': {
      const nodeId = state.agentToNode.get(ev.agentId);
      if (!nodeId) return state;
      const node = state.nodes.get(nodeId);
      if (!node) return state;
      // `tokenCount` is the agent's running total (not a delta) — see
      // packages/agents/src/agent-pool.ts:1002-1008. Replace, don't sum.
      const newTokens = ev.tokenCount ?? node.tokens;
      const delta = Math.max(0, newTokens - node.tokens);
      const next = new Map(state.nodes);
      next.set(nodeId, {
        ...node,
        tail: appendTail(node.tail, ev.text),
        tokens: newTokens,
        charsProduced: node.charsProduced + ev.text.length,
      });
      return {
        ...state,
        nodes: next,
        totalTokens: state.totalTokens + delta,
      };
    }

    case 'agent:tool_call': {
      const nodeId = state.agentToNode.get(ev.agentId);
      if (!nodeId) return state;
      const node = state.nodes.get(nodeId);
      if (!node) return state;
      const next = new Map(state.nodes);
      const argsPreview = previewArgs(ev.args);
      const chip = `→ ${ev.tool}${argsPreview ? ' ' + argsPreview : ''}`;
      next.set(nodeId, {
        ...node,
        toolCalls: node.toolCalls + 1,
        lastTool: ev.tool,
        // Tool-call chips replace whatever streaming line was in flight —
        // they're a clean break in the body.
        tail: pushTail(node.tail, chip),
      });
      return {
        ...state,
        nodes: next,
        totalToolCalls: state.totalToolCalls + 1,
      };
    }

    case 'agent:tool_result': {
      const nodeId = state.agentToNode.get(ev.agentId);
      if (!nodeId) return state;
      const node = state.nodes.get(nodeId);
      if (!node) return state;
      const preview = ev.result.split('\n')[0]?.slice(0, TAIL_LINE_MAX) ?? '';
      const next = new Map(state.nodes);
      next.set(nodeId, {
        ...node,
        tail: pushTail(node.tail, `← ${preview}`),
      });
      return { ...state, nodes: next };
    }

    case 'agent:report': {
      const nodeId = state.agentToNode.get(ev.agentId);
      if (!nodeId) return state;
      const node = state.nodes.get(nodeId);
      if (!node) return state;
      const next = new Map(state.nodes);
      const endMs = state.nowMs > 0 ? state.nowMs : performance.now();
      next.set(nodeId, {
        ...node,
        status: 'done',
        endMs,
        reportChars: ev.result.length,
      });

      // If this is the unique sink (no node depends on no-one downstream),
      // its result is the final answer.
      const isSink = state.topology
        ? !state.topology.edges.some(([from]) => from === nodeId)
        : false;
      const finalAnswer = isSink ? ev.result : state.finalAnswer;

      return { ...state, nodes: next, finalAnswer };
    }

    case 'agent:done':
      return state;

    case 'agent:tick':
      return {
        ...state,
        nowMs: performance.now(),
        kvCellsUsed: ev.cellsUsed,
        kvNCtx: ev.nCtx,
      };

    case 'compare:error':
      return {
        ...state,
        fatalError: { message: ev.message, stack: ev.stack },
      };

    default:
      return state;
  }
}

function seedTopology(
  state: AppState,
  nodes: { id: string; dependsOn: string[] }[],
  t0Ms: number,
): AppState {
  const layers = topoLayers(nodes);
  const edges: [string, string][] = [];
  for (const n of nodes) {
    for (const d of n.dependsOn) edges.push([d, n.id]);
  }
  const topology: Topology = { layers, edges };

  // Insert nodes in topo (layer-major) order so iterating the Map
  // produces a consistent rendering order.
  const map = new Map<string, NodeRuntime>();
  let colorIdx = 0;
  for (const layer of layers) {
    for (const id of layer) {
      const decl = nodes.find((n) => n.id === id)!;
      map.set(id, {
        id,
        dependsOn: decl.dependsOn,
        colorIndex: colorIdx++,
        status: 'pending',
        tail: [],
        toolCalls: 0,
        tokens: 0,
        charsProduced: 0,
      });
    }
  }

  return {
    ...initialState,
    t0Ms,
    nowMs: t0Ms,
    nodes: map,
    topology,
  };
}

/** Topological layering: layer(n) = max(layer(d) for d in deps) + 1. */
function topoLayers(nodes: { id: string; dependsOn: string[] }[]): string[][] {
  const layerOf = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  function computeLayer(id: string, stack: string[]): number {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (stack.includes(id)) {
      throw new Error(`compare: cycle detected: ${[...stack, id].join(' -> ')}`);
    }
    const n = byId.get(id);
    if (!n) throw new Error(`compare: unknown node id ${id}`);
    const deps = n.dependsOn;
    const layer = deps.length === 0
      ? 0
      : Math.max(...deps.map((d) => computeLayer(d, [...stack, id]))) + 1;
    layerOf.set(id, layer);
    return layer;
  }
  for (const n of nodes) computeLayer(n.id, []);
  const maxLayer = Math.max(...layerOf.values());
  const out: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  // Preserve declaration order within a layer.
  for (const n of nodes) out[layerOf.get(n.id)!].push(n.id);
  return out;
}

/** Append text to the tail buffer. Newlines split into separate lines.
 *  The last existing line absorbs leading text up to the first newline. */
function appendTail(tail: string[], text: string): string[] {
  if (text.length === 0) return tail;
  const lines = text.split('\n');
  const next = [...tail];
  if (next.length === 0) {
    next.push('');
  }
  // Extend the last line with the first chunk.
  next[next.length - 1] = (next[next.length - 1] + lines[0]).slice(0, TAIL_LINE_MAX);
  for (let i = 1; i < lines.length; i++) {
    next.push(lines[i].slice(0, TAIL_LINE_MAX));
  }
  while (next.length > TAIL_MAX_LINES) next.shift();
  return next;
}

/** Push a complete line as its own tail entry (used for tool chips). */
function pushTail(tail: string[], line: string): string[] {
  const next = [...tail, line.slice(0, TAIL_LINE_MAX)];
  while (next.length > TAIL_MAX_LINES) next.shift();
  return next;
}

function previewArgs(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs);
    if (typeof parsed === 'string') return JSON.stringify(parsed);
    if (parsed && typeof parsed === 'object') {
      const first = Object.entries(parsed)[0];
      if (!first) return '';
      const [k, v] = first;
      const vs = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${truncate(vs, 40)}`;
    }
    return '';
  } catch {
    return truncate(rawArgs, 40);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
