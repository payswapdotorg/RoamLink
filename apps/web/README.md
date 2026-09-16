# @roamlink/web — the RoamLink customer web application (RL-060)

The customer-facing experience surface: a PURE view + command layer over the
public application API. It holds **zero authority logic** — every read goes
through the typed `RoamLinkApiClient`, every mutation is a command with the
full envelope (request/correlation/idempotency ids, actor/tenant context,
optimistic version), and every outcome the app displays comes from the API's
acknowledgement or typed errors (spec/repository-layout.md "apps consume
public application APIs/read models and do not contain authority logic").

## Surfaces

| Page | What it shows |
|---|---|
| Overview (`/`) | The connectivity aggregate (per-subject commercial state, reference lifecycle, delivery evidence, freshness - never a single opaque status) + unread notifications + per-device observation freshness |
| Connectivity (`/connectivity`) | The full honest connectivity read (spec/api.md "Connectivity read API") |
| Devices (`/devices`) | Device list with capability/context freshness, enroll/update/retire flows |
| Experience intents (`/intents`, `/intents/{id}`) | The immutable version chain with supersession, the explainable decision summary (derived status + input freshness), create/activate/supersede flows |
| Commerce (`/commerce`, `/orders/{id}`) | Catalog, order placement, payments (money facts), invoices (state incl. `reconciled` = billable-final), subscriptions - with the explicit "payment is not delivery" framing (RL-LOCK-008) |
| Notifications (`/notifications`) | Durable notifications with their source RoamLink state transition, related refs with evidence summaries, recipient-scoped mark-read |
| Support (`/support`, `/support/{case}`) | Case creation and the CUSTOMER thread view (internal messages are structurally absent) |

## How mutations work

Flow methods on `CustomerWebApp` (`enrollDeviceFlow`, `createIntentFlow`,
`activateIntentFlow`, `supersedeIntentFlow`, `placeOrderFlow`,
`recordPaymentFlow`, `cancelOrderFlow`, `markNotificationReadFlow`,
`createSupportCaseFlow`, ...) wrap one client mutation and return a
`MutationFlowResult`:

- on success, pages render the **four-stage pipeline** (`accepted`,
  `executed`, `delivered`, `billable-final`) as separate rows — the app never
  collapses them (spec/api.md "Command semantics");
- on failure, pages render the typed error panel (kind/reason/retryability)
  — optimistic-version conflicts render the `conflict` panel with
  "refresh and retry" guidance.

Flows that target an existing versioned resource read the current revision
first and command against it; a lost race surfaces as a typed conflict.

Retries: re-invoke the flow with the same `idempotencyKey` — the API replays
the original acknowledgement without duplicating the effect (RL-LOCK-014).

## UI framework choice (recorded decision)

Framework-free typed HTML rendering via `@roamlink/app-kit`'s view core
(pure functions returning escaped-by-construction `HtmlFragment`s). Zero new
runtime dependencies, works in Node and the browser, deterministic component
tests without DOM emulation. This does **not** affect dependency direction
(apps → app-kit → contracts), so no ADR is required (RL-LOCK-020); the
choice is recorded here and in the app-kit README as the work items request.

## Mounting

The app is a library (like every workspace package here): a host composes
`CustomerWebApp({ client })` with any `HttpTransport` (a `fetch` adapter in
production, the deterministic in-memory fake in tests), renders
`renderDocument({ page, params, lastResult })`, and wires the rendered
form actions (`/flows/*`, `data-flow` attributes) to the matching flow
methods. The host owns sessions/CSRF; the app never sees credentials
(RL-LOCK-016).

## Tests

`pnpm test` (14 tests) drives the real app through the real typed client
against the deterministic fake with testkit clocks/ids:

- connectivity-aggregation rendering with FRESH/STALE/UNKNOWN states (and
  monotone STALE degradation as the guarantee expires);
- accepted/executed/delivered/billable-final distinction across the full
  order flow (evidence → delivered; invoice reconciliation → billable-final);
- optimistic-version conflict rendering (racing competitor write);
- idempotent retries through app flows (same key → one effect);
- the customer support thread hides internal messages;
- fail-closed page rendering on API errors and cross-tenant 404s.
