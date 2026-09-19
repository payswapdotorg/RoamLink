# @roamlink/tests-load

The RL-073 **load/reliability test suite**: deterministic load-shaped
suites that are NOT wall-clock benchmarks — everything runs on the testkit
clock/id generators with no sleeps, no network and no ambient time.
"Load" means VOLUME under CONTROLLED MEASUREMENT:

- **Counting proxies** wrap the PUBLIC ports (the projection store, the
  ADCOS client read surface, the notifications preference reads), so
  complexity invariants are expressed as exact, mechanically-checkable
  operation counts per unit of admitted work;
- **Bounded-behavior proofs** assert caps, budgets and shape invariants
  that hold for ANY input size;
- **Convergence completeness** asserts that high-volume churn loses no
  durable work and duplicates no effects.

The REAL engines run behind the counting decorators (they are
composition-layer proxies over public interfaces — not mocks of RoamLink
logic); the only external stand-in is the §10 ADCOS fake.

## The measured world

`src/harness.ts` composes the §8 reconciliation boundary over a
`CountingProjectionStore` (the public `ProjectionStore` port) with the
deterministic clock, and offers `ingestIntents` to drive N canonical
resources through the fake's public client surface.

## Suite catalog

| File | Suite | Invariants asserted |
|---|---|---|
| `webhook-ingestion-load.test.ts` | high-volume webhook ingestion (thousands of events; duplicates via `duplicateFactor: 2`; full stream reversal) through the inbox -> projections -> read models | **INV-1** N distinct events project with exactly N reads + N writes (O(1) per event — a rescan would show N²/2 reads); **INV-2** duplicates are O(1) admission with ZERO projection work; **INV-3** reordering costs one read per event with zero late writes and converges to the in-order outcome; **INV-4** re-drain touches the projection store ZERO times; **INV-5** exactly one effect per canonical resource with monotone versions. **DEFECT-1 record** (historical, REMEDIATED — AR-008 / RL-094): the inbox drain formerly could not progress past the first batch-limit records of a larger backlog; see below. |
| `sync-churn-notification-fanout-load.test.ts` | sustained edge outbox churn (a 400-record flood through failing rounds and batched reconnect) + notification fan-out under a 300-user preference mute storm | **SYNC-1** convergence completeness: exactly N server effects, byte-identical payloads (no lost durable work, no duplicate effects); **SYNC-2** bounded retry work (only due records re-attempted; totals bounded by rounds × batch); **SYNC-3** every sync pass claims at most its limit; **MUTE-1** K emissions under the mute storm perform exactly 2K per-user preference reads — never O(all-customers). |
| `reconciliation-resilience-load.test.ts` | reconciliation full-canonical-refresh vs incremental over N projected resources (counting client over the public `AdcosClient` port) + resilience under sustained failure | **REC-1** CONSISTENT targets cost ZERO canonical GETs (the freshness guarantee proves consistency; discovery costs a constant 4 list calls independent of N); **REC-2** each NEEDS_REFRESH target performs at most `maxCanonicalReadAttempts` fetches; under sustained outage the sweep degrades every projection honestly to STALE and the scan DEFERS with diagnosable failure codes (never a fabricated FRESH); **REC-3** the incremental/full split is a bounded 0-vs-N GET split; **REC-4** re-running a completed job id replays the outcome with zero additional work; **RES-1** an open circuit breaker rejects without invoking the dependency (500 attempts -> 0 calls), half-open probing admits at most `halfOpenMaxProbes` concurrent probes (saturation rejects fail-closed with `retryAfterMs: null`), failed probes re-open the cooldown; **RES-2** retry budgets cap total attempts at `maxAttempts`; deadline budgets stop work even with attempts remaining; **RES-3** a sliding-window limiter admits exactly `maxCost` per key per window under 1,000-take pressure, with honest retry-after guidance and window healing. |

## DEFECT-1 (recorded — REMEDIATED on work/rl-durable-recovery, AR-008 / RL-094)

**Historical defect:** `AdcosWebhookInboxService.processPending(limit)`
sliced the `ADMITTED` inbox list from index 0 on every call. Admission state
never changed after projection (processing status lives on the extended
record), so with a backlog larger than `limit` the first `limit` records
were re-considered forever and records beyond index `limit` were never
processed.

- **Historical minimal reproducer** (in `webhook-ingestion-load.test.ts`):
  admit 3 valid events, `processPending(2)` twice — the first call applied
  2; the second reported both as `alreadyProjected`; the third event was
  never considered (its extended record stayed PENDING forever).
- **Historical impact**: a webhook backlog > `inboxBatchLimit` (default 50)
  did not drain through repeated `processPending` calls — the reliability
  property "every admitted record reaches a terminal state in bounded
  calls" failed at the inbox level. Projection-level convergence still
  occurred via the reconciler's canonical refresh, so customer-facing read
  models recovered, but the inbox terminal-state invariant was violated.

**Remediation (AR-008, RL-094):** the batch is now the first `limit`
records whose processing status is NOT already terminal. PROJECTED records
are skipped — counted in `alreadyProjected`, never re-projected — WITHOUT
consuming batch slots, so repeated bounded drains ADVANCE: a backlog of N
records drains to completion across ceil(N / limit) successful calls. The
reproducer test now asserts the fixed behavior (the pin flipped; the
historical defect text above is retained for the record).

## Determinism rules

No wall-clock timing, no sleeps, no network, no ambient randomness: every
assertion is an exact operation count or a bounded-behavior proof on the
testkit clock. The generous vitest `testTimeout` is execution headroom for
volume only.

## §11 SLO emission-volume invariants (MVP-3 wiring)

The load harness (`src/harness.ts`) composes the same REAL
`@roamlink/observability` product-SLO plane and wires it into the boundary as
its `sloObserver`. The reconciliation load suite (REC) asserts the emission
volume as a complexity invariant (SLO-E): for N repaired targets the
recorder receives EXACTLY N good automatic-recovery events and N closed
stale-window durations (each the true TTL-expiry age), and NOTHING for
incremental no-ops or idempotent job replays — emission is exactly
proportional to durable repair work, never O(N²) chatter and never
duplicated.
