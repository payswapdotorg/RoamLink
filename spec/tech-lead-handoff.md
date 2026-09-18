# RoamLink — Final Tech Lead / Orchestrator Handoff

## Handoff status

**Repository:** `payswapdotorg/RoamLink`  
**Architecture:** v1.0.0, FROZEN  
**Completed baseline:** RL-001 through RL-081 implementation/evidence present; RL-080 and RL-081 release-gate reports are PASS artifacts.  
**Current phase:** Post-gate productization: RL-082 through RL-118.  
**Hosted product status:** NOT YET DEPLOYED as a complete interactive product.  
**Source of truth:** this repository only.

## 1. Read before changing code

Read in this order:

1. `spec/architecture-lock.md`
2. `spec/architecture.md`
3. `spec/authority-model.md`
4. `spec/adcos-integration.md`
5. `spec/ux-architecture.md`
6. `spec/user-journey-audit.md`
7. `spec/deployment.md`
8. `spec/work-items.md`
9. `spec/dependency-graph.md`
10. `spec/orchestrator.md`
11. `spec/current-state.md`
12. `spec/post-release-roadmap.md`
13. approved ADRs under `spec/adr/`
14. `docs/reports/mvp-release-gate.md`
15. `docs/reports/production-readiness-gate.md`

Then inspect the actual implementation tree.

## 2. Mission

Turn the already-verified RoamLink architecture into a genuinely usable, discoverable and deployable product.

Do not redesign the architecture.

Do not build a second connectivity OS.

Do not replace ADCOS authority.

The post-gate mission is:

`frozen architecture -> coherent UX -> real hosted runtime -> real persistence -> durable workers -> real ADCOS boundary -> deployed product -> journey validation`

## 3. Product definition

RoamLink is the Connectivity Experience OS above ADCOS.

Customer mental model:

- **Goals** — what connectivity experience the customer wants.
- **Devices** — where RoamLink is helping.
- **Connectivity** — what is happening and why.
- **Activity** — what RoamLink did and whether the customer needs to act.

Do not expose `ExperienceIntent`, `ConnectivityIntent`, NetworkPath, Lease, provider adapters or routing as the primary novice product vocabulary.

Advanced details remain available through progressive disclosure.

## 4. Non-negotiable architecture

ADCOS remains authoritative for:

- ConnectivityIntent;
- eligibility;
- Offer;
- Reservation/Lease;
- NetworkPath/path selection;
- Session;
- mobility;
- provider/access adapters;
- connectivity usage evidence;
- ADCOS commercial settlement.

RoamLink owns:

- customer/user/org identity;
- device registry/context;
- ExperienceIntent;
- customer goals/preferences;
- customer commerce;
- customer payment state;
- support/notifications;
- customer UX;
- projections/read models;
- reconciliation orchestration.

Provider/platform domains retain their own native authority.

Never introduce:

- local routing authority;
- local session authority;
- duplicate provider registry authority;
- duplicate ADCOS identity;
- payment-as-delivery semantics.

## 5. UX requirements

The target customer shell is defined in `spec/ux-architecture.md`.

Use the useful interaction principles found in `pectoraux/ShareNet`:

- quiet warm-light consumer surface;
- persistent connectivity status;
- desktop sidebar;
- mobile bottom navigation;
- lightweight onboarding;
- simple home hero;
- restrained connection-state visual language;
- generous whitespace;
- separate diagnostics/admin surface;
- quiet, human-readable error states.

Do not copy ShareNet code or branding.

RoamLink-specific navigation:

Desktop:
- Home
- Connectivity
- Activity
- Devices
- Goals
- Plans & Billing
- Support

Mobile:
- Home
- Connect
- Activity
- Devices
- More

## 6. Required first-run journey

A new customer must be able to complete:

`land -> understand -> choose goal -> enroll device -> confirm preferences -> reach Home`

The onboarding must remain lightweight and non-technical.

## 7. Required main journey

The primary experience must be:

`Home -> Goal -> Device -> Connectivity -> Activity -> Support`

Users must be able to understand:

- what is happening;
- why RoamLink is acting;
- what evidence exists;
- whether information is fresh;
- what RoamLink does not know;
- what the next action is.

## 8. Failure/recovery UX

Connectivity failure must surface as a narrative, not a generic error:

`observed -> requested -> accepted -> reserved -> path active -> delivery -> recovered`

Never show success merely because:

- payment succeeded;
- an order was placed;
- a reservation exists;
- a webhook arrived.

Use evidence and freshness.

Support must be accessible from degraded and failed states.

## 9. Commerce journey

A paid connectivity journey must visibly distinguish:

`payment confirmed`

from:

`connectivity requested -> offer/reservation -> activation -> delivery evidence -> billable-final`

The UI must never collapse these states.

## 10. Device experience

Every device must expose a human-readable capability view:

- automatic;
- confirmation required;
- manual;
- unavailable;
- unknown.

Platform limitations become actionable guidance, not silent failures.

The edge must continue useful observation and desired-state work while disconnected and converge when connectivity returns.

## 11. Enterprise journey

Implement:

`workspace -> organization verification -> policy -> connector -> devices -> capability verification -> first goal -> live organization overview`

Enterprise UX is not allowed to create a second connectivity authority.

## 12. Three-worker operating model

### Worker A — Experience

Wave 6:
- RL-082
- RL-083
- RL-084
- RL-085
- RL-086
- RL-087
- RL-088

Wave 7:
- RL-101
- RL-102
- RL-103
- RL-104

### Worker B — Runtime / ADCOS

Wave 6:
- RL-089
- RL-090
- RL-091
- RL-092
- RL-093
- RL-094

Wave 7:
- RL-105
- RL-106
- RL-107
- RL-108

### Worker C — Deployment / Platform

Wave 6:
- RL-095
- RL-096
- RL-097
- RL-098
- RL-099
- RL-100

Wave 7:
- RL-109
- RL-110
- RL-111
- RL-112

### Wave 8

All three workers may parallelize validation work:

- RL-113
- RL-114
- RL-115
- RL-116
- RL-117

The orchestrator owns RL-118.

## 13. First actions

Before implementation:

1. clone/open the repository;
2. inspect the complete tree;
3. read the frozen architecture documents;
4. run:
   - `pnpm install`
   - `pnpm check`
   - `pnpm mvp-gate`
   - `pnpm production-gate`
5. verify the stored gate reports and current-state document agree;
6. reconcile any documentation-only drift before starting feature work;
7. construct the active RL-082..RL-118 dependency graph;
8. dispatch the three workers.

**Important:** the stored RL-081 report predates the latest `spec/current-state.md` refresh. Therefore re-run the release gates before considering the documentation-risk record fully cleared.

## 14. Wave 6 starting gate

Do not dispatch all three workers immediately unless their prerequisites remain satisfied.

The intended starting slice is:

Worker A:
`RL-082 -> RL-083`

Worker B:
`RL-089 -> RL-090`

Worker C:
`RL-095 + RL-096 + RL-097 + RL-098 + RL-099`

The orchestrator then integrates:

`RL-083 + RL-090 + RL-092 + RL-100`

before opening the full Wave 7 surface.

## 15. Hosted deployment

Use `spec/deployment.md` as the implementation authority.

Selected early stack:

- **Vercel** — hosted web/runtime;
- **Neon Postgres** — durable relational state;
- **Upstash Redis** — bounded ephemeral coordination;
- **Upstash QStash** — retryable asynchronous delivery;
- **Cloudflare R2** — object storage.

Provider rules:

- PostgreSQL is durable source of truth.
- Redis is never durable business state.
- QStash is never business-state authority.
- R2 is never relational authority.
- Vercel is only runtime/hosting.
- all providers sit behind replaceable ports.

Verify current provider plan limits and commercial terms at deployment time. Never hard-code an assumed quota into correctness logic.

## 16. Real persistence requirement

The deterministic in-memory persistence implementation is not sufficient for hosted deployment.

Implement:

- real PostgreSQL driver;
- real SQL migrations;
- transaction semantics matching the existing UnitOfWork contract;
- optimistic concurrency;
- durable inbox/outbox;
- backup/restore.

Do not weaken persistence semantics just to fit a serverless platform.

## 17. Existing known findings that must be handled

The previous gate artifacts recorded:

- outbox records potentially stranded in DELIVERING;
- inbox batch progression limitation;
- security findings AR-004..AR-008;
- infrastructure-verification limits;
- the now-refreshed current-state documentation gap.

RL-093 and RL-094 specifically target the two operational correctness findings that matter immediately to hosted deployment.

Review `docs/reports/accepted-risks.json` before closing any risk.

## 18. Validation requirement

Do not validate the next phase only through unit tests.

Every major capability must be exercised through a user journey:

- onboarding;
- goal creation/editing;
- device enrollment;
- connectivity observation;
- degraded connectivity;
- automatic recovery;
- activity explanation;
- purchase;
- delivery;
- support;
- offline edge;
- enterprise onboarding.

Every journey must verify:

- discoverability;
- completion;
- degraded state;
- recovery state;
- support escape hatch;
- responsive/mobile behavior.

## 19. Definition of deployed

RoamLink is NOT considered deployed merely because Vercel serves HTML.

RL-118 requires:

1. real hosted web application;
2. real PostgreSQL;
3. reachable webhook endpoint;
4. real ADCOS compatibility probe;
5. real onboarding -> goal -> device -> connectivity -> activity -> support journey;
6. enterprise onboarding;
7. degraded/recovery journey;
8. offline mobile behavior;
9. responsive ShareNet-inspired shell;
10. deployed smoke tests;
11. accepted risks explicitly dispositioned;
12. architecture conformance still green.

## 20. Final rule

The implementation succeeds only when the user experiences RoamLink as one coherent Connectivity Experience OS while ADCOS remains the underlying connectivity authority.

Do not optimize for ticket completion.

Optimize for:

**architectural integrity + discoverability + truthful state + recoverability + deployability.**
