# RoamLink

RoamLink is the Connectivity Experience OS built on top of ADCOS.

## Architectural north star

RoamLink lets a person or organization specify the connectivity experience they want; RoamLink compiles that experience into technology-neutral ADCOS connectivity intents and continuously manages the customer experience while ADCOS remains authoritative for connectivity execution.

RoamLink is **not** an eSIM marketplace, carrier, SD-WAN replacement, routing engine, session engine, or provider registry. eSIM, Wi-Fi, cellular, fixed, satellite, mesh, and other technologies are implementation mechanisms underneath the ADCOS fabric.

## Authority boundary

- **RoamLink owns:** customer/user/org identity, device registry and context, experience intents/preferences, product packaging, orders/subscriptions, customer billing/payment state, support, notifications, edge UX, projections, reconciliation, and experience analytics.
- **ADCOS owns:** canonical ConnectivityIntent, eligibility, offers, reservations/leases, path selection, NetworkPath, logical sessions, mobility, adapter/provider integration, connectivity usage evidence, and ADCOS commercial settlement state.
- **Providers own:** physical-network and provider-native state.

RoamLink must never create a competing connectivity authority.

## Implementation source of truth

The implementation source of truth is this repository, especially:

1. `spec/architecture.md`
2. `spec/architecture-lock.md`
3. `spec/authority-model.md`
4. `spec/adcos-integration.md`
5. `spec/work-items.md`
6. `spec/dependency-graph.md`
7. `spec/orchestrator.md`
8. `spec/definition-of-done.md`

`spec/adr/` contains approved decisions. If code and the locked architecture disagree, stop implementation and resolve the architectural discrepancy; never silently reinterpret the architecture.

## Build strategy

The project is designed for an orchestrator running up to three workers concurrently. Work is sliced by bounded architectural ownership, with explicit dependency gates and no shared-authority work streams.

Suggested streams:

- **Worker A — Experience & Commerce:** customer, org, device/context, experience intent, product/order/subscription, customer billing, support.
- **Worker B — ADCOS Integration & Data:** ADCOS client/contract mapping, idempotency, webhook inbox, projections, reconciliation, integration tests.
- **Worker C — Edge & Platform:** edge agent/client contracts, sync/outbox, security/auth boundaries, observability, test harness, deployment/platform foundations.

The orchestrator is responsible for sequencing, contract review, integration, dogfooding, and architectural approval.

## Frozen scope rule

No worker may introduce a new authority for identity, connectivity sessions, paths, routing, provider state, topology, or ADCOS commercial settlement. Any proposed architectural change must go through `spec/adr/` and the architecture change process defined in `spec/architecture-lock.md`.

## Development

### Prerequisites

- Node.js >= 22 (enforced via `engines` and `.npmrc` `engine-strict`)
- pnpm 10 (pinned by the root `packageManager` field; `corepack enable` or `npm install -g pnpm@10.0.0`)

### Setup

```bash
pnpm install              # installs workspace deps, wires the lockfile, installs git hooks
cp .env.example .env      # optional for pure unit work; services validate keys at boot
```

### Everyday commands

| Command | What it does |
|---|---|
| `pnpm check` | full gate used by CI: `lint` + `typecheck` + `test` + `architecture:check` |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | run in every workspace package that declares them (`pnpm -r`) |
| `pnpm dev` | starts watch mode (e.g. vitest watch) in every package that declares a `dev` script |
| `pnpm architecture:check` | the frozen sanity script (`scripts/check-architecture.mjs`) |

Architecture conformance is additionally enforced by real tests in
`tests/architecture` (forbidden ADCOS-internal imports, contracts purity,
env-schema/.env.example parity) which run as part of `pnpm test` and fail the
build on violation (RL-LOCK-018).

### Commit hooks

A dependency-free pre-commit hook is installed automatically by
`pnpm install` (root `prepare` script, see `scripts/hooks/`). It:

1. blocks staging of local `.env` files (only `.env.example` is committed);
2. scans added diff content for common credential patterns (RL-LOCK-016);
3. lints staged TS/JS files using the ESLint config of their owning package.

### Environment

Configuration is validated fail-closed by `parseEnv` from
`@roamlink/contracts` (`packages/contracts/src/env/env-schema.ts`). The
recognized key set matches `.env.example` exactly. `NODE_ENV` is always
required; production additionally requires the service/ADCOS keys and fails
loudly, naming the missing KEY but never echoing values. `ADCOS_API_VERSION`
is pinned to `2.0`, the only supported ADCOS Developer API line.

### Package layout (current)

- `packages/contracts` — lowest-level shared contract package (RL-002): opaque
  IDs, foreign ADCOS references, UTC instants, evidence classes, error
  taxonomy, command envelope, versioning, canonical JSON + SHA-256 digests,
  freshness primitives, env schema. No domain logic, no business authority.
- `packages/auth` — RoamLink auth/tenant boundary (RL-004): User /
  Organization / Membership aggregates with the frozen account permission
  map, the server-side session abstraction (opaque tokens, digest-only
  storage, bounded lifetime), the password-hashing port (no vendor lock),
  actor→tenant resolution with fail-closed boundary authorization, and
  tenant-scoped repository ports with in-memory adapters that prove
  cross-tenant access fails closed. RoamLink identity only — no ADCOS
  fields (RL-LOCK-003).
- `packages/domain-experience` — the Experience domain (RL-010 + RL-011 +
  RL-013): the Device aggregate (lifecycle, ownership, platform metadata),
  immutable evidence-tagged `DeviceCapabilitySnapshot` over the closed
  11-name capability vocabulary mirroring spec/architecture.md §7
  (drift-guarded), the privacy-classified, minimized
  `DeviceContextSnapshot` with consent-gated fine location, and
  `ExperienceIntent` with immutable versions linked by a supersession
  chain plus a validated state machine. Access classes are PREFERENCES
  ONLY; no ADCOS types are imported or modeled (RL-LOCK-007) —
  compilation to ADCOS ConnectivityIntent is RL-012 (Wave 2). The
  additive RL-013 decision read model builds explainable, immutable
  `ExperienceDecision` snapshots from an intent + the device's latest
  capability/context evidence: derived customer status is a SEPARATE
  read-side vocabulary (authoritative statuses are referenced, never
  overwritten), every input carries freshness/evidence class/weight
  (STALE and UNKNOWN evidence weighs zero) and every outcome factor
  traces to the input evidence that produced it; decisions reference
  connectivity, they never authorize it.
- `packages/intent-compiler` — the ExperienceIntent compiler (RL-012,
  Wave 2): deterministic, pure compilation of an immutable intent version
  into the technology-neutral ADCOS ConnectivityIntent command shape per
  spec/adcos-integration.md §4 — schema validation, policy
  normalization, hard/soft constraint classification, privacy/service
  constraint mapping, validity-window calculation, deterministic
  canonical serialization, SHA-256 digest and command creation with full
  source-intent traceability. The structural output is exactly the
  RL-031 intent-command input (no dependency edge to the integration
  package, RL-LOCK-019); depends only on contracts +
  domain-experience.
- `packages/domain-commerce` — the Commerce domain (RL-020 + RL-021 +
  RL-022): the Product/ProductVariant catalog with a tenant-scoped,
  deterministic catalog read model, the Order/OrderLine/Subscription
  lifecycle with append-only chain-sequenced event sourcing and
  supersession of subscription changes, and the customer-facing money
  lifecycle — CustomerPayment, CustomerInvoice with reconciliation PROVEN
  from recorded money facts (succeeded payments minus succeeded refunds,
  same currency), and CustomerRefund with closed reason codes and
  partial-refund bounds — each aggregate carrying its OWN closed state
  vocabulary (`customer_payment_state` / `invoice_state` /
  `customer_refund_state`, never merged with order/subscription or any
  delivery state). Commerce records express COMMERCIAL INTENT and MONEY
  FACTS ONLY (RL-LOCK-008 "payment is not delivery"): no
  reservation/session/path/usage/delivery/settlement state lives here,
  and the commerce-to-connectivity reference model is RL-023 (sibling
  package `@roamlink/commerce-connectivity`). Money is integer minor
  units + ISO-4217-style codes only (no floats, no rounding, typed
  currency-mismatch errors). Sessions wrap the RL-003 persistence units
  of work, so multi-aggregate writes commit atomically and concurrent
  races surface as typed ConflictErrors; commands are §5-envelope-gated
  and idempotent; reads are tenant-scoped and fail closed (RL-LOCK-018).
- `packages/edge` — edge capability contracts + engines (RL-040 + RL-041 +
  RL-042): closed capability vocabulary with platform scope + evidence
  requirements, the immutable versioned capability snapshot, the pure
  evidence-based capability gate (`assertCapability`), device action
  request/result contracts, the desired-state + encrypted-outbox record
  shapes (RL-040); the observation engine that folds raw platform probes
  into evidence-tagged capability/context snapshot chains under the closed
  evidence-kind→class map (AUTHENTICATED unreachable locally, RL-LOCK-011);
  and the encrypted offline outbox/sync engine — ciphertext-only payloads at
  rest, batched sync with an explicit conflict policy, replay-safe
  redelivery and honest boundary states (RL-LOCK-015/016).
- `packages/edge-actions` — the device action adapter (RL-043, Wave 3):
  the action-execution half of the edge capability contract behind the
  stable `PlatformActionExecutor` seam — pure capability-gated admission
  over the DeviceCapabilitySnapshot closed vocabulary (unsupported and
  absent-evidence paths degrade to typed, diagnosable states, never
  best-effort guesses), execution with platform-evidence discipline
  (physical success only ever declared with evidence), the desired-state
  loop driver (privacy-aware local policy evaluation, encrypted-outbox
  queueing with dedupe/replay safety, sync-boundary projection updates,
  authoritative-result intake) and the local device-action projection with
  honest `queued ≠ executed` boundary states (RL-LOCK-011/013/014/015).
- `packages/edge-connector` — the enterprise edge connector contract
  (RL-044, Wave 3): the typed contract for MDM-managed configuration,
  system extensions, VPN/network extensions or an enterprise connector
  when supported — closed-vocabulary capability negotiation whose
  guaranteed degradation floor is observation + user-guided actions
  (the architecture still works when only those are available), versioned
  secret-free configuration delivery, and credential isolation
  (short-lived, device-bound, narrowly scoped, revocable grants carrying
  a secret REFERENCE only) with fail-closed runtime evaluation; plus a
  deterministic in-memory fake (no real MDM/VPN platform code).
- `packages/retention` — data retention/privacy enforcement (RL-054,
  Wave 3): purpose/retention classifications as first-class closed
  vocabularies with a structurally stricter policy for location and
  network identifiers (shorter windows, explicit consent, purpose
  limitation), the RL-LOCK-016 `assertNoSecretMaterial` enforcement
  point other packages' persisted payloads are tested against,
  classified records with minimization bounds and policy-computed
  expiry, and the enforcement engine over the RL-003 persistence
  primitives — admission, bounded expiry sweeps, tombstone/hard-delete
  erasure semantics, explicit erasure and audited access control with an
  append-only audit trail of every retention decision.
- `packages/secrets` — the secrets/credentials boundary (RL-050): typed
  log-safe secret references, the `SecretsResolver` port with a closed
  failure taxonomy, rotation-aware versioning, `SecretMaterial` redacted
  from every serialization path, value-free access notifications (the
  RL-051 audit seam), the RL-042 byte-key provider adapter, and an
  in-memory fake. Secret values only ever enter a running component
  through this boundary (RL-LOCK-016).
- `packages/audit` — the append-only audit/security event stream (RL-051):
  immutable UTC-instanced events with actor/tenant/command correlation and
  a closed security taxonomy (auth, secret-access, authority-decision,
  admin-override), tamper-evident SHA-256 digest chaining over canonical
  JSON, append-only-by-construction stores (no mutation API exists), and
  queries by correlation ID, actor, tenant, category and time range.
- `packages/resilience` — rate limits, retries and circuit breakers
  (RL-053): token-bucket and sliding-window limiters, bounded exponential
  retry policies with injectable (deterministic or production) jitter,
  attempt and wall-clock budgets classified through the Wave-0 error
  taxonomy, and a closed/open/half-open circuit breaker with rolling-window
  tripping, cooldown and bounded half-open probing. Pure/typed primitives,
  in-memory state only.
- `packages/integration` — the ADCOS integration adapters (RL-031 + RL-032):
  the `AdcosClient` seam implementation over a typed HTTP transport (closed
  v2 route table, canonical request bytes, idempotency-key enforcement,
  fail-closed response validation), the deterministic intent-command mapping
  with full §5 command envelopes and retry-safe resubmission, the
  offer/reservation (contract/lease) command + read surface with typed
  `route-unknown` degradation for surfaces v2 does not expose, the closed
  ADCOS→RoamLink error adaptation, and the §9 compatibility gate with
  fail-closed mutations.
- `packages/webhook-inbox` — the durable ADCOS webhook inbox (RL-033): the
  HMAC webhook verifier implementing the `WebhookVerifier` seam (signature,
  replay window, closed envelope, environment/version fail-closed) and
  durable admission on the persistence primitives (dedupe by ADCOS event id,
  immutable extended records, acknowledge-after-commit, async projection via
  the `AdcosWebhookProjector` port). Webhooks are signals, not truth
  (RL-LOCK-009).
- `packages/projections` — the ADCOS projection engine (RL-034):
  canonical-resource projections with the exact §8 record shape
  (provenance, freshness, evidence), the integration-boundary-only writer
  surface with optimistic concurrency, out-of-order/idempotency ordering
  defense, and explicit STALE/UNKNOWN degradation when canonical truth is
  unreachable — never a guess (RL-LOCK-010).
- `packages/reconciliation` — the ADCOS reconciliation engine (RL-035,
  Wave 3): the `ReconciliationJob` orchestration of spec §7 that
  periodically compares projection freshness against canonical ADCOS
  resources and repairs missed webhooks, duplicate webhooks, out-of-order
  events, stale projections, partially applied projections and transient
  ADCOS/API failures. Jobs are §5-envelope-carrying durable records on the
  persistence primitives — re-running a crashed job converges instead of
  duplicating (RL-LOCK-014). The boundary factory is the §8 composition
  point: it captures the projection writer capability (only the
  reconciler/integration boundary writes ADCOS-derived projections) and
  binds the webhook inbox projector through the boundary-owned engine.
  Truth-unreachable degrades to STALE/UNKNOWN — never a guess.
- `packages/compat` — the ADCOS compatibility suite (RL-036, Wave 3): the
  executable §9 startup gate — composes the Wave-2 compatibility gate with
  server-driven checks (lifecycle-state vocabulary, required
  `resource_version` fields, end-to-end webhook-delivery verification,
  verifier semantics accept/reject matrices, single-site version pin,
  fail-closed mutation-gate wiring). Incompatible ADCOS versions fail
  CLOSED for mutations with a diagnosable, value-free health report.
  Runs against any public `AdcosClient` — the local §10 fake in tests, real
  clients at startup; no ADCOS internals.
- `packages/observability` — platform observability contracts (RL-040 +
  RL-052): correlation-ID context propagation from the Wave-0 command
  envelope, the redacting structured log record contract, the
  counter/gauge/histogram naming + label contract (no vendor SDK),
  health/readiness aggregation, and the service-level objective /
  error-budget primitives — typed SLOs, good/bad event recording with pure
  window evaluation, burn-rate calculation, multi-window burn rates, and
  composition with the health registry, metrics contract and correlated
  logger (no-data is never silently healthy).
- `packages/commerce-connectivity` — the commerce-to-connectivity reference
  model (RL-023, Wave 3): the explicit, evidence-carrying reference layer
  between commercial subjects (orders/subscriptions) and the ADCOS-derived
  projections — an order does NOT imply delivery (RL-LOCK-008). The ONLY
  sanctioned way the commerce surface reads connectivity status:
  `delivery_evidence_state` is its own closed vocabulary (UNEVIDENCED |
  EVIDENCED, never merged with commerce/ADCOS state), evidence snapshots
  mirror the §8 projection field semantics (evidence class +
  observedAt/receivedAt/freshUntil + freshness + canonical refs + digest,
  RL-LOCK-010), and the read model exposes the subject's commercial state
  plus the evidence freshness re-evaluated at the query instant — FRESH
  degrades to STALE monotonically, UNKNOWN is presented, never hidden, and
  no combined opaque status exists. Evidence enters only through the
  read-only `DeliveryEvidenceSource` port (§8-shaped observations; the
  composition layer binds it to the integration boundary's exposed
  get/list/count projection reader — the package itself never imports the
  projection package, RL-LOCK-002); a missing projection is a typed
  NotFound (absence is presented, never guessed). Relinks snapshot
  immutably; the event chain keeps every observation (audit).
- `packages/notifications` — the notifications/support domain (RL-014,
  Wave 3): durable notifications, typed channel/preference contracts and
  support cases with event correlation. RL-LOCK-009 is enforced
  structurally: the `TransitionOrigin` contract (closed single-member
  origin vocabulary `roamlink_state_transition`, closed RoamLink
  aggregate-type vocabulary, REQUIRED durable event id) leaves no shape
  for a raw ADCOS payload to pass — notifications are emitted only from
  RoamLink's own durable state transitions. A preference mute produces a
  durable SUPPRESSED notification (a state, never a deletion); channel
  deliveries are immutable attempt records (first success delivers; failed
  only once every effective channel failed). Support cases carry typed
  related-ref correlation (orders/subscriptions/payments/invoices/refunds/
  connectivity references) and a structural customer/internal visibility
  boundary (internal messages gated behind `support_case:internal` and
  absent from the customer thread view by construction). The
  /v1/notifications resource mapper exposes RoamLink state + the source
  transition + evidence summaries (freshness + canonical refs) — never
  internal ADCOS types.
- `packages/testkit` — deterministic test primitives: monotonic injectable
  clock, deterministic ID generators, in-memory event/command recorders, and
  fixture builders for the Wave-0 contract types.
- `tests/architecture` — architecture conformance suite (RL-LOCK-018),
  including dependency-direction proofs for the Wave-2 and Wave-3 worker
  packages.
