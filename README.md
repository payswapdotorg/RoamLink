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

The current Tech Lead / Orchestrator handoff is:

- `spec/tech-lead-handoff-2026-09-21.md`

That document supersedes older post-gate status assumptions and contains the current roadmap graph, journey simulation findings, and next three-worker implementation plan.

## Current implementation status

- RL-001 through RL-081: ✅ foundation and release-gate baseline.
- RL-082 through RL-112: ✅ hosted productization, UX, persistence, provider adapters, workers and operational verification.
- RL-113 through RL-117: ✅ journey/UX/discoverability validation and demo acceptance gates.
- RL-118: ✅ deployment acceptance recorded on the live demo environment.

The accepted demo deployment is:

- **Vercel Hobby** — hosted Next.js portal/runtime.
- **Neon Free PostgreSQL** — durable relational source of truth.

The demo's RL-118 acceptance recorded 8 green checks and 4 named operator skips. Cloudflare R2 and Upstash Redis/QStash were not enabled in that demo environment, and ADCOS production compatibility credentials were intentionally not configured at acceptance time. The detailed record is `docs/reports/rl-118-deployment-acceptance.md`.

The product is therefore **deployed as an accepted demo**, but it still has post-acceptance UX/capability closure work recorded in the new Tech Lead handoff and in `docs/capability-discoverability.md`.

## Development

### Prerequisites

- Node.js >= 22
- pnpm 10

### Setup

```bash
pnpm install
```

### Core verification

```bash
pnpm check
pnpm mvp-gate
pnpm production-gate
```

### Deployment verification

```bash
pnpm smoke
pnpm demo:acceptance
pnpm rollback:check
```

Use the current handoff for the three-worker dispatch and the post-acceptance acceptance criteria.
