# @roamlink/integration

The ADCOS integration adapters (RL-031 + RL-032): the client-seam
implementation and the RoamLink-facing adapter surface over the pinned ADCOS
Developer API v2 contract from `@roamlink/adcos`.

## What lives here

| Module | Responsibility |
|---|---|
| `src/transport.ts` | The HTTP transport port (`AdcosTransport`), the fetch-based implementation, typed transport failures (`AdcosTransportError` with `not-sent` / `unknown` outcomes) and closed error-body parsing. |
| `src/client-impl.ts` | The `AdcosClient` implementation: one method per v2 route from the closed route table, canonical JSON request bytes, idempotency-key enforcement on every mutation, fail-closed response validation. |
| `src/error-mapping.ts` | The closed ADCOS→RoamLink failure adaptation: all 18 ADCOS error codes + transport outcomes onto the Wave-0 error taxonomy. No parallel kinds. |
| `src/intent-command.ts` | RL-031 deterministic intent-command mapping: schema validation, policy normalization, hard/soft classification, validity window, canonical serialization + digest, v2 request + §5 envelope construction, retry drafts. |
| `src/intent-adapter.ts` | RL-031 submission + reads: compile → submit → resubmit (same idempotency key, bumped retry metadata); intent/lifecycle reads. |
| `src/command-context.ts` | Shared §5 command construction for all non-intent mutations with deterministic idempotency-key derivation. |
| `src/offer-reservation-adapter.ts` | RL-032 offer/reservation surface: offers selection, contract activation/termination, lease grant/renew/revoke (reservations = v2 leases), usage/assurance/lifecycle reads; typed `route-unknown` degradation for offers discovery and billing/commercial reads. |
| `src/compatibility.ts` | The §9 compatibility gate: endpoint/schema availability, version compatibility, lifecycle-state vocabulary, closed schemas/enums, webhook signature semantics, idempotency replay probe; fail-closed mutation guard. |

## Key invariants

- **Determinism**: the same intent command input (+ instant + ids) always
  produces the same canonical request bytes, digest and idempotency key
  (`@roamlink/contracts` canonical JSON).
- **Retry safety** (RL-LOCK-014): timeouts surface as `unknown-state` (safe
  re-issue), connection loss as `unavailable`; the derived idempotency key
  absorbs duplicate delivery — re-issuing the same logical command cannot
  create a duplicate effect. Retry policy belongs to the caller / durable
  outbox (`@roamlink/persistence`), not to the adapters.
- **Compatibility gate** (§9): mutations fail closed until the startup check
  passes; incompatible versions produce a diagnosable health report. Reads
  remain available for diagnosis.
- **Closed surface** (RL-LOCK-002): routing comes only from the v2 route
  table; surfaces v2 does not expose (offers discovery, billing/commercial
  reference reads) degrade to typed `route-unknown` errors — never invented
  fields, never undocumented endpoints.
- **Authority** (RL-LOCK-001): ADCOS owns connectivity semantics; this
  package maps and projects nothing on its own (projections are RL-034 in
  `@roamlink/projections`).

## Test double

`test/fake-adcos.ts` implements the same public `AdcosClient` interface with
fault knobs for duplicates, reordering, delayed/dropped webhook events,
transient failures and silent canonical-state changes
(spec/adcos-integration.md §10). No test depends on ADCOS internals.

## Not here

- ExperienceIntent → intent-command compilation (RL-012, experience domain).
- Webhook admission/verification (RL-033, `@roamlink/webhook-inbox`).
- Projections (RL-034, `@roamlink/projections`) and reconciliation (RL-035).
