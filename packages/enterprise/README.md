# @roamlink/enterprise — the enterprise onboarding/API surface (RL-063)

The enterprise customer journey + public API surface (spec/api.md, the
RL-044 edge-connector contract): organization enrollment, tenant federation
(reference-only identity), enterprise API keys with scoped service
authorization through the secrets boundary, connector provisioning
(managed-edge enrollment flows), the RoamLink-side customer webhook
contract, and the typed `/v1/enterprise/...` API.

## Authority discipline

- The organization/user/membership aggregates stay owned by
  `@roamlink/auth` — the enrollment journey only binds the tenant
  **provisioned through the registrar port** (RL-LOCK-003/019). Enrollment
  state is its own closed vocabulary (`draft -> submitted -> verified ->
  active | rejected | cancelled`), never the organization status vocabulary.
- Tenant federation is **reference-only**: protocol + issuer reference +
  lifecycle. The record is structurally incapable of carrying identity
  material or authenticating anyone (negative proofs in
  `test/federation.test.ts`).
- API keys: the record carries a typed reference into the RL-050 secrets
  boundary (`keyRef`) — never material. Material is generated once,
  verified in constant time, rotated by appending secret versions (pinned
  consumers keep working until retirement), and never appears in records,
  audit events or errors (proven with the RL-054 secret scanner).
- Customer webhooks emit **only from validated RoamLink durable state
  transitions** (RL-LOCK-009): the closed single-member origin vocabulary,
  the closed RoamLink aggregate-type vocabulary (drift-guarded against
  `@roamlink/notifications`) and the REQUIRED durable event id leave no
  shape for a raw ADCOS payload to pass. Every delivery is HMAC-SHA256
  signed with a replay window in both directions, per-endpoint monotonic
  sequences, event-id dedup, bounded retries and dead-lettering.
- Connector provisioning uses the RL-044 closed vocabularies **directly**
  (`@roamlink/edge-connector`) — never redefined. The guaranteed
  degradation floor (observation + user-guided actions) provisions honestly
  with `user-guided` / `observation-only` operating modes.

## The public API surface (RL-LOCK-017)

`src/api-surface.ts` + `src/api-client.ts` + `src/api-fake.ts`:

- the typed `/v1/enterprise/...` route table (additive within a major);
- fail-closed wire-resource parsers (unknown fields are rejected; additive
  tolerance is governed by the record contract version — older minors
  parse, newer minors fail CLOSED, different majors never parse);
- the four-stage mutation acknowledgement mirror (drift-guarded against
  `@roamlink/app-kit`'s owner contract);
- the typed `EnterpriseApiClient` over an injectable transport — every
  mutation carries the full command header set (request/correlation/
  idempotency ids + the presented API key);
- the deterministic in-memory fake binding the routes to the REAL services
  with the request discipline enforced in order: authenticate (401, no
  state touched) -> authorize the route scope (403, no state touched) ->
  command envelope (400) -> idempotent execution.

## Layout

| File | Responsibility |
|---|---|
| `enrollment.ts` / `onboarding.ts` | The journey record + state machine; the service (registrar port, audit, idempotent commands) |
| `federation.ts` | Reference-only tenant federation configuration |
| `api-keys.ts` / `api-key-service.ts` | Scoped service authorization through the secrets boundary |
| `connectors.ts` | Connector provisioning + managed-edge enrollment records |
| `webhooks.ts` | The customer webhook contract + dispatcher |
| `stores.ts` | Deterministic in-memory stores + the registrar fake |
| `version.ts` / `ids.ts` | Contract versioning + branded identifiers |

## Known limitations / follow-ups

- Federation assertion verification (the auth-boundary verifier) is future
  auth-domain work; this package records configuration only.
- Durable stores (RL-003 persistence adapters) and the real HTTP service
  (`services/api`) are Wave-5 composition work; the in-memory fake
  implements the same contract semantics for tests and local dev.
- Webhook retry scheduling across processes (the in-process dispatcher is
  bounded and honest: failed -> retryable, exhausted -> dead-lettered) is
  deployment-platform work.
