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


## Post-gate productization: customer experience + hosted runtime

### Wave 6 — Product shell + hosted runtime
- RL-082 First-run onboarding — lightweight four-step onboarding from plain-language value proposition to goal, device enrollment, and preferences.
- RL-083 ShareNet-inspired RoamLink application shell — responsive consumer shell, persistent connection state, desktop sidebar, mobile bottom navigation, warm-light visual system, separate diagnostics surface.
- RL-084 Connectivity Center — user-facing connectivity facts, lifecycle, evidence, freshness, active/recent access, and next action.
- RL-085 Activity / automation timeline — explain what RoamLink observed, requested, recovered, and what requires intervention.
- RL-086 Goal-oriented intent UX — expose ExperienceIntent as human-facing Goals with progressive technical detail.
- RL-087 Device capability experience — human capability matrix and platform limitation/fallback guidance.
- RL-088 Responsive/mobile accessibility pass — keyboard, touch-target, reduced-motion, semantic navigation, non-color-only state communication.
- RL-089 Next.js/Vercel web host — real deployable host composing customer/admin packages plus API/BFF.
- RL-090 API/BFF host composition — authenticated HTTP entry point for public app-kit commands/queries and webhook ingress.
- RL-091 Real PostgreSQL persistence driver — production implementation of the persistence ports with transactional and optimistic-concurrency semantics.
- RL-092 SQL migration set — first real schema migrations and reproducible migration/rollback workflow.
- RL-093 Durable outbox recovery — recover stuck DELIVERING claims using an explicit public recovery or visibility-timeout mechanism.
- RL-094 Inbox batch progression fix — ensure repeated bounded drains converge over arbitrarily large inbox backlogs.

### Wave 6 — Provider/deployment foundation
- RL-095 Neon environment provisioning.
- RL-096 Upstash Redis integration — bounded ephemeral rate-limit/cache/coordination adapter; never source of truth.
- RL-097 Upstash QStash job delivery — retryable asynchronous delivery.
- RL-098 Cloudflare R2 integration — object storage adapter for attachments, exports, and large artifacts.
- RL-099 Deployment manifests/environment separation.
- RL-100 Hosted health/readiness plus synthetic smoke.

### Wave 7 — Journey completion
- RL-101 Guided purchase-to-delivery experience.
- RL-102 Connectivity evidence and why progressive disclosure.
- RL-103 Support contextual entry points.
- RL-104 Enterprise onboarding journey.
- RL-105 Production API hardening.
- RL-106 Real database concurrency verification.
- RL-107 Webhook/reconciliation production worker wiring.
- RL-108 Production ADCOS compatibility probe.
- RL-109 Observability dashboard.
- RL-110 Scheduled/event-driven recovery jobs.
- RL-111 Production backup/export verification.
- RL-112 Deployment rollback verification.

### Wave 8 — Discoverability and confidence validation
- RL-113 User-journey E2E suite.
- RL-114 Responsive/accessibility verification.
- RL-115 Capability discoverability audit.
- RL-116 Telemetry/SLO journey validation.
- RL-117 Demo environment acceptance.
- RL-118 Production deployment acceptance.