# @roamlink/web — the RoamLink customer web application (RL-060, RL-082, RL-083)

The customer-facing experience surface: a PURE view + command layer over the
public application API. It holds **zero authority logic** — every read goes
through the typed `RoamLinkApiClient`, every mutation is a command with the
full envelope (request/correlation/idempotency ids, actor/tenant context,
optimistic version), and every outcome the app displays comes from the API's
acknowledgement or typed errors (spec/repository-layout.md "apps consume
public application APIs/read models and do not contain authority logic").

## The application shell (RL-083, ADR-0002)

Every page renders inside the @roamlink/app-kit `applicationShell` — a
PRESENTATION boundary that acquires no domain authority:

- **Persistent connectivity status** in the global header, derived ONLY from
  the authoritative connectivity read (`ConnectivityOverviewResource`
  subjects) and rendered WITH its underlying facts — never one opaque badge.
  The closed state vocabulary (`evidenced-fresh`, `evidenced-stale`,
  `evidenced-unknown`, `unevidenced`, `no-reference`, `unverifiable`)
  claims "usefully connected" ONLY from fresh delivery evidence — never from
  payment, orders, reservations or webhooks (RL-LOCK-008/009). A failed read
  renders the honest "Cannot confirm right now" state.
- **Desktop sidebar + mobile bottom navigation** with the exact customer
  destinations (spec/ux-architecture.md §3):
  - Desktop: Home | Connectivity | Activity | Devices | Goals |
    Plans & Billing | Support
  - Mobile: Home | Connect | Activity | Devices | More
  Routes stay stable; labels are human (Goals renders the ExperienceIntent
  surface, Plans & Billing renders commerce). The More sheet
  (`/more`) contains Goals, Plans & Billing, Support and Settings.
- **Warm-light, quiet visual system** (`WARM_SHELL_STYLES` + this app's
  `WEB_APP_STYLES`): warm neutral palette, generous whitespace, strong
  typography hierarchy, restrained connected/warning/error colors. State is
  never communicated by color alone (text + data attributes always), focus
  is keyboard-visible (`:focus-visible`), motion respects
  `prefers-reduced-motion`, bottom-nav touch targets are ≥44px with
  `safe-area-inset-bottom` handling, and a skip link targets `#shell-main`.
- **Diagnostics stay out of the customer path**: protocol/engineering detail
  remains on the admin/diagnostics surfaces (RL-061), not in this shell.

## Home (the landing surface, `/`)

The Home hero answers within one viewport (spec §4):

- **Am I usefully connected?** — the dominant hero with the derived state
  line, the evidence-freshness badges and the per-reference facts summary;
- **What is my current goal?** — the active goal in human language with its
  explainable status translation;
- **Is RoamLink actively managing anything?** — the decision summary and a
  link into Activity;
- **Does RoamLink need me?** — the items needing attention (or an explicit
  "No.");

plus the compact device freshness facts. State families stay separate —
there is no combined/overall status anywhere (RL-LOCK-010).

## First-run onboarding (RL-082, `/onboarding`)

Exactly four lightweight steps (spec/ux-architecture.md §5); the flow NEVER
requires the customer to understand ADCOS, ConnectivityIntent, reservations,
NetworkPath, provider adapters, leases or routing (enforced by a vocabulary
ban test over every rendered step):

1. **Welcome** — the product in plain language.
2. **Choose the primary connectivity goal** — the spec's goal language
   ("Stay connected while traveling", "Keep work reliable",
   "Save connectivity cost", "Prefer trusted Wi-Fi when it is good enough",
   "Protect privacy", "Let RoamLink handle recovery automatically"), each
   mapped onto the typed ExperienceIntent access classes (presentation
   mapping only; the human sentence becomes the goal's rationale).
3. **Add or enroll a device** — pick an enrolled device or enroll a new one
   through the real command envelope.
4. **Confirm preferences and finish** — the goal + device summary, then
   `completeOnboardingFlow` (create + activate the goal) and the customer
   lands on Home.

The wizard is STATELESS by construction: choices ride the page request
params; the UI never becomes an authority and no local onboarding state
machine exists.

## Surfaces

| Page | What it shows |
|---|---|
| Home (`/`) | The hero (above) + getting-started entry into onboarding |
| Onboarding (`/onboarding`) | The four-step first-run journey (RL-082) |
| Connectivity (`/connectivity`) | The full honest connectivity read (spec/api.md "Connectivity read API") |
| Activity (`/activity`) | What RoamLink observed/did/recovered and what needs you (over the durable notifications, which keep their dedicated route/API); per-goal automation status. The full automation timeline deepening is RL-085 |
| Devices (`/devices`) | Device list with capability/context freshness, enroll/update/retire flows |
| Goals (`/intents`, `/intents/{id}`) | The immutable version chain with supersession, the explainable decision summary (derived status + input freshness), create/activate/supersede flows — presented under the human "Goals" label with the advanced "experience intents" label retained |
| Plans & Billing (`/commerce`, `/orders/{id}`) | Catalog, order placement, payments (money facts), invoices (state incl. `reconciled` = billable-final), subscriptions — with the explicit "payment is not delivery" framing (RL-LOCK-008) |
| Notifications (`/notifications`) | The dedicated notifications route (compatibility; represented in Activity per spec §8) |
| Support (`/support`, `/support/{case}`) | Case creation and the CUSTOMER thread view (internal messages are structurally absent) |
| More (`/more`) | The mobile More sheet: Goals, Plans & Billing, Support, Settings |
| Settings (`/settings`) | Account (actor session identity/scope/role), preferences pointer to Goals, accessibility statement |
| Overview (`/overview`) | The legacy RL-060 aggregate view (moved off `/` when Home became the landing surface; still fully reachable) |
| Workspace (`/workspace`) | The RL-104 guided enterprise journey + live org overview, and the PA-06 guided **connector enrollment** (start → provisioning → verification → provisioned, with the honest failure path: reason vocabulary + retry + support escape) |

## How mutations work

Flow methods on `CustomerWebApp` (`enrollDeviceFlow`, `createIntentFlow`,
`activateIntentFlow`, `supersedeIntentFlow`, `completeOnboardingFlow`,
`provisionConnectorFlow`, `placeOrderFlow`, `recordPaymentFlow`,
`cancelOrderFlow`, `markNotificationReadFlow`, `createSupportCaseFlow`, ...)
wrap one client mutation and return a `MutationFlowResult`:

- on success, pages render the **four-stage pipeline** (`accepted`,
  `executed`, `delivered`, `billable-final`) as separate rows — the app never
  collapses them (spec/api.md "Command semantics");
- on failure, pages render the typed error panel (kind/reason/retryability)
  — optimistic-version conflicts render the `conflict` panel with
  "refresh and retry" guidance.

Flows that target an existing versioned resource read the current revision
first and command against it; a lost race surfaces as a typed conflict.
`completeOnboardingFlow` composes create → activate against the created
goal's returned id, with the activate carrying its own idempotency key
suffix so a retry of the whole flow stays safe (RL-LOCK-014).

Retries: re-invoke the flow with the same `idempotencyKey` — the API replays
the original acknowledgement without duplicating the effect (RL-LOCK-014).

## UI framework choice (recorded decision)

Framework-free typed HTML rendering via `@roamlink/app-kit`'s view core
(pure functions returning escaped-by-construction `HtmlFragment`s). Zero new
runtime dependencies, works in Node and the browser, deterministic component
tests without DOM emulation. This does **not** affect dependency direction
(apps → app-kit → contracts), so no ADR is required (RL-LOCK-020); the
choice is recorded here and in the app-kit README as the work items request.
The shell primitives (application shell, navs, connectivity indicator, a11y
helpers) are app-kit public surface (additive), so any host can reuse them.

## Mounting

The app is a library (like every workspace package here): a host composes
`CustomerWebApp({ client })` with any `HttpTransport` (a `fetch` adapter in
production, the deterministic in-memory fake in tests), renders
`renderDocument({ page, params, lastResult })`, and wires the rendered
form actions (`/flows/*`, `data-flow` attributes — including the onboarding
`/flows/onboarding-enroll-device` and `/flows/onboarding-finish`, and the
workspace connector enrollment `/flows/provision-connector`) to the
matching flow methods. The host owns sessions/CSRF; the app never sees
credentials (RL-LOCK-016). After a connector-enrollment command the host
redirects to `/workspace?commandId=<ack.commandId>` so the page renders the
command's four-stage pipeline from the status read (the polling states).

## Tests

`pnpm test` (32 tests) drives the real app through the real typed client
against the deterministic fake with testkit clocks/ids:

- connectivity-aggregation rendering with FRESH/STALE/UNKNOWN states (and
  monotone STALE degradation as the guarantee expires);
- accepted/executed/delivered/billable-final distinction across the full
  order flow (evidence → delivered; invoice reconciliation → billable-final);
- optimistic-version conflict rendering (racing competitor write);
- idempotent retries through app flows (same key → one effect);
- the customer support thread hides internal messages;
- fail-closed page rendering on API errors and cross-tenant 404s;
- **RL-083 shell contract**: exact desktop/mobile destinations + order,
  More-sheet contents, aria-current, skip link, semantic landmarks, warm
  styles a11y rules (reduced motion, focus-visible, touch targets,
  safe-area), and the connectivity indicator's honest states
  (evidenced-fresh / evidenced-stale / unverifiable) with facts shown;
- **RL-082 onboarding journey**: land → understand → choose goal → enroll
  device → confirm preferences → Home, the six-goal vocabulary, the
  access-class mapping, the typed failure paths, and the novice-path
  vocabulary ban over every rendered step.
