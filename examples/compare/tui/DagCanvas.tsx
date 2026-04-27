/**
 * Topology-aware canvas. Lays cards out by topological layer and draws
 * orthogonal edges between consecutive layers.
 *
 * Layout math:
 *   - cardW = floor((cols - (maxLayerSize + 1)) / maxLayerSize)
 *   - per-layer card center column = gutter + i * (cardW + gutter) + cardW/2
 *
 * For each adjacent layer pair, we render an EdgeRow (3 text lines) with
 * the parent and child center columns. Edge endpoints stay aligned with
 * card-bottom and card-top centers because cards are flexShrink=0 and
 * have explicit widths.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AppState, NodeRuntime } from './state';
import { AgentCard } from './AgentCard';
import { EdgeRow, type EdgeEndpoint } from './EdgeRow';

const GUTTER = 1;
const MIN_CARD_WIDTH = 28;
const MAX_CARD_WIDTH = 56;
const BODY_HEIGHT = 6;

export interface DagCanvasProps {
  state: AppState;
  cols: number;
  /** Map from node id → human source label (e.g. "web", "corpus"). Optional. */
  sourceLabels?: Record<string, string>;
}

export const DagCanvas: React.FC<DagCanvasProps> = ({ state, cols, sourceLabels = {} }) => {
  if (!state.topology) {
    return <Text dimColor>Waiting for topology…</Text>;
  }
  const { layers } = state.topology;
  const maxLayerSize = Math.max(...layers.map((l) => l.length));
  // Reserve a 4-col safety margin so the rightmost card doesn't get clipped
  // by Ink's last-column write-then-newline behavior.
  const safetyMargin = 4;
  const usableCols = Math.max(MIN_CARD_WIDTH * maxLayerSize, cols - safetyMargin);
  const cardW = Math.min(
    MAX_CARD_WIDTH,
    Math.max(
      MIN_CARD_WIDTH,
      Math.floor((usableCols - GUTTER * (maxLayerSize + 1)) / maxLayerSize),
    ),
  );

  // Total canvas width in columns — used for centering layers and for the
  // edge router's coordinate space.
  const canvasW = (cardW + GUTTER) * maxLayerSize + GUTTER;

  // Compute card center cols per layer. The center of card i in a layer
  // of N cards = leftPad + i * (cardW + GUTTER) + cardW/2, where leftPad
  // centers the layer if it has fewer cards than the widest layer.
  function centersFor(layerIds: string[]): number[] {
    const n = layerIds.length;
    const usedW = n * cardW + (n - 1) * GUTTER;
    const leftPad = Math.floor((canvasW - usedW) / 2);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(leftPad + i * (cardW + GUTTER) + Math.floor(cardW / 2));
    }
    return out;
  }

  const elements: React.ReactNode[] = [];
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const centers = centersFor(layer);
    elements.push(<LayerRow key={`layer-${li}`} layer={layer} state={state} cardW={cardW} canvasW={canvasW} centers={centers} sourceLabels={sourceLabels} nowMs={state.nowMs} />);

    if (li < layers.length - 1) {
      const nextLayer = layers[li + 1];
      const nextCenters = centersFor(nextLayer);
      const parents: EdgeEndpoint[] = layer.map((id, i) => ({ id, col: centers[i] }));
      const children: EdgeEndpoint[] = nextLayer.map((id, i) => ({ id, col: nextCenters[i] }));
      const edges = state.topology.edges.filter(([from, to]) =>
        layer.includes(from) && nextLayer.includes(to),
      );
      elements.push(
        <EdgeRow key={`edges-${li}`} parents={parents} children={children} edges={edges} width={canvasW} />,
      );
    }
  }

  return <Box flexDirection="column">{elements}</Box>;
};

const LayerRow: React.FC<{
  layer: string[];
  state: AppState;
  cardW: number;
  canvasW: number;
  centers: number[];
  sourceLabels: Record<string, string>;
  nowMs: number;
}> = ({ layer, state, cardW, centers, sourceLabels, nowMs }) => {
  // Card centers were already chosen; turn them into per-card left-pads.
  // Use empty <Box width=N flexShrink=0/> as spacers so they survive flex
  // layout (Text spacers between Box siblings get clipped).
  const items: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < layer.length; i++) {
    const id = layer[i];
    const node = state.nodes.get(id);
    if (!node) continue;
    const cardLeft = centers[i] - Math.floor(cardW / 2);
    const gap = Math.max(0, cardLeft - cursor);
    if (gap > 0) {
      items.push(<Box key={`gap-${i}`} width={gap} flexShrink={0} />);
    }
    items.push(
      <AgentCard
        key={id}
        node={node as NodeRuntime}
        width={cardW}
        bodyHeight={BODY_HEIGHT}
        nowMs={nowMs}
        sourceLabel={sourceLabels[id]}
      />,
    );
    cursor = cardLeft + cardW;
  }
  return <Box flexDirection="row">{items}</Box>;
};
