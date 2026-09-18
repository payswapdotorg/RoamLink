# RoamLink UX Architecture

**Status:** IMPLEMENTATION BASELINE  
**Purpose:** Make the frozen RoamLink architecture discoverable and operable through a coherent customer experience.

## 1. Design direction

The consumer shell is inspired by the ShareNet product shell pattern:

- warm, quiet visual surface rather than an engineering dashboard;
- persistent connectivity state visible from the global shell;
- desktop sidebar and mobile bottom navigation;
- short, human-readable labels;
- restrained connected / warning / error state colors;
- generous whitespace and strong typography hierarchy;
- lightweight first-run onboarding;
- one obvious primary action per major page;
- diagnostics and protocol detail kept out of the normal customer path.

The implementation must be original RoamLink UI, not a copy of ShareNet assets or code.

## 2. Product mental model

The customer should understand RoamLink in four concepts:

1. **Goal** — what connectivity experience the customer wants.
2. **Devices** — where RoamLink is helping.
3. **Connectivity** — what is happening now and why.
4. **Activity** — what RoamLink has done, recovered, or needs from the customer.

Commerce, support and administration remain supporting areas.

## 3. Primary customer navigation

Desktop:

- Home
- Connectivity
- Activity
- Devices
- Goals
- Plans & Billing
- Support

Account/workspace controls appear in the shell footer/header.

Mobile:

- Home
- Connect
- Activity
- Devices
- More

The More destination contains Goals, Plans & Billing, Support and Settings.

Existing internal routes may remain stable; UI labels are allowed to be more human than route names.

## 4. Home

Home must answer within one viewport:

- Am I usefully connected?
- What is my current goal?
- Is RoamLink actively managing anything?
- Does RoamLink need me to do something?

The page uses one dominant connection/experience hero and a compact fact summary.

Recommended facts:

- current connectivity state;
- access/path evidence;
- goal satisfaction;
- freshness;
- current intervention / next action;
- cost where available;
- privacy posture where available.

Do not collapse authoritative state, evidence, freshness and commercial state into one opaque badge.

## 5. First-run onboarding

Onboarding is a maximum of four lightweight steps:

1. Welcome / explain the product in plain language.
2. Choose the user's primary connectivity goal.
3. Add or enroll a device.
4. Confirm preferences and finish.

Examples of goal language:

- Stay connected while traveling.
- Keep work reliable.
- Save connectivity cost.
- Prefer trusted Wi-Fi when it is good enough.
- Protect privacy.
- Let RoamLink handle recovery automatically.

The onboarding flow must never require users to understand ADCOS, ConnectivityIntent, reservations, NetworkPath, provider adapters, leases, or routing.

## 6. Connectivity center

The Connectivity page is the primary explanation surface.

It must expose:

- current connectivity facts;
- authoritative lifecycle stages;
- source/evidence;
- freshness;
- active and recent access;
- failover/recovery history;
- why RoamLink is taking an action;
- what RoamLink is waiting for;
- what the customer can do next.

Use progressive disclosure:

Summary -> Why -> Evidence -> Technical detail

A user should be able to understand the situation without opening Technical detail.

## 7. Goals

The current ExperienceIntent surface should be presented to users as **Goals** or **Connectivity goals**, with an optional advanced label of `Experience intent`.

A goal page must show:

- current goal;
- status;
- affected devices;
- preferences;
- active version;
- what changed;
- why RoamLink made its latest decision;
- freshness of the evidence used;
- a clear action for edit / activate / replace.

The immutable version chain remains an implementation guarantee, not the main user-facing metaphor.

## 8. Activity

Activity is the bridge between invisible automation and user trust.

Each activity item should answer:

- what happened;
- when;
- why;
- what evidence supported it;
- whether RoamLink acted automatically;
- whether the customer needs to intervene.

Examples:

- Wi-Fi became unreliable.
- RoamLink requested another available path.
- Connectivity recovered.
- Your goal is currently partially satisfied.
- Your device cannot perform this action automatically.
- We are waiting for the network to confirm delivery.

Notifications should be represented here and retain their dedicated route/API for compatibility.

## 9. Devices

Devices must be understandable as capabilities, not inventory rows alone.

Each device page should show:

- device identity;
- platform;
- enrollment;
- available automation;
- unavailable/unknown capabilities;
- capability evidence/freshness;
- current connectivity observations;
- recent actions;
- manual fallback guidance.

When the OS cannot perform an action, explain the limitation and present the supported fallback.

## 10. Plans & Billing

Commerce is explicitly separated from connectivity.

The page must show:

- plan/product;
- order;
- subscription;
- payment;
- invoice;
- refund.

A prominent explanatory rule is preserved:

> Payment confirms a commercial fact; it does not prove connectivity delivery.

Delivery evidence is shown separately.

## 11. Support

Support should be reachable from every degraded/error state.

A support case should automatically carry relevant references where the customer permits it:

- device;
- goal;
- connectivity reference;
- activity;
- order/subscription/payment;
- recent evidence/freshness.

Customer threads never expose internal-only messages.

## 12. Enterprise experience

Enterprise users need a workspace model:

- workspace switcher;
- organization connectivity overview;
- policy summary;
- device fleet;
- active goals;
- connector/enrollment status;
- activity/audit;
- support.

Enterprise onboarding should be a guided visual journey rather than API-only discovery.

## 13. Admin / diagnostics

Admin and diagnostics are not customer navigation.

Keep engineering surfaces separate, following the ShareNet pattern where diagnostics is a distinct engineering route.

Admin should expose:

- tenant administration;
- audit/security events;
- projection freshness;
- reconciliation;
- SLO health;
- support triage;
- integration/compatibility health.

Do not surface raw protocol terminology to normal customers merely because it exists in the admin model.

## 14. Accessibility and interaction rules

Required:

- keyboard-visible focus;
- semantic headings and navigation;
- minimum touch target suitable for mobile;
- reduced-motion behavior;
- never communicate state by color alone;
- loading/error/empty states for every primary surface;
- no unexplained technical error dumps;
- fresh/stale/unknown shown as text plus visual treatment.

## 15. Discoverability rule

Every capability in the frozen architecture must have:

- one primary user-facing entry point;
- one contextual link from the journey where it becomes relevant;
- one explanatory view;
- one recovery/support path.

Capabilities may be implemented below the UI, but they are not complete until customers can discover their user-relevant effects.
