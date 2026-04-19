import type { TraceEvent, TraceId } from './trace-types';

/**
 * Sink for structured trace events emitted by the agent runtime
 *
 * Implementations receive every {@link TraceEvent} produced during agent
 * execution. The runtime reads the active writer from the {@link Trace}
 * Effection context (set by {@link initAgents}).
 *
 * All methods must be synchronous and must not throw — tracing is
 * best-effort and must never disrupt agent execution.
 *
 * @category Agents
 */
export interface TraceWriter {
  /** Write a trace event. Must not throw. */
  write(event: TraceEvent): void;
  /** Allocate a new trace ID. Monotonically increasing. */
  nextId(): TraceId;
  /** Flush pending writes. Called at scope boundaries. */
  flush(): void;
}

/**
 * No-op trace writer — zero cost when tracing is disabled
 *
 * Default writer set by {@link initAgents} when no trace file is
 * configured. Every method is a no-op; {@link nextId} always returns 0.
 *
 * @category Agents
 */
export class NullTraceWriter implements TraceWriter {
  nextId(): TraceId { return 0; }
  write(_event: TraceEvent): void {}
  flush(): void {}
}

/**
 * JSONL file writer — one JSON object per line, buffered sync writes
 *
 * Buffers up to 64 events in memory before flushing to the underlying
 * file descriptor with `fs.writeSync`. Flush also occurs at every
 * {@link traceScope} close boundary to guarantee scope pairs are
 * persisted promptly.
 *
 * Construct with an open file descriptor (e.g. from `fs.openSync`).
 * Write failures are silently swallowed — tracing must never crash
 * the runtime.
 *
 * @category Agents
 */
export class JsonlTraceWriter implements TraceWriter {
  private _fd: number;
  private _nextId = 1;
  private _buffer: string[] = [];
  private _bufferSize: number;

  constructor(fd: number, opts?: { bufferSize?: number }) {
    this._fd = fd;
    this._bufferSize = opts?.bufferSize ?? 1;
  }

  nextId(): TraceId { return this._nextId++; }

  write(event: TraceEvent): void {
    this._buffer.push(JSON.stringify(event));
    if (this._buffer.length >= this._bufferSize) this.flush();
  }

  flush(): void {
    if (this._buffer.length === 0) return;
    const data = this._buffer.join('\n') + '\n';
    this._buffer.length = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeSync(this._fd, data);
    } catch { /* non-fatal */ }
  }
}
