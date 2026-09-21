# Current State

**Reviewed:** 2026-09-21  
**Repository:** `payswapdotorg/RoamLink`  
**Current main:** `acb3a827661a2b1b94c18f2c037e567c6b8c0eed`

**Architecture:** v1.0.0, FROZEN FOR IMPLEMENTATION.  
**Implementation:** RL-001 through RL-118 are implemented/evidenced.  
**Deployment:** RL-118 deployment acceptance passed for the live demo environment.  
**Next phase:** post-acceptance capability/discoverability closure.

## Delivered baseline

### Foundation / architecture
- Frozen layered architecture and authority model.
- ADCOS public Developer API boundary and lifecycle mapping.
- Customer/ADCOS state separation.
- Customer domain, commerce, edge, platform/security and integration packages.
- Architecture conformance, simulation, dogfood, load, security and deployment verification.
- RL-080 MVP release gate: PASS.
- RL-081 production-readiness gate: PASS.

### Hosted productization
- RL-082/083 onboarding and customer application shell.
- RL-084/085 Connectivity Center and Activity narrative.
- RL-086/087 Goals and Device capability experience.
- RL-088 responsive/accessibility verification.
- RL-089/090 hosted Next.js portal + API/BFF composition.
- RL-091 PostgreSQL persistence.
- RL-092 SQL migrations.
- RL-093/094 durable recovery and inbox progression.
- RL-095..099 provider adapters and deployment manifests.
- RL-100 real health/readiness + synthetic smoke.
- RL-101..104 journey completion.
- RL-105..108 runtime/ADCOS hardening.
- RL-109..112 operations verification.
- RL-113..116 journey, UX, discoverability and SLO validation.
- RL-117 demo acceptance gate.
- RL-118 deployment acceptance.

## Live demo deployment

The accepted deployment record is `docs/reports/rl-118-deployment-acceptance.md`.

Current recorded demo stack:
- Vercel Hobby / Next.js portal-host.
- Neon Free PostgreSQL.
- Webhook signing configured.
- Redis/QStash not configured in the demo.
- Cloudflare R2 not enabled in the demo.
- ADCOS production compatibility credentials not configured at the time of acceptance.
- Live smoke: 7/7 green.
- RL-118: 8 green, 4 named-skip, 0 red, exit 0.

The named skips are explicit operator-phase state, not silently passed criteria.

## Journey/discoverability state

The current customer journey is coherent across:
`onboarding -> goals -> devices -> connectivity -> activity -> support`.

The current enterprise journey is visible as:
`workspace -> organization verification -> policy -> connector -> devices -> capability verification -> first goal -> live overview`.

The remaining post-acceptance gaps are recorded in `docs/capability-discoverability.md` and the RL-114 verification suites.

### RL-115 capability gaps
- F1 eSIM profile management has no customer action journey.
- F2 SLO dashboard has no navigable admin entry point.
- F3 enterprise connector enrollment is status-only.
- F4 refunds have no customer surface.
- F5 SSO/SCIM/MDM have no enterprise UX/status surface.
- F6 ADCOS compatibility health has no admin surface.
- F7 organization policy has no real read model/surface.
- F8 order delivery journey is URL-only from the orders list.

### RL-114 accessibility/discoverability findings
- no web h1 contract on pages;
- heading hierarchy skips on some paths;
- 44px target floor is not universal;
- Notifications is URL-only;
- mobile shell lacks the web accessibility layer;
- mobile fragment links point at dead ids;
- mobile tables need proper header scoping and labelled scroll regions.

## Next implementation phase

Use `spec/tech-lead-handoff-2026-09-21.md`.

Three workers operate concurrently:

- **Worker A — Customer/Edge UX:** eSIM journey, refunds, order/notification discoverability, web accessibility, mobile accessibility/navigation.
- **Worker B — Enterprise/Admin:** connector enrollment, organization policy read model, enterprise integrations status, SLO navigation, ADCOS compatibility-health surface.
- **Worker C — Deployment/Operations:** R2, Redis, QStash and ADCOS live-wire configuration/verification, then final deployment acceptance.

The orchestrator owns shared contracts, architecture decisions, integration, release gates and the final capability audit.

## Completion definition

“Deployed” means the RL-118 accepted demo state.

“Post-acceptance complete” means every architecture-promised capability is either:
1. directly discoverable and actionable through a normal user journey, or
2. explicitly surfaced as unavailable/unsupported with a clear reason and support path,

while ADCOS remains the sole connectivity authority and all evidence/freshness rules remain truthful.
