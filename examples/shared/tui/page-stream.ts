import { statusClear } from './primitives';

/**
 * A page stream renders token deltas to stdout as a vertical, copyable region
 * of the terminal — the opposite of a status-line ticker that overwrites
 * itself. Used for live-rendering research agent reports and synthesis output.
 *
 * Lifecycle: open() → append() × N → close(). Safe to call close() when not
 * open; safe to call open() when already open (no-op).
 *
 * Segment semantics: a single agent may stream multiple segments (one per
 * generation window between tool calls). Each close() finishes a segment;
 * the next open() starts a fresh one. hadContent reflects the most recent
 * segment only — consumers use it to decide whether to render a fallback
 * block dump at report time (if no segment streamed content for this agent,
 * fall back; otherwise the streamed text already rendered the report).
 */
export interface PageStream {
  open(): void;
  append(text: string): void;
  close(): void;
  readonly isOpen: boolean;
  readonly hadContent: boolean;
}

export function createPageStream(indent = '  '): PageStream {
  let _isOpen = false;
  let _hadContent = false;
  const newlineReplacement = '\n' + indent;

  return {
    open(): void {
      if (_isOpen) return;
      _hadContent = false;
      statusClear();
      process.stdout.write('\n' + indent);
      _isOpen = true;
    },
    append(text: string): void {
      if (!_isOpen || !text) return;
      _hadContent = true;
      process.stdout.write(text.replace(/\n/g, newlineReplacement));
    },
    close(): void {
      if (!_isOpen) return;
      process.stdout.write('\n');
      _isOpen = false;
    },
    get isOpen(): boolean { return _isOpen; },
    get hadContent(): boolean { return _hadContent; },
  };
}
