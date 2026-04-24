/**
 * Visual smoke test — drives the full TUI sequence from composer boot
 * through plan review, research, and back to composer, using synthetic
 * events. Mirrors what main.ts's command loop would emit.
 *
 *   npx tsx examples/shared/tui-ink/__visual-smoke.tsx
 */

import { main, createChannel, createSignal, sleep, spawn, call } from 'effection';
import { render } from './render';
import type { WorkflowEvent } from './events';
import type { Command } from './commands';
import type { ConfigOrigin } from './config';

main(function* () {
  const channel = createChannel<WorkflowEvent, void>();
  const commands = createSignal<Command, void>();

  // Drain commands (a real main.ts would dispatch real work here).
  yield* spawn(function* () {
    for (const _cmd of yield* each(commands)) {
      void _cmd;
      yield* each.next();
    }
  });

  const instance = render(channel, (cmd) => commands.send(cmd));

  const origin: ConfigOrigin = {
    tavilyKey: 'file',
    corpusPath: 'unset',
    reasoningMode: 'default',
    modelPath: 'default',
    reranker: 'default',
  };

  yield* spawn(function* () {
    yield* sleep(100);

    // ── Boot → composer ──
    yield* channel.send({
      type: 'config:loaded',
      config: {
        version: 1,
        sources: { tavilyKey: 'tvly-saved-from-disk' },
        defaults: { reasoningMode: 'deep', verifyCount: 3, maxTurns: 10 },
        model: {},
      },
      origin,
      path: '/tmp/harness.json',
    } as WorkflowEvent);

    yield* sleep(600);

    // ── Submit query ──
    yield* channel.send({
      type: 'plan:start',
      query: 'How do modern voice agents achieve sub-800ms latency on-device?',
      mode: 'deep',
    } as WorkflowEvent);

    yield* sleep(400);

    // ── Plan arrives ──
    yield* channel.send({
      type: 'plan',
      intent: 'research',
      tasks: [
        { description: 'Survey STT models and their latency profiles' },
        { description: 'Compare local LLM inference engines' },
        { description: 'Survey TTS models with expressive output' },
      ] as never,
      clarifyQuestions: [],
      tokenCount: 412,
      timeMs: 1450,
    });
    yield* channel.send({ type: 'ui:plan_review' } as WorkflowEvent);

    yield* sleep(1200);

    // ── User accepts → research starts ──
    yield* channel.send({ type: 'research:start', agentCount: 3, mode: 'flat' });
    yield* channel.send({ type: 'fanout:tasks', tasks: [] as never });
    yield* channel.send({ type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent);
    yield* channel.send({ type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent);
    yield* channel.send({ type: 'agent:spawn', agentId: 3, parentAgentId: 0 } as WorkflowEvent);

    // Stream brief content into each column
    const streams: [number, string][] = [
      [1, 'STT Research\nSurveying Whisper variants under INT4.'],
      [2, 'LLM Engines\nComparing vLLM and faster-whisper.'],
      [3, 'TTS Engines\nChecking CosyVoice and StyleTTS2.'],
    ];
    for (const [id, text] of streams) {
      for (const word of text.split(' ')) {
        yield* channel.send({
          type: 'agent:produce',
          agentId: id,
          text: word + ' ',
          tokenCount: 0,
        } as WorkflowEvent);
        yield* sleep(12);
      }
      yield* channel.send({
        type: 'agent:produce',
        agentId: id,
        text: '</think>',
        tokenCount: 30,
      } as WorkflowEvent);
      yield* channel.send({
        type: 'agent:report',
        agentId: id,
        result: `Findings for agent ${id}: short report.`,
      } as WorkflowEvent);
    }

    yield* channel.send({ type: 'research:done', totalTokens: 400, totalToolCalls: 0, timeMs: 1800 });

    // Synth
    yield* channel.send({ type: 'synthesize:start' });
    yield* channel.send({ type: 'agent:spawn', agentId: 10, parentAgentId: 0 } as WorkflowEvent);
    for (const word of 'Voice agents stream STT, LLM, TTS overlapping for sub-800ms round-trip.'.split(' ')) {
      yield* channel.send({
        type: 'agent:produce',
        agentId: 10,
        text: word + ' ',
        tokenCount: 0,
      } as WorkflowEvent);
      yield* sleep(14);
    }
    yield* channel.send({
      type: 'synthesize:done',
      agentId: 10,
      ppl: 2.6,
      tokenCount: 60,
      toolCallCount: 0,
      timeMs: 900,
    });

    yield* channel.send({ type: 'verify:start', count: 3, mode: 'flat' });
    yield* sleep(300);
    yield* channel.send({ type: 'verify:done', count: 3, timeMs: 800 });
    yield* channel.send({
      type: 'eval:done',
      converged: true,
      tokenCount: 18,
      sampleCount: 3,
      timeMs: 400,
    });
    yield* channel.send({
      type: 'stats',
      timings: [],
      ctxPct: 52,
      ctxPos: 8500,
      ctxTotal: 16384,
    });
    yield* channel.send({ type: 'complete', data: {} });

    // ── Back to composer for follow-up ──
    yield* sleep(800);
    yield* channel.send({ type: 'ui:composer' } as WorkflowEvent);
    yield* sleep(800);
  });

  yield* sleep(15_000);
  instance.unmount();
  yield* call(() => instance.waitUntilExit());
});

// Helper local to the smoke — `each` imported via main's generator context.
import { each } from 'effection';
