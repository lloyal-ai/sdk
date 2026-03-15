import type { TraceEvent, TraceId } from './trace-types';

export interface TraceWriter {
  /** Write a trace event. Must not throw. */
  write(event: TraceEvent): void;
  /** Allocate a new trace ID. Monotonically increasing. */
  nextId(): TraceId;
  /** Flush pending writes. Called at scope boundaries. */
  flush(): void;
}

/** Null writer — zero cost when tracing is disabled */
export class NullTraceWriter implements TraceWriter {
  nextId(): TraceId { return 0; }
  write(_event: TraceEvent): void {}
  flush(): void {}
}

/** JSONL file writer — one JSON object per line, buffered sync writes */
export class JsonlTraceWriter implements TraceWriter {
  private _fd: number;
  private _nextId = 1;
  private _buffer: string[] = [];

  constructor(fd: number) { this._fd = fd; }

  nextId(): TraceId { return this._nextId++; }

  write(event: TraceEvent): void {
    this._buffer.push(JSON.stringify(event));
    if (this._buffer.length >= 64) this.flush();
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
