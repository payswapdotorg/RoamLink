# @roamlink/admin — the RoamLink admin/operations console (RL-061)

Operational read surfaces plus admin commands over the **same public
application APIs** the customer app consumes. The console holds **no parallel
authority**: it is a view + command surface over domain modules
(spec/repository-layout.md), and authorization is enforced by the API — the
console adds a fail-closed *rendering* gate on top.

## Surfaces

| Page | What it shows |
|---|---|
| Tenants (`/`) | The organization tied to the session's tenant: status, revision, members (role/status), suspend/reactivate commands. Cross-tenant management is not a console capability (the confused-deputy threat fails closed with 404 at the API) |
| Audit & security (`/audit`) | The append-only audit event stream with the SHA-256 digest-chain verification banner, closed category filter, actor/tenant/correlation (and command) columns — including `denied` admin commands (the privilege-escalation review surface) |
| Reconciliation (`/reconciliation`) | Durable job records as §5 commands (command/correlation/idempotency) with per-action repair outcomes (REPAIRED / ALREADY_CONSISTENT / DEGRADED_STALE / DEGRADED_UNKNOWN / …) and the manual trigger |
| Projection health (`/projection-health`) | Per-projection freshness facts (FRESH / STALE / UNKNOWN — unknown is displayed, never hidden), SLO states with burn rate and budget remaining; `no-data` renders degraded (never silently healthy) |
| Support triage (`/support`) | Case triage with the OPERATIONS thread view (internal messages visible here, structurally absent from the customer thread) and lifecycle transitions |

## The fail-closed rendering gate (the top threat)

Privilege escalation through administrative tooling is the top threat for
this app (spec/security.md "Threat priorities"). Every surface therefore
resolves the actor's session (`GET /v1/users/me`) **before any surface data
is fetched**:

- session unreadable → typed error panel (no surface, no data);
- session lacks the surface's permission → `access-denied` panel (no
  surface, **no surface request is even made** — proven by tests that capture
  the transport);
- cross-tenant actor → typed 404 panel (no existence oracle).

Read surfaces require `org:read`; admin commands require `org:manage`
(enforced by the API within the frozen `ACCOUNT_PERMISSIONS` vocabulary;
denials are audited server-side with outcome `denied` and appear in the
audit review). Personal (`usr:`) tenants hold only `account:*` permissions
and are denied all console surfaces.

## Admin commands (same command semantics)

`AdminConsoleApp` flows wrap the typed client: full envelope
(request/correlation/idempotency ids, actor/tenant context), optimistic
version against existing resources, idempotent retries with the same key.
Rendered results show the four-stage pipeline or typed error panels.

The **suspended-organization escape**: while an organization is suspended,
every read is blocked — only the reactivation command path is open. The
reactivation flow therefore commands against the revision carried by the
suspension acknowledgement (the operator's optimistic anchor), exactly
mirroring `@roamlink/auth`'s single sanctioned escape
(`allowSuspendedOrganization`, scoped to `org:manage` + reactivation only).

## UI framework choice (recorded decision)

Same as the customer app: framework-free typed HTML rendering via
`@roamlink/app-kit` (pure functions, escaped-by-construction). Zero new
runtime dependencies; deterministic component tests without DOM emulation.
Dependency direction unchanged (admin → app-kit → contracts), so no ADR is
required (RL-LOCK-020).

## Mounting

A host composes `AdminConsoleApp({ client })` with a `fetch`-backed
transport (production) or the deterministic in-memory fake (tests), renders
`renderDocument({ page, lastResult, auditCategory })` and wires the rendered
form actions (`data-flow` attributes) to the matching flow methods. The
host owns sessions/CSRF; the console never sees credentials (RL-LOCK-016).

## Tests

`pnpm test` (13 tests) drives the real console through the real typed client
against the deterministic fake with testkit clocks/ids:

- a member (org:read) sees every read surface but every command fails closed
  (403) and the denial is audited and visible in the audit review;
- personal-tenant actors are denied every surface **without any surface data
  request being made** (transport capture proof);
- cross-tenant actors render typed 404 panels;
- session failures render typed error panels, never surfaces;
- owner/admin operations: suspend → members blocked (fail-closed) →
  sanctioned reactivation (with the ack-anchored version) → audited trail;
- reconciliation trigger reports honest outcomes (DEGRADED_*, never invented
  REPAIRED);
- triage sees internal messages and advances cases legally (illegal
  transitions fail typed);
- the audit chain banner renders and verification is surfaced;
- projection health shows FRESH/STALE/UNKNOWN and degraded overall.
