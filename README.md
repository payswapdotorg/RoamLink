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

## Quickstart — reproduce the local dogfood run from a clean clone

The fastest way to verify this repository on a fresh machine is to run the
RL-072 end-to-end dogfood scenarios: full-lifecycle journeys that compose the
REAL public packages through their public surfaces (the only external
stand-in is the deterministic §10 ADCOS fake — no network, no sleeps, no
ambient time). Copy-paste:

```bash
git clone https://github.com/payswapdotorg/RoamLink.git
cd RoamLink
corepack enable            # or: npm install -g pnpm@10.0.0
pnpm install               # frozen-lockfile installs are used by CI and the gates
pnpm -C tests/dogfood test # the five dogfood scenarios (onboarding -> first
                           # usable connectivity, degradation -> failover ->
                           # recovery, offline edge round-trip, refund +
                           # incident correlation, enterprise onboarding)
```

Expected result: `Test Files  5 passed (5)` / `Tests  9 passed (9)`, exit 0.

To go one level deeper, reproduce the other verification waves the same way
(all deterministic, no infrastructure):

```bash
pnpm -C tests/conformance test   # RL-070: one negative-proof suite per architecture lock
pnpm -C tests/simulation test    # RL-071: failure/reordering/duplicate simulations
pnpm -C tests/load test          # RL-073: load/reliability complexity invariants
pnpm -C tests/security test      # RL-074: security/threat-model attack fixtures
pnpm -C tests/deployment test    # RL-075: deployment/recovery verification
```

And the release gates themselves (RL-080/RL-081) run the FULL verification
stack in dependency order and emit machine-readable verdict artifacts under
`docs/reports/`:

```bash
node scripts/release/mvp-gate.mjs         # or: pnpm mvp-gate
node scripts/release/production-gate.mjs  # or: pnpm production-gate (runs the MVP gate first)
```

Current gate status and per-criterion evidence:
`docs/reports/mvp-release-gate.md` and
`docs/reports/production-readiness-gate.md`.

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

### The RL-070 through RL-075 test matrix

Beyond `tests/architecture`, six dedicated suites prove the architecture
locks, the product promise, the security threat model and the
deployment/recovery story end-to-end (they also run as part of
`pnpm test`):

| Suite | What it proves |
|---|---|
| `tests/conformance` (RL-070) | NEGATIVE-PROOF suites per authority/dependency lock (RL-LOCK-001 through RL-LOCK-019, minus the meta-locks 018/020 covered elsewhere): each suite carries a green proof on the current tree AND a violating fixture that MUST turn it red. Behavioral suites assert typed rejection of violating inputs (delivery state on payments, ADCOS identity fields on Users, provider authority in evidence, path/session resource kinds, forged webhook origins, unversioned records, AI-SDK imports, ...). Structural suites scan manifests + sources and merge a VIRTUAL violating overlay when toggled. Toggle any lock's fixture with `ROAMLINK_CONFORMANCE_VIOLATION=<LOCK-ID> pnpm -C tests/conformance test` (e.g. `ROAMLINK_CONFORMANCE_VIOLATION=RL-LOCK-008`) - exactly that lock's negative proofs go red on a conforming tree, proving the suite fails when the implementation violates the lock (RL-LOCK-018). |
| `tests/simulation` (RL-071) | end-to-end failure-mode simulations over the composed public packages + the §10 ADCOS fake: duplicate command delivery at EVERY boundary (intent adapter timeouts, webhook redelivery, commerce commands, reconciliation re-runs, edge outbox re-enqueue), reordering (reversed webhook events vs projection ordering defense + convergence), loss (dropped events + silent canonical changes -> reconciler repair with digest-verified payloads), delay (freshness decay to STALE, delayed truth re-establishing freshness, commerce read model re-evaluating at the query instant), partition (offline edge convergence on reconnect, exactly-once server effects via idempotency-key dedupe), partial failure (UnitOfWork atomicity + transactional outbox retry convergence) and byzantine inputs (forged/malformed webhooks rejected at admission; schema drift -> §9 gate fails CLOSED for mutations). Deterministic throughout: testkit clock/ids/recorder, no sleeps, no network, no ADCOS internals. |
| `tests/dogfood` (RL-072) | full-lifecycle DOGFOOD scenarios composing the REAL public packages through their public surfaces (the §10 ADCOS fake is the only external stand-in), each deterministic (testkit clock/ids, one correlation-ID family) and asserted on OBSERVABLE public state - read models, notifications, audit, projections - never package internals: (1) new-customer onboarding -> first usable connectivity (auth -> device -> commerce -> intent -> compile -> submit -> offer/activation/reservation -> webhooks -> projections -> evidence -> decision -> notification) + a full idempotency leg; (2) degradation -> failover -> recovery (silent canonical change, honest device observations, stale-while-degraded, intent re-planning, digest-verified reconciliation repair, unreachable-truth degradation); (3) offline edge round-trip (encrypted outbox, partition backoff, batched sync with lost acks, conflict policy, dead-letter budget); (4) refund + partial refund with incident correlation (typed money facts, proven refund bounds, correlated case/notifications/audit, tamper-evident chains, durable mutes); (5) enterprise tenant onboarding through the enterprise surface with the admin console observing the SAME truth through the same public API (fail-closed privilege boundary). Every scenario also records and asserts the §11 SLOs through the REAL observability recorder composed into the world (time to usable connectivity, minutes without usable connectivity, manual interventions, successful automatic recovery, intent satisfaction, connectivity cost per useful unit where available, stale/unknown-state duration, provider/access failover, attributable support incidents) — including the PRODUCT-side emissions the wired reconciliation engine records from its durable job actions. |
| `tests/load` (RL-073) | deterministic LOAD/RELIABILITY suites (no wall-clock timing - testkit clock, exact operation counting through counting proxies over the PUBLIC ports): high-volume webhook ingestion (thousands of events, duplicates + full reversal) with complexity invariants (N distinct events = exactly N reads + N writes; duplicates = zero projection work; reordering = one read per event, zero late writes, convergence); sustained edge outbox churn (400-record flood -> exactly-once convergence, bounded retry work, bounded batches); notification fan-out under mute storms (K emissions = exactly K per-user preference reads, never O(all-customers)); reconciliation full-vs-incremental canonical refresh (CONSISTENT targets = zero canonical GETs, bounded attempts per target, honest STALE degradation under sustained outage, job-id replay = zero work); resilience under sustained failure (open breaker rejects without invoking, half-open probe saturation fail-closed, retry/deadline budgets cap total attempts, sliding-window admits exactly maxCost per key). Plus SLO-E emission-volume invariants: the §11 product-SLO recorder wired into the boundary receives EXACTLY N good automatic-recovery events + N closed stale-window durations for N repaired targets, and NOTHING for incremental no-ops or idempotent job replays (emission proportional to durable repair work). Recorded DEFECT-1 (inbox drain could not progress past the first batch-limit records of a larger backlog) — REMEDIATED on work/rl-durable-recovery (AR-008 / RL-094): the reproducer now pins the fixed bounded-drain expectation (a backlog of N records drains across ceil(N/limit) calls). |
| `tests/security` (RL-074) | SECURITY/THREAT-MODEL verification executing spec/security.md's threat priorities as attack fixtures with expected-rejection assertions (negative proofs + durable-state consequences): webhook source attacks (forged signatures, unknown keys, replays, replay-window both directions, unsupported schema versions, oversized payloads, environment mismatch, malformed envelopes, header/envelope disagreement - all rejected at inbox admission with zero durable side effects; customer webhooks emitted only from verified durable transitions); tenant/actor boundary attacks at EVERY public surface (no existence oracle, audited denials, fail-closed admin privilege escalation); the RL-054 secret-scanner sweep across every persisted surface (zero findings after poisoned-fixture negative proofs) - records FINDINGS RL-074-F1 (JWT-shaped provider references accepted into commerce records) and RL-074-F2 (auth-session tokenDigest field name scanner-flagged; the value is a non-invertible digest); auth/session attacks (exact-boundary expiry, revocation, idempotency attacks, unconstructible lifetime bounds; AUTHENTICATED fabrication structurally unreachable; rank-demotion protection; fail-closed rotation) - records FINDING RL-074-F3 (double revoke = typed CAS conflict); audit-chain tamper detection (mutation/reorder/splice at the exact broken sequence; the full-tail-rewrite limit pinned honestly); privacy/retention enforcement (purge semantics, consent gating, structural policy strictness, audited access). Verdict matrix + honest gaps: docs/threat-model-verification.md. |
| `tests/deployment` (RL-075) | DEPLOYMENT/RECOVERY verification as deterministic simulations (no real infrastructure) asserting durability invariants - no lost work, no duplicate effects, convergence: migration/recovery (clean application from empty and every prior state, idempotent re-runs, descending forward-compatible rollback, crash-during-migration convergence, fail-closed ledger corruption); cold start/orderly shutdown (empty start, exactly-once resumption, shutdown-mid-batch loses no durable work - batched drains advance across bounded calls, closing the RL-073 DEFECT-1 / AR-008, failing-storage admission acknowledges nothing) - the former FINDING RL-075-F1 (outbox records stranded in DELIVERING with no public recovery path) is REMEDIATED on work/rl-durable-recovery (AR-007 / RL-093): CS-4 verifies the restarted worker re-owns stranded claims through the public recoverInFlight sweep and the obligations continue and complete; backup/restore (public-contract export/import round-trip, digest-identical restored projections, §8 conformance core, surviving dedupe keys, reconciler repairs torn-write AND missed-webhook drift); dependency failure (ADCOS unreachable = honest STALE + bounded attempts + breaker rejects without invoking + retry/deadline budgets; partial degradation = stale-while-degraded; clock skew holds replay windows and query-instant freshness; storage failing = fail-closed with no silent loss; §9 gate fails closed for mutations); health/readiness composition (degraded != ready, unknown != healthy, no-data SLOs never healthy, composed data-plane health degrades honestly and recovers). Verified runbook + failure-mode matrix + honest gaps: docs/deployment-recovery.md. |

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
  logger (no-data is never silently healthy). The §11 SLO instrumentation
  surface (RL-052 / MVP-3 wiring) also lives here: the nine product SLOs of
  spec/architecture.md §11 as NAMED metric definitions
  (`roamlink_slo_<slug>…` constants, `registerProductSloMetrics`) plus the
  typed `createProductSloRecorder` whose nine record* methods emit through
  the metrics/SLO-event ports at explicit instants, with OPTIONAL
  good/bad-budget thresholds (never invented defaults — an unthresholded
  quantity is measured but not classified). Emission is wired where the
  product already computes the quantities: the reconciliation engine
  (optional structural `sloObserver` — successful automatic recovery,
  closed stale/unknown windows, manual interventions from the DURABLE job
  actions), the RL-013 decision read model (the pure
  `intentSatisfactionOf` mapping), and the composed dogfood/load harnesses
  (journey-level measurements: time to usable connectivity, minutes without
  usable connectivity, provider/access failover, connectivity cost per
  useful unit where available, attributable support incidents).
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
- `packages/provider-neon` — the Neon PostgreSQL configuration/health
  adapter surface (RL-095, Wave 6): TLS-enforced connection-string parsing
  with pooled/direct endpoint classification and value-free fail-closed
  errors, conservative pool GUIDANCE defaults (deployment.md §5 — quotas
  are documented, never correctness logic), a connection health check
  composing with the observability HealthRegistry (the real probe is
  injected by the RL-090 driver path), and connection-string redaction
  (RL-LOCK-016). The durable source of truth stays behind the persistence
  ports; Neon is an adapter, not architecture (ADR-0003).
- `packages/provider-redis` — the bounded ephemeral-coordination adapter
  surface (RL-096, Wave 6): the `EphemeralCoordinationPort` that makes
  Redis misuse unrepresentable by construction (every write carries a TTL,
  size-bounded values, safe-label keys, no durable structures), the
  deterministic in-memory fake, the Upstash REST client over a pinned wire
  contract (injected fetch, typed detail-suppressed provider errors), a
  distributed fixed-window limiter emitting resilience
  `LimiterDecision`s (state TTL-bounded via one pinned EVAL script), the
  secret-redacting env surface, and the REUSABLE contract battery run
  against BOTH paths (ADR-0003 replacement rule). Redis is optional for
  correctness — the system degrades to the non-accelerated path.
- `packages/provider-qstash` — the durable-jobs delivery adapter surface
  (RL-097, Wave 6): a transport-only `DurableJobDeliveryPort` (durable
  truth stays in the caller's PostgreSQL ledger; the idempotency key is
  carried, never invented), the deterministic fake simulating the full
  delivery loop (delay windows, exponential-backoff retries, dead-letter
  after the attempt budget, explicit redrive — no silent stranding), the
  Upstash QStash publish client (dedupe id header, injected fetch), and
  receiver-side signature verification with webhook-inbox rigor
  (constant-time compare, replay window both directions, closed value-free
  failure codes, current+next signing-key rotation). Jobs flow: webhook
  admission / scheduled work -> durable queue -> QStash delivery -> signed
  receiver verification.
- `packages/provider-r2` — the object-storage adapter surface (RL-098,
  Wave 6): the closed blob `ObjectStoragePort` (put/get/delete/list/
  presign; absence is a valid answer; bounded admission — size, presign
  TTL, printable metadata), the dependency-free AWS SigV4 S3-compatible
  client for Cloudflare R2 (anchored in tests to the AWS documentation's
  published SigV4 vector; strict closed-shape ListObjectsV2 XML parsing;
  presigned URLs), content-addressed key conventions (tenant-scoped,
  dated, idempotent re-uploads), the deterministic fake, the
  secret-redacting env surface, the health check, and the reusable
  contract battery — run against the fake AND the client over a
  SigV4-validating in-memory server. R2 never holds relational authority.
- `infra/deployment` — the deployment manifest layer (RL-099, Wave 6):
  per-environment env TEMPLATES (deployment.md §6: development/preview/
  demo/production; empty values only — secrets never committed),
  per-provider key templates, the port->adapter->env wiring manifest, the
  free-tier operating constraints as documented guidance (§5; quotas never
  become correctness logic), the Vercel project-config template, and the
  operator runbooks (Neon provisioning; end-to-end deploy + health +
  §7 deployment checks).
- `infra/deployment/smoke` — the synthetic smoke journey (RL-100, Wave 6):
  the deployment.md §7 "synthetic smoke journey is green" gate made
  executable. Zero-dependency Node >= 22 (root scripts `pnpm smoke` /
  `pnpm smoke:selftest`; run via `BASE_URL=<host> pnpm smoke` against a
  DEPLOYED stack, no secrets, no customer data). Asserts the honest
  readiness vocabulary (`ready | degraded:<dep> | not-ready:<reason>`)
  on `/readyz` + `/v1/readiness` with the servability HTTP codes, the
  shell surfaces' expected markup, referenced static assets, and the
  fail-closed ADCOS webhook ingress — and FAILS if a dependency lies
  (a ready claim over a down check, an out-of-vocabulary status, a
  servability-code mismatch, hidden unhealthy state). Honest degradation
  (surfaced `degraded:*`) passes — surfacing is not failure. The runner
  is proven by loopback selftests; first real-environment execution is
  the operator's RL-118 phase (runbook §6b: deploy → wait ready → run
  smoke → record).
- `infra/deployment/rollback` — the post-rollback state check (RL-112):
  the deployment runbook §9's EXECUTABLE rollback decision rule (root
  scripts `pnpm rollback:check` / `pnpm rollback:check:selftest`; run via
  `BASE_URL=<host> pnpm rollback:check` after redeploying the previous
  SHA). Asserts liveness, the honest AND SERVABLE readiness vocabulary
  (a truthful `not-ready:*` answer is NOT an accepted rollback), and the
  §6b synthetic smoke green. A rollback NEVER auto-runs migrateDown — the
  §9.2 rule encodes the forward-fix default and the deliberate,
  operator-commanded down-migration exception (which pairs with the RL-111
  backup/restore path). The runner is proven by loopback selftests.
- `infra/deployment/demo-acceptance` — the demo environment acceptance gate
  (RL-117, Wave 8): the deployment runbook §8 checklist composed and DECIDED
  by one command (root scripts `pnpm demo:acceptance` /
  `pnpm demo:acceptance:selftest`; live mode via
  `BASE_URL=<demo-host> pnpm demo:acceptance`). It composes the public
  verification surfaces — the tests/deployment batteries, the §6b smoke
  exports, the rollback rule's servable-readiness law, the RL-108 ADCOS
  compatibility probe (exit-faithful) and the environments config surface —
  fills the config-validation gaps (webhook-signature configuration
  PRESENCE, the no-in-memory-adapter production law, the R2
  scoped-credential surface), and emits the TWELVE-ROW spec/deployment.md
  §7 verdict: every row green | named-skip | needs-deployment | red, never
  a silently-passing row. Exit codes: 0 accepted (named-skips carry their
  AR-010 operator-phase flips), 1 a red row (not accepted), 2
  config-invalid. The selftest pins the runner loopback-only — a sabotaged
  (lying) deployment flips the verdict.
- `apps/portal-host` demo accounts (`src/demo-accounts.ts`) — the demo
  environment's PUBLIC sign-in fixtures with quick action logins, gated by
  `ROAMLINK_DEMO_ACCOUNTS` ("1"/"true" enables; unset/"0"/"false" disables;
  any other value refuses the host boot — see
  `infra/deployment/environments/demo.env.example`). When enabled, the
  composition seeds three personas through the REAL `@roamlink/auth`
  administration boundary (Demo Customer on a personal tenant; Demo Org
  Owner and Demo Org Member on the `RoamLink Demo Cooperative`
  organization) with fully deterministic identities (fixed UUIDs,
  idempotency keys and envelope mint instant — every cold boot rebuilds
  the identical roster), and `/login` renders one-click sign-in forms that
  POST each persona's public credentials to the SAME `/auth/session`
  cookie binding the manual form uses (no parallel auth path, no
  client-side script). The personas are public fixtures: `.example`
  domain emails, a shared password rendered on the login page, no secret
  material anywhere (RL-LOCK-016).
- `packages/app-kit` — the shared application kit for the RL-060/RL-061
  product surfaces: the public application API contract (spec/api.md) as
  schema-first typed wire resources with fail-closed parsers, the
  mutation-outcome stages (`accepted`/`executed`/`delivered`/`billable-final`
  as separate, individually absent-or-present facts), the typed
  `RoamLinkApiClient` over an injectable transport (every mutation carries
  request/correlation/idempotency ids, actor/tenant context and the
  optimistic version; retries with the same idempotency key replay the
  original acknowledgement), a deterministic in-memory fake API implementing
  the contract semantics (idempotency dedupe, optimistic-version conflicts,
  fail-closed tenant scoping and admin authorization, freshness evaluated at
  the query instant, the SHA-256 audit chain, evidence-driven stage
  progression), and the framework-free typed HTML view core both apps render
  with. Depends only on `@roamlink/contracts`; the state vocabularies are
  drift-guarded mirrors of the owning domain packages (never redefinitions).
- `packages/persistence` — the frozen persistence PORT layer (handoff §16):
  the storage-agnostic UnitOfWork/record-store/outbox/inbox/migration ports
  plus the in-memory adapter that is the SEMANTIC reference for every real
  driver (optimistic concurrency via CAS, idempotent admission, transactional
  outbox). No SQL, no driver imports — adapters implement these ports.
- `packages/persistence-postgres` — the real PostgreSQL adapter (RL-091):
  implements the frozen persistence ports over `pg` (pglite in tests),
  faithfully mirroring the in-memory adapter's semantics — CAS optimistic
  concurrency, transactional outbox enqueue/drain with the typed state
  machine, durable inbox admission, and a forward/rollback migration runner
  over `infra/migrations` with an applied-migrations ledger. SQLSTATE errors
  are mapped to the port's typed failures at the driver seam; pooled-connection
  isolation and multi-connection race hardening are pinned as RL-106
  verification debt (honest gaps in the package README).
- `services/api` — the authenticated public API/BFF service (RL-090): the
  spec/api.md route surface as a pure application service — every mutation
  requires the full command envelope (request/correlation/idempotency ids,
  actor/tenant, optimistic version) parsed at the @roamlink/auth boundary,
  commands are durably accepted through the command ledger + transactional
  outbox (RL-LOCK-014), and the ADCOS webhook ingress goes through the
  durable inbox (admission only — routes never process delivery inline).
  Consumed by `apps/portal-host`; testable in-memory or over real migrations
  on pglite.
- `apps/web` — the customer web application (RL-060): a pure view + command
  surface over the public application API (zero authority logic): the
  connectivity aggregate (projections + observations + freshness, never a
  single opaque status), devices, experience-intent create/version/supersede
  flows, products/orders/subscriptions/payments, notifications, and the
  customer support thread — with the four-stage acknowledgement pipeline
  rendered separately on every mutation and typed conflict/error panels on
  failures.
- `apps/admin` — the admin/operations console (RL-061): operational read
  surfaces over the same public APIs (tenant/org management, audit/security
  event review with digest-chain verification, reconciliation job
  monitoring, projection freshness/SLO health dashboards, support-case
  triage) plus admin commands through the same command semantics. Privilege
  escalation is the top threat: every surface resolves the actor session
  fail-closed BEFORE fetching any data (a denied actor never triggers the
  surface request — proven by transport-capture tests), and denials are
  audited server-side.
- `packages/enterprise` — the enterprise onboarding/API surface (RL-063,
  Wave 4): the organization enrollment journey (own closed state machine;
  the tenant is bound ONLY through the registrar port — auth stays the
  identity authority), reference-only tenant federation, enterprise API
  keys with scoped service authorization through the RL-050 secrets
  boundary (records carry typed key references, material verified in
  constant time, rotation-aware versioning, no-leak proofs via the RL-054
  scanner), connector provisioning over the RL-044 closed vocabularies
  (the observation + user-guided degradation floor provisions honestly)
  plus managed-edge enrollment records, the RoamLink-side customer webhook
  contract (emissions ONLY from validated RoamLink durable state
  transitions — RL-LOCK-009 — with HMAC-SHA256 authentication, replay
  windows, per-endpoint dedupe + bounded retries), and the typed,
  versioned, additive-tolerant `/v1/enterprise/...` public API surface
  (route table, fail-closed parsers, the four-stage acknowledgement
  mirror, typed client, deterministic in-memory fake).
- `apps/mobile` — the mobile/edge UX shell (RL-062, Wave 4): the
  observation/experience/synchronization agent surface per spec/mobile.md —
  the edge desired-state loop UI (local context -> policy evaluation ->
  capability-gated desired action -> encrypted offline outbox -> sync ->
  authoritative result -> local projection update). The shell reuses the
  edge packages (@roamlink/edge capability model + observation engine +
  offline outbox, @roamlink/edge-actions device-action adapter) and
  contains NO radio/network authority logic: freshness is ALWAYS rendered
  (FRESH degrades to STALE; UNKNOWN presented, never hidden; connectivity
  is never fabricated), offline continues observation + bounded telemetry
  + desired-state changes, degraded controls render observation/manual
  guidance, and the enrollment publishes a signed/versioned/expiring
  capability snapshot through an injectable signer port (key material
  never enters the shell). Host-agnostic by construction — platform
  seams (probe/executor/cipher/signer/transport) are all injected.
- `apps/portal-host` — the real deployable Next.js host (RL-089): composes
  `apps/web` (under `/`), `apps/admin` (under `/admin`) and the `services/api`
  API/BFF (under `/v1`) into one Node 22+ runtime with real health
  (`/healthz`) and readiness (`/readyz` — since RL-100 carrying the honest
  composed vocabulary `ready | degraded:<dep> | not-ready:<reason>`: the
  database probe + the migration ledger +, when `ROAMLINK_API_BASE_URL` is
  configured, a bounded-timeout probe of the API's own readiness) endpoints.
  Route handlers are three-line
  forwarders into framework-free handlers; the call-chain discipline is
  HTTP → application command/query → domain/integration → persistence
  (routes never touch the database). The boot is fail-closed: a composition
  that refuses to start serves only the honest 503 — it never degrades to a
  fake. Per spec/adr/0003 Vercel is the host, not the authority: the same
  host runs anywhere with a PostgreSQL `DATABASE_URL` (zero provider
  lock-in, no secrets in code).
- `infra/migrations` — the first real SQL migrations (RL-092): forward/
  rollback pairs for the identity/org schema ledger, versioned records,
  durable outbox, durable inbox, and the command/commerce/notification/
  projection tables, applied idempotently through the
  `packages/persistence-postgres` runner (manifest ledger + verified
  forward/rollback cycle).
- `tests/architecture` — architecture conformance suite (RL-LOCK-018),
  including dependency-direction proofs for the Wave-2, Wave-3 and Wave-4
  worker packages (apps consume only the application kit; the app contract
  mirrors the owning domain vocabularies without merging state families).
- `tests/conformance` — the RL-070 authority conformance suite: one
  negative-proof suite per architecture lock (ADCOS-the-only-authority,
  one integration boundary, no duplicate identity/session/path/provider
  authority, intent separation, payment != delivery, webhooks-are-signals,
  evidence/freshness first-class, capability evidence-based, AI advisory-only,
  no provider SDK leakage, idempotent commands, offline convergence, no
  secret leakage, versioned contracts, three-worker-safe ownership). Every
  suite has a green proof on the current tree and a toggleable violating
  fixture (`ROAMLINK_CONFORMANCE_VIOLATION=<LOCK-ID>`) that must turn it
  red - a suite that cannot fail is not a proof.
- `tests/simulation` — the RL-071 failure/reordering/duplicate simulation
  suite: deterministic end-to-end scenarios (duplicates at every boundary,
  reordering vs projection ordering defense, loss -> reconciliation repair,
  delay -> STALE decay and recovery, offline partition convergence,
  UnitOfWork atomicity + outbox retry, byzantine webhook rejection and
  schema-drift fail-closed) asserting the ARCHITECTURAL invariants (no
  duplicate effects, no fabricated truth, no lost work) over the public
  packages and the §10 ADCOS fake only.
- `tests/dogfood` — the RL-072 end-to-end dogfood scenario suite: five
  full-lifecycle journeys (onboarding -> first usable connectivity,
  degradation -> failover -> recovery, offline edge round-trip,
  refund + partial refund with incident correlation, enterprise onboarding
  -> admin observation) composing the REAL packages through their public
  surfaces with deterministic clock/ids and one correlation-ID family per
  scenario, asserting architectural truth properties (authority, evidence,
  freshness, idempotency, no fabricated truth) on observable public state
  only.
- `tests/load` — the RL-073 load/reliability suite: deterministic
  load-shaped suites (no wall-clock timing) proving complexity invariants
  through counting proxies over the public ports — high-volume webhook
  ingestion (O(1) per event, zero duplicate work, reordering convergence),
  sustained edge outbox churn (exactly-once convergence, bounded retry
  work), notification fan-out under mute storms (per-user reads only),
  reconciliation full-vs-incremental canonical refresh (bounded per-target
  fetches, honest degradation), and resilience under sustained failure
  (circuit-breaker probe saturation, retry/deadline budgets, limiter
  windows). Records DEFECT-1 (inbox drain backlog progression) with a
  minimal reproducer.
- `tests/security` — the RL-074 security/threat-model verification suite:
  an executable verification of spec/security.md's threat priorities —
  webhook source attacks, tenant/actor boundary attacks at every public
  surface, the RL-054 secret-scanner sweep across every persisted surface,
  auth/session attacks (AUTHENTICATED fabrication, rank demotion, rotation),
  audit-chain tamper detection, and privacy/retention enforcement — each
  with attack fixtures that MUST be rejected (negative proofs with
  durable-state consequences). Verdict matrix and honest gaps in
  docs/threat-model-verification.md.
- `tests/deployment` — the RL-075 deployment/recovery verification suite:
  deterministic simulations of the deployment and recovery story —
  migration/recovery, cold start/orderly shutdown with crash injection,
  backup/restore through the public contracts with reconciler drift repair,
  dependency-failure modes (ADCOS outage, partial degradation, clock skew,
  storage failure, compatibility gate) and honest health/readiness
  composition — asserting durability invariants (no lost work, no duplicate
  effects, convergence). Verified runbook and failure-mode matrix in
  docs/deployment-recovery.md.


## Current implementation handoff

The architecture and deterministic release-gate baseline are complete, and RL-082 through RL-118 are now implemented/evidenced. RL-118 deployment acceptance is recorded for the live demo environment.

The canonical current Tech Lead/Orchestrator handoff is:

- `spec/tech-lead-handoff-2026-09-21.md`

Supporting current evidence:

- `docs/capability-discoverability.md` — RL-115 capability entry/link/view/recovery audit and findings.
- RL-114 accessibility findings are pinned in the Wave 8 verification suites.
- `docs/reports/rl-118-deployment-acceptance.md` — live demo deployment record.
- `spec/current-state.md` — current implementation/deployment status.

The accepted demo runs on Vercel Hobby with Neon Free PostgreSQL. The RL-118 record contains 8 green checks, 4 named operator-phase skips, and 0 red rows. Cloudflare R2 and Upstash Redis/QStash were not enabled in the accepted demo, and ADCOS production credentials were not configured at acceptance time.

Post-acceptance work is now focused on closing the RL-114/RL-115 discoverability and capability gaps rather than restarting RL-082..RL-118.
