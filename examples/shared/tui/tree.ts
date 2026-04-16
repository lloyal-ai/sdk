import { c } from './primitives';

/**
 * Tree-drawing glyphs wrapped in ANSI dim formatting. Used by TUI handlers
 * to render the agent tool-call tree, section dividers, and streaming-report
 * boundary prefixes consistently. Grouping these in one place prevents
 * styling drift across handlers and documents the tree vocabulary.
 */
export const tree = {
  trunk: `${c.dim}│${c.reset}`,   // vertical continuation
  branch: `${c.dim}├${c.reset}`,  // content node along a trunk
  leaf: `${c.dim}└${c.reset}`,    // last node on a trunk
  stem: `${c.dim}├──${c.reset}`,  // labeled branch header
  tail: `${c.dim}└──${c.reset}`,  // labeled last header
  arrow: `${c.dim}←${c.reset}`,   // tool-result indicator
};

export const bullet = `${c.green}●${c.reset}`;
export const section = (title: string): string =>
  `\n  ${bullet} ${c.bold}${title}${c.reset}`;
