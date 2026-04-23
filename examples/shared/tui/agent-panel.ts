import { c, isTTY } from './primitives';

/**
 * Multi-region panel renderer for parallel agent streams.
 *
 * Owns a fixed vertical area of the terminal. Each region is one task's
 * block — mirroring the chain-mode visual (`┌ Task N — ...` header,
 * streaming body, `└ done` footer) but rendered in parallel across N
 * simultaneously-active agents.
 *
 * Use for any section where multiple agents stream concurrently and the
 * default shared `agentStream` would interleave their tokens into garbage
 * (flat-mode research, verify pool, eval pool when multi-agent, etc.).
 *
 * Mechanism: reserve N × (1 header + bodyHeight + 1 footer) lines up front,
 * track per-region state (body ring buffer, partial line, footer), and
 * re-render the full panel block on any mutation via cursor-up + clear +
 * rewrite. Scales fine for small N (3-8 agents).
 *
 * **Constraint**: no other `log()` or `stdout.write` calls from caller
 * code during the panel's lifetime — they shift the cursor and corrupt
 * the re-render math. The caller must route ALL streaming output through
 * the panel's methods between `createAgentPanel` and `close()`.
 */
export interface AgentPanel {
  /** Append streaming tokens to region i's in-flight line. Newlines flush
   *  the line into the body ring buffer and start a new partial. */
  appendTokens(i: number, text: string): void;
  /** Append a complete line to region i's body (for tool_call / tool_result
   *  summaries, which are one-liners not a token stream). */
  addLine(i: number, line: string): void;
  /** Mark region i done and set its footer line. Subsequent updates to i
   *  are ignored (region is frozen). */
  finish(i: number, footer: string): void;
  /** Finalize the panel: cursor moves past the last region; no further
   *  updates accepted. */
  close(): void;
}

export interface AgentPanelTask {
  /** Task description shown in the region header. */
  title: string;
  /** Label shown alongside the title (e.g. `A0`, `A1`). */
  label: string;
}

const INDENT = '    ';
const BODY_PREFIX = '    │ ';

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Show the LAST `max` chars with a leading ellipsis. For in-flight partial
 *  lines where the interesting content is what's being appended, not the
 *  stale beginning. */
function truncateTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}

interface RegionState {
  label: string;
  title: string;
  body: string[];          // ring buffer of last bodyHeight completed lines
  partial: string;         // current in-flight line (tokens since last \n)
  footer: string | null;   // null until finish() called
}

export function createAgentPanel(
  tasks: AgentPanelTask[],
  bodyHeight = 3,
): AgentPanel {
  if (!isTTY) {
    // Non-TTY (piped output, jsonl mode, tests): no-op panel. Callers should
    // still route events through the panel; nothing renders.
    return {
      appendTokens() {},
      addLine() {},
      finish() {},
      close() {},
    };
  }

  const regions: RegionState[] = tasks.map(t => ({
    label: t.label,
    title: t.title,
    body: [],
    partial: '',
    footer: null,
  }));

  // Height per region = 1 header + bodyHeight body lines + 1 footer line.
  // Footer line is always present (blank when not done) so total height is
  // stable — simpler cursor math, no re-allocation when an agent completes.
  const regionHeight = 1 + bodyHeight + 1;
  const totalHeight = regions.length * regionHeight;

  let closed = false;
  let firstRender = true;

  const cols = (): number => process.stdout.columns || 80;

  function renderHeader(r: RegionState): string {
    const max = cols() - INDENT.length - 4;
    const body = truncate(`${c.bold}${r.label}${c.reset} ${r.title}`, max + c.bold.length + c.reset.length);
    return `${INDENT}${c.dim}┌${c.reset} ${body}`;
  }

  function renderBodyLine(text: string, tailTruncate = false): string {
    const max = cols() - BODY_PREFIX.length;
    const clean = text.replace(/\t/g, ' ');
    const cut = tailTruncate ? truncateTail(clean, max) : truncate(clean, max);
    return `${c.dim}${BODY_PREFIX}${c.reset}${c.dim}${cut}${c.reset}`;
  }

  function renderEmptyBody(): string {
    return `${c.dim}${BODY_PREFIX}${c.reset}`;
  }

  function renderFooter(r: RegionState): string {
    if (r.footer === null) return `${c.dim}${BODY_PREFIX}${c.reset}`;
    const max = cols() - INDENT.length - 4;
    return `${INDENT}${c.dim}└${c.reset} ${c.dim}${truncate(r.footer, max)}${c.reset}`;
  }

  function regionLines(r: RegionState): string[] {
    const lines: string[] = [];
    lines.push(renderHeader(r));

    // Body: ring buffer tail, with partial as the current last line.
    // Partial uses tail-truncation so streaming tokens remain visible
    // (in-flight content grows from the end — e.g. JSON-escaped recovery
    // output that never emits a raw newline). Body lines are complete
    // logical lines, head-truncation is fine there.
    const hasPartial = r.partial.length > 0;
    const visible: Array<{ text: string; isPartial: boolean }> =
      hasPartial ? [...r.body.map(b => ({ text: b, isPartial: false })), { text: r.partial, isPartial: true }]
                 : r.body.map(b => ({ text: b, isPartial: false }));
    const tail = visible.slice(Math.max(0, visible.length - bodyHeight));
    for (let i = 0; i < bodyHeight; i++) {
      const entry = tail[i];
      lines.push(entry === undefined
        ? renderEmptyBody()
        : renderBodyLine(entry.text, entry.isPartial));
    }

    lines.push(renderFooter(r));
    return lines;
  }

  function render(): void {
    // On first render: print all lines freshly. Cursor ends below the last
    // region, one line past it (from the final \n).
    if (firstRender) {
      for (const r of regions) {
        for (const line of regionLines(r)) {
          process.stdout.write(line + '\n');
        }
      }
      firstRender = false;
      return;
    }

    // Subsequent renders: move cursor up to the top of the panel, rewrite
    // every line clearing first, then cursor lands back below the panel.
    // Uses ESC[F (cursor up to column 1) and ESC[2K (erase entire line).
    process.stdout.write(`\x1b[${totalHeight}F`);
    for (const r of regions) {
      for (const line of regionLines(r)) {
        process.stdout.write('\x1b[2K' + line + '\n');
      }
    }
  }

  render();

  return {
    appendTokens(i: number, text: string): void {
      if (closed) return;
      const r = regions[i];
      if (!r || r.footer !== null) return;  // frozen
      // Merge text into partial; on newline, push completed line into body.
      let remaining = text;
      while (true) {
        const nl = remaining.indexOf('\n');
        if (nl === -1) {
          r.partial += remaining;
          break;
        }
        r.partial += remaining.slice(0, nl);
        if (r.partial.length > 0 || r.body.length > 0) {
          r.body.push(r.partial);
          if (r.body.length > bodyHeight) r.body.shift();
        }
        r.partial = '';
        remaining = remaining.slice(nl + 1);
      }
      render();
    },

    addLine(i: number, line: string): void {
      if (closed) return;
      const r = regions[i];
      if (!r || r.footer !== null) return;
      // Complete line — push flushed partial first (if any), then this line.
      if (r.partial.length > 0) {
        r.body.push(r.partial);
        if (r.body.length > bodyHeight) r.body.shift();
        r.partial = '';
      }
      r.body.push(line);
      if (r.body.length > bodyHeight) r.body.shift();
      render();
    },

    finish(i: number, footer: string): void {
      if (closed) return;
      const r = regions[i];
      if (!r || r.footer !== null) return;
      // Flush partial into body one last time so final state is captured.
      if (r.partial.length > 0) {
        r.body.push(r.partial);
        if (r.body.length > bodyHeight) r.body.shift();
        r.partial = '';
      }
      r.footer = footer;
      render();
    },

    close(): void {
      if (closed) return;
      closed = true;
      // Cursor is already on the line below the last region from the final
      // '\n' of the last render. Nothing to do — subsequent log() calls
      // will flow below the panel naturally.
    },
  };
}
