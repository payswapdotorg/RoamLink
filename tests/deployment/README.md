# @roamlink/tests-deployment

The RL-075 **deployment/recovery verification suite**: the deployment and
recovery story as deterministic, executable simulations — no real
infrastructure. Every suite composes the REAL stateful components (inbox,
projections, outbox, audit, notifications, reconciliation) over the
persistence primitives and asserts DURABILITY INVARIANTS (no lost work, no
duplicate effects, convergence), never just absence of exceptions.

The verified recovery runbook, the failure-mode matrix and the honest gaps
are documented in `docs/deployment-recovery.md`.

## Determinism rules

Testkit clock/ids, no sleeps, no network, no ADCOS internals. Storage
failure is injected through a `FailingPersistence` decorator over the real
persistence ports; "restarts" rebuild the composed boundary over the same
durable state; backup/restore round-trips through the public reader
contracts (JSON in the middle).

## Suite catalog

| File | Recovery area | Representative durability invariants |
|---|---|---|
| `migration-recovery.test.ts` | persistence migration/recovery (RL-003 runner contract) | clean application from empty state and from EVERY prior state (per-k continuation converges to the same ledger); idempotent re-runs; descending, forward-compatible rollback; crash-during-migration recovery converges (torn window re-runs to a fixed point); ledger corruption fails closed |
| `cold-start-shutdown.test.ts` | cold start / orderly shutdown / crash injection | every component starts empty and resumes with exactly-once continuation; shutdown between admission and projection loses no durable work (batched drains pin the RL-073 DEFECT-1; unbounded drains complete); UnitOfWork atomicity under crash injection; failing-storage admission acknowledges nothing. Records FINDING RL-075-F1 (DELIVERING-strand reproducer) |
| `backup-restore.test.ts` | backup/restore semantics | canonical-state export/import round-trips through the PUBLIC contracts; restored projections digest-identical; the restored state passes the §8 conformance core; dedupe keys survive (replays are DUPLICATE, versions continue); reconciliation repairs BOTH drift modes (torn write → authoritative digest-verified replacement; missed webhook → discovery + canonical repair) |
| `dependency-failure.test.ts` | dependency-failure modes | ADCOS unreachable → honest STALE degradation with bounded attempts and DEFERRED outcomes (never a fabricated FRESH); circuit breaker rejects without invoking; retry attempt/deadline budgets cap work; partial degradation is stale-while-degraded; clock skew holds replay windows in both directions; storage failing → fail-closed, no silent data loss, exactly-once retry after healing; the §9 compatibility gate fails closed for mutations |
| `health-readiness.test.ts` | health/readiness composition (RL-052) | down dominates; degraded ≠ ready; empty registry is healthy; throwing/garbage/renamed checks are down with suppressed details; SLO no-data and exhausted budgets are degraded (never silently healthy); the composed data-plane health built from REAL state degrades honestly and recovers |
