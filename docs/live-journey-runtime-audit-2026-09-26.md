# RoamLink — Live Interface & Journey Runtime Audit (2026-09-26)

## Scope

This audit reviews the current main tree after PA-018/PA-019 and the live-provider verification work through PA-017.

Current main reviewed:
a68cf94537d247401c2368c8446fb300136680e6

Vercel reports a successful deployment check on that commit.

This audit is source/test-driven. The deployed URL was not manually fetched from this review environment, so this document does not claim a literal browser click-through of the latest deployment. The repository does contain the hosted UI, host routing, form-action plane, real API composition, and the real-composition journey suites.

## 1. Interfaces that exist

### Customer interface

The deployed portal host composes apps/web and exposes the customer product through:

/login
/onboarding
/
/connectivity
/activity
/devices
/devices/{deviceId}
/devices/{deviceId}/sim
/intents
/intents/{intentId}
/commerce
/orders/{orderId}
/support
/support/{caseId}
/more
/settings
/workspace

The shell follows the frozen ShareNet-inspired interaction direction:
- quiet warm-light surface;
- desktop sidebar;
- mobile bottom navigation;
- persistent connectivity status;
- lightweight onboarding;
- generous whitespace;
- one primary action per major surface;
- technical diagnostics separated from the normal customer path;
- progressive disclosure.

The current implementation is original RoamLink UI. ShareNet is an inspiration/reference, not a code dependency.

### Admin / operations interface

apps/admin provides the operations console with:
- Tenants;
- Audit & security;
- Reconciliation;
- Projection health;
- SLO health;
- Support triage;
- Integration health.

/ops/slo remains a host-side, session-gated operations surface.

### Mobile / edge interface

apps/mobile remains the mobile/edge experience with:
- Now;
- Capabilities;
- Controls;
- Outbox.

It is not merely a mock page: it exercises the real edge contracts and offline/outbox semantics in its verification suites.

## 2. What PA-018 and PA-019 actually closed

### PA-018

Every rendered /flows/* form action now has a host-side dispatcher.

The closed flow set includes:
enroll-device
update-device
retire-device
esim-install
esim-enable
esim-remove
mark-notification-read
create-intent
activate-intent
supersede-intent
create-support-case
place-order
record-payment
cancel-order
provision-connector
onboarding-enroll-device
onboarding-finish

The host performs session/CSRF validation, typed parsing, dispatch and fail-closed rendering.

This proves the UI is no longer posting to unowned/unwired /flows/* targets.

### PA-019

The API now composes real read models for the state actually bound to the service:
- users;
- organizations;
- devices;
- experience intents and versions;
- payments;
- connectivity;
- reconciliation jobs;
- support cases.

The important truth law is:

accepted command != executed command != delivered != billable-final

The read models only project a resource when the durable command record says it executed.

Therefore an accepted-but-not-executed command correctly produces an empty read model rather than invented state.

## 3. Critical finding: the current portal is real, but not yet a complete live product

The old problem “the UI is only a library” is gone.

The new problem is narrower and more important:

some customer/admin pages and some rendered actions still depend on runtime read/command sources that are intentionally not composed in services/api.

### Current real-runtime kept-501 reads

services/api/src/read-models.ts currently keeps these honest 501 routes:

/v1/products
/v1/orders
/v1/orders/{orderId}
/v1/subscriptions
/v1/notifications
/v1/audit-events
/v1/projection-health
/v1/integration-health

The reasons are explicit rather than fake data:
- product catalog not bound;
- order pricing facts not bound;
- subscription state not bound;
- notification store not bound;
- audit chain not bound;
- projection-health source not bound;
- integration-health source not bound.

The enterprise workspace read is different: it is not in the composed read dispatcher, so the current real API returns a plain 404 for /v1/enterprise/workspace.

### Current real-runtime mutation parity

services/api/src/commands.ts currently defines mutation routes for:
- device enroll/update/retire;
- experience-intent create/activate/supersede;
- order place/cancel/complete;
- payment record;
- notification read;
- support cases;
- organization suspend/reactivate.

The current list does not include the rendered customer actions for:
- eSIM install/enable/remove;
- enterprise connector provisioning.

Therefore PA-018 proves host form wiring, but not yet end-to-end API mutation parity for those two capabilities.

**Mutation-parity closure note (PA-023, 2026-09-26, additive — the original finding above is unchanged):**
the four missing mutation routes landed in the real API. `services/api/src/commands.ts` `MUTATION_ROUTES` now serves
`/v1/devices/{deviceId}/sim/install` → `esim.install`, `/v1/devices/{deviceId}/sim/profiles/{profileId}/remove` → `esim.remove`,
`/v1/devices/{deviceId}/sim/profiles/{profileId}/enable` → `esim.enable`, and
`/v1/enterprise/workspace/connector/provision` → `connector.provision` (the kinds follow the in-repo command vocabulary — the
deterministic fake API's and the workers' executor-table key style — rather than a new naming). Per the NO-INVENTION law these
routes DURABLY ACCEPT a typed command envelope into the command plane (idempotency key, correlation id, the atomic
command-record + key-pointer + outbox-obligation unit of work) and answer the four-stage acknowledgement with only `accepted`
reached — execution remains the worker path's concern (PA-025), so accepted ≠ executed stays honest. Server-side payload
validation mirrors the app-kit serializers exactly (same field names, same bounds, fail-closed typed rejections:
`activationCode` non-empty string, `enabled` boolean, the ids as canonical lowercase UUIDs on the path, and the bounded
printable connector label `/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/` — never a secret); the pre-existing 15 kinds keep their
ingestion contract with the fake API as the reference. The gap is now held closed by a repo-level law:
`tests/architecture/test/mutation-route-parity.test.ts` parses the rendered-flow union (apps/web pages + the app's typed flow
methods), the portal-host `FLOW_HANDLERS` table, and the services/api `MUTATION_ROUTES` table, and fails on drift in either
direction — every rendered/hosted flow must resolve to a real API mutation route, and every API-only mutation kind must stay
in the documented exceptions list (`order.complete`, `support-case.transition`, `organization.suspend`, `organization.reactivate`
— the service-plane extras). Battery evidence: `services/api/test/esim-connector-mutations.test.ts` (12 tests — the positive
acceptance, idempotency dedupe/conflict, the durable read-back through `/v1/commands/{commandId}`, and the fail-closed
negative matrix per route) and the strengthened e2e rows in `tests/e2e/test/hosted-flows-form-actions.test.ts` (the three
eSIM flows now assert the typed acknowledgement panel — command id + idempotency key echo + the honest four-stage pipeline —
and the connector flow asserts the redirect law `303 → /workspace?commandId=<ack.commandId>` with the durable command verified
through the REAL /v1 mount). The `pnpm check` floor held (45 packages, 0 fail); no existing test was weakened, skipped or deleted.

## 4. Journey simulation

### Journey 1 — Login → Home

/login
  ↓
Home

Result: ◐

The login/session path is real.

The shell is real.

The Home surface, however, has a dependency on notifications while /v1/notifications is a kept-501 read. The current E2E suite therefore correctly records a fail-closed Home body rather than fabricating Activity/notification state.

Learning: optional supporting data must not blank the entire primary customer surface.

The shell should render the useful core facts it can prove and isolate unavailable secondary panels.

### Journey 2 — Onboarding

Welcome
  ↓
Goal
  ↓
Enroll device
  ↓
Finish
  ↓
Home

Result: ◐

The rendered onboarding forms are wired and the enrollment command is durably accepted.

PA-019 now composes the device list, so the device step can render the honest empty state rather than a fake device picker.

The remaining limitation is execution:
- commands are accepted into the durable command plane;
- the live demo does not currently have the command-execution worker path advancing them to executed;
- therefore the goal activation leg fails read-first on the honest not-found state rather than inventing a goal id.

Learning: the user journey is not complete merely because the command was accepted. The demo needs the execution worker path, not just command ingestion.

### Journey 3 — Goals

Goals
  ↓
No goals yet
  ↓
Create goal
  ↓
Activate / supersede

Result: ◐

The Goals page now has a real empty read model.

Create is a real durable command.

Versioned activation/supersession correctly refuse to act on a goal that has not executed.

Learning: once the worker plane is deployed, this journey should become fully executable without changing the UX contract.

### Journey 4 — Devices

Devices
  ↓
Device detail
  ↓
Capability status
  ↓
Actions / fallback

Result: ◐

Device list/detail reads are composed.

Enrollment is accepted through the real command plane.

The current demo still needs command execution for an accepted enrollment to become an executed device projection.

The capability UI itself is discoverable and was closed by the RL-115 audit.

### Journey 5 — eSIM

Device
  ↓
SIM & Profiles
  ↓
Install / Enable / Remove

Result: ◐

The UI exists and the host dispatches all three actions.

The underlying real API mutation route table does not currently include the eSIM mutation routes.

Therefore the capability is:
discoverable ✅
host-wired ✅
real API mutation ❌

This must be closed before eSIM is considered live.

### Journey 6 — Connectivity

Home
  ↓
Connectivity
  ↓
summary
  ↓
why
  ↓
evidence
  ↓
technical

Result: ◐

Connectivity itself now has a real composed empty aggregate:
subjects = []
deviceObservations = []

This is an improvement over the earlier “read model entirely unavailable” state.

But actual delivery/recovery cannot be demonstrated until:
- command execution is running;
- provider/ADCOS compatibility is configured;
- worker/reconciliation execution is live;
- observation/evidence sources are available.

The UI correctly refuses to call an accepted command “delivered”.

### Journey 7 — Activity / Notifications

Result: ❌ as a live runtime journey

Activity is the intended customer narrative surface, but the underlying notification store is not bound in services/api.

The /notifications page is intentionally compatibility-only, but Activity still needs the notification-derived state to be available or to fail at component level rather than destroying the entire page.

Learning: wire the notifications read model and/or make Activity progressively degrade around it.

### Journey 8 — Plans & Billing → purchase → order → delivery

Plans & Billing
  ↓
Product
  ↓
Order
  ↓
Payment
  ↓
Delivery progress

Result: ❌ on the current real runtime

The customer routes exist and the form actions are wired.

But:
- /v1/products is 501;
- /v1/orders is 501;
- /v1/orders/{id} is 501;
- /v1/subscriptions is 501.

Therefore the commerce surface cannot yet emerge as a complete live journey over the real host.

The commerce domain itself exists and the dogfood suite proves the semantics; the missing piece is the production read/command composition.

### Journey 9 — Support

degraded/error surface
  ↓
Get help with this
  ↓
Support case
  ↓
related refs
  ↓
case thread

Result: ◐

Support creation is a real host flow and support-case reads are composed.

The contextual-carry mechanism from PA-103 remains intact.

This journey becomes more useful once the surrounding notification/order/connectivity surfaces are fully live.

### Journey 10 — Enterprise Workspace

Workspace
  ↓
Organization
  ↓
Policy
  ↓
Connector
  ↓
Devices
  ↓
Capability verification
  ↓
First goal
  ↓
Live overview

Result: ❌ on the current real runtime

The customer workspace UI exists and the RL-115 render-level audit is closed.

However, the real API currently has no composed /v1/enterprise/workspace read route; the current E2E suite records the real runtime answer as 404.

The connector action is also only host-wired: the services/api mutation route table has no connector-provision route.

So the architecture is present, but the hosted enterprise journey is not yet executable end-to-end.

### Journey 11 — Admin / Operations

Result: ◐

The operations console exists.

SLO health is reachable through the admin navigation and is intentionally host-side.

Integration health has a real page and honest state vocabulary, but /v1/integration-health is still a kept-501 on the current API composition.

Audit and projection-health are similarly not bound in the current API read dispatcher.

Learning: admin discoverability is solved; admin data-plane composition is not.

### Journey 12 — Offline mobile edge

Result: ✅ at the edge/runtime-contract level

The mobile edge surface and tests cover:
- Now;
- capabilities;
- controls;
- encrypted outbox;
- offline convergence;
- manual fallback;
- evidence/freshness.

The remaining deployment work is making the hosted/customer enrollment journey clearly lead users to the mobile experience and running final device/browser acceptance.

### Additive closure note (2026-09-26, PA-020 — component-scoped degradation)

This note is additive; the findings above are unchanged. PA-020 implements the
§5 graceful-composition direction for Journeys 1, 6, 7, 10 and 11: the five
multi-source surfaces now degrade per component instead of failing the whole
page body closed when a secondary read is unavailable.

What now degrades per-component:
- Journey 1 (Login → Home): core = connectivity + intents + devices (hero,
  goal card, devices card); secondary = the notification feed (the
  "Does RoamLink need you?" card renders the quiet panel when
  /v1/notifications keeps its typed 501 NOTIFICATION_STORE_NOT_BOUND).
- Journey 6 (Connectivity): core = the connectivity overview (the whole
  explanation center); secondary = the notification feed (the
  "Recent connectivity events" section degrades to the quiet panel).
- Journey 7 (Activity/Notifications): core = intents + devices (the
  automation-status section renders its honest state); secondary = the
  notification feed (the needs-attention list and the timeline degrade to
  the quiet panel — never a fabricated narrative).
- Journey 10 (Enterprise Workspace): core = session + devices + intents +
  connectivity (the fleet, goals, org-connectivity and support sections, plus
  the journey's devices/capability/first-goal/live-overview steps); secondary
  = the enterprise workspace read (the not-composed 404 degrades the
  switcher, the four workspace-composed journey steps, the connector
  enrollment, the policy summary, the integrations and the enrollment status
  sections each to the quiet panel).
- Journey 11 (Admin/Operations): core = the session gate (a denied or
  unresolvable actor still never sees surface data — the fail-closed
  authorization law is unchanged, including "no data even fetched");
  secondary = each console page's data-plane read (Audit & security,
  Reconciliation, Projection health, Support triage, Integration health
  each render their heading plus the quiet panel when their source refuses,
  while the navigation and every healthy diagnostic page stay usable).

The panel contract (packages/app-kit, additive): a small, quiet,
section-scoped block — title "Not available right now", the WHY (the typed
reason rendered verbatim, plus the contract-borne explanation with the named
reason when the source gave one), and one what-this-means line naming what
still renders on the page and where help is reachable. No retry buttons that
cannot work, no fake data, no full-page alarm styling. Degradation applies
only to unavailability-class typed errors (unavailable — the typed 501
READ_MODEL_NOT_COMPOSED, 503s, transport failures; not-found; rate-limited);
authorization refusals and contract-integrity failures keep the existing
honest full-body fail-closed law, as does any CORE read failure.

Battery evidence (the three mandated states per surface — core available +
secondary unavailable asserting BOTH the core content and the quiet panel;
core unavailable asserting the unchanged fail-closed body; mixed
fresh/stale/unknown asserting each section's truthful state):
- packages/app-kit/test/degradation.test.ts — the panel contract and the
  secondary-read helper's degradable/non-degradable error classes;
- apps/web/test/component-scoped-degradation.test.ts — Home, Connectivity,
  Activity and Workspace over the deterministic fake with the real runtime's
  typed refusal bodies (kept-501 named reasons; the not-composed workspace
  route's 404);
- apps/admin/test/component-scoped-degradation.test.ts — the five console
  pages, the unchanged gate law (including the no-data-fetched proof) and
  the healthy-sibling pages.
- tests/e2e (RL-113) — the hosted journeys on Home/Connectivity/Activity/
  Workspace now assert the component-scoped degradation over the REAL
  composition; the Commerce and Order journeys keep their full fail-closed
  assertions (their read sets are entirely kept-501).

## 5. Product-level design learning

The ShareNet-inspired shell is the correct visual interaction direction.

The next improvement is not visual reinvention. It is graceful composition:

primary surface
    |
    +--> core fact available -> render it
    |
    +--> secondary read unavailable -> render that section as unavailable
    |                                with a concise explanation
    |
    +--> mutation available -> expose the action
    |
    +--> mutation unavailable -> explain + support/manual path

A single missing optional read should not turn Home, Connectivity, Activity or Workspace into a blank error panel when the rest of the page has authoritative data.

This is directly consistent with the ShareNet-inspired quiet error/empty-state philosophy and RoamLink's existing truthful-state rule.

## 6. Current completion interpretation

There are now three distinct completion levels:

### Architecture

✅ complete and frozen.

### Customer/admin surface design

✅ all RL-114/RL-115 discoverability findings closed at the surface/audit level.

### Live hosted product

◐ not complete.

The remaining blocker class is runtime composition/execution, not a second architecture redesign:

UI
  ↓
host form dispatcher
  ↓
API command/read contract
  ↓
real persistence
  ↓
worker execution
  ↓
read model
  ↓
user-visible evidence

All six layers must be live for a major journey to count as complete.
