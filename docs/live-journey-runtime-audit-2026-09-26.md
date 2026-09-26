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
