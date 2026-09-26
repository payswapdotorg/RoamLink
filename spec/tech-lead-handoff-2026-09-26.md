# RoamLink — Final Tech Lead / Orchestrator Handoff (2026-09-26)

Repository: payswapdotorg/RoamLink
Reviewed: 2026-09-26
Current main: a68cf94537d247401c2368c8446fb300136680e6
Architecture: v1.0.0, FROZEN
RL-001..RL-118: implemented/evidenced
PA-001..PA-019: implemented/evidenced
Current phase: live-runtime composition and final hosted journey completion

This handoff supersedes the earlier 2026-09-21 handoff.

## 1. Roadmap graph

FOUNDATION
RL-001..RL-081 ✅
        │
        ▼
WAVE 6 — Product shell + hosted runtime + providers
RL-082 ✅ → RL-083 ✅ → RL-084 ✅ → RL-085 ✅ → RL-086 ✅
                                      ├→ RL-087 ✅ → RL-088 ✅

RL-089 ✅ → RL-090 ✅
RL-003 ✅ → RL-091 ✅ → RL-092 ✅ → RL-093 ✅ → RL-094 ✅
RL-095 ✅ + RL-096 ✅ + RL-097 ✅ + RL-098 ✅ + RL-099 ✅ → RL-100 ✅

WAVE 7 — Journey completion + runtime hardening
RL-101 ✅ → RL-102 ✅ → RL-103 ✅ → RL-104 ✅
RL-105 ✅ → RL-106 ✅ → RL-107 ✅ → RL-108 ✅
RL-109 ✅ → RL-110 ✅ → RL-111 ✅ → RL-112 ✅

WAVE 8 — Validation + deployment acceptance
RL-113 ✅ + RL-114 ✅ + RL-115 ✅ + RL-116 ✅
                         │
                         ▼
                    RL-117 ✅
                         │
                         ▼
                    RL-118 ✅

POST-ACCEPTANCE
PA-001 ✅ → PA-002 ✅ → PA-003 ✅ → PA-004 ✅ → PA-005 ✅
PA-006 ✅ → PA-007 ✅ → PA-008 ✅ → PA-009 ✅ → PA-010 ✅
PA-011 ✅ → PA-012 ✅ → PA-013 ✅ → PA-014 ✅ → PA-015 ✅
PA-016 ✅ → PA-017 ✅ → PA-018 ✅ → PA-019 ✅

CURRENT NEXT WAVE
PA-020 → PA-021 → PA-022
      ├→ PA-023
      ├→ PA-024
      ├→ PA-025
      └→ PA-026 → PA-027 → PA-028 → PA-029

## 2. Interfaces

### Customer portal
Mounted by the real Next.js portal host and composing apps/web.
Major routes: /login, /onboarding, /, /connectivity, /activity, /devices, /devices/{deviceId}, /devices/{deviceId}/sim, /intents, /intents/{intentId}, /commerce, /orders/{orderId}, /support, /support/{caseId}, /workspace, /settings, /more.

### Admin / operations
apps/admin is an actual operations console with Tenants, Audit & security, Reconciliation, Projection health, SLO health, Support triage and Integration health.
The SLO dashboard is host-side and session-gated at /ops/slo.

### Mobile / edge
apps/mobile provides Now, Capabilities, Controls and Outbox.

## 3. Design baseline
Continue the current RoamLink UX architecture inspired by pectoraux/ShareNet:
- warm/light, quiet visual language;
- generous whitespace;
- desktop sidebar;
- mobile bottom navigation;
- persistent connectivity status;
- lightweight onboarding;
- one primary action per major page;
- calm loading/empty/error states;
- technical diagnostics separated from the normal customer path;
- progressive Summary → Why → Evidence → Technical disclosure.

ShareNet is inspiration only. Do not copy its code, assets, branding or semantics.

Customer mental model: Goal → Devices → Connectivity → Activity.
Plans & Billing, Support and Workspace remain supporting surfaces.

## 4. PA-018 / PA-019 baseline
PA-018 closes the old host form-action wiring defect. The rendered flow union is dispatched through the authenticated portal host with typed parsing, session/CSRF validation and fail-closed rendering.

PA-019 closes the old all-501 business-read composition gap for state actually bound to the service. Current composed reads include users, organizations, devices, experience intents and versions, payments, connectivity, reconciliation jobs and support cases.

Truth law:
accepted command != executed command != delivered != billable-final.

An accepted-but-not-executed command produces an honest empty read model.

## 5. Critical current finding
The UI is no longer merely a library.

The remaining gap is live runtime composition: several customer/admin reads are intentionally unbound, and several UI mutations are not yet present in the live services/api mutation route table.

Current kept-501 reads:
/v1/products
/v1/orders
/v1/orders/{orderId}
/v1/subscriptions
/v1/notifications
/v1/audit-events
/v1/projection-health
/v1/integration-health

/v1/enterprise/workspace is currently not composed and answers a real 404.

Current mutation-route table does not yet include live eSIM mutations or enterprise connector provisioning.

Therefore surface-level RL-114/RL-115 discoverability completion is green, but live hosted journey completion is not.

## 6. Journey simulation

Login → Home: ◐
Authentication and shell are real. Home can still fail closed because it depends on the unbound notification store.
Next behavior: render core Home facts while isolating unavailable secondary notification/activity data.

Onboarding: ◐
Wizard and forms are real. Device reads now compose. Goal activation still stops honestly because the current demo command plane does not have the execution worker advancing accepted commands to executed.

Goals: ◐
Real empty-state read and durable create exist. Activation/supersession correctly refuse to act on a non-executed resource.

Devices: ◐
List/detail reads compose. Enrollment is durable but requires command execution before it becomes a projected device.

eSIM: ◐
Customer UX and host flow wiring exist, but the live API mutation route table lacks the eSIM mutation routes.

Connectivity: ◐
Real empty connectivity aggregate composes. Actual delivery/recovery still requires worker execution, live ADCOS compatibility, observation/evidence and reconciliation.

Activity / Notifications: ❌ for complete live journey
Activity is the primary customer narrative, but the notification store is not bound on the real API.

Plans & Billing / Orders / Delivery: ❌ for complete live journey
Products, orders, order detail and subscriptions are still honest 501 reads.

Support: ◐
Support creation and support-case reads are real; contextual support-carrier behavior remains valid.

Enterprise Workspace: ❌ for complete live journey
The workspace UI exists, but /v1/enterprise/workspace is not composed. Connector provisioning is host-wired but lacks the live services/api mutation route.

Admin / Operations: ◐
SLO is reachable through the admin navigation. Integration health, audit and projection health still need real data-plane composition or local typed-unavailable handling.

Offline mobile edge: ✅ at the edge-contract level
Now, capabilities, controls, encrypted outbox, offline convergence, manual fallback and evidence/freshness are covered. Final black-box acceptance remains.

## 7. Product learning
The next UX improvement is component-scoped degradation, not visual redesign.

Primary surface
  → core fact available: render it
  → secondary fact unavailable: render a quiet unavailable section
  → mutation available: expose it
  → mutation unavailable: explain plus fallback/support

A missing optional read must not blank Home, Connectivity, Activity, Workspace or Admin when the rest of that page has authoritative data.

## 8. Three-worker implementation plan

### Worker A — Experience / accessibility / black-box UI
PA-020 — component-scoped degradation across Home, Connectivity, Activity, Workspace and Admin.
PA-021 — browser-level acceptance against deployed BASE_URL covering login, onboarding, Goals, Devices, SIM & Profiles, Connectivity, Activity, Plans & Billing, Orders, Support, Workspace, Admin, SLO and Integration Health.
PA-022 — final UX closure after runtime sources are live; no architecture redesign.

### Worker B — API / persistence / workers / runtime
PA-023 — mutation-route parity: eSIM install/enable/remove and enterprise connector provisioning; add a CI parity law between CustomerWebApp flow union, portal-host dispatcher and services/api mutation routes.
PA-024 — compose remaining live read models: products, orders, order detail, subscriptions, notifications, enterprise workspace, integration health, audit/security and projection health as required by the journeys.
PA-025 — make the command-execution path live in the demo. Preferred low-cost topology: Neon durable outbox → QStash → authenticated bounded worker endpoint → existing services/workers execution seam → executed/delivered/billable-final facts → read models.
PA-026 — complete enterprise workspace + connector runtime composition end-to-end.

### Worker C — deployment / providers / release
PA-027 — deploy current main after A/B changes and run migration, smoke, demo acceptance and rollback checks against the actual deployed SHA.
PA-028 — validate the free-tier provider stack and actual runtime enablement: Vercel, Neon, Upstash Redis, Upstash QStash, Cloudflare R2 and ADCOS public Developer API.
PA-029 — final live acceptance and handoff record.

## 9. Free-tier deployment plan
Current accepted demo history definitely uses Vercel Hobby for hosting and Neon Free PostgreSQL for durable state.

R2, Redis and QStash have real-wire provider verification in PA-012, PA-013 and PA-017. Their current runtime enablement must be confirmed again on the current main acceptance run.

Target early validation stack:
Vercel Hobby + Neon Free + Upstash Redis Free + Upstash QStash Free + Cloudflare R2 + ADCOS public Developer API.

Provider roles:
PostgreSQL = durable business truth.
Redis = ephemeral accelerator.
QStash = asynchronous delivery.
R2 = object storage.
Vercel = host/runtime.
ADCOS = connectivity authority.

Current official free-tier facts:
- Vercel Hobby is $0 but current terms restrict it to personal/non-commercial use. citeturn676093search0
- Neon Free currently includes 10 projects, 50 CU-hours/month/project, 0.5 GB storage/project, 10 branches/project and 5 GB/month egress. citeturn676093search4
- Upstash Redis Free is $0 with 256 MB data, 500K monthly commands and 10 GB monthly bandwidth. citeturn676093search1
- Upstash QStash Free is $0 with 1,000 messages/day, 50 GB/month bandwidth and 1 MB max message size. citeturn676093search3
- Cloudflare R2 free tier includes 10 GB-month Standard storage, 1M Class A operations and 10M Class B operations/month, with free internet egress. citeturn676093search2

Never encode provider limits into correctness.

## 10. Handoff startup sequence
1. Read architecture-lock, architecture, authority-model and ADCOS integration.
2. Read ux-architecture, docs/live-journey-runtime-audit-2026-09-26, deployment and current-state.
3. Inspect apps/web, apps/admin, apps/mobile, apps/portal-host, services/api and services/workers.
4. Verify mutation parity.
5. Verify read-model coverage.
6. Run pnpm install, pnpm check, pnpm mvp-gate, pnpm production-gate, pnpm smoke:selftest and pnpm demo:acceptance:selftest.
7. Deploy current main.
8. Run the live browser journey suite.
9. Dispatch Workers A/B/C.

## 11. Merge/release rules
Reject work that:
- invents state to make a page look complete;
- treats accepted as executed;
- treats executed as delivered;
- treats payment as connectivity delivery;
- wires forms only to deterministic fakes;
- leaves a rendered action without a real API route;
- leaves a required journey read unbound;
- blanks a useful primary surface because a secondary read is unavailable;
- copies ShareNet code or branding;
- introduces a new connectivity/session/path/provider authority;
- encodes free-tier quotas into business correctness.

## 12. Final completion definition
Architecture: ✅
RL-114/RL-115 surface discoverability: ✅
Hosted product: pending PA-020..PA-029.

A major journey counts as complete only when:
discoverable → actionable → real API → real persistence → real execution → real read model → evidence/freshness → recovery/support.

Final individual journey:
login → onboarding → goal → device → eSIM/capabilities → connectivity → activity → purchase → payment → delivery evidence → support.

Final enterprise journey:
workspace → organization → policy → connector → devices → capability verification → first goal → live organization overview.

Final operator journey:
admin → SLO → integration health → reconciliation → projection health → audit → support.

RoamLink remains a Connectivity Experience OS above ADCOS.
The final criterion is not “every route returns 200”. It is that every architecture-promised journey is discoverable, executable end-to-end, evidence-backed, recoverable and truthful.