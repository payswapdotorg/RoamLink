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
