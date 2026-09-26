# Tech Lead / Orchestrator Protocol

## Mission

Build the complete RoamLink architecture without architectural drift. The repository is the source of truth.

## Authority hierarchy

1. spec/architecture-lock.md
2. spec/architecture.md
3. spec/authority-model.md
4. spec/adcos-integration.md
5. approved ADRs
6. work-item definitions and dependency graph
7. implementation code
8. tests/fixtures as verification evidence

When lower layers disagree with higher layers, stop and resolve the discrepancy.

## Current baseline

RL-001..RL-118 and PA-001..PA-019 are implemented/evidenced.

The current phase is not architecture construction. It is live-runtime completion.

Read first:
- spec/tech-lead-handoff-2026-09-26.md
- docs/live-journey-runtime-audit-2026-09-26.md
- spec/current-state.md
- spec/ux-architecture.md
- spec/deployment.md

## Three-worker operating model

### Worker A — Experience / browser validation

Owns:
- component-scoped degradation;
- current deployed browser journey suite;
- final customer/mobile accessibility;
- ShareNet-inspired UX polish.

Work:
- PA-020
- PA-021
- PA-022

### Worker B — API / runtime / execution

Owns:
- services/api mutation route parity;
- remaining read models;
- services/workers execution;
- enterprise runtime composition.

Work:
- PA-023
- PA-024
- PA-025
- PA-026

### Worker C — deployment / providers / release

Owns:
- current-main deployment;
- free-tier provider configuration;
- smoke/acceptance/rollback;
- current deployment evidence.

Work:
- PA-027
- PA-028
- PA-029

## Shared-contract ownership

The orchestrator owns:
- app flow ↔ API mutation parity contract;
- read-model coverage matrix;
- worker-execution trigger contract;
- browser acceptance contract;
- deployment acceptance record;
- any architecture/ADR changes.

## Mandatory parity checks

Before merging:
1. Every CustomerWebApp mutation flow maps to a real services/api mutation route or to an explicitly documented multi-command orchestration.
2. Every customer/admin primary surface has an explicit read dependency map.
3. Every read dependency is either composed, locally degraded, or explicitly unavailable with a named reason.
4. Accepted commands are never rendered as executed.
5. Executed commands are never rendered as delivered without delivery evidence.
6. Payment never renders as connectivity delivery.
7. The worker path is idempotent and restart-safe.

## UX review rule

A feature is incomplete when the user cannot discover:
- what it does;
- where it is;
- why it changed;
- what RoamLink knows;
- what RoamLink does not know;
- what the user can do next;
- how to get help.

A primary page should remain useful when a secondary data source is unavailable.

## Deployment review rule

Use spec/deployment.md as the source of truth.

Provider roles:
- Neon/PostgreSQL = durable truth;
- Redis = ephemeral acceleration;
- QStash = delivery;
- R2 = object storage;
- Vercel = hosting/runtime;
- ADCOS = connectivity authority.

A provider limit that threatens correctness is a blocker.

## Validation sequence

After each worker lane:
1. pnpm check
2. relevant focused tests
3. architecture conformance
4. journey suite
5. inspect changed dependency edges
6. update work-item status

At integration:
1. deploy current main;
2. run smoke;
3. run live browser journeys;
4. run demo acceptance;
5. run rollback check;
6. refresh current-state and deployment evidence.

## Stop conditions

Stop and write an ADR/blocker if:
- a new connectivity authority is required;
- an internal ADCOS dependency is proposed;
- a required provider capability is not exposed by the public contract;
- a read model can only be made “complete” by inventing state;
- serverless execution would violate persistence semantics;
- the design requires copying ShareNet code/branding.

## Final release rule

The phase is complete only when the current deployed SHA supports the major individual, enterprise and operator journeys end-to-end, remains truthful under degradation, and passes architecture conformance.
