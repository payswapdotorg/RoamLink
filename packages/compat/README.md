# @roamlink/compat

The ADCOS compatibility suite (RL-036, spec/adcos-integration.md §9).

The executable form of the §9 startup compatibility gate. The supported
ADCOS contract version is configured in ONE place — `ADCOS_API_VERSION` in
@roamlink/adcos — and a suite check proves it agrees with the
`SUPPORTED_ADCOS_API_VERSIONS` env pin in @roamlink/contracts.

## What the suite verifies

`runAdcosCompatibilitySuite({ client, probe, webhookSemantics, at, state })`
composes the Wave-2 gate (`runAdcosCompatibilityCheck` from
@roamlink/integration) and extends it:

| §9 requirement | Checks |
|---|---|
| endpoint/schema availability | `application_self.available`, `intent_get.available`, `intent_lifecycle_get.available`, `contract_get.available`, `contract_usage_get.available`, `lease_get.available` (Wave-2 gate, probe-gated) |
| version compatibility | `application_self.available` (client pin) + `version_pin.single_site` (one-place pin consistency) |
| required lifecycle states | `contract_lifecycle_states.required` (pinned 13-state vocabulary, Wave-2) + `lifecycle_state_vocabulary.server` (the SERVER's documents speak the pinned vocabulary) |
| required fields/enums | `request_schemas.closed`, `webhook_envelope.closed` (Wave-2) + `document_required_fields.resource_version` (server documents carry the reconciliation ordering field) |
| signature/webhook semantics | `webhook_signature_semantics.pinned` (Wave-2) + `webhook_verifier_semantics.accepts_valid` / `rejects_tampered_signature` / `rejects_stale_timestamp` / `rejects_unknown_key` + `webhook_signature_semantics.hmac_known_answer` + `webhook_delivery_verifies.server` (an OBSERVED server delivery verified end-to-end) |
| idempotency behavior | `idempotency_behavior.replay` (same-key replay returns the identical response) |
| fail closed for mutations | `mutation_gate.fail_closed` — the runtime gate refuses mutations while unverified/incompatible and opens only on a compatible report |

Every check result is diagnosable (name + pass/fail + log-safe code/detail,
RL-LOCK-016: values and secrets never appear). Incompatible ADCOS versions
fail closed for mutations: pass an `AdcosCompatibilityState` to the suite and
adapter mutations are refused with `ADCOS_COMPATIBILITY_GATE_CLOSED` (or
`ADCOS_COMPATIBILITY_GATE_UNVERIFIED` before the first run).

## Test-double discipline (§10)

The suite runs against ANY public `AdcosClient` — the local fake in tests
(implements the same public interface; simulates duplicates, reordering,
delayed events, dropped events, transient failures and canonical-state
changes) and real sandbox/production clients at startup. No test depends on
ADCOS internals (`test/test-double.test.ts` proves it at the type level and
by scanning the fake's imports).

## Dependencies

`@roamlink/contracts`, `@roamlink/adcos` (public types + pinned constants),
`@roamlink/integration` (the Wave-2 gate + runtime state),
`@roamlink/webhook-inbox` (the pinned HMAC verifier), `@roamlink/testkit`.
