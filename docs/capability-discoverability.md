# RoamLink Capability-Discoverability Audit (RL-115)

**Work item:** RL-115 — Capability-discoverability audit (post-gate Wave 8, Worker B)
**Suites:** `apps/web/test/rl115-capability-discoverability.test.ts` (render-level,
the customer web surface), `apps/mobile/test/rl115-mobile-capability-surface.test.ts`
(render-level, the mobile/edge surface), `tests/architecture/test/wave8-b-capability-guards.test.ts`
(structural drift-guards).
**Source inventory:** `spec/architecture.md` §2 (Layers A–F owns-lists), §4 (the three
control loops), §5 (projection record fields), §6 (reconciliation musts), §7 (the device
capability matrix), §8 (enterprise model), §10 (failure semantics), §11 (the nine SLOs).
**Requirement:** `spec/ux-architecture.md` §15 — every capability must have one
**primary user-facing entry point**, one **contextual link** from the journey where it
becomes relevant, one **explanatory view**, one **recovery/support path** — and
`spec/user-journey-audit.md` line 199: *"A capability is not considered discoverable
merely because an API or page exists."*
**Method:** a FROZEN capability inventory (35 rows, every row citing its spec section)
is checked against the RENDERED surfaces (the real page modules driven through the real
app/shell objects against the deterministic fake) for the four §15 requirements. Every
row's current verdict is recorded below with its evidence or its absence probe. Findings
are RECORDED, not fixed (the `docs/threat-model-verification.md` precedent): all findings
are pinned in the suites as current observable behavior, so the eventual fixes flip
explicit assertions. Zero src changes were made by this work item.

**Post-audit update (PA-003 — Order + Notification Discoverability):** per the
audit's designed mechanism (fixes flip explicit assertions), RL-115-F8 is CLOSED
and RL-114-F4 is RESOLVED as the designed Option B contract. The affected matrix
rows (CAP-B-ORDERS, CAP-L-COMMERCIAL, CAP-A-NOTIFICATIONS) are VERIFIED below
with their closure evidence, and the flipped assertions live in the same suites
that pinned the gaps. All other findings stand unchanged.

**Post-audit update (PA-005 — Mobile Accessibility/Navigation Closure):** the
mobile/edge lane of RL-114 is CLOSED. F5 (the a11y layer), F6 (the dead nav
anchors) and F7 (the table scope/scroll-region contract) are fixed on the
mobile surface only (`apps/mobile/src/views.ts`), and the pinned assertions in
`apps/mobile/test/rl114-mobile-document-contract.test.ts` are flipped to the
closed expectations; the mobile capability probe (`apps/mobile/test/
rl115-mobile-capability-surface.test.ts`) gains the truth table's a11y
alignment proof (the matrix stays status-only — the mobile half of RL-115-F1's
pin is unchanged; the web journey from PA-001 owns the management affordances).
No web/admin surface, shared app-kit component or dependency is touched. The
section 6 cross-reference rows below carry the closure evidence.

**Post-audit update (PA-009 — SLO Dashboard Navigation):** RL-115-F2 is CLOSED
by the same flip mechanism: the admin console nav carries the §13 "SLO health"
entry to the host's session-gated `/ops/slo` surface, CAP-SLO is VERIFIED
(proxy) below with its closure evidence, the flipped assertions live in the
same suites that pinned the gap, and the customer surfaces stay SLO-free BY
DESIGN (§13: admin and diagnostics are not customer navigation). All other
findings stand unchanged.

**Post-audit update (PA-007 — Organization Policy Read Model):** RL-115-F7 is
CLOSED by the same flip mechanism. The organization policy READ MODEL now
exists: a read-only record owned by the enterprise domain
(`packages/enterprise/src/policy.ts` — state/source vocabularies, freshness,
fail-closed parse, NO write path) mirrored additively through the app
contract's workspace read (`packages/app-kit/src/api/enterprise.ts` —
`ENTERPRISE_POLICY_RESOURCE_STATES`/`SOURCES`, drift-guarded in wave4-a;
an older payload without the section parses to the honest null section,
RL-LOCK-017). The workspace page's promised policy summary section is real:
the current policy record renders (summary, source, version, effective
instant, freshness pairing) and the absence states stay EXPLICIT contract
states — `not-configured` (an observation verified no policy upstream),
`unknown` (no verified observation) and `not-available` (this workspace
composes no policy section) — never a UI shrug, never collapsed. The section
is READ-ONLY: policy is organization-level configuration managed upstream,
so the available user action names where management lives (the authority
note) and the surface composes no policy editor (RoamLink creates no second
policy authority, RL-LOCK-003/004/005). CAP-E-POLICY is VERIFIED below with
its closure evidence; the flipped assertions live in the same suites that
pinned the gap. All other findings stand unchanged.

**Post-audit update (PA-008 — Enterprise Integrations Surface):** RL-115-F5
is CLOSED by the same flip mechanism. The SSO/SCIM/MDM integrations now
have a visible surface: the workspace's Enterprise integrations section
(`apps/web/src/pages/workspace-page.ts` `integrationsSection`, anchored
`#integrations`), rendered FROM THE READ MODEL — a new READ-ONLY
integration status record owned by the enterprise domain
(`packages/enterprise/src/integrations.ts` — the closed kind vocabulary
sso/scim/mdm and the four-state vocabulary, fail-closed parse with honest-
state invariants, NO write path) mirrored additively through the app
contract's workspace read (`packages/app-kit/src/api/enterprise.ts` —
`ENTERPRISE_INTEGRATION_RESOURCE_KINDS`/`STATES`, drift-guarded in wave4-a;
an older payload without the section parses to the honest null section,
RL-LOCK-017, and the surface degrades honestly from there). Each
integration distinguishes EXACTLY four states — Configured | Not configured
| Unavailable | Unknown — and the missing backend contract is represented
HONESTLY: `unavailable` renders "requires the enterprise integration API"
with an explanation, never a fabricated configuration control (the section
composes no form, button or command flow: no OAuth dance, no SCIM endpoint
fields, no MDM enrollment forms — the UI never fabricates configuration
capability). The deterministic fake seeds the honest wave-2 world (SSO
configured + fresh; SCIM/MDM the unavailable declaration) and the scenario
seeds derive every kind × state world. CAP-E-SSO-SCIM-MDM is VERIFIED below
with its closure evidence; the flipped assertions live in the same suites
that pinned the gap. All other findings stand unchanged.

**Post-audit update (PA-010 — ADCOS Compatibility Health Surface):** RL-115-F6
is CLOSED by the same flip mechanism: the admin console gains the §13
"integration/compatibility health" surface — a read-only page over the
application contract's new `/v1/integration-health` read, rendering the
RECORDED outcome of the env-gated ADCOS compatibility probe (RL-108):
Compatible | Incompatible | Not configured | Unknown, with the recorded
last-checked freshness, the supported API version, the probe suite version
and the failed-check explanation when incompatible. The surface never
triggers the probe and never mutates compatibility state (the mutation gate
stays inside the ADCOS integration boundary); not configured is a first-class
honest state, never a fabricated compatibility. CAP-D-COMPAT is VERIFIED
(proxy) below with its closure evidence, the flipped assertions live in the
same suites that pinned the gap (the web GAP probe became the closure probe
keeping the customer surface compatibility-free BY DESIGN, §13; the wave8-b
structural absence guard became the presence guard), and the customer
surfaces stay compatibility-vocabulary-free BY DESIGN. All other findings
stand unchanged.

---

## 1. Verdict vocabulary and how to read the matrix

- **VERIFIED** — mechanically proven by a render-level test on the current tree: the
  requirement's evidence was rendered and asserted.
- **VERIFIED (proxy)** — the strongest mechanical proxy: the surface lives on another
  app of this repository (mobile/admin/ops) and is proven by that surface's render-level
  suite and/or the structural drift-guards, not by the customer web renderer itself.
- **GAP** — the requirement is not met on this tree; recorded below as a finding with a
  minimal reproducer.

The matrix columns abbreviate the four §15 requirements: **Entry** (primary user-facing
entry point), **Link** (contextual link from the journey), **View** (explanatory view),
**Recovery** (recovery/support path).

## 2. Capability → verdict matrix

### §2 Layer A — Experience Domain

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-A-ACCOUNTS | User and organization accounts | Settings (`/settings`) | More sheet → Settings | Settings account panel | Support (nav + case flow) | **VERIFIED** |
| CAP-A-DEVICE-REGISTRY | Device registry + capability/context snapshots | Devices (`/devices`) | Home fact card → "Manage devices" | Device detail capability card | Device manual-fallback guidance; degraded-capability escape | **VERIFIED** |
| CAP-A-GOALS | Human preferences / ExperienceIntent (Goals) | Goals (`/intents`) | Home fact card → "Review your goal" | Goal detail (asked/derived/changed) | Support (nav + case flow) | **VERIFIED** |
| CAP-A-NOTIFICATIONS | Notifications | Activity (`/activity`) — the sole user-facing notification surface | Home → "Open Activity" | Activity timeline ("What RoamLink did") | Support escape on warning/critical entries | **VERIFIED** — RL-114-F4 resolved by PA-003 (Option B): `/notifications` is compatibility-only BY DESIGN — zero inbound links is the contract (pinned as designed behavior in `apps/web/test/rl114-extended-a11y.test.ts` + the wave8-b structural guard) and the page carries the visible compatibility-role note naming Activity as the live narrative |
| CAP-A-SUPPORT | Support carrier (cases, context, threads) | Support (`/support`) | Connectivity escape → "Get help with this" | Case detail (customer thread) | Carried-context transparency before opening | **VERIFIED** |
| CAP-A-EXPLAINABILITY | Explainability (why/evidence/freshness, progressive disclosure) | Connectivity center (`/connectivity`) | Shell indicator → "Connectivity details" (every page) | Why/Evidence/Technical disclosure layers | Escape from degraded evidence states | **VERIFIED** |

### §2 Layer B — RoamLink Commerce

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-B-CATALOG | Product catalog / customer-facing offers | Plans & Billing (`/commerce`) | More sheet → Plans & Billing | Catalog table + the "never implies connectivity delivery" rule | Support (nav + case flow) | **VERIFIED** |
| CAP-B-ORDERS | Orders, subscriptions, entitlements | Order journey (`/orders/{id}`) | Orders table → "Open delivery progress" (per row) | Delivery-progress view (commercial vs delivery facts) | Order escape ("Get help with this") | **VERIFIED** — RL-115-F8 closed by PA-003: every Orders-table row links to its delivery-progress journey (anchor + real href + `.order-link` 44px floor; flipped probe in `apps/web/test/rl115-capability-discoverability.test.ts`, structural guard in `tests/architecture/test/wave8-b-capability-guards.test.ts`); the host-composed post-payment redirect stays |
| CAP-B-PAYMENTS-INVOICES | Payment state, invoices, pricing presentation | Order journey commercial facts | Order → "Plans & Billing" | "Commercial facts (separate)" + invoices | Support (nav + case flow) | **VERIFIED** |
| CAP-B-REFUNDS | Refunds | NONE | NONE | NONE | Support-ref kind only | **GAP** — finding RL-115-F4 |

### §2 Layer C — RoamLink Edge

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-C-OBSERVATION | Device-side observation/context collection | Device detail "What connectivity it has now" | Device ↔ Connectivity cross-links | Connectivity "Device observations" | Honest absence text when nothing observed | **VERIFIED** |
| CAP-C-OFFLINE-OUTBOX | Durable outbox / graceful offline operation | Mobile edge shell Outbox leg | Mobile shell nav ("Outbox") | Outbox screen (ciphertext note, attempts, boundary states) | Closed manual-guidance map; honest queued≠executed | **VERIFIED (proxy)** — proven in `apps/mobile/test/rl115-mobile-capability-surface.test.ts`; the hosted web surface has no offline view |
| CAP-C-READ-MODEL | Current connectivity read model | Connectivity center | Home → "See the full connectivity read" | Overview ("Your connectivity, honestly") | "What you can do" next-action section | **VERIFIED** |

### §2 Layer D + §5/§6 — ADCOS integration plane, projections, reconciliation

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-D-RECONCILIATION | Reconciliation (durable admit, dedupe, repair, honest stale) | Customer effect: Connectivity "What RoamLink is waiting for" | More → Workspace | Honest stale/unknown language | Support escapes | **VERIFIED (proxy)** — operator view = admin Reconciliation page (structural guard); an unavailable read renders "Cannot confirm right now", never a status |
| CAP-D-PROJECTIONS | Projection of ADCOS state (§5 record fields) | Evidence disclosure (class, canonical record, source version, observed/received, freshness, digest) | Order → Connectivity | Evidence/Technical disclosure layers | Support escapes | **VERIFIED (proxy)** — §5 fields render through the evidence disclosure; operator view = admin Projection-health page (structural guard) |
| CAP-D-COMPAT | Compatibility checks vs the supported ADCOS API contract | Admin console Integration health (`/integration-health`) — the §13 "integration/compatibility health" page | Workspace names the admin operations surface (§13: admin is not customer navigation) | The recorded probe outcome (state + checks + last-checked + supported version + failure explanation), read-only | Read-only ops surface; the mutation gate lives in the ADCOS integration boundary | **VERIFIED (proxy)** — RL-115-F6 closed by PA-010: the admin console's Integration health page renders the recorded RL-108 probe outcome through the application contract's `/v1/integration-health` read (render-level proof in `apps/admin/test/admin-app.test.ts` "Integration health surface": each of the four states renders honestly, the surface performs no mutations — GET-only, never triggers the probe — and freshness pairs with the state; structural presence guard in `tests/architecture/test/wave8-b-capability-guards.test.ts`, vocabulary drift guard in `tests/architecture/test/wave4-a-app-boundaries.test.ts`); the customer surfaces stay compatibility-free BY DESIGN (§13) |

### §4 — the three control loops

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-L-DESIRED | Desired-state loop | Onboarding (`/onboarding`) | Home → "Review your goal" | Goal detail "What RoamLink derived from your goal" | Goal detail "What you can do" | **VERIFIED** |
| CAP-L-RECOVERY | Recovery loop | Activity "Automation status" | Home → "See what RoamLink did" | Activity narrative | Support case flow | **VERIFIED** |
| CAP-L-COMMERCIAL | Commercial loop | Order journey | Orders table → "Open delivery progress" (RL-115-F8 closed by PA-003) | Command pipeline + commercial/delivery separation | Order escape | **VERIFIED** — RL-115-F8 closed by PA-003 (same closure evidence as CAP-B-ORDERS) |

### §7 — the device capability matrix (11 closed names, 8 §7 bullets)

The per-capability truth table (status, evidence class, freshness, gate preview, closed
manual guidance) is the MOBILE edge shell's capability matrix. The customer WEB device
card carries verification freshness + the five automation levels, not per-capability rows.

| ID | Capability (closed names) | Verdict | Note |
|----|---------------------------|---------|------|
| CAP-X-WIFI | `wifi_observation`, `wifi_control` | **VERIFIED (proxy)** | Matrix rows render with gate preview (`allow` / decision + reason); web card is freshness-only |
| CAP-X-SIM-SELECT | `cellular_data_sim_selection` | **VERIFIED (proxy)** | Generic gating mechanism only; no dedicated SIM-selection UX |
| CAP-X-ESIM-MANAGE | `esim_profile_install/remove/enable` | **VERIFIED** | RL-115-F1 CLOSED by PA-001: the SIM & Profiles journey (`/devices/{id}/sim`, linked from the device page) renders the three-row truth table + gated install (activation-code entry)/remove/enable flows with the closed guidance map; the mobile matrix remains the per-capability truth table owner |
| CAP-X-INTERFACE-SELECT | `active_interface_selection` | **VERIFIED (proxy)** | Generic gating mechanism only |
| CAP-X-VPN | `vpn_network_extension` | **VERIFIED (proxy)** | Generic gating mechanism only |
| CAP-X-CONCURRENT | `concurrent_interface_constraints` | **VERIFIED (proxy)** | Renders as gate decisions + guidance |
| CAP-X-TELEMETRY | `radio_os_telemetry` | **VERIFIED (proxy)** | Observation freshness per device; no telemetry-specific UX |
| CAP-X-BACKGROUND | `background_execution_limits` | **VERIFIED (proxy)** | Closed gate-reason vocabulary + manual guidance |

### §8 — the enterprise model

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-E-WORKSPACE | Workspace model (switcher note, org connectivity, fleet, goals, audit note, support) | Workspace (`/workspace`) | Settings → "Open your workspace" | Guided journey + live org overview (same read model) | Workspace support escape | **VERIFIED** |
| CAP-E-ONBOARDING | Guided enterprise onboarding journey (the frozen 8-step chain) | Workspace journey | More → Workspace | Per-step states (complete/waiting/action-needed/blocked/not-started/not-available) | Workspace support section | **VERIFIED** |
| CAP-E-POLICY | Organization-level policies + policy summary | Workspace policy summary section (`/workspace` `#policy-summary`) | Policy journey step → "Review the policy summary" (in-page anchor) | The summary section: current policy (statement, source, version, effective instant) with the freshness pairing; the explicit absence states (not-configured / unknown / not-available) | Policy support-reachability note + the workspace Support section | **VERIFIED** — was RL-115-F7 (GAP); closed by PA-007 (the org-policy read model + the real summary section; READ-ONLY — the authority note names where management lives upstream) |
| CAP-E-CONNECTOR-ENROLLMENT | Enterprise connector (enrollment/provisioning as a user task) | Workspace connector-enrollment flow (`/workspace#connector-enrollment`) — the [Start enrollment] command form (`data-flow="provision-connector"`), capability-gated | Connector journey step → "Start connector enrollment" (in-page anchor to the flow) | The four-stage guided flow (Not started → Provisioning → Verification → Provisioned; closed failure-reason vocabulary explained; command pipeline on the `commandId` polling read) | Failure panel: [Retry enrollment] + support escape pre-carrying the connector facts | **VERIFIED** — was RL-115-F3 (GAP); closed by PA-06 |
| CAP-E-SSO-SCIM-MDM | SSO/SCIM/MDM integrations | Workspace integrations section (`/workspace` `#integrations`) | Settings → "Review enterprise integrations" (in-page anchor target on the workspace) | The integrations section: one row per integration (SSO / SCIM / MDM), each with its state, per-state fact and freshness pairing; the honest missing-backend-contract explanation | The integrations support escape ("Get help with integrations", pre-carrying the three statuses) in the unavailable/unknown worlds; the quiet reachability note otherwise | **VERIFIED** — was RL-115-F5 (GAP); closed by PA-008 (the enterprise integrations surface: statuses render from the READ MODEL with EXACTLY four honest states; `unavailable` is the honest "requires the enterprise integration API" state, never a fabricated control — READ-ONLY, no configuration affordance at all) |
| CAP-E-AUDIT | Organization audit trail | Admin console Audit page (structural guard) | Workspace names the admin ops surface | Admin audit view | Support | **VERIFIED (proxy)** |

### §10 — failure semantics

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-S-FAILURE-STATES | The separated lifecycle states incl. unknown/stale | Connectivity journey (observed → requested → … stages) | Order ↔ Connectivity cross-links | Order/Subscription connectivity journeys; mutation four-stage pipeline | Support escapes | **VERIFIED** |

### §11 — the nine SLOs

| ID | Capability | Entry | Link | View | Recovery | Verdict |
|----|------------|-------|------|------|----------|---------|
| CAP-SLO | SLO health (the nine §11 product SLOs) | Admin console nav "SLO health" → `/ops/slo` (the session-gated host ops surface, RL-109) | The admin nav entry renders on every console page (denied renders included — the nav is chrome; the target holds the gate) | Host-side dashboard: real recorder state, all nine rows, multi-window burn rates, honest no-data-degraded | Read-only ops surface | **VERIFIED (proxy)** — RL-115-F2 closed by PA-009: the admin nav entry (render-level proof in `apps/admin/test/admin-app.test.ts`, structural presence guard in `tests/architecture/test/wave8-b-capability-guards.test.ts`); the customer surfaces stay SLO-free by design (§13) |

**Tally:** 22 VERIFIED · 12 VERIFIED (proxy) · 1 GAP.
(PA-003: CAP-B-ORDERS, CAP-L-COMMERCIAL and CAP-A-NOTIFICATIONS moved from
VERIFIED (proxy) to VERIFIED. PA-001: RL-115-F1 flipped GAP -> VERIFIED —
the eSIM management journey closed through the audit's designed flip
mechanism: the pinned absence probe became a VERIFIED probe in the web
suite, the structural guard flipped from absence to presence, and this row
flipped with them. PA-06: RL-115-F3 closed — CAP-E-CONNECTOR-ENROLLMENT
moved GAP -> VERIFIED via the guided connector enrollment action. PA-009:
RL-115-F2 closed — CAP-SLO moved GAP -> VERIFIED (proxy) via the admin
console's "SLO health" nav entry to the host ops route. PA-007: RL-115-F7
closed — CAP-E-POLICY moved GAP -> VERIFIED via the organization policy
read model + the real policy summary section. PA-008: RL-115-F5 closed —
CAP-E-SSO-SCIM-MDM moved GAP -> VERIFIED via the enterprise integrations
surface: the workspace's integrations section rendering the SSO/SCIM/MDM
statuses from the read model with exactly four honest states. PA-010:
RL-115-F6 closed — CAP-D-COMPAT moved GAP -> VERIFIED (proxy) via the
admin console's Integration health page over the application contract's
integration-health read.)

---

## 3. Findings (recorded — fix ownership: Tech Lead)

Every finding below is pinned as current observable behavior in the suites, so the
eventual fixes flip explicit assertions.

### RL-115-F1 — eSIM profile management has no UX path (CAP-X-ESIM-MANAGE)

**STATUS: CLOSED by PA-001** (the eSIM management journey work order). The
original record is preserved below; the flip evidence follows it.

- **Where:** the §7 device capability matrix's only UX carriers — the mobile capability
  truth table (`apps/mobile/src/views.ts capabilityMatrixScreen`) and the web device
  capability card.
- **What:** the mobile matrix renders all three closed eSIM names
  (`esim_profile_install`, `esim_profile_remove`, `esim_profile_enable`) as STATUS rows
  with evidence/freshness/gate previews, and the closed guidance map explains a blocked
  install — but nothing more. There is no flow to install/remove/enable a profile, no
  profile inventory view, no activation-code entry; the customer web surface carries zero
  eSIM vocabulary. The §15 primary-entry requirement is therefore unmet for eSIM
  MANAGEMENT: a customer cannot discover, from any surface, how to manage an eSIM.
- **Exposure bound:** capability VISIBILITY and honest gating are verified (proxy); the
  gap is the missing management journey, not a false claim elsewhere.
- **Minimal reproducers:**
  1. `apps/web` suite, GAP probe CAP-X-ESIM-MANAGE: render all 17 web routes → the joined
     document text contains no `esim` / `e-sim` / `sim selection` (case-insensitive).
  2. `apps/mobile` suite, GAP probe CAP-X-ESIM-MANAGE: the rendered capability matrix
     contains the three eSIM rows but zero `<a`, `<form` or `<button` elements.
- **Candidate remediation (orchestrator disposition):** a guided eSIM management journey
  (profile list + gated install/remove/enable actions riding the existing desired-state
  command envelope), reachable from the device detail page.

**Flip record (PA-001):** the candidate remediation was implemented exactly as bounded —

- the customer web app gained a SIM & Profiles journey at `/devices/{deviceId}/sim`
  (`apps/web/src/pages/sim-profiles-page.ts`), linked from the device detail page's new
  SIM & Profiles section (Devices -> Device -> SIM & Profiles);
- the journey renders the three closed eSIM capability names as a truth table (status,
  evidence class, freshness, gate preview), the profile inventory with per-profile
  state + evidence/freshness (a requested install is never rendered as an installed
  profile), the activation-code install flow where the platform contract requires it,
  remove/enable/disable where the gate allows, and the CLOSED manual-guidance map for
  every blocked action (never a disabled mystery);
- every mutation rides the existing command envelope: additive app-kit routes
  (`/v1/devices/{id}/sim` read + the three gated commands), client mutations with the
  full header set, the fake's capability-gated admission (typed `CAPABILITY_GATE_BLOCKED`
  rejection before any state is touched), the four-stage pipeline rendered per-stage,
  and the contextual support escape on failure (RL-103);
- the pinned assertions FLIPPED: the web suite's GAP probe became the VERIFIED probe
  (`apps/web/test/rl115-capability-discoverability.test.ts`), the structural guard
  flipped from absence to required presence
  (`tests/architecture/test/wave8-b-capability-guards.test.ts`), the inventory row
  flipped GAP -> VERIFIED with its four §15 surfaces, and this matrix row flipped
  with them. The MOBILE matrix is intentionally untouched (a separate work order owns
  the mobile journey; its pinned status-only probe stays green).

### RL-115-F2 — the §11 SLO dashboard has no entry point from any surface (CAP-SLO)

**STATUS: CLOSED by PA-009** (the SLO dashboard navigation work order). The
original record is preserved below; the flip evidence follows it.

- **Where:** `apps/portal-host/src/ops-slo-page.ts` (the dashboard, RL-109) vs the admin
  console nav (`apps/admin/src/app.ts`) and the customer navs.
- **What (the recorded finding):** spec/ux-architecture.md §13 requires admin to expose
  "SLO health". The dashboard EXISTS and honestly renders the nine §11 rows over the
  real recorder — but it was reachable ONLY by knowing `/ops/slo`: the admin console's
  five-item nav carried no SLO destination, and no web/admin/mobile source referenced
  the path. By journey-audit line 199 it was not discoverable.
- **Original minimal reproducer (the pin, now flipped):** the RL-115 GAP probe
  CAP-SLO rendered home/settings/more/workspace/connectivity and asserted zero
  `/ops/slo` references and zero SLO nav labels; the structural guard asserted the
  same over all three apps' sources while pinning that the ops surface itself still
  exists.
- **Candidate remediation:** an admin-console nav entry (or ops-surface link) to the
  session-gated dashboard.

**Flip record (PA-009, verified with evidence):** the candidate remediation was
implemented exactly as bounded —

- the admin console nav gained the §13 "SLO health" entry (the `NAV` array in
  `apps/admin/src/app.ts`), pointing at the host's ops route through the named
  constant `OPS_SLO_DASHBOARD_PATH = "/ops/slo"` (`apps/admin/src/routes.ts` —
  deliberately NOT a console page route: the dashboard lives host-side because the
  console's `/v1` read routes answer the honest 501 READ_MODEL_NOT_COMPOSED for it
  on the real runtime, so the console must not compose its read model);
- the entry is a plain link, honoring every bound: it renders on every console page
  (the access-denied renders included — the nav is chrome), it adds ZERO API
  requests and renders NO SLO content of its own (the console composes no SLO read
  model and no fabricated values), and the TARGET keeps its fail-closed session +
  `org:read` permission gate — the same permission the console's read surfaces map
  to. The dashboard itself (RL-109: real recorder state, the nine §11 rows,
  multi-window burn rates, honest no-data-degraded) is UNCHANGED — only
  discoverability was closed — and NO customer-surface link was added (§13 keeps
  admin and diagnostics out of customer navigation; the customer web/mobile
  surfaces stay SLO-free by design);
- the pinned assertions FLIPPED: the web suite's GAP probe became the closure probe
  "VERIFIED CAP-SLO (RL-115-F2, closed by PA-009)" (the customer-surface absence
  is now pinned as DESIGNED behavior, the /notifications Option B discipline), the
  structural guard flipped from three-app absence to admin PRESENCE + customer
  absence (`tests/architecture/test/wave8-b-capability-guards.test.ts`), the
  suite's inventory row and the matrix row above flipped GAP -> VERIFIED (proxy)
  with the closure evidence, and the GAP count went 5 -> 4.
- Evidence: `apps/admin/test/admin-app.test.ts` ("SLO health navigation entry
  (PA-009, closes RL-115-F2)": the nav renders the entry on every console surface,
  the entry's href is exactly the ops route, the entry is a link — no SLO read
  triggered, no dashboard content rendered — and the gate behavior is unchanged:
  the entry renders on the denied panel while the target keeps its own session
  gate), `apps/web/test/rl115-capability-discoverability.test.ts` (the flipped
  probe + the VERIFIED(proxy) inventory row), `tests/architecture/test/
  wave8-b-capability-guards.test.ts` (the flipped presence guard), and
  `apps/portal-host/test/ops-slo.test.ts` (the target's fail-closed gate and real
  recorder state — unchanged and still green).

### RL-115-F3 — enterprise connector enrollment has no action path (CAP-E-CONNECTOR-ENROLLMENT) — CLOSED by PA-06

- **Where:** `apps/web/src/pages/workspace-page.ts` (connector status + journey step) vs
  the enterprise package's API machinery (RL-104 read contract only).
- **What (the recorded finding):** the workspace honestly rendered connector STATUS
  ("No connector has been set up yet.", journey step "Not started", provisioning
  states when present) but offered NO affordance to start provisioning: the web app
  composed no connector flow, no command path, no route. The capability's §15 entry
  point was a status readout, not an action.
- **Original minimal reproducer:** the RL-115 GAP probe rendered a workspace WITHOUT
  enterprise fixtures and asserted `data-connector-absent="true"` + the "Not
  started" step + zero anchors whose text matches connector/provision/enroll; the
  structural guard asserted no `provisionConnector`/`enrollConnector`/`flows/*connector*`
  exists in the web sources.
- **Closure (PA-06, verified with evidence):** the connector journey step is now the
  guided action. The workspace composes a connector-enrollment flow section
  (`data-connector-enrollment="true"`) whose four stages — Not started →
  [Start enrollment] → Provisioning (honest in-flight) → Verification → Provisioned —
  derive PURELY from the workspace read; the only writer is the
  `provision-connector` command through the app-kit contract route
  `/v1/enterprise/workspace/connector/provision` (the enterprise package's transition
  machinery remains the authority — the fake's progression controls mirror its legal
  map; the web app imports no enterprise machinery, pinned by the flipped structural
  guard). The failure path renders the closed failure-reason vocabulary honestly with
  [Retry enrollment] (a NEW provisioning — the domain's failed state is terminal) and
  a support escape pre-carrying the connector facts. The start affordance is
  capability-gated on the verified/active enrollment + the `org:manage` permission the
  API enforces; the gated worlds render the honest explanation instead of a dead
  action. **Flipped assertions:** the suite's F3 probe now asserts the start anchor +
  the guided flow + the command form in the actionable world AND the honest gated
  render in the pre-enrollment world; the structural guard now pins the presence
  (composed through the app contract, no enterprise domain machinery in the web app).
  Evidence: `apps/web/test/rl115-capability-discoverability.test.ts` (the flipped
  probe + the VERIFIED inventory row),
  `apps/web/test/connector-enrollment-journey.test.ts` (the end-to-end journey:
  not-started render, start → provisioning → verification → provisioned, failure →
  explanation → retry → provisioned, idempotent replay, one-active-attempt conflict,
  server-side gates, support escape),
  `tests/architecture/test/wave8-b-capability-guards.test.ts` (the flipped guard).

### RL-115-F4 — refunds have no customer surface (CAP-B-REFUNDS)

- **Where:** `apps/web/src/pages/commerce-page.ts`, `order-journey-page.ts` vs
  `packages/domain-commerce` (refund aggregate exists) and the support-ref vocabulary
  (`refund` kind).
- **What:** Layer B owns "customer-facing … refunds", but no surface renders refund
  state — the commerce page shows products/orders/subscriptions, the order journey shows
  payments/invoices; the only refund trace in the UX layer is the support-ref kind.
- **Minimal reproducer:** the RL-115 GAP probe renders commerce + order and asserts the
  joined text contains no "refund" (case-insensitive); the structural guard asserts no
  refund vocabulary in the web page sources.
- **Candidate remediation:** a refund read model section on the order journey (state +
  freshness, riding the projection discipline).

### RL-115-F5 — SSO/SCIM/MDM integrations have zero UX vocabulary (CAP-E-SSO-SCIM-MDM) — **CLOSED by PA-008**

- **Where:** all app surfaces.
- **What (the recorded gap):** §8 lists SSO/SCIM/MDM integrations; no web, admin or mobile
  source carried the vocabulary at all. There was no integration-status view, let alone a
  setup journey.
- **Original minimal reproducer (the pin, now flipped):** the RL-115 GAP probe
  asserted `\b(SSO|SCIM|MDM)\b` is absent from workspace/settings/more renders;
  the structural guard asserted absence over all three apps' sources.
- **CLOSURE (PA-008, VERIFIED):** the candidate remediation was implemented
  exactly as bounded — an enterprise integrations section on the workspace
  page (honest not-available states until the API exists — the page's
  established pattern), PLUS the minimal read contract that pattern calls
  for. The owning record is the enterprise domain's read-only
  `EnterpriseIntegrationStatusRecord`
  (`packages/enterprise/src/integrations.ts`): the closed kind vocabulary
  (`ENTERPRISE_INTEGRATION_KINDS`: sso / scim / mdm) and the closed
  FOUR-state vocabulary (`ENTERPRISE_INTEGRATION_STATES`: configured /
  not-configured / unavailable / unknown — exactly the four states the
  finding's remediation demanded, never collapsed), first-class freshness
  (used DIRECTLY from @roamlink/contracts, never redefined), a fail-closed
  parse with honest-state invariants (a `configured` assertion carries its
  summary and rests on a COMPLETE observation; an `unavailable` record is a
  contract declaration carrying NO observation — the missing backend
  contract is never dressed up as an observed state; absence states carry
  no integration content), and NO write path (the module owns parse +
  vocabularies only; the authority fence is pinned by its own test). The
  record is mirrored additively through the app contract's workspace read
  (`packages/app-kit/src/api/enterprise.ts`: `EnterpriseIntegrationView`
  — `kind`, `state`, optional `summary`, the shared `FreshnessView`
  pairing — and `ENTERPRISE_INTEGRATION_RESOURCE_KINDS`/`STATES`,
  drift-guarded by the wave4-a mirrors; duplicate kinds and unknown
  fields/states fail closed; an older payload without the section parses
  to the honest null section, RL-LOCK-017). The deterministic fake seeds
  the honest wave-2 world by default (SSO configured + fresh with its
  summary; SCIM and MDM carrying the honest `unavailable` declaration) and
  the scenario seeds derive every kind × state world. The page's
  `deriveIntegrationRows` renders the section from the read only: one row
  per §8 kind (the mirrored kind vocabulary is the render's totality
  anchor — a kind the read does not carry renders the honest unavailable
  state), each with its state word, per-state fact and freshness pairing
  (a stale configured read keeps its content PAIRED with the stale badge —
  the §14 discipline), the authority note naming where integration
  management lives (upstream, with the organization's administrators and
  its own identity/device systems), and the §15 recovery path: the support
  escape ("Get help with integrations", pre-carrying the three statuses)
  in the unavailable/unknown worlds, the quiet reachability note
  otherwise. THE NO-FABRICATION CONTRACT: the section composes NO form,
  button or command flow — no OAuth dance, no SCIM endpoint fields, no
  MDM enrollment forms — because no write contract backs them; a
  workspace composing no integrations read degrades honestly (every kind
  renders `unavailable` — "requires the enterprise integration API" with
  an explanation — plus the support escape). The settings page carries
  the contextual link ("Review enterprise integrations" →
  `/workspace#integrations`); the admin and mobile surfaces stay
  integration-vocabulary-free until their own work orders.
- **Closure evidence (flipped assertions):**
  1. `apps/web/test/rl115-capability-discoverability.test.ts` — the GAP
     probe became the closure probe "VERIFIED CAP-E-SSO-SCIM-MDM
     (RL-115-F5 closed)": the workspace renders
     `data-integrations="true"` with all three integration rows, SSO
     `configured` with the freshness pairing, SCIM/MDM `unavailable` with
     the exact honest explanation, NO form/button/input inside the
     section slice, the settings contextual link, the vocabulary bounded
     to the workspace entry surface (settings/more stay acronym-free),
     and the honest null-section degradation (every kind `unavailable` +
     the support escape). The inventory row CAP-E-SSO-SCIM-MDM flipped
     GAP -> VERIFIED with its four §15 surfaces.
  2. `apps/web/test/enterprise-workspace.test.ts` — the journey tests:
     the seeded-world render (SSO configured + summary + freshness
     pairing, SCIM/MDM the unavailable declarations with their per-kind
     explanations, the escape with the pre-carried statuses), EACH
     INTEGRATION × EACH STATE (3 kinds × 4 states, `it.each`) rendering
     its closed state marker + state word + per-state honest content, the
     stale-freshness pairing, the null-section honest degradation, the
     no-configuration-affordance pin (+ the authority note), the quiet
     reachability note in the fully-verified world, and the settings
     contextual link.
  3. `tests/architecture/test/wave8-b-capability-guards.test.ts` — the
     flipped structural guard: the web surface NOW carries the
     SSO/SCIM/MDM vocabulary, the `data-integrations` /
     `data-integration-state` markers, the "requires the enterprise
     integration API" explanation, the `deriveIntegrationRows` composition
     over the mirrored kind vocabulary and the settings link; the
     integrations section source composes no form/button/input and the
     web app composes no integration write affordance; no direct
     enterprise package import; admin/mobile stay vocabulary-free. The
     GAP-count guard moved 3 -> 2 with the doc row.
  4. `tests/architecture/test/wave4-a-app-boundaries.test.ts` — the new
     mirror drift guards: `ENTERPRISE_INTEGRATION_RESOURCE_KINDS` <-
     `ENTERPRISE_INTEGRATION_KINDS` and
     `ENTERPRISE_INTEGRATION_RESOURCE_STATES` <-
     `ENTERPRISE_INTEGRATION_STATES`.
  5. `packages/enterprise/test/integrations.test.ts` +
     `packages/app-kit/test/enterprise-workspace.test.ts` — the record's
     honest-state invariants (fail-closed parse, the unavailable
     declaration's observation-free discipline, no write path) and the
     read contract's additive-tolerance + vocabulary + fail-closed
     proofs.

### RL-115-F6 — no integration/compatibility-health surface (CAP-D-COMPAT) — **CLOSED by PA-010**

- **Where:** `apps/admin/src/pages/*` vs §13 ("integration/compatibility health").
- **What (the recorded gap):** the env-gated compatibility probe (RL-108) runs
  host-side, but the admin console had no page exposing its outcome; §13's admin
  musts were otherwise covered (tenants, audit, reconciliation, projection health,
  support triage, plus the PA-009 SLO entry).
- **Original minimal reproducer (the pin, now flipped):** the structural guard
  asserted the admin page sources contain no compatibility/integration-health
  vocabulary; the web suite's GAP probe asserted no customer nav or page carries
  compatibility vocabulary and recorded the admin-side absence as the finding.
- **CLOSURE (PA-010, VERIFIED):** the admin console's Integration health page
  (`apps/admin/src/pages/integration-health-page.ts`, route
  `/integration-health`) renders the recorded outcome of the RL-108 probe
  through the application contract's additive `/v1/integration-health` read
  (RL-LOCK-017): the four honest states (Compatible | Incompatible | Not
  configured | Unknown — the closed vocabulary owned by @roamlink/compat,
  `ADCOS_INTEGRATION_HEALTH_STATES`, mirrored in the app contract and
  drift-guarded), the recorded last-checked freshness, the supported ADCOS API
  version (the single-site pin), the probe suite version, the full check table,
  and the failed-check explanation when incompatible. The surface is READ-ONLY:
  it never triggers the probe and never mutates compatibility state — the
  mutation gate stays inside the ADCOS integration boundary
  (spec/adcos-integration.md §9); not-configured is a first-class honest state,
  never a fabricated compatibility.
- **Closure evidence (flipped assertions):**
  1. `apps/web/test/rl115-capability-discoverability.test.ts` — the GAP probe
     became the closure probe "VERIFIED CAP-D-COMPAT (RL-115-F6, closed by
     PA-010)": the customer surfaces (more/settings/home/connectivity/workspace
     renders + the frozen nav vocabularies) carry ZERO compatibility vocabulary
     BY DESIGN (§13), and the row flipped GAP -> VERIFIED (proxy) with the admin
     render + structural proof named as the closure evidence.
  2. `tests/architecture/test/wave8-b-capability-guards.test.ts` — the
     structural absence guard ("no compat / integration health vocabulary in
     the admin pages") became the presence guard (the page, the vocabulary,
     the state data attributes, the read-only discipline vocabulary, and the
     never-triggers-the-probe pins); `ADMIN_PAGE_ROUTES` flipped five -> six
     console surfaces; the GAP count floor flipped 4 -> 3.
  3. `apps/admin/test/admin-app.test.ts` — the render-level proof: each of the
     four states renders honestly (compatible with the recorded report,
     incompatible with the failed-check explanation, not-configured as the
     honest first-class state, unknown as the fail-closed default); the
     surface performs NO mutations (GET-only requests, no probe/adcos route
     ever requested, re-render purity); freshness pairs with the state
     (recorded last-checked vs never-checked); the fail-closed rendering gate
     and the nav chrome hold; a read failure renders the typed error panel,
     never a guessed compatibility.
  4. `tests/architecture/test/wave4-a-app-boundaries.test.ts` — the app
     contract's `INTEGRATION_HEALTH_RESOURCE_STATES` mirror is drift-guarded
     against the owning `ADCOS_INTEGRATION_HEALTH_STATES` (RL-LOCK-018).
- **Honest limit (recorded):** the `/v1/integration-health` read model is not
  composed on the real runtime in this wave — `services/api` answers the typed
  501 READ_MODEL_NOT_COMPOSED for it (exactly like its sibling admin
  observability reads), and the deterministic fake API remains the contract
  reference; the page renders the typed error panel on that runtime, never a
  fabricated value. Composing the real read model over the worker host's
  recorded probe outcome (`services/workers/src/host.ts`) is follow-up
  operator work.

### RL-115-F7 — organization policies render only their own absence (CAP-E-POLICY) — **CLOSED by PA-007**

- **Where:** `apps/web/src/pages/workspace-page.ts policySummarySection` + the `policy`
  journey step.
- **What (the recorded gap):** the workspace page HONESTLY rendered "Not available
  yet" (`data-policy-gap`, step state `not-available`) because no org-policy read
  model existed. §15-wise the capability had no entry/view; the page's own recorded
  honest state was the finding.
- **Original minimal reproducer (the pin, now flipped):** the RL-115 GAP probe
  asserted `data-policy-gap="true"`, the "Not available yet" render and the step's
  `not-available` state on the seeded world.
- **CLOSURE (PA-007, VERIFIED):** the organization policy READ MODEL exists and the
  promised summary section is real. The owning record is the enterprise domain's
  read-only `OrganizationPolicyRecord` (`packages/enterprise/src/policy.ts`): the
  closed `ORGANIZATION_POLICY_STATES` (configured / not-configured / unknown) and
  `ORGANIZATION_POLICY_SOURCES` (organization-administration) vocabularies,
  first-class freshness (used DIRECTLY from @roamlink/contracts, never redefined),
  a fail-closed parse with honest-absence invariants (a `configured` assertion
  carries its facts; absence states carry no policy content; an assertion rests on
  a complete observation — an incomplete one forces the honest `unknown` state),
  and NO write path (the module owns parse + vocabularies only; the authority
  fence is pinned by its own test). The record is mirrored additively through the
  app contract's workspace read (`packages/app-kit/src/api/enterprise.ts`:
  `EnterprisePolicyView` — `policyId`, `state`, `source`, optional
  `policyVersion`/`summary`/`effectiveAt`, the shared `FreshnessView` pairing),
  drift-guarded by the wave4-a mirrors; an older payload without the section
  parses to the honest null section (RL-LOCK-017). The deterministic fake seeds
  the present world by default (configured + fresh, with version/summary/
  effective instant) and scenario seeds derive the not-configured / unknown /
  stale / not-available worlds. The page's `derivePolicySummary` renders the step
  and the section from the read only: the current policy with its freshness
  pairing (a stale read keeps its summary PAIRED with the stale badge — the
  §14 discipline), the explicit absence states as CONTRACT states, the authority
  note naming where management lives upstream, and the support-reachability
  note (§15 recovery). No policy editor exists anywhere: policy is
  organization-level configuration managed upstream (RL-LOCK-003/004/005 — the
  web app composes no policy write affordance, pinned by the wave8-b guard).
- **Closure evidence (flipped assertions):**
  1. `apps/web/test/rl115-capability-discoverability.test.ts` — the GAP probe
     became the closure probe "VERIFIED CAP-E-POLICY (RL-115-F7 closed)": the
     seeded world renders `data-policy-summary="configured"` + the statement +
     source + version + freshness, the old `data-policy-gap` marker is GONE, and
     the absence worlds render their EXPLICIT states (not-available for a
     workspace composing no section; not-configured for a record asserting no
     policy upstream). The inventory row CAP-E-POLICY flipped GAP -> VERIFIED
     with its four §15 surfaces.
  2. `apps/web/test/enterprise-workspace.test.ts` — the journey tests: the
     present-policy render (summary/source/version/effective/freshness + the
     complete step with its `#policy-summary` contextual link), the
     absent-policy honest render (not-configured: action-needed step naming the
     upstream action; not-available: the null-section world), the
     stale-freshness pairing (content PAIRED with the stale badge, waiting
     step), the unknown world, and the READ-ONLY authority-note proof.
  3. `tests/architecture/test/wave8-b-capability-guards.test.ts` — the flipped
     structural guard: the workspace page composes `derivePolicySummary` with
     the state/authority/reachability markers, the old `data-policy-gap`
     marker is absent from the source, no policy write affordance exists on
     the web surface, and the web app still imports no enterprise domain
     machinery. The GAP-count guard moved 4 -> 3 with the doc row.
  4. `tests/architecture/test/wave4-a-app-boundaries.test.ts` — the new mirror
     drift guards: `ENTERPRISE_POLICY_RESOURCE_STATES` <-
     `ORGANIZATION_POLICY_STATES` and `ENTERPRISE_POLICY_RESOURCE_SOURCES` <-
     `ORGANIZATION_POLICY_SOURCES`.
  5. `packages/enterprise/test/policy.test.ts` +
     `packages/app-kit/test/enterprise-workspace.test.ts` — the record's
     honest-absence invariants (fail-closed parse, no write path) and the read
     contract's additive-tolerance + vocabulary proofs.

### RL-115-F8 — the delivery-progress order journey is URL-only (CAP-B-ORDERS / CAP-L-COMMERCIAL) — **CLOSED by PA-003**

- **Where:** `apps/web/src/pages/commerce-page.ts` (Orders table) vs
  `apps/web/src/pages/order-journey-page.ts` (the RL-101 guided purchase-to-delivery
  view) and `WEB_PAGE_ROUTES.order`.
- **What (the recorded gap):** the delivery-progress view — the commercial loop's
  explanatory view and the user-journey-audit §6 requirement ("after payment,
  navigate to a delivery progress view") — renders only when a host composes the
  post-payment redirect. No static link reaches it: the commerce Orders table
  renders plain rows (no anchors), and the route appears in no page source. A
  customer with a placed order cannot navigate to its delivery journey from the
  commerce surface.
- **Original minimal reproducer (the pin, now flipped):** the RL-115 GAP probe
  asserted the commerce document contains `data-orders="true"` and the seeded
  order id as text, but no `/orders/` href anywhere; the structural guard asserted
  the Orders table section composes no `pagePath("order")`.
- **CLOSURE (PA-003, VERIFIED):** every Orders-table row now links to its
  delivery-progress journey through the route table —
  `pagePath("order", { orderId })` rendered as `<a class="order-link"
  href="/orders/{orderId}">Open delivery progress</a>` in a new "Delivery
  progress" column (`apps/web/src/pages/commerce-page.ts`). The anchor is a real
  `href` (keyboard reachable) carrying the repo's card-style action-link class
  `.order-link` with the 44px touch-target floor (`apps/web/src/styles.ts`, the
  same discipline as `.support-escape a`). The host-composed post-payment
  redirect is unchanged (additive discoverability, not a flow change).
- **Closure evidence (flipped assertions):**
  1. `apps/web/test/rl115-capability-discoverability.test.ts` — the GAP probe
     became the closure probe "VERIFIED CAP-B-ORDERS (RL-115-F8 closed)": every
     `data-order-id` row (including a NEWLY placed order) composes its
     `<a class="order-link" href="/orders/{orderId}">` link, and the inventory
     rows CAP-B-ORDERS / CAP-L-COMMERCIAL are VERIFIED with the contextual link
     commerce → `/orders/{seeded id}` → "Open delivery progress".
  2. `tests/architecture/test/wave8-b-capability-guards.test.ts` — the structural
     guard now asserts the Orders section COMPOSES `pagePath("order"` and no
     hand-written `/orders/` path.
  3. `apps/web/test/rl114-extended-a11y.test.ts` — the frozen 44px anchor-floor
     enumeration gained `.order-link` (the finding RL-114-F3 itself stands for
     the generic in-content links).

---

## 4. Candidate gaps investigated and dispositioned

The dispatch named three candidates; each was verified, not assumed:

1. **eSIM profile management** — confirmed GAP (RL-115-F1), with the nuance that status
   visibility IS verified on the mobile matrix: the gap was the management journey.
   **Closed by PA-001** (see the flip record on the finding above).
2. **SLO dashboard entry from the admin console** — confirmed GAP (RL-115-F2): the view
   is real (host-side, honest), the entry is missing everywhere. **Closed by PA-009**
   (the admin console nav now carries the §13 "SLO health" entry to the host's
   session-gated `/ops/slo` surface — see the flip record on the finding above).
3. **Enterprise connector enrollment discoverability** — confirmed GAP (RL-115-F3):
   status was discoverable on the workspace; the enrollment ACTION was not.
   **Closed by PA-06** (the connector journey step is now the guided action — see the
   F3 record below).

Three further gaps were found by the audit and recorded above: refunds (F4),
SSO/SCIM/MDM (F5), plus the org-policy absence made explicit
by the page itself (F7) and the URL-only delivery-progress journey (F8). F8 has since
been CLOSED by PA-003, F7 by PA-007 (see the finding records above) and F5 by
PA-008 (the enterprise integrations surface — see the finding record above); F6
(compatibility health) has since been CLOSED by PA-010 (see the finding record
above); the other
findings stand.

## 5. Honest verification limits (AR-009/AR-010 discipline)

- The render-level proofs are deterministic scanners over rendered HTML — they prove
  structure, vocabulary and linkage, not visual appearance, real screen-reader behavior
  or real touch hardware. No browser/AT tooling was added (the repo is deliberately
  dependency-light); §14's visual dimension is verified at the stylesheet-contract level.
- The admin console and ops dashboard rows are VERIFIED (proxy): their render-level
  behavior is covered by their own existing suites plus this audit's structural guards
  (this work item's scope excludes `apps/admin/test` and `apps/portal-host`).
- Everything standing from the campaign remains standing: no real-cloud execution
  (AR-009) and no real-infra verification legs (AR-010) — the hosted product a customer
  would actually traverse still does not exist, so "discoverable" here means discoverable
  by the rendered surfaces of this tree.
- `docs/reports/accepted-risks.json` was deliberately NOT extended: these findings are
  verification records for the Tech Lead to disposition (the threat-model precedent),
  not self-accepted risks.

## 6. RL-114 cross-reference (the responsive/accessibility lane of Wave 8B)

The RL-114 extended suites pin the UX findings in their headers and tests; summarized
here for one-stop reading (full reproducers in the suites):

| Finding | Surface | One-line record | Pinned in |
|---------|---------|-----------------|-----------|
| RL-114-F1 | web | No rendered web document contains an `<h1>` (shell title is an anchor); every hierarchy starts at h2 | `apps/web/test/rl114-extended-a11y.test.ts` |
| RL-114-F2 | web | Level skips on edge paths: Connectivity's h2→h4 disclosure panels; read-failure and mutation-result bodies lead with h3 | same |
| RL-114-F3 | web | The 44px floor skips generic in-content action links and the shell indicator link | same |
| RL-114-F4 | web | RESOLVED by PA-003 (Option B): `/notifications` is compatibility-only BY DESIGN — zero inbound links is the contract, the page carries the visible compatibility-role note, Activity is the sole narrative surface | same |
| RL-114-F5 | mobile | **CLOSED by PA-005**: the edge document shell carries the a11y layer — a skip link to the `main` landmark (the document's first anchor), a `:focus-visible` outline contract, a `prefers-reduced-motion` guard, a 44px floor on every interactive family (bottom-nav links + skip link), and `env(safe-area-inset-*)` on the header and the labelled bottom navigation (app-kit `bottomNav`: `nav[aria-label]` > ul > li > a, the same four legs) — `apps/mobile/src/views.ts` `MOBILE_EDGE_STYLES` + `mobileDocument` | `apps/mobile/test/rl114-mobile-document-contract.test.ts` (flipped) |
| RL-114-F6 | mobile | **CLOSED by PA-005**: every screen renders its nav-fragment target id (`id="now"/"capabilities"/"controls"/"outbox"` on the leg headings), so all four nav anchors resolve in any composition that renders the screens; the hosted composition pattern (all four legs in one document, `tests/e2e/test/hosted-offline-edge-enterprise.test.ts`) resolves every fragment link, skip link included | same (flipped) |
| RL-114-F7 | mobile | **CLOSED by PA-005**: every table header cell declares `scope="col"` and every table renders inside a labelled, keyboard-focusable scroll region (`role="region"` + `aria-label` + `tabindex="0"` `.table-wrap`) — the Now context, the capability matrix, the outbox and the action history | same (flipped) |

The RL-114 VERIFIED contracts (loading/error/empty per surface, badge text pairing,
per-leg mobile document contract, guidance pairing) are the green suites referenced
above. The mobile lane (F5/F6/F7) is CLOSED by PA-005; the web lane (F1/F2/F3)
remains open for its own work order.

## 7. How to run

```bash
pnpm -C apps/web test -- rl115            # the render-level cross-reference suite
pnpm -C apps/mobile test -- rl115         # the mobile capability-surface suite
pnpm -C tests/architecture test -- wave8-b # the structural drift-guards
pnpm -C apps/web test -- rl114            # the extended responsive/a11y suite (web)
pnpm -C apps/mobile test -- rl114         # the mobile document contract
```

The drift-guards fail when a surface gains or loses a capability reference, when the
cited vocabularies (routes, navs, §7 capability names, §11 SLO ids, support-ref kinds)
change, or when the doc and the suite inventories diverge — that is the point: the
inventory is frozen against the spec, and any change to the surfaces must update the
audit in the same change.
