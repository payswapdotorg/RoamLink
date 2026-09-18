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
