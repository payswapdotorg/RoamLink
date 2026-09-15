# Implementation Work Items

Work items are atomic enough for one worker branch/session and have explicit outputs. IDs are stable.

## Foundation
- **RL-001 Repo/CI foundation** — runtime, package manager, lint/type/test, commit hooks, CI, env schema, local dev.
- **RL-002 Architecture contracts** — common IDs, timestamps, evidence, errors, command envelope, versioning.
- **RL-003 Persistence/queue primitives** — migrations, transaction boundary, outbox/inbox primitives, optimistic concurrency.
- **RL-004 Auth/tenant boundary** — users, organizations, membership, sessions, service authorization.

## Experience
- **RL-010 Device registry** — device lifecycle, capability snapshots, context snapshots.
- **RL-011 ExperienceIntent** — immutable versions, validation, supersession, policy/preferences.
- **RL-012 Intent compiler** — deterministic ExperienceIntent -> ADCOS ConnectivityIntent mapping with traceability.
- **RL-013 Experience decision/read model** — explainability, freshness/evidence, derived customer status.
- **RL-014 Notifications/support** — durable notifications, support cases and incident correlation.

## Commerce
- **RL-020 Product/catalog**
- **RL-021 Order/subscription lifecycle**
- **RL-022 Customer payments/invoices/refunds**
- **RL-023 Commerce-to-connectivity reference model** — order does not imply delivery.

## ADCOS integration
- **RL-030 ADCOS public-client contract** — contract types only; no internals.
- **RL-031 ADCOS intent adapter** — command mapping/idempotency.
- **RL-032 Offer/reservation adapter** — reads and commands supported by current ADCOS API.
- **RL-033 Webhook inbox** — authentication, replay defense, durable admission.
- **RL-034 Projection engine** — canonical-resource projections with provenance/freshness.
- **RL-035 Reconciliation engine** — periodic/triggered repair and canonical refresh.
- **RL-036 ADCOS compatibility suite** — contract/self-test against real/fake ADCOS.

## Edge
- **RL-040 Edge capability contract**
- **RL-041 Edge observation engine**
- **RL-042 Encrypted offline outbox/sync**
- **RL-043 Device action adapter** — platform-scoped, capability-gated actions only.
- **RL-044 Enterprise edge connector contract**

## Platform/security
- **RL-050 Secrets/credentials boundary**
- **RL-051 Audit/security events**
- **RL-052 Observability/SLO instrumentation**
- **RL-053 Rate limits/retries/circuit breakers**
- **RL-054 Data retention/privacy enforcement**

## Product surfaces
- **RL-060 Customer web application**
- **RL-061 Admin/operations console**
- **RL-062 Mobile/edge UX shell**
- **RL-063 Enterprise onboarding/API surface**

## Verification
- **RL-070 Authority conformance suite**
- **RL-071 Failure/reordering/duplicate simulation**
- **RL-072 End-to-end dogfood scenarios**
- **RL-073 Load/reliability tests**
- **RL-074 Security/threat-model verification**
- **RL-075 Deployment/recovery verification**

## Release gates
- **RL-080 MVP release gate**
- **RL-081 Production readiness gate**

Every work item must update tests and documentation for the behavior it introduces. A work item is incomplete if it only implements the happy path.
