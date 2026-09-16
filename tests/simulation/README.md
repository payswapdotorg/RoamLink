# @roamlink/tests-simulation

The RL-071 **failure/reordering/duplicate simulation suite**: deterministic
end-to-end failure-mode simulations across the composed public packages,
asserting ARCHITECTURAL invariants (no duplicate effects, no fabricated
truth, no lost work) — not just the absence of exceptions.

## The world

`src/harness.ts` composes the real packages exactly like production
composition would, with no ADCOS internals (only the §10 fake):

```
FakeAdcos (duplicates/reorder/drop/delay/fault knobs)
  -> signed deliveries -> AdcosWebhookInboxService (admission)
  -> BoundaryWebhookProjector -> projection engine (the §8 boundary writer)
  -> AdcosReconciliationEngine (freshness sweep + inbox drain + canonical repair)
  -> projection reader -> DeliveryEvidenceSource (composition binding)
  -> ConnectivityReferenceService (the honest commerce read model)
```

Everything is driven by the testkit clock/id generators: no sleeps, no
network, no ambient time or randomness.

## Scenarios

| File | Scenario |
|---|---|
| `duplicate-delivery.test.ts` | the same logical command delivered twice at EVERY boundary (intent adapter timeout + re-issue, webhook duplicateFactor=2, commerce order/payment envelopes, reconciliation job re-runs, edge outbox re-enqueue) — exactly one effect everywhere |
| `reordering.test.ts` | webhook events delivered REVERSED: the projection ordering defense skips outdated events, the final projection equals the in-order outcome (convergence), and no invented event identity ever appears |
| `loss-repair.test.ts` | dropped events and silent canonical changes: the reconciler repairs projections from the canonical read (digest-verified, AUTHENTICATED provenance, freshness re-established); never-observed resources are discovered and projected; transient read failures DEFER honestly |
| `delay-staleness.test.ts` | freshness decays FRESH -> STALE monotonically; delayed events carrying newer truth still apply; the commerce read model re-evaluates evidence freshness at the QUERY instant and relinking a repaired observation returns to FRESH |
| `partition-convergence.test.ts` | the edge offline round-trip: enqueue while partitioned, exponential backoff, nothing lost, convergence exactly once; UNKNOWN sync outcomes re-deliver and the server's idempotency-key dedupe absorbs the duplicate |
| `partial-failure-atomicity.test.ts` | UnitOfWork atomicity (business write + outbox enqueue commit together or not at all; a losing race leaves nothing) and the transactional outbox delivery loop (bounded retries, exactly-once effect) |
| `byzantine-inputs.test.ts` | forged/malformed webhooks (tampered signature, stale timestamp, unknown key, wrong environment, extra envelope members, dropped headers, oversized payloads, event-id mismatch) rejected AT ADMISSION; ADCOS schema drift (unknown lifecycle vocabulary, stripped resource_version) fails the §9 compatibility gate CLOSED for mutations while reads stay diagnosable |
