# Pool lifecycle invariants

This directory holds property-based tests and named scenarios that enforce
the pool's lifecycle invariants — the guarantees the framework's source
code documents in comments. The existing `agent-pool.test.ts` and
sibling files cover *specific regressions*. These invariant tests cover
*structural guarantees*: single-fiber native access, SETTLE policy
consultation, recovery diagnostic completeness, etc.

## Why this exists

Comments in the source like:

> *"Pending spawns — populated by PoolContext.spawn, drained by the tick
> loop's SPAWN phase … guarantees that all native store operations are
> issued from the tick loop's single fiber — never concurrently with
> other store work."*

state invariants the code actually relies on. Before this directory, the
invariant was enforced only by developer discipline — a change that
reintroduced a direct `store.prefill` from `ctx.spawn` would pass CI
because the tests mocked around the interaction. Invariants tests make
the guarantee machine-checked.

## Directory layout

- `harness.ts` — `runPool(spec)` returns a `PoolRun` carrying the full
  trace event stream, channel events, native-call timing, and result.
- `predicates.ts` — named predicate functions (I1, I4, I24, …) that
  consume a `PoolRun` and return `{ok, violations}`.
- `arbitraries.ts` — `fast-check` generators for orchestration shapes,
  pressure profiles, tool result sizes, agent token scripts.
- `*.prop.test.ts` — property tests. Each file covers a cluster of
  related invariants (`pressure.prop.test.ts`, `batching.prop.test.ts`,
  `recovery.prop.test.ts`, …).
- `scenarios/*.scenario.test.ts` — concrete named lifecycle walkthroughs
  with explicit expected event sequences.

## Adding an invariant

1. Pick an ID (next available after the highest in `predicates.ts`).
2. Write the predicate in `predicates.ts`:
   ```ts
   export function I41_my_invariant(run: PoolRun): PredicateResult { ... }
   ```
3. Add at least one property test (generator → asserts predicate).
4. Add at least one scenario — a concrete, canonical shape — so humans
   reading the directory can see the invariant in action.

## Adding a scenario

Scenarios are vitest tests with `.scenario.test.ts` suffix. They:

- Set up a pool with specific, known inputs (not random).
- Run `runPool(spec)` via the harness.
- Assert explicit trace event sequences — not just existence checks.
- Document *what the framework promises* for this shape of work.

A scenario without a companion property test is OK. A property test
without a companion scenario is discouraged — scenarios are how humans
learn the framework's contract.

## Invariant catalog

The full catalog lives in `/Users/zuhairnaqvi/.claude/plans/mutable-waddling-bentley.md`.
This directory implements them incrementally. Implemented so far:

- I24 (SETTLE-policy-consulted) — `pressure.prop.test.ts` +
  `scenarios/pressure-exit-via-settle-policy-nudge.scenario.test.ts`
- I25 (stall-break-distinct) — `scenarios/pressure-exit-via-stall-break.scenario.test.ts`
- I29 (recovery-diagnostic-complete) — `scenarios/recovery-fails.scenario.test.ts`

Remaining invariants (I1–I23, I26–I28, I30–I40) land incrementally.

## Running

```bash
npx vitest run packages/agents/test/invariants/
```

Property tests use a pinned seed for reproducibility. Increase `numRuns`
locally for deeper coverage; default is 30.
