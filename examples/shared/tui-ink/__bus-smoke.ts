/**
 * Smoke tests for the replay-to-first-subscriber event bus.
 *
 *   npx tsx examples/shared/tui-ink/__bus-smoke.ts
 */

import assert from 'node:assert';
import { createBus } from './event-bus';

function check(label: string, fn: () => void) {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

check('events sent before subscribe are replayed on first subscribe', () => {
  const bus = createBus<number>();
  bus.send(1);
  bus.send(2);
  bus.send(3);
  const seen: number[] = [];
  bus.subscribe((n) => seen.push(n));
  assert.deepEqual(seen, [1, 2, 3]);
});

check('events sent after subscribe go live to the subscriber', () => {
  const bus = createBus<number>();
  const seen: number[] = [];
  bus.subscribe((n) => seen.push(n));
  bus.send(1);
  bus.send(2);
  assert.deepEqual(seen, [1, 2]);
});

check('buffer + live mix: buffer drains first, then live follows', () => {
  const bus = createBus<number>();
  bus.send(1);
  bus.send(2);
  const seen: number[] = [];
  bus.subscribe((n) => seen.push(n));
  bus.send(3);
  bus.send(4);
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

check('second subscriber gets only live events — buffer is consumed once', () => {
  const bus = createBus<number>();
  bus.send(1);
  bus.send(2);
  const a: number[] = [];
  const b: number[] = [];
  bus.subscribe((n) => a.push(n));
  bus.subscribe((n) => b.push(n));
  bus.send(3);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [3]);
});

check('unsubscribe stops delivering', () => {
  const bus = createBus<number>();
  const seen: number[] = [];
  const unsub = bus.subscribe((n) => seen.push(n));
  bus.send(1);
  unsub();
  bus.send(2);
  assert.deepEqual(seen, [1]);
});

check('last unsubscribe followed by send: event is dropped (bus drained once)', () => {
  const bus = createBus<number>();
  const unsub = bus.subscribe(() => {});
  unsub();
  bus.send(42); // no subscribers — the bus already left buffer mode
  const late: number[] = [];
  bus.subscribe((n) => late.push(n));
  // The 42 is gone — we don't re-buffer after first drain.
  assert.deepEqual(late, []);
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
