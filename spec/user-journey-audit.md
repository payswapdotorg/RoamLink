# RoamLink User-Journey Audit

**Date:** 2026-09-18  
**Method:** repository-driven walkthrough of the actual customer web routes, admin routes, mobile shell, architecture, dogfood scenarios and ShareNet UX implementation.

## 1. Executive finding

RoamLink already contains substantial user-facing capability in code:

- customer web surface;
- admin/operations surface;
- mobile/edge UX shell;
- enterprise API surface;
- notifications/support;
- connectivity projections;
- experience intents;
- commerce;
- reconciliation/observability.

However, apps/web is explicitly a **library** that requires a host, and the repository does not currently contain a production web host/service or deployment configuration. Therefore the capabilities are implemented but are not yet presented as a single deployed product that a normal user can enter and navigate.

## 2. Simulated journey: first-time individual

1. Land on RoamLink.
2. Understand what it does.
3. Choose a goal.
4. Enroll device.
5. Configure preferences.
6. Connect.
7. Understand current state.
8. Recover automatically from degradation.
9. Inspect what RoamLink did.
10. Manage plan/payment.
11. Contact support.

### Findings

**Gap A — no lightweight first-run onboarding shell.**

The current route model starts with Overview and does not provide the ShareNet-style first-run explanation.

**Change:** add four-step onboarding.

**Gap B — the current vocabulary is too technical for first contact.**

Experience intents is an architecture term. A first-time customer should see Goals.

**Change:** human-facing labels with advanced terminology available on detail views.

**Gap C — the customer has to discover the automation model indirectly.**

A user needs to understand that RoamLink acts continuously rather than simply buying connectivity.

**Change:** Home hero + Activity feed + explicit RoamLink management state.

## 3. Simulated journey: connectivity failure

1. User is connected.
2. Wi-Fi becomes unreliable.
3. RoamLink observes degradation.
4. RoamLink evaluates the active goal.
5. ADCOS path/eligibility changes.
6. RoamLink requests/observes recovery.
7. User sees service restored.
8. User wants to know why.

The backend supports the lifecycle, freshness and reconciliation semantics, but the customer experience needs a dedicated narrative.

**Change:** Connectivity center + Activity timeline.

The UI must distinguish:

observed -> requested -> accepted -> reserved -> path active -> delivered

and must never display a success state from payment/reservation alone.

## 4. Simulated journey: device enrollment

Current device routes expose lifecycle and freshness well, but automation capabilities are not yet a first-class onboarding concept.

**Change:** after enrollment, show a capability matrix in human terms:

- automatic;
- available with confirmation;
- manual;
- unavailable;
- unknown.

Each state has an explanation and recovery action.

## 5. Simulated journey: goal editing

Current intent routes support creation/activation/supersession and the decision model contains explainability.

Potential user friction:

- immutable versioning is an implementation concept;
- evidence classes are more technical than necessary for novice users.

**Change:** present Current goal, What changed, Why, and Evidence as progressive disclosure.

## 6. Simulated journey: purchasing

Current commerce support is explicit and correctly separates payment from delivery.

User-facing improvement:

After payment, navigate to a delivery progress view rather than leaving the customer on a payment success page.

The view must show:

- payment confirmed;
- connectivity request;
- offer/reservation if available;
- activation;
- delivery evidence;
- billable-final only when actually proven.

## 7. Simulated journey: offline mobile

The mobile shell implements observation, capability gating, encrypted outbox, sync, recovery and authoritative-result intake.

The user-facing problem is discoverability rather than architecture.

**Change:** expose an explicit edge status screen:

- last observation;
- capability freshness;
- sync status;
- queued actions;
- action result;
- why an action is unavailable;
- manual guidance.

Never show the edge as broken merely because sync is offline when observation and local desired-state work can continue.

## 8. Simulated journey: enterprise onboarding

The current enterprise package has the required API/state machinery.

**Gap:** the visual enterprise onboarding journey is not a first-class customer surface.

**Change:** build a guided enterprise setup:

Create workspace -> verify organization -> choose policy -> enroll connector -> enroll devices -> verify capabilities -> first goal -> live overview

## 9. Simulated journey: support

Support exists and carries correlation references.

**Change:** expose Get help with this context actions directly from:

- degraded connectivity;
- failed automation;
- stale/unknown evidence;
- failed purchase/delivery;
- unsupported capability.

## 10. ShareNet-inspired lessons adopted

The redesign adopts these useful principles from pectoraux/ShareNet:

- consumer shell separated from diagnostics;
- persistent global connection indication;
- desktop sidebar;
- mobile bottom navigation;
- simple home hero;
- lightweight onboarding;
- restrained warm-light visual system;
- calm connection-state colors;
- large whitespace;
- progressive detail;
- quiet error states on the customer surface.

RoamLink-specific additions:

- Goal/Experience model;
- Connectivity lifecycle and evidence;
- automation/activity narrative;
- commerce/delivery separation;
- enterprise workspace;
- device capability matrix;
- reconciliation visibility.

## 11. Validation requirement

The new UI work must be tested as journeys rather than only page snapshots.

Each journey must have:

- entry point;
- discoverability check;
- primary task completion;
- degraded state;
- recovery state;
- support escape hatch;
- mobile variant.

A capability is not considered discoverable merely because an API or page exists.

---

## Campaign-closing re-audit (2026-09-24, PA-016)

**Date:** 2026-09-24
**Work item:** PA-016 — the campaign's closing audit pass (spec/tech-lead-handoff-2026-09-21.md §4 "Orchestrator — PA-16 final journey audit").
**Head of record:** `772e9c534420f7a8679e0e60c67da5558e07578e` (public main; the merge of PR #48).
**Method:** the original audit's repository-driven walkthrough, re-run AT THE FINAL HEAD — every journey this document defines (§2–§9) walked again through the real surfaces (the customer web route model `apps/web/src/routes.ts` lines 19–41, the admin surface `apps/admin/src/routes.ts` lines 8–18, the mobile/edge shell `apps/mobile/src/shell.ts`), each original finding's remediation verified to HOLD, the dogfood scenario suite executed, and the live-surface evidence cited from PA-015's acceptance re-run (not re-derived — this work order's rule).
**Placement note:** the addendum lives HERE, as a new dated section appended below the original (which stays as-was, per the additive-and-dated rule), rather than in a separate `docs/reports/final-journey-audit.md` — the repository's own convention is in-file dated accumulation (`docs/capability-discoverability.md` carries the PA-003/PA-007/PA-008/PA-010/PA-002 post-audit updates as in-file sections), and the original method, its findings, and their closing verdict read as one arc in a single document.
**Baseline gate at this head:** `corepack pnpm@10.0.0 check` exit **0** — lint ✓, typecheck ✓, architecture:check ✓ ("RoamLink architecture checks passed."), and the full workspace test leg: **45 package test legs / 0 fail; 252 test files passed + 2 skipped files; 2640 tests passed + 21 named-skips** (the AR-010 operator-phase legs: `packages/persistence-postgres` 7, `packages/provider-qstash` 3, `packages/provider-r2` 2, `packages/provider-redis` 4, `tests/deployment` 5 — every skip named in its own output, never a silent pass).

### A. Per-journey re-audit table

Every row cites file+line evidence on the head tree, the executable scenario that proves the journey, or the PA-wave commit that delivered it. "HELD" means the remediation is present and verified at the head; no REGRESSED row exists — every original finding's remediation holds.

| Journey (original §) | Original finding / change requested | Status at head | Evidence |
|---|---|---|---|
| First-time individual, steps 1–3 (§2) — **Gap A** | No first-run onboarding shell → add four-step onboarding | **HELD** | The four steps `welcome/goal/device/preferences`: `apps/web/src/pages/onboarding-page.ts` line 33 (`ONBOARDING_STEPS`), step bodies lines 192–228 (plain-language welcome), 231–275 (goal choices), 278–363 (device enrollment), 366–432 (confirm + finish); route `/onboarding` at `apps/web/src/routes.ts` line 21; the Home page renders the "New to RoamLink?" entry (`apps/web/src/pages/home-page.ts` lines 202–216). Executable: `apps/web/test/onboarding-journey.test.ts` (incl. the novice-path vocabulary ban over every rendered step) + dogfood scenario 1. |
| First-time individual (§2) — **Gap B** | Vocabulary too technical → human-facing labels, advanced terms on detail views | **HELD** | "Goal" is the user-facing word (`apps/web/src/pages/intents-page.ts` lines 5–6); nav labels Home/Connectivity/Activity/Devices/**Goals**/**Plans & Billing**/Support (`apps/web/src/app.ts` lines 94–103; route names stay stable per `apps/web/src/routes.ts` lines 10–17); technical vocabulary confined to disclosure layers (`apps/web/src/pages/devices-page.ts` lines 260–277 "Automation levels explained — you never need this section"). |
| First-time individual, steps 7–9 (§2) — **Gap C** | Automation model invisible → Home hero + Activity feed + explicit RoamLink management state | **HELD** | Hero with facts line and evidence freshness (`apps/web/src/pages/home-page.ts` lines 92–114, 221–235); "What RoamLink is doing" fact card (lines 133–152); "Does RoamLink need you?" (lines 153–178); Activity's "What RoamLink did" narrative and "Automation status" panel (`apps/web/src/pages/activity-page.ts` lines 196, 224–254). Executable: `apps/web/test/activity-timeline.test.ts`, dogfood scenarios 1–2. |
| Connectivity failure (§3) | Lifecycle narrative + the observed→requested→accepted→reserved→path-active→delivered distinction; never a success state from payment/reservation alone | **HELD** | The seven-stage journey derived ONLY from projection state (`apps/web/src/pages/lifecycle.ts` lines 95–156; the hard rule "commercial state NEVER feeds this derivation" lines 10–16); the Connectivity Center's journey section (`apps/web/src/pages/connectivity-page.ts` lines 158–202) and the "Commercial fact (separate) — it never stands in for delivery" row (lines 125–137); support escapes on every degraded state (lines 139–149, 234–250; `isDegradedShellState` at `lifecycle.ts` lines 166–168). Executable: `apps/web/test/connectivity-center.test.ts`, dogfood scenario 2. |
| Device enrollment (§4) | Capability matrix in human terms (automatic / available with confirmation / manual / unavailable / unknown), each with explanation and recovery action | **HELD** | The capability card: `apps/web/src/pages/devices-page.ts` lines 188–296 — the five automation levels (line 190) each explained (`apps/web/src/pages/language.ts` lines 307–313), freshness-paired (lines 217–225), "established by verification, never assumed" (line 281), degraded-capability support escape (lines 283–293); manual-fallback guidance section (`devices-page.ts` line 515 + `language.ts` `MANUAL_FALLBACK_GUIDANCE`). Executable: `apps/web/test/device-capability.test.ts`; dogfood scenarios 1–3. |
| Goal editing (§5) | Current goal / What changed / Why / Evidence as progressive disclosure | **HELD** | The goal detail journey renders in order: "What you asked for" (`apps/web/src/pages/intents-page.ts` `goalDetailPage`, `data-goal-current` section, lines ~437–471), "What RoamLink derived from your goal" + "Freshness of the evidence used" (`decisionSection`, lines 236–273), "Requested and delivered — kept honest" (`honestGapSection`, lines 322+), "What changed" version history (`versionChain`, lines 275–320), "What you can do" (`goalActions`); the advanced label stays available progressively (the page heading carries "(Advanced: experience intent {intentId})", and the module header lines 5–6 record the Gap B law). Executable: `apps/web/test/goals-journey.test.ts`. |
| Purchasing (§6) | After payment navigate to a delivery-progress view; payment confirmed / connectivity request / offer-reservation / activation / delivery evidence / billable-final only when proven | **HELD** | The order journey IS the post-payment landing ("after payment the customer lands HERE — a delivery-progress view — not on a payment-success page": `apps/web/src/pages/order-journey-page.ts` lines 22–23); the commercial and connectivity chains visibly distinguished (lines 7–16); the five chain stages `connectivity-requested/offer-reservation/activation/delivery-evidence/billable-final` (lines 95–101) derived only from the read + command (lines 428–460); every Orders-table row links to it (`apps/web/src/pages/commerce-page.ts` lines 144–146, `.order-link`). Executable: `apps/web/test/purchase-delivery-journey.test.ts` ("shows payment confirmed as a commercial fact - never as delivery"); dogfood scenario 4; RL-113 e2e purchase leg (`tests/e2e/test/hosted-commerce-support.test.ts` lines 51–112). |
| Offline mobile (§7) | Edge status screen: last observation, capability freshness, sync status, queued actions, action result, why unavailable, manual guidance; never "broken" merely because sync is offline | **HELD** | The offline banner: "Offline - observation continues; queued commands are held in the encrypted outbox" (`apps/mobile/src/views.ts` lines 133–159); last-observation cycle + freshness per row + outbox census (lines 181–224); capability truth table with gate preview (lines 253–296); closed manual-guidance map (lines 299–316); action outcome with "queued is NOT executed" (lines 319–362); the encrypted outbox screen (lines 365–400); action history with sync boundaries (lines 403–438). Executable: `apps/mobile/test/enrollment-and-offline.test.ts`; dogfood scenario 3; RL-113 e2e offline leg (`tests/e2e/test/hosted-offline-edge-enterprise.test.ts`). |
| Enterprise onboarding (§8) | Guided enterprise setup: workspace → verify org → policy → connector → devices → capabilities → first goal → live overview | **HELD** | The frozen 8-step chain: `apps/web/src/pages/workspace-page.ts` lines 116–125 (`WORKSPACE_JOURNEY_STEPS`), six honest per-step states (lines 130–137), per-step facts and contextual actions (connector gate links lines 402, 420); the guided connector-enrollment flow (PA-06: `#connector-enrollment` line 820, `data-flow="provision-connector"`); the policy summary section (PA-007: `#policy-summary` line 993); the integrations section (PA-008: `#integrations` line 1248, SSO/SCIM/MDM rows lines 1120–1132); the live organization overview through the same connectivity read model. Executable: `apps/web/test/enterprise-workspace.test.ts`, `apps/web/test/connector-enrollment-journey.test.ts`; dogfood scenario 5. |
| Support (§9) | "Get help with this context" actions from degraded connectivity, failed automation, stale/unknown evidence, failed purchase/delivery, unsupported capability | **HELD** | The shared carrier: `apps/web/src/pages/support-context.ts` lines 180–198 (`supportEscape` — pre-carried typed refs, transparency note, fail-closed decode lines 137–165); escape sites at the head: connectivity (3), devices (2 — degraded capability), order journey (4 — incl. "Get help with refunds" line 357), SIM & profiles (3), Activity (2), Workspace (5). Executable: `apps/web/test/support-context.test.ts`; dogfood scenario 4 (incident correlation). |
| ShareNet lessons adopted (§10) | Consumer shell separated from diagnostics, persistent connection indication, desktop sidebar, mobile bottom nav, simple home hero, warm-light system, quiet errors | **HELD** | The application shell: skip link → header (title + persistent indicator) → sidebar + main → bottom nav → footer (`packages/app-kit/src/ui/shell.ts` lines 273–309); warm-light stylesheet with non-color-only state (lines 315–349); the admin console is the separate diagnostics surface (`apps/admin/src/routes.ts` lines 8–18). Executable: `apps/web/test/shell-nav.test.ts`, `apps/web/test/responsive-a11y.test.ts`. |
| Validation requirement (§11) — journeys as tests (entry point, discoverability, completion, degraded, recovery, support escape, mobile variant) | Every journey tested, not merely page-snapshotted | **HELD** | RL-113 hosted-journey E2E suite: `tests/e2e/test/hosted-entry-onboarding-goals.test.ts`, `hosted-devices-connectivity-recovery.test.ts`, `hosted-commerce-support.test.ts`, `hosted-offline-edge-enterprise.test.ts` — **4 files / 14 tests green at the head** over the REAL composition (real pglite PostgreSQL, real migrations, real /v1, real app flows: `tests/e2e/src/host.ts`); the mobile variant asserted inside every web journey (`expectShellChrome` checks the bottom-nav labels, `hosted-entry-onboarding-goals.test.ts` lines 36–53). |

**The RL-114 web a11y lane (PA-004, commit `8dd6c1f`):** HELD — the shell h1 (`packages/app-kit/src/ui/shell.ts` lines 282–292, the h1-wrapped title anchor), the skip-free heading hierarchy (document-body-level panels are h2 under the shell h1: `packages/app-kit/src/ui/components.ts` `mutationResultPanel`/`errorPanel`), and the universal 44px touch floor (buttons/inputs lines 46/49; `.home-fact-action a` line 62, `.support-escape a` line 112, `.order-link` line 114, `.goal-card a` line 133, `.journey-action a` line 143 in `apps/web/src/styles.ts`; `.shell-indicator-link` at `packages/app-kit/src/ui/shell.ts` line 345). Executable: `apps/web/test/rl114-extended-a11y.test.ts` — the flipped F1/F2/F3 probes ("every rendered web document carries exactly one h1", "no level skips exist anywhere", "every generic in-content action-link family carries the 44px touch-target floor") — and the mobile lane `apps/mobile/test/rl114-mobile-document-contract.test.ts` (PA-005: F5/F6/F7 — a11y layer, real fragment targets, scoped tables in labelled scroll regions: `apps/mobile/src/views.ts` lines 25–49, 166–178).

**The RL-115 capability-discoverability lane:** HELD at **23 VERIFIED · 12 VERIFIED (proxy) · 0 GAP** (`docs/capability-discoverability.md` §2 tally, line 273) — the last recorded GAP (RL-115-F4 refunds) closed by PA-002 (commit `17f2b63`); the refund read model renders read-only money facts on the order journey (`apps/web/src/pages/order-journey-page.ts` lines 311–418: authority note lines 318–324, honest not-available/empty states lines 365–385, "Get help with refunds" escape lines 339–363). Executable: `apps/web/test/rl115-capability-discoverability.test.ts` (the flipped closure probes at lines 796–1229), `apps/mobile/test/rl115-mobile-capability-surface.test.ts`, and the structural drift-guards in `tests/architecture/test/wave8-b-capability-guards.test.ts`.

### B. The executable journey evidence (dogfood, at the head)

`corepack pnpm@10.0.0 -C tests/dogfood exec vitest run` — **6 test files / 14 tests, all green, 0 failed, 0 skipped**:

```text
 ✓ test/slo-journey-emission-matrix.test.ts (5 tests) 99ms
 ✓ test/scenario-4-refund-incident-correlation.test.ts (2 tests) 62ms
 ✓ test/scenario-2-degradation-failover-recovery.test.ts (2 tests) 73ms
 ✓ test/scenario-1-onboarding-first-connectivity.test.ts (2 tests) 59ms
 ✓ test/scenario-3-offline-edge-roundtrip.test.ts (2 tests) 27ms
 ✓ test/scenario-5-enterprise-admin-observation.test.ts (1 test) 23ms

 Test Files  6 passed (6)
      Tests  14 passed (14)
```

The five RL-072 scenarios (`tests/dogfood/test/scenario-{1..5}-*.test.ts`, describe blocks at lines 118/62/157/102/64 respectively) compose the REAL public packages through their public surfaces and assert on observable public state; the RL-116 SLO-journey emission matrix (`tests/dogfood/test/slo-journey-emission-matrix.test.ts`, 5 tests) pins the §11 SLO emissions exactly, including the honest absence rows. Companion render-level evidence at the head: `apps/web` 17 files / 241 tests, `apps/mobile` 6 files / 58 tests, `apps/admin` 1 file / 24 tests, `tests/architecture` 11 files / 124 tests — all green (each re-run individually during this audit; also green inside the §Baseline `pnpm check`).

### C. The campaign context

**The remediation arc, compactly:** the original audit's "Change:" items became the post-gate work items RL-082..RL-118 (spec/work-items.md lines 71–118); the journeys were constructed across PRs #18–#31 (the onboarding shell PR #19 `1a23260`, the hosted runtime PR #20 `70d4e75`, the experience surfaces PR #23 `f632612`, journey completion PR #25 `345c080`, the E2E journeys PR #28 `3f0ffe4`), and this audit's findings were operationalized as the RL-114/RL-115 record in PR #29 `90d772a` (work/rl-ux-verification). The acceptance record then froze at `2abdb2e` / PR #31 — **sixteen PRs stale: #32–#47, verified by the merge log** (`docs/reports/rl-118-deployment-acceptance.md` §7, lines 192–194 — the repository's own campaign accounting, adopted verbatim here). Those sixteen, one line each (PR# — subject — what it changed relative to the journeys):

1. **#32** — `feat(portal-host): public demo accounts with quick action logins` (`381be69`) — the entry journey on the live demo: one-click persona sign-in on the login document.
2. **#33** — `fix(api): /v1/users/me returns the contracted ActorSessionResource` (`a7c8e36`) — the Settings/Workspace journeys render the real session view (the RL-113 cross-surface finding resolved).
3. **#34** — `style(portal-host): 44px touch targets for the login form's submit button` (`59838ec`) — the entry journey's touch floor on the live surface.
4. **#35** — PA-003: order journey links + the /notifications compatibility-only contract (`7a2d5e6`) — closes RL-115-F8 (every order row links its delivery-progress journey) + RL-114-F4 (Option B: zero inbound links is the designed contract).
5. **#36** — PA-001: the eSIM management journey (`57d9eae`) — closes RL-115-F1: the device journey gains the SIM & profiles leg (`/devices/{id}/sim`).
6. **#37** — PA-06: guided connector enrollment on the workspace (`2d8cf00`) — closes RL-115-F3: the enterprise journey's connector step becomes the guided action.
7. **#38** — PA-005: the mobile a11y/navigation layer (`f6e827e`) — closes RL-114-F5/F6/F7: the mobile journey documents carry the a11y contract.
8. **#39** — PA-009: the admin SLO dashboard navigation (`3657a60`) — closes RL-115-F2: the operator journey's "SLO health" entry (`apps/admin/src/app.ts` NAV lines 81–89, incl. `OPS_SLO_DASHBOARD_PATH` and "Integration health").
9. **#40** — PA-007: the organization policy read model (`3bcbd98`) — closes RL-115-F7: the enterprise journey's policy step renders the real summary.
10. **#41** — PA-008: the enterprise integrations surface (`407be4f`) — closes RL-115-F5: SSO/SCIM/MDM statuses render from the read model.
11. **#42** — PA-010: the ADCOS compatibility health surface (`250822d`) — closes RL-115-F6: the operator journey's Integration health page (`/integration-health`).
12. **#43** — PA-002: the refund read model on the order journey (`17f2b63`) — closes RL-115-F4: the LAST recorded discoverability GAP.
13. **#44** — PA-004: the document a11y contract — shell h1, skip-free hierarchy, full touch floors (`8dd6c1f`) — closes RL-114-F1/F2/F3 (§A above).
14. **#45** — PA-011: the real PostgreSQL persistence legs (`797b9c8`) — operator-phase real-run record (row 1/7/8/11's flips).
15. **#46** — PA-012: the real R2 backup/restore legs (`09cd47a`) — operator-phase real-run record (row 2/9's flips).
16. **#47** — PA-013: the real Redis delivery legs (`a043422`) — operator-phase real-run record (row 10's transport proof; QStash honestly pending).

PR **#48** — PA-015: the final acceptance re-run (`7410b1c`, merged as the head `772e9c5`) — the campaign-closing acceptance verdict this addendum cites.

**The operator-phase real-run records (one line each):**
- **PA-011 (2026-09-23):** real PostgreSQL persistence legs — `rollback-roundtrip.test.ts` RT-4 3/3, 0 skipped + the recovery-battery real leg 8/8, 0 skipped, against the real pool (`docs/reports/rl-118-deployment-acceptance.md` §7.1 row 1; neon-provisioning.md §6.1).
- **PA-012 (2026-09-24):** real R2 backup/restore legs — `backup-restore-real.test.ts` 2/2 passed, 0 skipped, against the operator's R2 + PostgreSQL pair (digest-identical restore, surviving dedupe keys, post-round-trip audit chain) (§7.1 row 2; neon-provisioning.md §7.1).
- **PA-013 (2026-09-24):** real Redis delivery legs — `packages/provider-redis` 43/43, 0 skipped, the limiter-under-load real leg admitting exactly maxCost of 50 concurrent takes (§7.1 row 10; deployment-runbook.md §7) — the QStash wire stayed honestly pending (AR-009).

**PA-015's acceptance verdict (cited, not re-derived):** the twelve-row §7 re-run at the campaign head against the LIVE demo surface — **"12 rows — 11 green, 1 named-skip, 0 needs-deployment, 0 red — the demo deployment is accepted"** (row 5 ADCOS keeps its honest named-skip); gate exit 0; the §6b smoke 7/7 against https://roamlink-ten.vercel.app (`docs/reports/rl-118-deployment-acceptance.md` §7.1 verdict line + §7.4).

### D. The final honest-gaps ledger

What remains open after the campaign, consolidated (items 1–3 are the standing records this audit inherits; items 4–5 are what THIS re-walk found and records — standing design states, not PA-wave regressions; all are finding-and-record only, fixes belong to future work orders):

1. **ADCOS row 5 (RL-118 §7.1/§7.5 item 1):** the operator must issue the RoamLink application credential in ADCOS production and set the four `ADCOS_*` keys; until then the RL-108 probe honestly reports not-configured (exit 2) and row 5 stays named-skip. No ADCOS credentials exist on the tree.
2. **AR-009's QStash wire note (append-only, never flipped or reworded):** the QStash surface (token + current/next receiver signing keys) is still not delivered; the built env-gated legs (`packages/provider-qstash` client-wire; the escalation-path leg of `runtime-hardening.test.ts`) skip with named reasons (RL-118 §7.5 item 2).
3. **The deployment lag (RL-118 §7.5 item 3):** the campaign head `10ba5d9` was not yet deployed to production at the PA-015 re-run (Vercel quota; reset ~05:14 UTC 2026-09-24); the delta is proven demo-surface-neutral, and re-running the §6b smoke + acceptance against the redeployed surface is the recorded follow-up.
4. **F-016-1 (this re-walk) — the hosted mutation legs are not host-wired:** the web app's forms POST to `/flows/*` (e.g. `apps/web/src/pages/commerce-page.ts` line 92 `action: "/flows/place-order"`; the onboarding forms `apps/web/src/pages/onboarding-page.ts` lines 336, 405), and `apps/web/README.md` lines 137–147 assign the wiring of those form actions to the host ("a host … wires the rendered form actions (`/flows/*`, `data-flow` attributes) to the matching flow methods. The host owns sessions/CSRF"). The portal host implements the session/login POST, the page rendering, and the real `/v1` command plane — but has NO `/flows/*` handler (`apps/portal-host/src/app/[...surface]/route.ts` exports GET only; no flow handler exists in `apps/portal-host/src/handlers.ts`). On the live demo a browser user therefore cannot submit the rendered mutation forms; the journey mutations are proven through the app's typed flow methods over the real `/v1` mount (RL-113: `tests/e2e/test/hosted-commerce-support.test.ts` line 63). This is a standing never-wired state (present since RL-089 `fc8bec2`), unchanged by the PA wave — recorded here so a future work order can wire the form-action POSTs (or narrow the rendered forms) deliberately.
5. **F-016-2 (this re-walk) — the real runtime composes no business read models:** every business read route answers the typed 501 `READ_MODEL_NOT_COMPOSED` (`services/api/src/api-service.ts` lines 119–144; the header law lines 28–33: "the read models are not composed on the real runtime in this wave; the service invents NO data — the deterministic fake API remains the contract reference for those reads"). On the live demo every business page therefore renders the fail-closed typed panel rather than journey content — the honest terrain RL-113 pins (`tests/e2e/src/host.ts` lines 14–18; asserted across the four e2e journey files). The complete product journeys (§A's table) are proven at the application level through the executable suites. Standing recorded state, unchanged by the PA wave — the live demo's read-journey content and the `/flows/*` wiring of F-016-1 are the two legs a future deployment phase would compose.

   **PA-019 closure note (2026-09-25, additive — the finding above stands as the historical record):** F-016-2 is closed by composing the business read models on the real runtime (`services/api/src/read-models.ts`, wired through the service's bound persistence + identity stores — every served field is a real fact of that bound state, per the standing no-invented-data law). Composed: `users/{id}` and `organizations` (identity-backed), and the command-ledger projections `devices` (+single), `experience-intents` (+single, +versions), `payments`, `connectivity` (the honest aggregate), `support-cases` (+single), plus `reconciliation-jobs` over the durable `adcos-reconciliation-jobs` records. The projection law: a business resource exists only when its creating command has EXECUTED and recorded its resource id — accepted is not executed, so on the live demo (no composed executors) every ledger projection serves its honest EMPTY state and the business pages render the real empty journey content (Devices, Goals, Support render their empty states; the shell indicator states the honest `no-reference`) instead of the fail-closed panel — the e2e journeys were flipped accordingly under this work order's authorization (`tests/e2e/test/hosted-{entry-onboarding-goals,devices-connectivity-recovery,commerce-support,offline-edge-enterprise}.test.ts`, harness doc `tests/e2e/src/host.ts`). Kept-501 with named reasons (the honest skips, enumerated in `READ_MODELS_NOT_COMPOSED`): `products` (PRODUCT_CATALOG_NOT_BOUND), `orders` (+single) (ORDER_PRICE_FACTS_NOT_BOUND — prices are never invented), `subscriptions` (SUBSCRIPTION_STATE_NOT_BOUND), `notifications` (NOTIFICATION_STORE_NOT_BOUND), `audit-events` (AUDIT_CHAIN_NOT_BOUND), `projection-health` (PROJECTION_HEALTH_SOURCE_NOT_BOUND), `integration-health` (INTEGRATION_HEALTH_SOURCE_NOT_BOUND, per PA-010); pages whose read set includes one of those (Home, Activity, Commerce, Order journey, Connectivity center) still fail closed into the typed panel — pinned as-is. Battery evidence: `services/api/test/read-models.test.ts` — 13 tests green (write-then-read round trips per composed model over the house in-memory persistence with the worker-plane execution simulated through the same ledger discipline, every composed body parsed under the frozen app-kit fail-closed parsers, the kept-501 named reasons, the READ_MODEL_ROUTES coverage contract, and the tenant fail-closed discipline), plus the evolved composed/kept split in `services/api/test/commands.test.ts`; the e2e flip is 14/14 green over the real pglite composition. The F-016-1 `/flows/*` wiring gap is unaffected and stands.

No REGRESSED rows: every original finding's remediation (Gaps A/B/C, the §3–§9 changes, RL-114-F1..F7, RL-115-F1..F8) was re-verified present and green at the head (§A; §B).

### E. Closing verdict

At the campaign's final head, every journey the 2026-09-18 audit defined is implemented, discoverable, honest under degradation, and executable-proven — the audit's findings are all closed and none regressed — while the live demo deployment is accepted (11 green / 1 named-skip) with its standing operator flips and the two recorded live-journey composition gaps (F-016-1/F-016-2) carried honestly forward.

PA-016 COMPLETE
