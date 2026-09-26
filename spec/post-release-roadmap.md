# RoamLink Implementation Roadmap

**Baseline:** RL-001..RL-118 and PA-001..PA-019 are implemented/evidenced.
**Current objective:** finish the hosted product's live runtime, not redesign the architecture.

## Completed roadmap

### Foundation
- ✅ RL-001..RL-081

### Wave 6
- ✅ RL-082..RL-100

### Wave 7
- ✅ RL-101..RL-112

### Wave 8
- ✅ RL-113..RL-118

### Post-acceptance
- ✅ PA-001..PA-019

## Current next wave — live runtime completion

### Worker A — Experience / browser

- PA-020 — component-scoped degradation on primary surfaces
- PA-021 — deployed browser journey acceptance
- PA-022 — final UX closure after runtime composition

### Worker B — API / runtime / workers

- PA-023 — mutation route parity for every rendered customer action
- PA-024 — remaining real read-model composition
- PA-025 — live command-execution worker path
- PA-026 — enterprise workspace + connector runtime completion

### Worker C — deployment / provider / release

- PA-027 — redeploy current main + current-main acceptance
- PA-028 — verify/configure free-tier provider stack
- PA-029 — final live acceptance + release record

## Dependency graph

PA-020 → PA-022
PA-021 depends on PA-020

PA-023 → PA-025
PA-024 → PA-025
PA-023 + PA-024 + PA-025 → PA-026

PA-021 + PA-022 + PA-026 → PA-027
PA-027 → PA-028
PA-027 + PA-028 → PA-029

## Worker rules

A worker stops and escalates to the orchestrator when:
- an architecture lock would be changed;
- a real API route does not map to public ADCOS capability;
- a read model requires fabricated state;
- accepted is being presented as executed;
- a provider limitation would alter correctness;
- a UI feature requires a new connectivity authority.

## Required final journeys

Individual:
login → onboarding → goal → device → eSIM/capabilities → connectivity → activity → purchase → payment → delivery evidence → support

Enterprise:
workspace → organization → policy → connector → devices → capability verification → first goal → live organization overview

Operator:
admin → SLO → integration health → reconciliation → projection health → audit → support

## Exit criteria

Do not mark the current phase complete until:
1. every rendered mutation has a real API route;
2. every required customer/admin read is either composed or component-level explicitly unavailable;
3. the command execution worker path advances durable commands in the deployed demo;
4. onboarding and Goals complete without fabricated state;
5. eSIM actions execute through the real API;
6. commerce reads/orders/delivery journey are live;
7. Activity remains usable with notification data live or locally degraded;
8. enterprise workspace and connector are live;
9. admin integration/audit/projection surfaces are live or locally degraded;
10. the deployed browser journey suite passes;
11. smoke, demo acceptance and rollback checks pass on current main;
12. ADCOS compatibility is configured and verified for the target environment;
13. architecture conformance remains green.
