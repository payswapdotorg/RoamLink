# @roamlink/api-service

The authenticated public API/BFF composition (RL-090): ONE framework-free
handler over the app-kit `HttpRequest`/`HttpResponse` contract. Hosts
(`apps/portal-host`, RL-089) translate transport and nothing more — route
handlers never touch the database (spec/deployment.md §4:
`HTTP -> application command/query -> domain/integration -> persistence`).

## What the boundary really does

| Route | Behavior |
| --- | --- |
| `GET /v1/readiness` | **Composed readiness surface (RL-100)** — unauthenticated (load balancers/smoke probe it). Aggregates the REAL per-dependency probes bound at composition (each through its provider port) into the honest vocabulary `ready \| degraded:<dependency,...> \| not-ready:<reason,...>`; 200 for ready/degraded (servable), 503 for not-ready. REQUIRED dependencies (the PostgreSQL source of truth, the migration ledger) being down is not-ready; an OPTIONAL accelerator/transport (Redis/QStash/R2) being down only ever degrades — its absence can never fail readiness for correctness it does not own (deployment.md §7). Probes are re-run on EVERY request (never a boot snapshot, never a business-event inference); with no checks bound the endpoint honestly answers `not-ready:composition`. |
| `POST /v1/webhooks/adcos` | Webhook ingress: HMAC verify (pinned v2 contract) -> durable inbox admit + persist. The route ONLY admits and persists — projection/processing stays in the workers (RL-LOCK-009). Body is the byte-exact delivery payload (never re-serialized before verification). Signed deliveries: 202 ADMITTED/DUPLICATE; rejections: 401 (signature/auth/timestamp) or 400 (version/environment/size) with the closed ADCOS error codes. |
| `POST /v1/auth/session` | Password login through the `@roamlink/auth` boundary (envelope-gated, idempotent under RL-LOCK-014). The opaque token appears exactly once in the response; the host turns it into an httpOnly cookie. Every failure is the SAME 401 (no account existence oracle). |
| `GET /v1/users/me` | The authenticated principal view (from the verified session). |
| `POST <mutation routes>` | Durable command ingestion (see below): validates the full header envelope, authorizes actor->tenant, dedupes on the idempotency key, stores the command + enqueues the delivery obligation in ONE real unit of work, answers the four-stage acknowledgement with `acceptedAt` present and later stages absent. |
| `GET /v1/commands/{commandId}` | The stored-command acknowledgement view (tenant-scoped; cross-tenant reads are 404 — no existence oracle). |
| `GET <spec read routes>` | `501 READ_MODEL_NOT_COMPOSED` — the read models are not composed on the real runtime in this wave; the service invents NO data. The deterministic fake API (app-kit) remains the contract reference for those reads. |

## Command ingestion semantics (RL-LOCK-014)

- the header envelope (request id, correlation id, idempotency key, actor id,
  tenant id, optional optimistic version) is validated BEFORE any state is
  touched; the actor header is cross-checked against the authenticated
  session (headers are transport context, never an authorization grant);
- authorization is `@roamlink/auth`'s `AuthorizationService.resolveActorTenant`
  (fail-closed on unknown tenants, missing/revoked memberships, suspended
  organizations — the org-reactivation escape is scoped to its own use case);
- replaying the same idempotency key with the same command digest replays the
  recorded acknowledgement with NO additional effect; the same key with a
  different digest is the typed conflict (never a silent overwrite);
- the command record (repository `api-commands`, keyed by commandId) and the
  key->commandId pointer (`api-command-keys`) plus the outbox delivery
  obligation commit atomically — one real database transaction;
- the acknowledgement's stage timestamps are individually absent until the
  stage is actually reached: `accepted` now, `executed`/`delivered`/
  `billable-final` only when composed execution (workers, RL-107+) records
  them. Nothing collapses, nothing lies.

## Composition (what the host must inject)

```ts
const service = createApiService({
  persistence,          // REAL persistence: UnitOfWorkFactory + PersistenceReader
  identity: { users, directory, credentials, sessions, memberships, organizations, ledger, hasher },
  webhookVerifier,      // HmacWebhookVerifier over the server-side key registry
  now,                  // explicit clock
  newId,                // canonical lowercase UUIDs
});
```

The identity stores are the auth package's tenant-scoped repository ports;
the hosted composition binds them until the identity/schema persistence
adapters land (the session/credential stores are the documented durability
gap of this wave — see "Honest gaps").

## Honest gaps (never faked)

- **Read models** (devices, intents, commerce, connectivity, notifications,
  audit, reconciliation, projection health) answer `501
  READ_MODEL_NOT_COMPOSED`. No fake data is served in the hosted runtime.
- **Domain command execution** is not composed here; commands are durably
  accepted and queued (durable outbox) for the worker wave (RL-107). The
  acknowledgement honestly stops at `accepted`.
- **Identity durability**: the injected identity stores are currently bound
  to the auth package's in-memory adapters; a process restart drops sessions
  until the identity store adapter (next wave) makes them durable. The
  command/webhook paths ARE durable (real PostgreSQL).
- **Outbox delivery** (the worker that consumes the command queue) is
  RL-107's deliverable; records stay PENDING until then (visible, honest
  backlog).
