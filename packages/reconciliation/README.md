# @roamlink/reconciliation

The ADCOS reconciliation engine (RL-035, spec/adcos-integration.md §7).

A `ReconciliationJob` orchestration that periodically compares projection
freshness against canonical ADCOS resources and repairs:

| §7 repair class | Mechanism |
|---|---|
| missed webhooks | freshness expiry + resource discovery trigger canonical reads that re-apply authoritative truth |
| duplicate webhooks | the scan verifies projections against canonical truth; duplicates are provably effect-free (`ALREADY_CONSISTENT`) |
| out-of-order events | the projection engine's ordering defense skips late events; canonical refresh converges to the newest version |
| stale projections | the freshness sweep flips expired FRESH records to STALE; canonical re-observation renews the guarantee |
| partially applied projections | payload/digest mismatch (torn writes) triggers an authoritative replacement; admitted-but-unprojected inbox records are drained idempotently |
| transient ADCOS/API failures | bounded in-job retries; exhaustion degrades to STALE/UNKNOWN and the next job retries |

When canonical truth cannot be obtained, projections degrade to `STALE` or
`UNKNOWN` — the system never guesses (RL-LOCK-010). ADCOS remains the
connectivity authority (RL-LOCK-001): the reconciler only READS canonical
resources; it never mutates ADCOS and never redefines lifecycle semantics.

## Boundary (spec §8)

Only the reconciler/integration boundary writes ADCOS-derived projections.
`createAdcosReconciliationBoundary` is that boundary as one composition point:
it constructs the Wave-2 projection engine over the raw store with the write
capability captured in a closure, binds the durable webhook inbox to a
boundary-owned projector (RL-033 → RL-034 inside the boundary), and exposes
only read surfaces plus the reconciler. Architecture tests
(`test/boundary-enforcement.test.ts`) fail the build when a non-boundary
package imports the projection writer surface (RL-LOCK-018).

## Job model (§5 idempotency, RL-LOCK-014)

Jobs are durable records on the @roamlink/persistence primitives (named
repository `adcos-reconciliation-jobs`, optimistic concurrency) carrying the
full §5 command metadata (command/job id, correlation id, idempotency key,
actor/tenant, created_at, retry metadata). Re-running a job by id after a
crash converges: a COMPLETED job replays its recorded outcome with zero new
effects; a FAILED/RUNNING(`resume: true`) job re-runs with every effect
idempotent (projection writes are version-guarded; inbox processing is
status-guarded).

Closed vocabularies: job statuses (`PENDING → RUNNING → COMPLETED | FAILED`,
COMPLETED terminal, FAILED retryable), trigger reasons (`scheduled`,
`startup`, `manual`, `crash-recovery`), action types (`FRESHNESS_SWEEP`,
`INBOX_DRAIN`, `DISCOVERY`, `CANONICAL_REFRESH`) and action outcomes
(`REPAIRED`, `ALREADY_CONSISTENT`, `DEGRADED_STALE`, `DEGRADED_UNKNOWN`,
`CANONICAL_ABSENT`, `DEFERRED`, `FAILED`).

## Honest-state decisions (documented)

- **Freshness renewal** re-applies the same-version canonical document as a
  versionless authoritative snapshot: observed_at/received_at/fresh_until
  advance and `source_version` becomes `null` (honest lineage after
  renewal); the observation instant gates late events, so ordering stays
  safe.
- **Partially applied records** (payload no longer digests to
  `payload_digest`) are repaired by an authoritative replacement that is NOT
  gated by the (untrustworthy) recorded version. If truth is unreachable
  they degrade to `UNKNOWN` with the payload retained for diagnostics.
- **Canonical absence** (`resource-unknown`) is truth, not degradation: the
  prior payload is retained and ages to STALE through the normal freshness
  sweep; the job action records `CANONICAL_ABSENT`. (The §8 record shape is
  closed — there is no tombstone field, and none is invented.)
- **Compatibility gate closed** (unknown/incompatible, RL-036): canonical
  fetches defer entirely (zero client reads — a foreign-version document
  must never be projected) while local degradation still happens via the
  sweep.

## Scheduler

`AdcosReconciliationScheduler` runs jobs on an interval through an
injectable timer port (`SystemReconciliationTimer` in production, manual
timers in tests). A failing job never stops the schedule; failures surface
through `onJobError`.

## Dependencies

`@roamlink/contracts`, `@roamlink/adcos` (public types only),
`@roamlink/persistence`, `@roamlink/integration` (transport-error
classification), `@roamlink/projections` (the §8 writer — this package is
the boundary), `@roamlink/webhook-inbox` (the durable inbox),
`@roamlink/testkit` (deterministic clocks/ids).
