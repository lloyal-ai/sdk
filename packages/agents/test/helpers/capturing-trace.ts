/**
 * TraceWriter that captures all events for assertion in tests.
 */
import type { TraceWriter } from '../../src/trace-writer';
import type { TraceEvent, TraceId } from '../../src/trace-types';

export class CapturingTraceWriter implements TraceWriter {
  events: TraceEvent[] = [];
  private _nextId = 1;

  nextId(): TraceId { return this._nextId++; }
  write(event: TraceEvent): void { this.events.push(event); }
  flush(): void {}

  /** Filter events by type discriminant */
  ofType<T extends TraceEvent['type']>(type: T): Extract<TraceEvent, { type: T }>[] {
    return this.events.filter(e => e.type === type) as any;
  }
}
