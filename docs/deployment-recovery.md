# RoamLink Deployment & Recovery Verification (RL-075)

**Work item:** RL-075 — Deployment/recovery verification
**Suite:** `tests/deployment` (`@roamlink/tests-deployment`, runs as part of `pnpm test`)
**Source checklist:** `spec/definition-of-done.md` ("Operations": health/readiness
semantics, migration/rollback behavior), `spec/adcos-integration.md` §7/§8/§9,
`spec/architecture.md` §5/§6 (projections are disposable; reconciliation),
`spec/security.md` ("Fail-safe defaults"), `spec/repository-layout.md`
(infra/migrations intent).
**Method:** deterministic simulations over the REAL public packages — no real
infrastructure. The §10 ADCOS fake is the only external stand-in; storage
failure is injected through a `FailingPersistence` decorator over the real
persistence ports; "restarts" rebuild the composed boundary over the same
durable state. Every recovery assertion is a DURABILITY INVARIANT (no lost
work, no duplicate effects, convergence), never just absence of exceptions.

---

## 1. The verified recovery runbook (deterministic commands)

These are the commands the suites actually execute — deterministic, no
network, no sleeps, runnable on any checkout:

```bash
pnpm -C tests/deployment test        # all five suites (26 tests)
```

Individual legs:

```bash
# Schema migration / recovery (M-1..M-6)
pnpm -C tests/deployment exec vitest run test/migration-recovery.test.ts

# Cold start / orderly shutdown / crash injection (CS-1..CS-7)
pnpm -C tests/deployment exec vitest run test/cold-start-shutdown.test.ts

# Backup / restore + drift repair (B-1..B-4)
pnpm -C tests/deployment exec vitest run test/backup-restore.test.ts

# Dependency-failure modes (D-1..D-5)
pnpm -C tests/deployment exec vitest run test/dependency-failure.test.ts

# Health / readiness composition (H-1..H-4)
pnpm -C tests/deployment exec vitest run test/health-readiness.test.ts
```

### Operational procedures, as verified

**Deploy (fresh environment)** — M-1: apply the migration sequence from
empty state (`migrateUp()`): ascending version order, applied-versions ledger
records each `(version, appliedAt)`. Every stateful component starts empty
(CS-1); the compatibility gate must PASS before mutations flow (D-5 —
`assertMutationsAllowed()` refuses on `unknown` and on `incompatible`).

**Upgrade (from any prior state)** — M-2: applying up to version k, then
continuing, converges to exactly the same ledger as a single pass (verified
for every k). The inbox resumes from persisted state with exactly-once
projection continuation (CS-2).

**Rollback** — M-4: `migrateDown(target)` runs `down` in descending order,
target stays applied; a subsequent forward run re-applies cleanly
(forward-compatible writes).

**Crash during migration** — M-5: the torn window (schema effect applied,
ledger not updated) is recovered by RE-RUNNING `migrateUp()`: the
deterministic migration re-executes, the ledger catches up, and a third
crash-free run applies nothing (fixed point). Convergence, not duplication.

**Process restart** — CS-2/CS-3: rebuild the components over the same
durable state; admitted-but-unprojected events complete exactly once (a
re-drain is a no-op); projection versions advance monotonically; inbox dedupe
keys survive so replays are `DUPLICATE`. NOTE (AR-008 / RL-094, REMEDIATED
on work/rl-durable-recovery): repeated BATCHED drains formerly could not
progress past the first batch — backlogs > the batch limit required an
unbounded drain; batch progression has landed and repeated bounded drains
now advance (ceil(N/limit) calls), so the former unbounded-drain
workaround pin is obsolete. (Historical DEFECT-1 record retained in
tests/load and the accepted-risk registry.)

**Backup** — B-1: export through the PUBLIC reader contracts (named record
repositories at their recorded versions, the inbox admission log with dedupe
keys, the outbox with delivery states, projection records, audit events in
plain form). The export is JSON-serializable end to end.

**Restore** — B-1/B-2/B-3 (`restoreDataPlane` in the suite harness):
re-insert records at their recorded versions (optimistic-concurrency tokens
continue from where the backup left off); re-admit every `ADMITTED` dedupe
key (replayed events are `DUPLICATE` — exactly-once admission survives the
restore); re-enqueue only UNSETTLED outbox obligations (terminal
`DELIVERED`/`FAILED` records are never re-enqueued — that would duplicate
effects). The restored state passes the §8 conformance core (full projection
field set, honest digests) and the exported audit chain still verifies.

**Drift repair after restore** — B-4: the reconciler (RL-035) repairs BOTH
drift modes: a torn write (payload no longer digesting to its recorded
`payload_digest`) is repaired by an AUTHORITATIVE REPLACEMENT (versionless
canonical apply, digest re-verified against canonical truth); a missed
webhook (canonical state changed while the backup was stale) is repaired by
discovery + canonical refresh after freshness decay.

**ADCOS outage** — D-1: sustained unreachability degrades every projection
honestly to `STALE` (never a fabricated `FRESH`), with bounded per-target
fetch attempts (≤ `maxCanonicalReadAttempts`) and `DEFERRED` outcomes naming
the failure code. A circuit breaker over the dependency opens after the
rolling threshold and REJECTS WITHOUT INVOKING; retry attempt budgets and
wall-clock deadlines cap total work.

**Storage failure** — D-4/CS-7: a failing commit is a typed, loud error — no
record, no outbox row, no acknowledgment survives it (UnitOfWork atomicity
keeps business writes and outbox rows together). After healing, the retry
lands exactly once (the failed attempt left nothing behind).

**Readiness gate** — H-4: compose health from the real state (inbox backlog
via extended-record processing status, outbox backlog, projection freshness,
audit-chain verification): `down` dominates, `degraded` is not ready, and the
report recovers to `healthy` only after the backlog drains and the
projections refresh.

---

## 2. Failure-mode matrix

| Failure mode | Verified behavior | Suite / IDs |
|---|---|---|
| Migration crash (torn window) | Re-run converges; ledger catches up; fixed point on the crash-free re-run | M-5 |
| Ledger corruption (unknown/duplicate versions) | Fail closed `MIGRATION_LEDGER_CORRUPT` — never guessed through | M-6 |
| Process crash between admission and projection | Admitted events survive; restart completes them exactly once | CS-2/CS-3 |
| Process crash between outbox claim and outcome | Records strand in `DELIVERING` until the restarted worker runs the PUBLIC stuck-claim sweep (`UnitOfWork.outbox.recoverInFlight`, AR-007 / RL-093): the sweep re-owns them (PENDING due at the recovery instant, retry budget untouched) and the obligations continue and complete; the surrounding atomicity holds everywhere it is expressible. (Former FINDING RL-075-F1, §3 — REMEDIATED.) | CS-4 |
| Storage full / failing commits | Typed fail-closed errors; nothing persisted, nothing acknowledged; retry lands exactly once after healing | CS-7, D-4 |
| Uncommitted unit of work (crash before commit) | Nothing behind — no orphan records, outbox rows or inbox admissions | CS-5 |
| ADCOS unreachable (sustained) | Honest `STALE` everywhere; bounded attempts; `DEFERRED` with diagnosable codes; breaker rejects without invoking; retry/deadline budgets cap work | D-1 |
| ADCOS partial degradation | Stale-while-degraded: prior payload + digest preserved verbatim while freshness degrades | D-2 |
| Clock skew (±) | Webhook replay window enforced in BOTH directions; freshness evaluated at the query instant | D-3 |
| ADCOS contract incompatibility | Mutations fail closed (`unknown` is not compatible; `incompatible` is diagnosable and value-free) | D-5 |
| Backup/restore round-trip | Digest-identical projections; dedupe keys survive; versions continue; §8 conformance core passes; audit chain verifies | B-1/B-2/B-3 |
| Restored-projection drift (torn write) | Authoritative replacement, digest re-verified against canonical truth | B-4(a) |
| Restored-projection drift (missed webhook) | Discovery + canonical refresh repair after freshness decay | B-4(b) |
| A component throwing / returning garbage health | `down` with suppressed details (never healthy, never leaked) | H-2 |
| SLO with no data / exhausted budget | `degraded` — never silently healthy | H-3 |

## 3. Findings (recorded — fix ownership: Tech Lead)

### RL-075-F1 — outbox records stranded in DELIVERING have no public recovery path (REMEDIATED — AR-007 / RL-093)

- **Where:** `packages/persistence` outbox port (`claimDue` /
  `markDelivered` / `markAttemptFailed` / `recoverInFlight`).
- **What (historical):** the production delivery shape is claim-commit →
  attempt → outcome-commit. A crash between the claim commit and the
  outcome commit left records in `DELIVERING`; `claimDue` only considers
  `PENDING` records, and the public outbox port exposed NO
  requeue/stuck-sweep API. The restarted worker therefore could not
  continue those obligations through the public interface. (The EDGE
  outbox — `@roamlink/edge` RL-042 — already exposed `recoverInFlight`.)
- **Exposure bound (historical):** no data was LOST (the records, payloads
  and digests remained intact; a still-live owner could complete them);
  the invariant broken was "restart continues in-flight work", not
  durability of the record itself.
- **Historical reproducer** (`tests/deployment/test/cold-start-shutdown.test.ts`,
  CS-4): enqueue 2 records; `claimDue` commits; (crash); restart;
  `claimDue` again → returns `[]`; both records remain `DELIVERING`.
- **REMEDIATION (AR-007, RL-093, work/rl-durable-recovery):** the port
  gained the public stuck-claim sweep `UnitOfWork.outbox.recoverInFlight(at)`
  — the persistence-side port of the edge outbox's `recoverInFlight`
  semantic: every DELIVERING record moves back to PENDING due exactly at
  `at` WITHOUT consuming its retry budget (crash recovery is not a failed
  delivery attempt); payload bytes/digests are untouched (idempotent
  replay verifies the digest; obligations are idempotency-keyed,
  RL-LOCK-014, so redelivery is at-least-once and safe); terminal states
  (DELIVERED/FAILED) are never resurrected; the sweep is transactional
  (a concurrent delivered outcome wins the race as the typed
  ConflictError). The PostgreSQL driver mirrors the same shared pure
  transition (`recoverStuckOutboxRecord`) over locked DELIVERING rows.
  The sweep must be called only when no live worker still holds claims
  (crash/restart discipline — the record carries no claim timestamp to
  filter by age, so the honest semantic is the full operator-visible
  sweep). CS-4 now verifies the restart continues and completes the
  obligations through the sweep.

*(RL-073's DEFECT-1 — batched inbox drains could not progress past the first
batch — was REMEDIATED by the AR-008 / RL-094 batch-progression fix on
work/rl-durable-recovery; CS-3 now pins the bounded-drain expectation and
the former unbounded-drain workaround is obsolete. Ownership recorded with
the load suite and the accepted-risk registry.)*

## 4. Honest gaps

1. **Real-database semantics.** The persistence ports are exercised through
   the deterministic in-memory adapter (the contract a PostgreSQL driver
   implements). Real-database crash-recovery nuance (WAL replay, fsync
   ordering, page-level torn writes) is out of scope for an in-process suite;
   the PORT discipline (UnitOfWork atomicity, optimistic concurrency, typed
   conflicts) is what is verifiable here and is verified, including under
   injected commit failures.
2. **No SQL migrations exist yet.** `infra/migrations/` is scaffolded with
   the runner contract only; M-1..M-6 verify the RUNNER semantics (the port
   a driver implements). When real SQL migrations land, the same suites
   apply by swapping the ledger/migration list.
3. **Multi-process concurrency.** Crash injection is single-process (the
   deterministic model). True concurrent multi-worker races (two workers
   claiming the same record) are covered at the CONTRACT level (typed
   `ConflictError` on CAS paths, proven in CS-4/CS-5 and RL-071), but a
   multi-process orchestrator test is deployment work not present on this
   tree.
4. **Point-in-time restore granularity.** The verified restore is a
   whole-state import (the backup/restore semantics the public contracts
   expose). PITR (transaction-log replay to an arbitrary instant) is a
   storage-engine capability, not expressible through these ports.
5. **Health-check authenticity.** H-2/H-4 verify the COMPOSITION's honesty
   (garbage/throwing checks are down; real degradation surfaces; recovery
   heals). Whether production check implementations themselves measure the
   right things per deployment is an operational review concern; the
   contract-level fail-closed behavior is what is mechanically provable.

## Operational record — 2026-09-26 (the quota-blocked deploy window and the git-link remediation)

The `api-deployments-free-per-day` quota (100/day, account-wide) exhausted
at ~02:55 UTC 2026-09-26 while main carried two merged, gated waves
(PA-020 @ 45a446e, PA-023 @ 9d10ec59) not yet deployed — a RECORDED
deployment lag with a material delta (unlike the earlier neutral lag the
RL-118 record describes). Remediation: the Vercel project was linked to
the GitHub repository (production branch `main`) at 03:24 UTC, enabling
push-triggered production deploys on the git-integration path (a quota
bucket separate from API creates). Sequencing impact recorded honestly:
PA-021 (deployed browser acceptance) was held behind the deploy;
deploy-independent work orders (PA-024) continued. The quota resets at
~04:00 UTC 2026-09-27 regardless.

### Correction (2026-09-26, later the same hour — the honest-record discipline)

The remediation paragraph above was written on a wrong premise and is
superseded by this note (kept additive; the record does not rewrite
itself). The facts established after full diagnosis:

- The alias `roamlink-ten.vercel.app` is owned by the `roamlink` project
  (`prj_ZnOFB8LA...`), which has ALWAYS been the real production pipeline
  (GitHub integration, rootDirectory `apps/portal-host`, production
  branch `main`). The earlier `roamlink-ten` project deploys (including
  every v13 `gitSource` API create this campaign recorded as "deployed")
  were EMPTY no-op builds on an unconfigured project — the live
  verifications that followed them were, in truth, verifying the
  `roamlink` project's git-auto-deployed production of the same commits.
- The actual blocker for deploying current main (`10dbe80`, PA-020 +
  PA-023 merged) is the free-tier DEPLOYMENT RATE LIMIT on the `roamlink`
  project: the commit status reads "Deployment rate limited — retry in 24
  hours" (visible on the commit's Vercel status; the blocked webhooks do
  not retry). Production therefore serves `7b3f6a7` (the pre-PA-020/023
  docs head) until the limit resets (~2026-09-27 04:00 UTC).
- The remediation that actually works when the limit resets: ANY new push
  to `main` triggers the production deploy (the integration is healthy —
  branch pushes deployed previews minutes before the limit clamped).
- The diagnostic branch `deploy/main-current` was deleted after the
  diagnosis (the blocked webhook will not retroactively deploy it).
