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

## Edge hardening (RL-105)

The dispatch above is composed behind a hardened edge wrapper — additive to
the handler table, changing no envelope/idempotency/authorization semantics:

- **Admission control (rate limiting).** A bounded per-bucket rate limit runs
  BEFORE dispatch (`GET /v1/readiness` is exempt — load balancers probe it).
  Bucket keys are route-classed with a per-principal hint:
  `webhooks-adcos.<delivery key id|anonymous>`, `auth-session`, and
  `api.<actor header hint|anonymous>` (the actor header is transport context,
  never an authorization grant — the session decides the actor after
  admission). A declined admission answers the TYPED 429 through the single
  error mapping: kind `rate-limited`, `retryAfterMs` in the body and the
  standard `retry-after` response header. Binding law (never a silent
  downgrade):
  - a distributed limiter bound at composition (the provider-redis
    `DistributedFixedWindowLimiter` over the ephemeral-coordination port) is
    the production shape — readiness reports `rate-limit` healthy;
  - with no limiter bound, NON-production modes compose the honest in-memory
    sliding-window fallback, emit a loud composition log line
    (`rate_limit_binding`, binding=in-memory) and report `degraded:rate-limit`;
  - PRODUCTION mode with no limiter bound REFUSES the fallback: rate limiting
    is disabled (never a quiet single-process downgrade) and the readiness
    surface carries `degraded:rate-limit` with the reason.
- **Correlation + structured request logging.** Every request resolves a
  correlation id (the envelope's `x-roamlink-correlation-id` header when it
  is a valid foreign-reference, generated at the edge otherwise), establishes
  the observability correlation context for the whole dispatch, echoes the id
  on every response, and emits ONE redacting structured log record per
  request (`http_request`: method, path, status, durationMs) through
  `@roamlink/observability`. Headers, bodies and credentials never enter a
  record (RL-LOCK-016).
- **Ingress body cap.** Every body over the edge cap (default 1 MiB,
  `edge.bodyLimitBytes`) is refused with the typed 413
  (`reason: PAYLOAD_TOO_LARGE`) BEFORE any handler or authentication runs.
  The webhook policy keeps its own, stricter bound inside.

Composition options (all additive, honest defaults):

```ts
createApiService({
  ...,                          // the existing bindings
  mode: "production",           // default "development"
  edge: {
    rateLimiter,                // the distributed limiter (composition root binds it)
    rateLimitWindowMs: 60_000,  // in-memory fallback window
    rateLimitMaxCost: 600,      // in-memory fallback budget
    bodyLimitBytes: 1_048_576,  // ingress cap
    logSink,                    // default: JSON lines on console
    logLevel: "info",
  },
});
```

Hosts compose `resolveApiRateLimitBinding(mode, edge)` (the same resolution
law the service uses) with `rateLimitReadinessCheck(binding.state)` in their
readiness bindings — one truth for admission control, surfaced honestly.

### Honest gaps (unchanged by RL-105)

- **Identity durability** — the injected identity stores are still the auth
  package's in-memory adapters (a persistence-backed identity store is its
  own work item class; the command/webhook paths remain durable PostgreSQL).
- **Read models** — still the honest `501 READ_MODEL_NOT_COMPOSED`; composing
  them is not this item.
