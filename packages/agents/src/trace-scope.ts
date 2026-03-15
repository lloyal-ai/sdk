import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';

/** Create matched scope:open / scope:close pairs for building the trace tree */
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
