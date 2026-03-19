import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';

/**
 * Create matched `scope:open` / `scope:close` pairs for building the trace tree
 *
 * Opens a named scope immediately and returns a handle to close it later.
 * The close callback emits a `scope:close` event with the elapsed duration
 * and flushes the writer, ensuring scope boundaries are always persisted.
 *
 * Used throughout the runtime to bracket agent pools, tool dispatches,
 * shared-root regions, and generation passes.
 *
 * @param writer - Active {@link TraceWriter} to emit events to
 * @param parentTraceId - Trace ID of the enclosing scope, or `null` for root scopes
 * @param name - Human-readable scope label (e.g. `"pool"`, `"tool:search"`)
 * @param meta - Optional key-value metadata attached to the `scope:open` event
 * @returns Object with the allocated `traceId` and a `close` callback
 *
 * @category Agents
 */
export function traceScope(
  writer: TraceWriter,
  parentTraceId: TraceId | null,
  name: string,
  meta?: Record<string, unknown>,
): { traceId: TraceId; close: () => void } {
  const traceId = writer.nextId();
  const ts = performance.now();
  writer.write({
    traceId, parentTraceId, ts,
    type: 'scope:open', name, meta,
  });
  return {
    traceId,
    close() {
      writer.write({
        traceId: writer.nextId(), parentTraceId: traceId,
        ts: performance.now(),
        type: 'scope:close', name, durationMs: performance.now() - ts,
      });
      writer.flush();
    },
  };
}
