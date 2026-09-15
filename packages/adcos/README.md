# @roamlink/adcos

The ADCOS public-client contract (RL-030). **CONTRACT TYPES ONLY** for the
ADCOS Developer API **v2.0** public surface - the version pin, request
headers, environments, the closed route table, typed request bodies, the
contract state machine, the webhook contract, the error taxonomy,
pagination, and the typed client/verifier seams. No HTTP code, no client
behavior, no fake server (RL-031+ later waves).

This package is the ONLY production integration boundary to ADCOS
(RL-LOCK-001/002, ADR-0001). It depends only on `@roamlink/contracts`.

## v2 reality that shapes this package

- **Contracts + leases, not sessions/paths.** The v2 public surface exposes
  intents, CONTRACTS (accepted-offer results), LEASES, webhook endpoints and
  deliveries. There is NO session or NetworkPath resource type in the public
  API, and none is modeled here (RL-LOCK-004/005). Session/path-ish read
  models are future projections (RL-034) derived from contract
  lifecycle/usage/assurance reads - tracked by the TL as a pin.
- **Response field layouts are opaque.** The verified v2 facts pin the
  pagination envelope, the contract states, the execution statuses, the
  webhook envelope and the error taxonomy - not per-resource response
  fields. Route responses are therefore nominal opaque document types
  (`documents.ts`); RL-031+/RL-036 pin concrete schemas additively.

## Surface

| Module | Provides |
|---|---|
| `version` | `ADCOS_API_VERSION = "2.0"` - the single-site version pin |
| `headers` | the 4 request header names + typed required/mutation header records |
| `environments` | `sandbox` \| `production` + the fail-closed `environment-mismatch` check |
| `errors` | the closed 18-code error taxonomy with pinned retryable flags + `AdcosApiError` |
| `routes` | the closed 21-route v2 table (method, path, operation, mutation) |
| `pagination` | next_cursor model: `AdcosListQuery` (limit 1..100 default 20, cursor, equality filters) + `AdcosPage<T>` |
| `contract-state` | the 13-state contract machine + legal-transition table; the 8-value execution-status vocabulary |
| `requests` | typed v2 request bodies + validating parsers (closed/open schemas exactly per the verified facts) |
| `documents` | route-nominal opaque response document types |
| `webhooks` | 9 event types, the closed event envelope, 7 delivery headers, HMAC-SHA256 signature message, 300s replay window, retry backoff (60/300/1800/7200/21600s, max 6 attempts) |
| `client` | the `AdcosClient` interface: one method per route, idempotency key required on mutations, environment-scoped |
| `webhook-verifier` | the typed `WebhookVerifier` interface: signature + timestamp window + dedupe key extraction |

## Key design decisions

- **Fail-closed everywhere.** Unknown enum members are rejected by the
  parsers (closed vocabularies); environment mismatches throw
  `AdcosEnvironmentMismatchError` carrying the ADCOS `environment-mismatch`
  code; envelope API versions outside the pin are rejected.
- **Idempotency is structural.** `AdcosMutationContext` requires the
  idempotency key (RL-LOCK-014); the mutation header record type makes a
  mutation-header set without the key uncompilable.
- **The typed seams carry the authority boundary.** `AdcosClient` exposes
  exactly the v2 routes - a conformance test asserts no session/path surface
  leaks in (RL-LOCK-018: tests prove architecture).
- **No premature adaptation.** `AdcosApiError` carries the ADCOS code and its
  pinned retryable flag; mapping to RoamLink error kinds belongs to the
  adapters (RL-031+), not the boundary.
- **Documented derivation points.** The contract legal-transition table (from
  the canonical lifecycle), the derived route operation names, the
  termination_request field names, and the signature-message separator are
  derived/assumed where the verified facts were silent - each is flagged in
  source and in the RL-030 report for TL confirmation.

## Consumption notes

- Exports TypeScript source (`src/index.ts`), erasable-syntax-only, same
  internal-package pattern as `@roamlink/contracts`.
- Parsers accept `unknown` (post-`JSON.parse` values) and throw typed
  `ValidationError`s naming field paths, never values (RL-LOCK-016).

## Scope guard

This package must not gain HTTP/transport code, ADCOS fake-server behavior
(RL-036 test double), projection logic (RL-034), or mapping logic (RL-031).
It models the public contract; it never becomes a second connectivity
authority (RL-LOCK-001/004/005).
