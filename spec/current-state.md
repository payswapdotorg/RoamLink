# Current State

**Reviewed:** 2026-09-26
**Repository:** payswapdotorg/RoamLink
**Current main:** a68cf94537d247401c2368c8446fb300136680e6

**Architecture:** v1.0.0, FROZEN FOR IMPLEMENTATION.
**Implementation:** RL-001 through RL-118 implemented/evidenced.
**Post-acceptance:** PA-001 through PA-019 implemented/evidenced.
**Deployment:** hosted Vercel + Neon demo exists; current main has a successful Vercel check.
**Next phase:** live-runtime composition and final hosted journey completion.

## Delivered baseline

### Foundation / architecture
- Frozen layered architecture and authority model.
- ADCOS public Developer API boundary and lifecycle mapping.
- Customer/ADCOS state separation.
- Customer, commerce, edge, platform/security and integration packages.
- Architecture conformance, simulation, dogfood, load, security and deployment verification.
- RL-080 MVP release gate: PASS.
- RL-081 production-readiness gate: PASS.

### Hosted productization
- RL-082..RL-088 customer shell, onboarding, Connectivity, Activity, Goals, Devices and accessibility.
- RL-089..RL-094 hosted runtime, API/BFF, PostgreSQL, SQL migrations and durable recovery.
- RL-095..RL-100 provider adapters, deployment manifests, health/readiness and smoke.
- RL-101..RL-112 journey completion, hardening, worker/maintenance and ops verification.
- RL-113..RL-118 journey validation, discoverability/accessibility audits, demo acceptance and deployment acceptance.

### Post-acceptance
- PA-001 eSIM customer journey.
- PA-002 refund read model.
- PA-003 order discoverability + notifications compatibility-only contract.
- PA-004 web accessibility closure.
- PA-005 mobile accessibility/navigation closure.
- PA-006 enterprise connector UX.
- PA-007 organization policy read model.
- PA-008 enterprise integrations UX.
- PA-009 SLO navigation.
- PA-010 integration-health surface.
- PA-011 real PostgreSQL verification.
- PA-012 real R2 verification.
- PA-013 real Redis verification.
- PA-014..PA-016 deployment/provider acceptance work.
- PA-017 real QStash wire verification.
- PA-018 hosted form-action wiring.
- PA-019 real business read-model composition.

## Current interfaces

Customer:
- hosted Next.js portal composing apps/web;
- onboarding;
- Home;
- Connectivity;
- Activity;
- Devices;
- eSIM/SIM & Profiles;
- Goals;
- Plans & Billing;
- Orders;
- Support;
- Workspace;
- Settings/More.

Admin:
- tenants;
- audit/security;
- reconciliation;
- projection health;
- SLO health;
- support triage;
- integration health.

Mobile/edge:
- Now;
- Capabilities;
- Controls;
- Outbox.

## Current live-runtime qualification

The surface-level RL-114/RL-115 discoverability audit is closed.

The newer runtime audit is recorded in:
docs/live-journey-runtime-audit-2026-09-26.md

The key distinction is:

**surface capability != live-runtime capability**

PA-019 composes real reads for:
- users;
- organizations;
- devices;
- experience intents/versions;
- payments;
- connectivity;
- reconciliation jobs;
- support cases.

The real API still keeps named 501 reads for:
- products;
- orders;
- order detail;
- subscriptions;
- notifications;
- audit events;
- projection health;
- integration health.

Enterprise workspace is currently not composed and returns a real 404.

services/api mutation routes currently do not yet cover:
- eSIM install/enable/remove;
- enterprise connector provisioning.

The current live demo also does not yet provide the complete command-execution path that advances accepted commands to executed/delivered/billable-final. Consequently some pages correctly render empty/read-first-not-found states instead of inventing resources.

## Current deployment

The accepted demo history uses:
- Vercel Hobby;
- Neon Free PostgreSQL.

Provider wire verification has also been completed for:
- Cloudflare R2;
- Upstash Redis;
- Upstash QStash.

Those providers may be optional or disabled in the current demo environment; their active runtime configuration must be re-recorded against current main.

ADCOS production credentials are still a required external integration flip for live connectivity delivery.

The formal RL-118 acceptance report predates the latest PA-018/PA-019 merges. The next tech lead must regenerate the final live acceptance record against the current main.

## Next implementation phase

Canonical handoff:
spec/tech-lead-handoff-2026-09-26.md

Three workers:

- Worker A: component-scoped UI degradation, browser-level deployed journeys, final UX closure.
- Worker B: mutation-route parity, remaining real read models, live command execution, enterprise runtime.
- Worker C: current-main deployment, provider configuration, live acceptance and release record.

## Completion definition

Architecture:
✅ complete.

Surface discoverability:
✅ RL-114/RL-115 closure.

Hosted product:
pending the live-runtime completion wave.

A journey is complete only when:
1. the user can discover it;
2. the UI action reaches the real API;
3. durable state is written;
4. execution advances the command where required;
5. the correct read model observes the result;
6. evidence/freshness is shown;
7. failure/degradation is honest;
8. recovery/support is reachable.

RoamLink must remain a Connectivity Experience OS above ADCOS.
