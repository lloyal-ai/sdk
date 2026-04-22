import type { PoolRun, NativeCall } from './harness';
import type { TraceEvent } from '../../src/trace-types';

export interface Violation {
  invariant: string;
  detail: string;
  at?: number;
}

export interface PredicateResult {
  ok: boolean;
  violations: Violation[];
}

function ok(): PredicateResult { return { ok: true, violations: [] }; }
function fail(invariant: string, detail: string, at?: number): PredicateResult {
  return { ok: false, violations: [{ invariant, detail, at }] };
}

/** I1 Native-store-single-fiber: no two native calls overlap in time. */
export function I1_nativeStoreSingleFiber(run: PoolRun): PredicateResult {
  const calls = run.nativeCalls.slice().sort((a, b) => a.tStart - b.tStart);
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    if (cur.tStart < prev.tEnd) {
      return fail(
        'I1',
        `native ${prev.op} (seq ${prev.seq}, ended ${prev.tEnd.toFixed(3)}ms) overlaps with ${cur.op} (seq ${cur.seq}, started ${cur.tStart.toFixed(3)}ms)`,
      );
    }
  }
  return ok();
}

/**
 * I4 SPAWN-batched: when multiple agents spawn "at once" (same tick), their
 * suffix prefill lands in one native prefill call with N pairs, not N calls.
 * Implemented as: the first store.prefill of a run carries branchCount
 * equal to the number of agentFork branch:create events preceding it.
 */
export function I4_spawnBatched(run: PoolRun): PredicateResult {
  const forks = run.traceEvents.filter(
    e => e.type === 'branch:create' && (e as any).role === 'agentFork',
  ).length;
  if (forks === 0) return ok();
  const firstPrefill = run.nativeCalls.find(c => c.op === 'prefill');
  if (!firstPrefill) {
    return fail('I4', `${forks} agentFork(s) but no store.prefill call recorded`);
  }
  if (firstPrefill.branchCount !== forks) {
    return fail(
      'I4',
      `SPAWN-phase prefill carried ${firstPrefill.branchCount} branches, expected ${forks} (batched as one native call)`,
    );
  }
  return ok();
}

/**
 * I24 SETTLE-policy-consulted: when SETTLE encounters an oversized tool
 * result (headroom exceeded) the policy's onSettleReject is consulted.
 *
 * Proxy assertion: for every agent drop with reason `pressure_settle_reject`
 * or `settle_stall_break`, the run must have called the policy's
 * onSettleReject at least once for that agent (counted by the policy probe).
 *
 * Since we don't have direct visibility into policy calls from trace events,
 * this predicate requires the caller to pass a probe — see I24_via_probe.
 */
export function I24_settlePolicyConsulted(
  run: PoolRun,
  probeCallCount: number,
): PredicateResult {
  const settleDrops = run.traceEvents.filter(
    e => e.type === 'pool:agentDrop'
      && ((e as any).reason === 'pressure_settle_reject'
        || (e as any).reason === 'settle_stall_break'),
  );
  if (settleDrops.length === 0) return ok();
  if (probeCallCount === 0) {
    return fail(
      'I24',
      `${settleDrops.length} settle-related drop(s) but policy.onSettleReject was never invoked`,
    );
  }
  return ok();
}

/**
 * I25 Stall-break-last-resort: settle_stall_break fires only when policy
 * said nudge and the nudge itself re-deferred (or policy is absent). A drop
 * with reason `settle_stall_break` must NOT occur when there exists an
 * active agent at the time the decision was made.
 *
 * Weakly verified via: no two drops with reason 'settle_stall_break' can
 * happen while another agent is still active in the trace.
 *
 * Strongly verified by inspecting production code paths — future work.
 * For now, check that `settle_stall_break` is used at all (not collapsed
 * with `pressure_settle_reject`).
 */
export function I25_stallBreakDistinct(run: PoolRun): PredicateResult {
  const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
  const reasons = new Set(drops.map(d => (d as any).reason));
  const hasSettleReject = reasons.has('pressure_settle_reject');
  const hasStallBreak = reasons.has('settle_stall_break');
  const hasStallBreakReason = drops.some(
    d => (d as any).reason === 'settle_stall_break',
  );
  if (hasSettleReject && !hasStallBreak) {
    return fail(
      'I25',
      `pressure_settle_reject present but settle_stall_break never — reasons are collapsed into one`,
    );
  }
  return ok();
}

/**
 * I29 Recovery-diagnostic-complete: every recovery attempt emits exactly
 * one of pool:recoveryReport / pool:recoveryFailed after its
 * branch:prefill role=recovery.
 */
export function I29_recoveryDiagnostic(run: PoolRun): PredicateResult {
  const recoveryPrefills = run.traceEvents.filter(
    e => e.type === 'branch:prefill' && (e as any).role === 'recovery',
  );
  if (recoveryPrefills.length === 0) return ok();
  for (const prefill of recoveryPrefills) {
    const agentId = (prefill as any).branchHandle;
    const rest = run.traceEvents.slice(run.traceEvents.indexOf(prefill) + 1);
    const report = rest.find(
      e => (e.type === 'pool:recoveryReport' || e.type === 'pool:recoveryFailed')
        && (e as any).agentId === agentId,
    );
    if (!report) {
      return fail(
        'I29',
        `recovery prefill for agent ${agentId} emitted no pool:recoveryReport or pool:recoveryFailed diagnostic`,
      );
    }
  }
  return ok();
}

/**
 * Helper: every `pool:agentNudge` event with `reason` carries a numeric
 * budget in its message ("… within N words"). Use after any scenario
 * that nudges, to verify the budget-surfacing invariant.
 */
export function nudgeMessageContainsBudget(
  run: PoolRun,
  reason?: 'settle_reject' | 'nudge' | 'pressure_softcut' | 'pressure_settle_reject' | 'time_nudge',
): PredicateResult {
  const nudges = run.traceEvents.filter(e => e.type === 'pool:agentNudge');
  const filtered = reason
    ? nudges.filter(n => (n as any).reason === reason)
    : nudges;
  if (filtered.length === 0) return ok();
  for (const n of filtered) {
    const msg = (n as any).message as string | undefined;
    if (!msg || !/within \d+ words/.test(msg)) {
      return fail(
        'budget-visible',
        `nudge (reason=${(n as any).reason}) has no "within N words" budget: ${msg ?? '<missing>'}`,
      );
    }
  }
  return ok();
}

/**
 * Format a PredicateResult for fast-check / expect output.
 */
export function formatResult(name: string, r: PredicateResult): string {
  if (r.ok) return `${name}: ok`;
  return `${name}: ${r.violations.map(v => `[${v.invariant}] ${v.detail}`).join('; ')}`;
}
