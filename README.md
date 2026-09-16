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
- `packages/domain-experience` — the Experience domain (RL-010 + RL-011):
  the Device aggregate (lifecycle, ownership, platform metadata), immutable
  evidence-tagged `DeviceCapabilitySnapshot` over the closed 11-name
  capability vocabulary mirroring spec/architecture.md §7 (drift-guarded),
  the privacy-classified, minimized `DeviceContextSnapshot` with
  consent-gated fine location, and `ExperienceIntent` with immutable
  versions linked by a supersession chain plus a validated state machine.
  Access classes are PREFERENCES ONLY; no ADCOS types are imported or
  modeled (RL-LOCK-007) — compilation to ADCOS ConnectivityIntent is
  RL-012 (Wave 2).
- `packages/edge` — edge capability contract package (RL-040): closed
  capability vocabulary with platform scope + evidence requirements, the
  immutable versioned capability snapshot, the pure evidence-based
  capability gate (`assertCapability`), device action request/result
  contracts, and the desired-state + encrypted-outbox record shapes.
  Contracts only — platform adapters (RL-043) and the sync engine (RL-042)
  come later.
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
- `packages/observability` — platform observability contracts: correlation-ID
  context propagation from the Wave-0 command envelope, the redacting
  structured log record contract, the counter/gauge/histogram naming + label
  contract (no vendor SDK), and health/readiness aggregation.
- `packages/testkit` — deterministic test primitives: monotonic injectable
  clock, deterministic ID generators, in-memory event/command recorders, and
  fixture builders for the Wave-0 contract types.
- `tests/architecture` — architecture conformance suite (RL-LOCK-018).
