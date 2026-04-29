/**
 * Braille spinner frames used by every waiting indicator in the examples —
 * Ink's <PlanningSpinner>, <Verify>, and any pre-Ink stderr spinners. One
 * array, one look.
 *
 * Plain TypeScript (no Ink, no Effection) so CJS and ESM callers can both
 * import it without dragging heavy deps into the wrong module graph.
 */

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** ~80ms per frame = ~12 FPS, slow enough not to tax terminals, fast enough
 *  that users feel movement. Matches Ink's useInterval usage in the React
 *  spinners. */
export const SPINNER_TICK_MS = 80;
