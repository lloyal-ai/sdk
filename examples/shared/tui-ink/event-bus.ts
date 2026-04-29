/**
 * Minimal replay-to-first-subscriber event bus.
 *
 * Motivating race: main.ts mounts Ink and immediately dispatches boot-phase
 * events (config:loaded, download:start, ...). Ink's useEffect subscribes
 * to the event stream in a microtask AFTER the first React commit. An
 * unbuffered Signal drops any send that happens in that gap.
 *
 * This bus buffers while no subscriber exists. The FIRST subscriber
 * synchronously receives every queued event, then live events stream as
 * they arrive. Later subscribers get only live events — this is a
 * replay-to-first-subscriber semantic (like a ReplaySubject that's
 * drained on first consumption), not a general BehaviorSubject.
 *
 * The bus is a plain JS object — no Effection, no React. Callers bridge
 * it to their framework of choice. `send` is synchronous, so it's safe
 * to call from non-generator callbacks (e.g. downloadIfMissing.onProgress).
 */

export interface EventBus<T> {
  send(event: T): void;
  subscribe(handler: (event: T) => void): () => void;
}

export function createBus<T>(): EventBus<T> {
  let buffer: T[] | null = [];
  const subscribers = new Set<(event: T) => void>();

  return {
    send(event: T): void {
      if (buffer !== null) {
        // No subscriber yet — buffer and wait.
        buffer.push(event);
        return;
      }
      for (const handler of subscribers) handler(event);
    },
    subscribe(handler: (event: T) => void): () => void {
      subscribers.add(handler);
      if (buffer !== null) {
        // First subscriber ever — drain the buffer to this handler, then
        // flip to live mode forever. Drain synchronously so there's no
        // second-race window.
        const drained = buffer;
        buffer = null;
        for (const event of drained) handler(event);
      }
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
