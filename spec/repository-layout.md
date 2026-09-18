# Repository Layout

```text
RoamLink/
  apps/
    web/
    admin/
    mobile/
  packages/
    contracts/
    domain-experience/
    domain-commerce/
    adcos/
    projections/
    edge/
    auth/
    observability/
    testkit/
  services/
    api/
    workers/
    reconciler/
    webhook-ingest/
  infra/
    migrations/
    deployment/
  tests/
    architecture/
    contract/
    integration/
    e2e/
    simulation/
  spec/
    adr/
    state-machines/
  .github/
    workflows/
```

## Dependency direction

`contracts` is lowest-level.

`domain-experience` and `domain-commerce` depend on contracts, never on ADCOS internals.

`adcos` owns all ADCOS boundary concerns and may depend on contracts.

`projections` may depend on contracts and the public ADCOS boundary types, not ADCOS implementation modules.

`edge` depends on contracts and experience policy interfaces; platform adapters are leaf dependencies.

`apps` consume public application APIs/read models and do not contain authority logic.

`services` compose domain modules and integration modules; they do not redefine domain authority.

`tests/architecture` is allowed to inspect dependency graphs and fail the build when forbidden imports appear.

## Runtime baseline

Use a typed, testable, reproducible TypeScript monorepo unless an approved ADR changes this choice. Prefer a workspace package manager, strict TypeScript, schema-first API contracts, PostgreSQL-compatible persistence, and a durable queue/outbox mechanism. Infrastructure choices may be swapped behind contracts.

Do not couple domain packages to a specific web framework, database ORM or cloud vendor.


## Hosted product additions

The post-gate hosted architecture adds a real application host without moving authority into the UI.

Recommended host composition:

- apps/portal-host — deployable web host for customer and admin surfaces.
- services/api — authenticated public API/BFF composition layer.
- services/workers — durable async work orchestration.
- services/reconciler — canonical ADCOS refresh/reconciliation worker.
- services/webhook-ingest — webhook admission endpoint/worker.
- infra/migrations — real PostgreSQL migration set.
- infra/deployment — provider manifests and environment templates.

Existing apps/web, apps/admin and apps/mobile remain presentation/application packages. They are consumed by the host and do not become authority-bearing services.
