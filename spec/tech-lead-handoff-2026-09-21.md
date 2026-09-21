# RoamLink — 2026-09-21 Tech Lead / Orchestrator Handoff

**Repository:** `payswapdotorg/RoamLink`  
**Reviewed:** 2026-09-21  
**Current main:** `acb3a827661a2b1b94c18f2c037e567c6b8c0eed`  
**Architecture:** v1.0.0, FROZEN  
**Canonical status:** RL-001 through RL-118 implemented; RL-118 deployment acceptance recorded.  
**Next phase:** post-acceptance capability/discoverability closure and provider/operator hardening.

> This document supersedes the earlier assumption that RL-082..RL-118 were still unimplemented. The repository has moved through those waves. Read this file together with the frozen architecture documents and the RL-114/RL-115 audit records.

---

## 1. Current roadmap graph

Legend: `✅` completed and evidenced; `◐` accepted with explicitly named operator skips; `→` dependency; `+` parallel dependency.

### Foundation

```text
RL-001..RL-081 ✅
        │
        ├──────────────────────────────────────────────┐
        │                                              │
        ▼                                              ▼
Wave 6                                            Wave 7
                                                                
A: RL-082 ✅ → RL-083 ✅ → RL-084 ✅ → RL-085 ✅ → RL-086 ✅
                                      │
                                      ├→ RL-087 ✅ → RL-088 ✅
                                      │
B: RL-089 ✅ → RL-090 ✅
               │
RL-003 ✅ → RL-091 ✅ → RL-092 ✅ → RL-093 ✅ → RL-094 ✅
               │
C: RL-095 ✅ + RL-096 ✅ + RL-097 ✅ + RL-098 ✅ + RL-099 ✅ → RL-100 ✅
                                                                
                    Wave 7
A: RL-101 ✅ → RL-102 ✅ → RL-103 ✅ → RL-104 ✅
B: RL-105 ✅ → RL-106 ✅ → RL-107 ✅ → RL-108 ✅
C: RL-109 ✅ → RL-110 ✅ → RL-111 ✅ → RL-112 ✅
                    │
                    ▼
                Wave 8
RL-113 ✅ + RL-114 ✅ + RL-115 ✅ + RL-116 ✅
                    │
                    ▼
               RL-117 ✅
                    │
                    ▼
               RL-118 ✅
```

### Wave 6 — product shell, hosted runtime, provider foundation

**Worker A — Experience**
- ✅ RL-082 — first-run onboarding
- ✅ RL-083 — ShareNet-inspired customer application shell
- ✅ RL-084 — Connectivity Center
- ✅ RL-085 — Activity / automation timeline
- ✅ RL-086 — goal-oriented intent UX
- ✅ RL-087 — device capability experience
- ✅ RL-088 — responsive/accessibility verification

**Worker B — Runtime**
- ✅ RL-089 — Next.js/Vercel web host
- ✅ RL-090 — API/BFF host composition
- ✅ RL-091 — PostgreSQL persistence adapter
- ✅ RL-092 — real SQL migrations
- ✅ RL-093 — durable outbox recovery / stranded-claim sweep
- ✅ RL-094 — inbox bounded-batch progression

**Worker C — Deployment**
- ✅ RL-095 — Neon provider adapter/provisioning surface
- ✅ RL-096 — Upstash Redis adapter
- ✅ RL-097 — Upstash QStash adapter
- ✅ RL-098 — Cloudflare R2 adapter
- ✅ RL-099 — deployment manifests/environment separation
- ✅ RL-100 — real readiness composition + synthetic smoke runner

### Wave 7 — journey completion and operational hardening

**Worker A — Experience**
- ✅ RL-101 — purchase-to-delivery journey
- ✅ RL-102 — shared evidence / why progressive disclosure
- ✅ RL-103 — contextual support entry points
- ✅ RL-104 — enterprise workspace/onboarding journey

**Worker B — Runtime / ADCOS**
- ✅ RL-105 — production API hardening
- ✅ RL-106 — real PostgreSQL concurrency proof suite
- ✅ RL-107 — production worker/maintenance wiring
- ✅ RL-108 — live ADCOS compatibility probe entry point

**Worker C — Operations**
- ✅ RL-109 — SLO dashboard
- ✅ RL-110 — scheduled/event-driven recovery receiver
- ✅ RL-111 — real-infrastructure backup/export battery
- ✅ RL-112 — rollback verification + executable rollback decision rule

### Wave 8 — validation

- ✅ RL-113 — real-composition user-journey E2E
- ✅ RL-114 — responsive/accessibility verification
- ✅ RL-115 — capability-discoverability audit
- ✅ RL-116 — journey-state × SLO emission matrix
- ✅ RL-117 — demo acceptance gate
- ✅ RL-118 — deployment acceptance

### RL-118 deployment status

`✅ RL-118` is accepted, but it is an **operator-qualified acceptance**, not a claim that every optional provider is enabled.

Recorded live verdict:

- 12 checks
- 8 green
- 4 named-skip
- 0 red
- exit 0
- demo deployment accepted

The accepted live deployment is on Vercel Hobby with Neon Free PostgreSQL. The four named skips are the operator-phase legs for migration/backup evidence, ADCOS production credentials, and Cloudflare R2; Upstash Redis/QStash are intentionally optional and not configured in the demo environment.

---

## 2. What the journey simulation found

The simulation used the current route graph, rendered customer/admin/mobile surfaces, the RL-113 real-composition E2E journeys, the RL-114 accessibility findings, and the RL-115 capability-discoverability matrix. The live deployment itself is already covered by the RL-118 smoke/acceptance record.

### Journey A — first-time individual

```text
Login
  → Welcome
  → choose Goal
  → add/enroll Device
  → confirm Preferences
  → Home
  → Connectivity
  → Activity
  → Support
```

**Result:** ✅ The intended journey is present and coherent.

What is now discoverable:
- Home explains current connectivity, current goal, what RoamLink is doing, whether it needs the user, and device state.
- Onboarding uses plain-language goals and avoids ADCOS vocabulary.
- Devices expose capability state/freshness.
- Connectivity explains state, evidence and next action.
- Activity explains what happened and why.
- Support can be entered contextually.

No new architecture is needed here.

### Journey B — degraded connectivity → automatic recovery

```text
Healthy
  → observation degrades
  → Connectivity Center
  → Why / Evidence / Technical
  → RoamLink acts
  → Activity records action
  → delivery evidence becomes fresh
  → recovered narrative
  → Support if intervention is needed
```

**Result:** ✅ Core experience is surfaced.

The important architecture law remains intact: payment, order placement, reservation, webhook admission or another non-delivery fact must never be presented as proof of delivery.

### Journey C — goals

```text
Home
  → Goals
  → inspect current goal
  → edit/supersede
  → see derived state
  → Connectivity / Activity
```

**Result:** ✅ Discoverable.

The technical immutable-version model is correctly hidden behind the user-facing “Goal” concept.

### Journey D — device and capability

```text
Home
  → Devices
  → Device detail
  → capability status + freshness
  → automation level
  → manual fallback / support
```

**Result:** ◐ The generic device-capability experience is good, but a specific capability is missing.

**RL-115-F1: eSIM management has no customer journey.**
The repository exposes eSIM capability truth/status, but not a customer-discoverable flow to:
- inspect installed profiles;
- install a profile;
- remove a profile;
- enable/disable a profile;
- enter/confirm the information needed for a platform-authorized profile operation.

The fix must ride the existing desired-state/command envelope and must not create an eSIM/provider authority inside RoamLink.

### Journey E — purchase → delivery

```text
Plans & Billing
  → purchase
  → payment confirmed
  → /orders/{orderId}
  → connectivity requested
  → offer/reservation
  → activation
  → delivery evidence
  → billable-final
```

**Result:** ◐ The destination exists, but the journey is not fully discoverable.

**RL-115-F8:** the order table is URL-only. The order/delivery route exists and the post-payment redirect exists, but a customer browsing existing orders has no normal in-page link to the delivery-progress page.

Fix: every order row/card must link to its order journey.

### Journey F — refunds

The commerce domain already models customer refunds.

**Result:** ❌ The customer experience does not expose it.

**RL-115-F4:** no refund state/summary exists on the Commerce or Order journey. Support-ref typing alone is not a customer refund surface.

Fix: add a refund section to the order/commercial read model with:
- state;
- amount/currency;
- reason;
- timestamps;
- relation to the originating payment/invoice;
- clear separation from connectivity-delivery state.

### Journey G — notifications

**Result:** ◐ The intended primary narrative is Activity, which is correct, but the compatibility Notifications page is URL-only.

**RL-114-F4:** no inbound navigation reaches `/notifications`.

Fix: either:
1. expose Notifications as a discoverable secondary entry from Activity/More, or
2. explicitly make Activity the only customer-facing notification surface and mark `/notifications` as compatibility-only in the route contract/tests.

Do not keep a live customer route that users cannot discover.

### Journey H — offline/mobile edge

The mobile edge shell has the required Now / Capabilities / Controls / Outbox concepts and the RL-113 journey suite exercises offline behavior.

**Result:** ◐ The capability is present as a mobile proxy, but the mobile document itself has accessibility/discoverability defects.

RL-114 findings:
- mobile nav anchors point at dead fragment IDs;
- no skip-link/focus treatment/reduced-motion contract;
- no 44px target floor;
- no safe-area handling;
- navigation controls lack sufficient labels;
- capability tables lack `th scope` / correct labelled scroll regions.

The hosted customer shell also does not provide a web substitute for the offline edge surface, which is acceptable only if the mobile edge surface is explicitly discoverable from the enrolled-device journey.

### Journey I — enterprise

```text
More / Settings
  → Workspace
  → organization verification
  → policy
  → connector
  → devices
  → capability verification
  → first goal
  → live organization overview
```

**Result:** ◐ The eight-stage visual journey exists and is honest, but several underlying capabilities do not yet have actionable entry points.

Open findings:

- **RL-115-F3:** connector enrollment is status-only; no start/provision action.
- **RL-115-F7:** organization policy currently renders only “not available yet” because no policy read model exists.
- **RL-115-F5:** SSO/SCIM/MDM integrations have no user-facing vocabulary/status surface.
- The current workspace switcher explicitly says multi-workspace switching is not yet available; do not imply it is supported.

### Journey J — operator/admin trust

The admin/ops capabilities exist, but discoverability is incomplete.

- **RL-115-F2:** SLO dashboard exists but is reachable only by knowing `/ops/slo`.
- **RL-115-F6:** the ADCOS compatibility probe exists, but admin has no integration/compatibility-health surface.

These should be fixed without exposing deployment/operator internals as customer product concepts.

---

## 3. Additional accessibility findings that must not be lost

RL-114 recorded seven concrete UX defects that should now be treated as the next polish gate:

1. **RL-114-F1:** no `h1` on web pages.
2. **RL-114-F2:** heading hierarchy skips on some paths.
3. **RL-114-F3:** the 44px target floor is not universal.
4. **RL-114-F4:** Notifications is URL-only.
5. **RL-114-F5:** mobile shell lacks the web accessibility layer.
6. **RL-114-F6:** mobile fragment navigation targets do not match rendered IDs.
7. **RL-114-F7:** mobile tables lack proper header scoping/labelled scroll regions.

These are implementation findings, not permission to weaken the frozen UX architecture.

---

## 4. New post-acceptance implementation plan

The next team should **not** restart Wave 6–8. It should close the concrete journey gaps above.

### PA-00 — status reconciliation (orchestrator, first)

Update these documents so the repository tells one current story:

- `spec/current-state.md`
- `README.md`
- `spec/tech-lead-handoff.md`
- `spec/post-release-roadmap.md` status references
- deployment/acceptance report references

The repository currently contains newer implementation/deployment evidence than some older status prose. No engineering work should be judged against the stale “not deployed / RL-082..118 unfinished” wording.

### Wave 9 — three-worker dispatch

```text
                         PA-00 ✅/reconciliation
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
      Worker A — UX        Worker B — Enterprise   Worker C — Ops/Deploy
             │                    │                    │
      PA-01 eSIM            PA-06 connector       PA-11 R2 live enablement
      PA-02 refunds         PA-07 policy           PA-12 Redis live enablement
      PA-03 order links     PA-08 SSO/SCIM/MDM     PA-13 QStash live enablement
      PA-04 web a11y        PA-09 SLO nav          PA-14 ADCOS live compatibility
      PA-05 mobile a11y     PA-10 compat health     PA-15 final acceptance
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  ▼
                         PA-16 final journey audit
```

### Worker A — customer/edge experience

**PA-01 — eSIM management journey**

Entry:
- Devices → device detail → “SIM & profiles” (or the architecture-approved equivalent).

Must provide:
- profile inventory;
- profile state and freshness;
- install/remove/enable/disable actions only when the capability gate allows them;
- explicit blocked/manual guidance;
- command acknowledgements and outcome states;
- support escape with device/capability context.

Must not:
- store provider-native authority;
- invent an eSIM marketplace;
- claim delivery from commercial state.

**PA-02 — refund visibility**

Add customer-visible refund state to the existing order/commercial journey.

Acceptance:
- refund/partial-refund state is rendered from commerce truth;
- payment and delivery remain distinct;
- currency/amount reconciliation remains exact;
- support context can reference the refund.

**PA-03 — order and notification discoverability**

- Link every order row/card to `/orders/{orderId}`.
- Decide and encode the Notifications policy:
  - either make `/notifications` reachable from Activity/More,
  - or formally reduce it to compatibility-only and remove any implication that it is a primary product surface.
- Add journey tests for both cases.

**PA-04 — web accessibility closure**

Close RL-114-F1..F4:
- one meaningful `h1` per page;
- valid heading hierarchy;
- 44px minimum interactive target where applicable;
- discoverable notification surface;
- preserve warm-light visual language and progressive disclosure.

**PA-05 — mobile accessibility/navigation closure**

Close RL-114-F5..F7:
- real fragment/id targets;
- skip/focus/reduced-motion behavior;
- safe-area handling;
- labelled navigation;
- 44px targets;
- accessible capability tables and labelled scroll regions.

### Worker B — enterprise/admin/integration

**PA-06 — enterprise connector enrollment**

The workspace connector stage must become an actionable guided journey:

```text
not started → start enrollment → provisioning → verify → provisioned
                         ↘ failed → explain → retry/support
```

Use the existing command envelope and enterprise authority. Do not make the UI the authority.

**PA-07 — organization policy read model**

Implement the application-level read contract needed for the already-declared policy step.

Acceptance:
- honest no-policy state;
- current policy summary;
- source/version/freshness where applicable;
- link to the policy-management action where the architecture permits it;
- no duplicated connectivity authority.

**PA-08 — enterprise integrations surface**

Create a Workspace → Integrations section for:
- SSO;
- SCIM;
- MDM.

The surface must distinguish:
- available and configured;
- available but not configured;
- not available in this environment;
- unknown/unreadable.

Do not fabricate provider capabilities. If command contracts are not yet supported, render an honest status/entry point and record the missing backend contract rather than inventing one.

**PA-09 — admin SLO discoverability**

Add a direct Admin/Operations navigation entry to `/ops/slo`.

Acceptance:
- SLO dashboard remains session-gated;
- all nine SLOs stay sourced from the real recorder;
- no invented values;
- zero secret leakage;
- navigation and permission tests prove the surface is discoverable only to the intended operator scope.

**PA-10 — admin ADCOS compatibility health**

Expose the existing RL-108 compatibility probe state in Admin/Operations:

- compatible;
- incompatible;
- not configured;
- unknown;
- last checked;
- supported API version.

The surface is read-only. Mutation gating remains in the integration layer.

### Worker C — deployment/provider operations

**PA-11 — enable Cloudflare R2 on the demo environment**

The current provider design already has the R2 adapter.

Operator work:
- enable R2;
- create a least-privilege scoped token for the intended bucket;
- configure env secrets;
- run RL-111 real export/upload/restore battery;
- record the result;
- re-run `pnpm demo:acceptance`.

**PA-12 — enable Upstash Redis**

The current deployment intentionally works without Redis.

For the enhanced demo:
- provision a free-tier Redis database;
- bind the REST credentials;
- verify distributed fixed-window limiter behavior;
- verify readiness becomes healthy for rate-limit acceleration rather than `degraded:rate-limit`;
- re-run smoke and acceptance.

Redis remains optional for correctness.

**PA-13 — enable Upstash QStash**

- provision a free-tier QStash surface;
- configure the delivery endpoint;
- configure current + next receiver signing keys;
- execute the event-driven maintenance path against the live deployment;
- verify signature rotation, retry, dedupe, DLQ/redrive semantics;
- record real-wire evidence.

QStash remains transport, never business truth.

**PA-14 — configure production ADCOS compatibility**

- issue the RoamLink ADCOS application credentials out-of-band;
- configure `ADCOS_API_BASE_URL`, client id/secret, webhook secret and pinned version;
- run RL-108 against the real endpoint;
- verify the compatibility state opens mutations only when compatible;
- verify the webhook path end-to-end;
- re-run the journey suite and demo acceptance.

RoamLink must still consume only the public ADCOS Developer API.

**PA-15 — final live acceptance**

Run, against the deployed SHA:

```bash
pnpm check
pnpm mvp-gate
pnpm production-gate
pnpm smoke
pnpm demo:acceptance
pnpm rollback:check
```

Record:
- deployed SHA;
- provider configuration state;
- migration manifest;
- backup/restore evidence;
- ADCOS compatibility result;
- smoke result;
- acceptance report;
- remaining named risks.

### Orchestrator — PA-16 final journey audit

After all three workers finish:

1. Re-run the RL-113 journeys.
2. Re-run RL-114 responsive/accessibility.
3. Re-run RL-115 capability-discoverability.
4. Re-run the offline/mobile surface.
5. Re-run enterprise journey.
6. Re-run the live demo acceptance.
7. Compare the result to `spec/architecture.md` capability inventory.
8. Reject any feature that is technically present but not discoverable from a normal journey.

---

## 5. Acceptance criteria for the next wave

A post-acceptance item is not complete because a route or API exists.

For every capability, the team must prove:

```text
PRIMARY ENTRY
     ↓
CONTEXTUAL LINK
     ↓
EXPLANATION
     ↓
HONEST CURRENT STATE
     ↓
USER NEXT ACTION
     ↓
DEGRADED / UNKNOWN STATE
     ↓
RECOVERY OR SUPPORT
```

The UI must always make clear:
- what RoamLink knows;
- how fresh the evidence is;
- what it is doing;
- what the user can do;
- what it cannot do;
- what is awaiting an external authority.

---

## 6. ShareNet design reference

Use `pectoraux/ShareNet` as interaction inspiration, not as a code dependency.

Keep these patterns:

- warm/light, low-noise presentation;
- strong whitespace and typography;
- a persistent connection-status affordance;
- desktop sidebar + mobile bottom navigation;
- lightweight onboarding;
- a simple home hero with a primary next action;
- calm connected/warning/error states;
- quiet loading/error/empty states;
- separate diagnostics/admin surfaces;
- progressive detail rather than a dashboard full of technical controls.

RoamLink-specific additions remain:
- Goals;
- Connectivity Center;
- Activity;
- evidence/freshness;
- commercial-vs-delivery separation;
- support context;
- enterprise workspace;
- capability truth.

Never copy ShareNet branding, code, names or domain semantics.

---

## 7. Deployment plan — current and target

### Current accepted demo

```text
Vercel Hobby
   │
   ├── Next.js portal-host
   ├── API/BFF
   ├── health/readiness
   └── webhook ingress
          │
          ▼
Neon Free PostgreSQL
   └── durable source of truth

Optional but currently OFF:
   ├── Upstash Redis
   ├── Upstash QStash
   └── Cloudflare R2

External dependency:
   └── ADCOS production compatibility credentials currently OFF
```

### Target low-cost/demo configuration

- Vercel Hobby for non-commercial/demo validation.
- Neon Free for durable relational state.
- Upstash Redis Free for ephemeral rate limiting/coordination.
- Upstash QStash Free for bounded asynchronous delivery.
- Cloudflare R2 Free allowances for object storage/backup artifacts.
- ADCOS compatibility configured against the target public service.

Provider limits are operational constraints, not domain semantics. No quota may decide correctness.

### Commercial transition

Vercel Hobby is for personal/non-commercial use. Before commercial operation, move the hosted runtime to an appropriate paid Vercel plan or another compatible host. The rest of the provider ports should remain replaceable so the architecture does not become tied to any one vendor.

---

## 8. Repository truth rules after this handoff

The Tech Lead must treat these as distinct:

1. **Architecture truth:** frozen `spec/architecture*.md` + authority model.
2. **Implementation truth:** current source tree.
3. **Verification truth:** current generated gates and journey batteries.
4. **Deployment truth:** latest live acceptance report.
5. **UX truth:** current capability-discoverability and accessibility audits.

Older prose must not override a newer generated verification artifact.

No worker may create a new authority for:
- connectivity sessions;
- NetworkPath/path selection;
- provider identity/state;
- ADCOS connectivity intent;
- ADCOS commercial settlement.

No customer-facing surface may infer connectivity delivery from payment.

No UI may silently convert UNKNOWN/STALE into success.

---

## 9. New completion definition

The product should be considered **post-acceptance complete** when:

- all RL-114 findings are closed;
- all RL-115 capability gaps have a real entry/action or an architecture-approved explicit “not available” surface;
- the order journey is discoverable without knowing a URL;
- refunds are customer-visible;
- eSIM management is an actual gated journey;
- enterprise connector enrollment is actionable;
- enterprise policy is a real read model;
- enterprise integrations have a visible status surface;
- admin SLO and ADCOS compatibility health are navigable;
- live ADCOS compatibility is green;
- live R2/backup acceptance is green;
- live Redis/QStash behavior is verified where enabled;
- RL-113..RL-118 remain green;
- architecture conformance remains green.

The success condition is not “more pages”.

It is:

**a user can discover and complete every architecture-promised capability through normal journeys, while every technical authority and every uncertainty remains truthful.**
