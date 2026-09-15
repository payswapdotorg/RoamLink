# RoamLink Architecture

**Version:** 1.0.0
**Status:** FROZEN FOR IMPLEMENTATION
**Authority:** This document plus `architecture-lock.md` define the architecture. Implementation may choose different libraries or deployment mechanics only when the authority boundaries and contracts remain intact.

## 1. Product boundary

RoamLink is the customer-facing Connectivity Experience OS above ADCOS. It converts human and organizational connectivity outcomes into ADCOS-native connectivity requests and presents a stable experience across heterogeneous access technologies.

The core product promise is: **specify the connectivity outcome; RoamLink continuously assembles and explains the best available connectivity without requiring the customer to manually choose providers.**

## 2. Layered architecture

### Layer A — Experience Domain
Owns:
- User and organization accounts.
- Device registry and device capability/context snapshots.
- Human-facing preferences and `ExperienceIntent`.
- Travel, work-mode, cost, privacy, reliability and application needs.
- Notifications, support and explainability.

Does not own network path, routing, session, provider, or physical connectivity state.

### Layer B — RoamLink Commerce
Owns:
- Product/catalog and product variants.
- Offers as customer-facing commercial packaging; references ADCOS offers where applicable.
- Orders, subscriptions and customer entitlements.
- Customer-facing payment state, invoices, refunds and support adjustments.
- Customer pricing presentation.

RoamLink commerce state is distinct from ADCOS commercial settlement. Payment success never means connectivity delivery succeeded.

### Layer C — RoamLink Edge
Owns:
- Device-side observation and context collection subject to platform permissions.
- Local experience policy evaluation that determines what RoamLink wants from connectivity, not how connectivity is routed.
- Durable intent/sync outbox.
- Current connectivity read model for UX.
- Graceful offline operation and eventual synchronization.

The edge cannot contain hidden ADCOS authority or provider credentials.

### Layer D — ADCOS Integration Plane
The only production integration boundary to ADCOS is `packages/adcos` (or the equivalent bounded module selected by implementation).

It owns:
- ADCOS API client.
- Versioned request/response schemas.
- Mapping `ExperienceIntent -> ConnectivityIntent`.
- Server-side application authentication.
- Idempotency keys and request correlation.
- Durable ADCOS webhook inbox.
- Canonical-resource refresh and reconciliation.
- Projection of ADCOS state into RoamLink read models.
- Compatibility checks against the supported ADCOS API contract.

RoamLink application modules must not import ADCOS implementation internals.

### Layer E — ADCOS connectivity fabric
ADCOS remains authoritative for:
- canonical ConnectivityIntent;
- eligibility;
- Offer;
- Reservation/Lease;
- candidate selection and NetworkPath validation;
- logical Session;
- mobility;
- access/provider adapters;
- connectivity usage evidence;
- ADCOS commercial settlement lifecycle.

RoamLink interacts with these through ADCOS public contracts only.

### Layer F — physical/provider domains
Carrier, ISP, Wi-Fi, satellite, fixed, enterprise WAN, eSIM, device-radio and other provider technologies retain authority over their own physical/provider-native state.

## 3. Experience intent model

RoamLink has a customer-facing `ExperienceIntent` and ADCOS has the authoritative `ConnectivityIntent`.

Example ExperienceIntent:

> Travel to Ghana for two weeks; keep work traffic reliable; prefer trusted Wi-Fi when it satisfies the target; avoid unnecessary roaming cost; automatically recover from failures; do not require manual provider switching.

Compiler output is a normalized ADCOS ConnectivityIntent containing technology-neutral constraints and preferences such as locality, reliability, latency, cost, privacy and validity.

The compiler may translate, enrich, prioritize and explain intent. It may not invent network facts.

## 4. Control loops

### Desired-state loop
`User/Policy -> ExperienceIntent -> Compile -> ADCOS ConnectivityIntent -> ADCOS lifecycle -> Projection -> Experience`

### Recovery loop
`Observation/ADCOS event -> validate freshness/evidence -> reconcile -> recompile if experience intent is unsatisfied -> ADCOS`

### Commercial loop
`Customer order/payment -> commercial entitlement -> ADCOS request/reference -> delivery evidence -> customer billing/read model`

These loops remain logically separate. Delivery evidence is never inferred from payment state.

## 5. Projection model

RoamLink maintains read models of ADCOS state. Each projection record must retain at least:
- source authority (`adcos` or `roamlink`);
- canonical resource identifier;
- source version/event identifier when available;
- observed-at timestamp;
- received-at timestamp;
- freshness/expiry metadata;
- evidence/provenance classification;
- projection version.

Projections are disposable; canonical ADCOS state is not.

## 6. Reconciliation

Webhook processing is an input signal, not truth by itself.

The reconciliation engine must:
1. durably admit inbound notifications;
2. deduplicate using provider/event identifiers;
3. fetch canonical resources where required;
4. tolerate reordering and duplication;
5. repair missed webhooks;
6. mark uncertain/stale state instead of guessing;
7. expose evidence and freshness to UX and diagnostics.

## 7. Device capability boundary

RoamLink must maintain a capability matrix per device/platform. Capabilities include, where legally and technically available:
- Wi-Fi observation/control;
- cellular data-SIM selection;
- eSIM profile installation/removal/enablement;
- active interface selection;
- VPN/network-extension operation;
- concurrent-interface constraints;
- radio/OS telemetry;
- background execution limits.

The architecture never assumes that an ordinary iOS/Android application can arbitrarily control the cellular baseband or act as a gNB.

## 8. Enterprise deployment model

RoamLink supports:
- cloud control/experience plane;
- managed edge agent/client;
- optional enterprise connector;
- SSO/SCIM/MDM integrations;
- organization-level policies and audit;
- server-side ADCOS credentials.

Enterprise integrations may observe and request connectivity but cannot create a second path/session authority.

## 9. Security model

- RoamLink identity and ADCOS identity are distinct domains connected by explicit integration credentials.
- ADCOS credentials are server-side only.
- Edge credentials are short-lived and least-privileged.
- Webhooks are authenticated and replay-protected.
- Secrets never enter topology/projection records.
- Every cross-boundary command has a correlation ID and idempotency key.
- Authorization is checked at the RoamLink boundary and, where applicable, ADCOS boundary.

## 10. Failure semantics

RoamLink must distinguish at least:
- requested;
- accepted;
- reserved;
- authorized;
- path active;
- delivery started;
- delivered/usage accruing;
- completed;
- billable final;
- failed;
- canceled;
- unknown/stale.

Customer payment, order acceptance, reservation, path activity, delivered traffic, and billable finality are separate states.

## 11. SLOs

The product must measure, at minimum:
- time to usable connectivity;
- minutes without usable connectivity;
- manual interventions per session/day;
- successful automatic recovery rate;
- intent satisfaction rate;
- connectivity cost per useful hour/GB where available;
- stale/unknown-state duration;
- provider/access failover success;
- support incidents attributable to connectivity orchestration.

## 12. Non-goals

RoamLink will not:
- implement ADCOS routing;
- replace ADCOS session management;
- own provider topology;
- maintain a competing carrier/provider authority;
- treat eSIM as the product architecture;
- require customers to abandon underlying network providers;
- assume unrestricted mobile-radio control;
- use AI as a connectivity authority.
