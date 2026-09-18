# RoamLink Post-Gate Implementation Plan

**Baseline:** RL-080 and RL-081 deterministic release gates pass.  
**Next objective:** turn the verified architecture into a genuinely deployable, discoverable product.

## Wave 6 — Product shell + hosted runtime

### Worker A — Experience
- RL-082 First-run onboarding
- RL-083 ShareNet-inspired RoamLink application shell
- RL-084 Connectivity Center
- RL-085 Activity / automation timeline
- RL-086 Goal-oriented intent UX
- RL-087 Device capability experience
- RL-088 Responsive/mobile web accessibility pass

### Worker B — Runtime
- RL-089 Next.js/Vercel web host
- RL-090 API/BFF host composition
- RL-091 Real PostgreSQL persistence driver
- RL-092 SQL migration set
- RL-093 Durable outbox recovery / stuck-claim sweep
- RL-094 Inbox batch progression fix

### Worker C — Operations / deployment
- RL-095 Neon environment provisioning
- RL-096 Upstash Redis integration
- RL-097 Upstash QStash job delivery
- RL-098 Cloudflare R2 integration
- RL-099 deployment manifests/secrets/environment separation
- RL-100 hosted health/readiness + synthetic smoke checks

## Wave 7 — Journey completion

### Worker A
- RL-101 Guided purchase-to-delivery experience
- RL-102 Connectivity evidence / why progressive disclosure
- RL-103 Support contextual entry points
- RL-104 Enterprise onboarding journey

### Worker B
- RL-105 production API hardening
- RL-106 real database concurrency verification
- RL-107 webhook/reconciliation production worker wiring
- RL-108 production ADCOS compatibility probe

### Worker C
- RL-109 observability dashboard
- RL-110 scheduled/event-driven recovery jobs
- RL-111 production backup/export verification
- RL-112 deployment rollback verification

## Wave 8 — Discoverability / confidence validation

All three workers participate through isolated lanes.

- RL-113 user-journey E2E suite
- RL-114 responsive/accessibility verification
- RL-115 capability discoverability audit
- RL-116 telemetry/SLO journey validation
- RL-117 demo environment acceptance
- RL-118 production deployment acceptance

## Critical dependencies

RL-082 + RL-083 -> RL-084 -> RL-085 -> RL-086

RL-001..RL-081 -> RL-089 -> RL-090

RL-003 -> RL-091 -> RL-092

RL-091 -> RL-093 -> RL-094

RL-095 + RL-096 + RL-097 + RL-098 + RL-099 -> RL-100

RL-084 + RL-085 + RL-086 + RL-087 + RL-100 -> RL-101..104

RL-091 + RL-092 + RL-093 + RL-094 + RL-108 -> RL-105..108

RL-101..112 -> RL-113..118

## Parallelism rules

Three workers may operate concurrently.

Shared interfaces are orchestrator-owned.

A worker must stop when:

- the requested provider capability is unavailable;
- a real persistence implementation changes semantics;
- an existing architecture lock would be violated;
- a customer state cannot be mapped to authoritative evidence;
- a UI feature requires a new authority.

## Exit criteria for this roadmap

Do not call RoamLink deployed until:

1. a real web host exists;
2. a real Postgres instance backs state;
3. a real webhook endpoint is reachable;
4. the ADCOS compatibility gate runs against the configured service;
5. a real user can complete onboarding -> goal -> device -> connectivity -> activity -> support;
6. an enterprise user can complete workspace onboarding;
7. a degraded connectivity journey can be observed and explained;
8. offline mobile behavior can be exercised;
9. the ShareNet-inspired navigation works responsively;
10. smoke tests run against the deployed environment;
11. accepted production findings are either remediated or explicitly retained with owner and exposure;
12. the architecture conformance suite remains green.
