# @roamlink/app-kit

The shared application kit for the RL-060 customer web app (`apps/web`) and the
RL-061 admin/operations console (`apps/admin`): the typed public application
API contract (spec/api.md) plus the framework-free UI primitives both apps
render with.

**Authority discipline** (spec/repository-layout.md: "apps consume public
application APIs/read models and do not contain authority logic"): this
package contains NO domain authority. It depends ONLY on
`@roamlink/contracts` (Wave-0 primitives: error taxonomy, freshness, UTC
instants, command ids). It never imports a domain, integration, edge or
platform package - the future `services/api` implements the same contract over
the domain modules, and the conformance suite guards the boundary.

## Layout

- `src/api/outcomes.ts` - the mutation-outcome stages (`accepted`,
  `executed`, `delivered`, `billable-final`) as SEPARATE, individually absent-
  or-present facts, plus the fail-closed acknowledgement parser. The parser
  rejects structurally impossible combinations (a stage present while an
  earlier stage is absent = a collapsed pipeline).
- `src/api/context.ts` - actor/tenant context, the mutation header set
  (`x-roamlink-request-id`, `x-roamlink-correlation-id`, `idempotency-key`,
  `x-roamlink-actor-id`, `x-roamlink-tenant-id`,
  `x-roamlink-expected-version`) and the request-plan builder. Retrying a
  mutation with the SAME idempotency key is the sanctioned retry story
  (RL-LOCK-014).
- `src/api/transport.ts` - the injectable HTTP transport port (GET/POST only:
  mutations are commands, not resource patches).
- `src/api/errors.ts` - the wire error resource + `ApiClientError` (typed
  kind/reason/retryability; transport failures fail closed as retryable
  `unavailable`; unparseable bodies never propagate third-party text,
  RL-LOCK-016).
- `src/api/resources.ts` - every wire resource with a fail-closed parser
  (unknown fields rejected, closed vocabularies checked, UTC instants
  validated). The connectivity overview carries the per-subject commercial
  state, reference lifecycle, delivery-evidence state and evidence freshness
  side by side - there is deliberately NO combined opaque status field
  (spec/data-model.md "State separation").
- `src/api/commands.ts` - the typed mutation request payloads.
- `src/api/routes.ts` - the route table. A drift test parses `spec/api.md` and
  fails when a spec-listed `/v1/...` resource disappears ("generated from or
  checked against the API contract"). Additive routes are allowed
  (RL-LOCK-017): `/v1/commands/{id}` (stage polling), `/v1/users/me` (actor
  session), `/v1/support-cases`, `/v1/audit-events`,
  `/v1/reconciliation-jobs`, `/v1/projection-health`,
  `/v1/enterprise/workspace` (the RL-104 workspace read),
  `/v1/enterprise/workspace/connector/provision` (the PA-06 connector
  provisioning command), `/v1/integration-health` (the PA-010 recorded
  ADCOS compatibility probe outcome — the read-only integration-health
  surface's feed; its state vocabulary mirrors @roamlink/compat's closed
  four-state list, drift-guarded by tests/architecture).
- `src/api/client.ts` - `RoamLinkApiClient`: reads return parsed resources;
  every mutation carries the full command header set; optimistic-version
  conflicts surface as typed `conflict` errors.
- `src/api/fake/` - the deterministic in-memory fake API (seed + transport
  implementation) used by every app component test. It implements the
  CONTRACT semantics, not domain authority: idempotency dedupe/replay,
  optimistic-version conflicts, the stage pipeline (progressed only by
  evidence/finality facts via test controls), freshness evaluated at the
  query instant, tenant scoping fail-closed (404 without an existence
  oracle), admin authorization fail-closed, the SHA-256 audit digest chain,
  and the one sanctioned suspended-organization escape (reactivation).
  The enterprise connector provisioning (PA-06) follows the same discipline:
  the command creates the record in the honest in-flight `provisioning`
  state and NEVER invents the completion - the test controls
  (`progressConnectorToProvisioned` / `failConnectorProvisioning`) mirror
  the owning domain's transition machinery
  (`packages/enterprise/src/connectors.ts` legal map).
- `src/ui/` - the typed, XSS-safe HTML core (`html.ts`: text is escaped by
  construction, there is NO raw-HTML escape hatch) and the shared components
  (`components.ts`: freshness badges, the four-stage mutation pipeline,
  connectivity subject cards, error panels, page shell).
- `src/ui/shell.ts` (RL-083, additive) - the customer application-shell
  primitives per ADR-0002: `applicationShell` (skip link, header with the
  persistent connectivity status, desktop sidebar nav, mobile bottom nav,
  footer), `sidebarNav`/`bottomNav` (aria-current aware), the derived
  connectivity indicator (`deriveShellConnectivityState` +
  `shellConnectivityIndicator`: a closed vocabulary computed ONLY from the
  read-model subjects, rendered WITH its facts, "usefully connected" only
  from fresh delivery evidence, honest `unverifiable` state on read
  failure), the warm-light stylesheet (`WARM_SHELL_STYLES`: focus-visible,
  prefers-reduced-motion, >=44px touch targets, safe-area inset), and the
  additive `htmlDocument(..., { styles })` parameter. The shell is a
  presentation boundary: it holds no domain authority and no local
  connectivity state machine.

## Admin surface permission mapping (RL-061)

Authorization is enforced by the API, never by the console. The mapping (within
the frozen `ACCOUNT_PERMISSIONS` vocabulary from `packages/auth`, RL-004):

- read/list surfaces (`/v1/organizations`, `/v1/audit-events`,
  `/v1/reconciliation-jobs`, `/v1/projection-health`,
  `/v1/integration-health`): `org:read`;
- mutating admin commands (org suspend/reactivate, reconciliation trigger,
  support-case transitions): `org:manage`;
- administrative surfaces require an organization tenant scope: personal
  (`usr:`) tenants hold only `account:read`/`account:manage` and are denied
  (the web app covers personal-tenant self-service).

Role grants (mirroring `packages/auth/src/membership.ts`): owner = all
permissions; admin = everything except `owner:manage`; member = `org:read` +
`member:read` (read-only). A member can therefore READ the console surfaces
but every admin command fails closed with 403 - and the denial is audited.

## Mutation outcome stages (spec/api.md)

`accepted != executed != delivered != billable-final`:

- `accepted` - the boundary took the command (envelope complete).
- `executed` - RoamLink applied it to its own state.
- `delivered` - delivery evidence was linked for the affected subject (the
  commerce-to-connectivity reference model; RL-023). Money facts never set
  this (RL-LOCK-008).
- `billable-final` - commerce finality (e.g. the invoice reconciled).

Commands that cannot reach a stage simply never carry its timestamp (a device
update tops out at `executed`; a payment command never carries `delivered`).
Stage progression is polled via `GET /v1/commands/{commandId}`.

## UI framework choice (recorded for RL-060/061)

Both apps use app-kit's framework-free typed view core instead of a
third-party framework: zero new runtime dependencies, identical behavior in
Node and the browser, and pure-function components over parsed resources make
deterministic tests trivial (no DOM emulation). This does NOT affect
dependency direction (apps -> app-kit -> contracts), so no ADR is required
(spec/architecture-lock.md RL-LOCK-020); the choice is recorded here and in
each app README as the work items request.

## Tests

`pnpm test` runs:

- `test/client-contract.test.ts` - header discipline, idempotency replay,
  optimistic-version conflicts, typed failures, stage-parser proofs;
- `test/spec-route-drift.test.ts` - the route table covers spec/api.md;
- `test/fake-api.test.ts` - the fake's contract semantics (idempotency,
  tenant scoping, admin authz fail-closed + audited denials, the suspended-org
  escape, audit chain, freshness degradation, honest stage progression);
- `test/components.test.ts` - shared UI component behavior (freshness
  rendering, stage separation, connectivity aggregation without a combined
  status, safe error panels).
