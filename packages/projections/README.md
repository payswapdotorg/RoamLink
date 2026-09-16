# @roamlink/projections

The ADCOS projection engine (RL-034): canonical-resource projections with
provenance, freshness and evidence (spec/adcos-integration.md §7/§8).

## Record shape (spec §8, exact)

```
projection_id            deterministic: prj.<resource_type>.<canonical_id>
source_authority         "adcos" (this store) | "roamlink"
canonical_resource_type  closed vocabulary: the v2 canonical resources
canonical_resource_id    the ADCOS resource reference
source_version           event/resource version when known, else null
event_id                 the originating webhook event id when known, else null
payload_digest           SHA-256 over the canonical payload JSON
observed_at              when ADCOS observed the state (event occurred_at / read instant)
received_at              when RoamLink received the observation
fresh_until              freshness guarantee horizon (received_at + policy TTL)
freshness_state          FRESH | STALE | UNKNOWN (honestly evaluated)
evidence_class           the frozen vocabulary from @roamlink/contracts
projection_version       monotonic per-record revision (optimistic concurrency)
payload                  the projected canonical snapshot (opaque JSON)
```

There is deliberately **no session or NetworkPath resource type**
(RL-LOCK-004/005): session/path-ish read models derive later from lifecycle,
usage and assurance reads; they are not canonical v2 resources.

## Modules

| Module | Responsibility |
|---|---|
| `src/projection-record.ts` | The closed §8 record shape, the canonical-resource vocabulary, validation and the deterministic projection identity. |
| `src/projection-store.ts` | The `ProjectionWriter` (integration-boundary only) and `ProjectionReader` (everyone else) ports + the deterministic in-memory adapter with optimistic-concurrency writes. |
| `src/projection-engine.ts` | `AdcosProjectionEngine`: event-driven projection (verified webhook signals), canonical-read projection, out-of-order/idempotency ordering defense, freshness TTL policy, `markStale`/`markUnknown` degradation and `refreshFreshnessStates` (monotone FRESH → STALE). |

## Ordering rules

- Event with `source_version` **lower** than the applied one →
  `SKIPPED_OUTDATED` (late/reordered delivery never regresses state).
- **Equal** `source_version` → `SKIPPED_SAME_VERSION` (idempotent no-op; the
  first observation at that version wins).
- **Higher** version → applied, `projection_version` +1.
- A **versionless canonical snapshot** (v2 documents are opaque — no fields
  may be invented) applies as an authoritative refresh, but an event that
  *occurred before* the snapshot's observation is still skipped.

## Degradation (never guess)

When the canonical source is unreachable, the reconciler (RL-035) calls
`markStale` (known prior state, guarantee voided) or `markUnknown` (truth
unobtainable; last-known payload retained without a guarantee). Absence of a
record is already the unknown state (`NO_RECORD`). `refreshFreshnessStates`
performs the monotone FRESH → STALE transition when guarantees expire.

## Authority

Only this engine writes ADCOS-derived projections (spec §8: "Only the
reconciler/integration boundary may write"). Webhooks are signals, not truth
(RL-LOCK-009): event projections carry the authenticated envelope; canonical
bodies arrive via `projectCanonicalRead` when the boundary fetches them.
Periodic repair/canonical-refresh scheduling is the reconciliation engine's
job (RL-035) and composes with `@roamlink/webhook-inbox`'s
`AdcosWebhookProjector` port at the service layer.
