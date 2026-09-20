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
| `runtime-hardening.test.ts` | RL-105..RL-108 deployment pins (Wave 7) | the worker drain sweeps stranded claims BEFORE its first claim and drains bounded batches (terminals never resurrected); the cron route is fail-closed, bounded and idempotent (deterministic per-day job ids on the event-driven path); the ADCOS probe is honest-not-configured and fail-closed |
| `recovery-battery.test.ts` | RL-110 scheduled/event-driven recovery battery | the SCHEDULED path driven through the REAL authenticated cron route: stranded DELIVERING claims re-owned + delivered, an inbox backlog DEEPER than one bounded batch advances past the first batch and drains in ceil(N/limit) kicks, unauthenticated triggers never run the sweeps; the EVENT-DRIVEN escalation delivers the durable jobs to the REAL receiver (signature VERIFIED before acting, the same bounded sweeps execute) and a TAMPERED signature is refused with nothing run; the HONEST NOT-CONFIGURED pins (no receiver keys -> 503, never a faked trigger); a DATABASE_URL-gated leg re-proves the scheduled path over a REAL pooled PostgreSQL (named skip when absent) |
| `backup-restore-real.test.ts` | RL-111 production backup/export verification (env-gated) | leg A (DATABASE_URL + the R2 env surface): real export through the PUBLIC reader contracts, content-addressed R2 upload + a manifest naming the digests, byte-identical read-back, the payload-digest and audit-chain laws on real data; leg B (+ a DISTINCT scratch DSN): restore into a scratch database migrated with the REAL files — digest-identical records, dedupe keys survive (replayed admission is DUPLICATE), versions continue, terminal outbox records never re-enqueued, the audit chain still verifies after the real round-trip; NO DDL on the source, the scratch never is the source; env absent -> named skips |
| `rollback-decision-rule.test.ts` | RL-112 executable rollback decision rule | the post-rollback check (infra/deployment/rollback/check.mjs, runbook §9) is proven end to end by its loopback selftest within the standard run: honest ready + green smoke ACCEPTED, surfaced degraded ACCEPTED, truthful not-ready REJECTED (not restored service), lying ready REJECTED (the no-lie law), unreachable fails without crashing; the root scripts are wired |
