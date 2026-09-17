# @roamlink/tests-dogfood

The RL-072 **end-to-end dogfood scenario suite**: full-lifecycle journeys
that compose the REAL packages through their PUBLIC surfaces — the only
external stand-in is the §10 ADCOS fake (RL-LOCK-001/002) — and assert
ARCHITECTURAL truth properties (authority, evidence, freshness, idempotency,
no fabricated truth), never package internals.

## The world

`src/world.ts` composes one deterministic dogfood world per scenario —
exactly like production composition would, driven by the testkit
clock/id generators (no sleeps, no network, no ambient time, no
randomness) and ONE correlation-ID family per scenario:

```
AUTH (RL-004)            AccountAdministrationService / AuthorizationService
EXPERIENCE (RL-010/011)  DeviceRegistryService, ExperienceIntentService
COMMERCE (RL-020-022)    Catalog / Order / Subscription / Payment services
COMPILER (RL-012)        compileExperienceIntent -> ConnectivityIntent command
ADCOS BOUNDARY (RL-031/032) AdcosIntentAdapter + AdcosOfferReservationAdapter
                         over FakeAdcos (§10), behind AdcosCompatibilityState
DATA PLANE (RL-033/034/035) createAdcosReconciliationBoundary: webhook inbox
                         -> projection engine -> reconciler + §8 read reader
REFERENCES (RL-023)      ConnectivityReferenceService (commerce <-> evidence)
NOTIFICATIONS (RL-014)   NotificationService (durable state transitions only)
AUDIT (RL-051)           InMemoryAuditLog (tamper-evident SHA-256 chain)
```

`src/journey.ts` seeds the compressed scenario-1 lifecycle so the
failure-path scenarios start from honestly established connectivity.

## Scenario catalog

| File | Scenario | Architectural assertions |
|---|---|---|
| `scenario-1-onboarding-first-connectivity.test.ts` | tenant + customer -> catalog -> paid order + payment -> intent authoring -> compilation -> submission -> offer/activation/reservation -> webhooks -> projections -> evidence link -> decision -> notification; plus a full idempotency leg | every projection carries `source_authority=adcos`, AUTHENTICATED evidence, canonical refs, digests, FRESH windows (RL-LOCK-010); payment is not delivery — a succeeded payment plus an UNEVIDENCED reference is the honest state until ADCOS truth arrives, and linking evidence before any projection exists is a typed NotFound, never a fabricated delivery (RL-LOCK-008/010); compiler output is technology-neutral with full source-intent traceability (§4); notifications only from durable RoamLink transitions with event-id receipts (RL-LOCK-009); one correlation family end to end; replayed §5 envelopes and replayed ADCOS commands replay original outcomes (RL-LOCK-014) |
| `scenario-2-degradation-failover-recovery.test.ts` | ADCOS degrades SILENTLY (no event) -> device keeps observing honestly -> freshness decays FRESH -> STALE -> desired-state re-planning (intent v2 + failover contract) -> reconciliation repairs the missed signal -> customer relinks to the failover truth; plus an unreachable-truth leg | "unknown" connectivity is recorded as evidence-tagged OBSERVED truth, never fabricated "online" (RL-LOCK-011); stale-while-degraded — the read model shows the AGED last honest observation, never a guessed DEGRADED (RL-LOCK-010); the repair is digest-verified AUTHENTICATED canonical truth that ADVANCES the projection version (no history rewrite); unreachable truth degrades to STALE with bounded canonical-read attempts (RL-035) |
| `scenario-3-offline-edge-roundtrip.test.ts` | the device goes offline -> observation continues -> desired-state actions accumulate in the encrypted outbox -> partition with backoff -> reconnect -> batched sync with a lost ack and a server-side conflict -> resolution -> authoritative results; plus a dead-letter budget leg | ciphertext-only at rest (RL-LOCK-016 discipline); queued shows `pending` — accepted ≠ executed (RL-LOCK-011/014); convergence is exactly-once effects (idempotency-key dedupe absorbs UNKNOWN-outcome re-deliveries, RL-LOCK-014/015); a conflict parks under require-manual and resolves explicitly — never silently overwritten; dead-lettering is bounded work (exactly maxAttempts deliveries, never retried blindly) |
| `scenario-4-refund-incident-correlation.test.ts` | payment failure -> support case -> retry payment + invoice reconciliation -> full refund -> partial refunds on a second payment -> notification -> case closure -> audit; plus a preference-mute leg | payment failure is a typed closed-vocabulary money fact that never mutates order state (RL-LOCK-008); refunds are capped by PROVEN money facts — over-refunds are typed rejections, never silent clamps; the incident is correlated across the case, notifications and audit with ONE correlation family; the customer thread structurally hides internal messages; the audit trail is COMPLETE and tamper-evident (SHA-256 digest chain verifies, queryable by correlation id, RL-051); a preference mute is a durable SUPPRESSED state, never a deletion |
| `scenario-5-enterprise-admin-observation.test.ts` | the enrollment journey through the typed enterprise API client (draft -> submitted -> verified -> active, tenant bound only through the registrar) -> the REAL admin console observes the SAME provisioned tenant over the app-kit public API -> fail-closed privilege boundary -> suspend/reactivate commands | the tenant binds ONLY through the registrar port (auth stays the identity authority, RL-LOCK-003); every enterprise mutation replays idempotently (RL-LOCK-014); onboarding decisions are audited in a chain-verified correlated trail; the admin observes the SAME tenant truth through the same public API both apps consume; a denied actor's command is audited server-side, and a personal-tenant actor is denied every surface WITHOUT fetching its data (the session resolves first — the privilege-escalation threat fails closed) |

## Determinism rules

Every scenario is fully deterministic: testkit clock/ids, one correlation
family, no sleeps, no wall-clock timing, no network. The ADCOS fake is the
only external stand-in; every RoamLink-side package is the real public
surface.
