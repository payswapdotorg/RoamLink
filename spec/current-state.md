# Current State

**Baseline:** implementation-ready architecture v1.0.0
**Implementation status:** MVP scope implemented and verified — every roadmap work item RL-001..RL-081 is delivered and merged; the MVP release gate (RL-080) and the production readiness gate (RL-081) both pass (exit 0) on main
**Repository state:** post-campaign MVP tree — 25 packages, 3 app surfaces (`apps/web`, `apps/admin`, `apps/mobile`), 7 verification suites (`tests/`), 1,861 tests green across 36 test workspaces

## How this status was reached

Seventeen merged pull requests delivered the roadmap in dependency order (merge history on main):

- **Wave 0** (PR #1): repo/CI foundation + architecture contracts (RL-001/RL-002).
- **Wave 1** (PRs #2–#4): persistence/queue primitives, auth/tenant boundary, experience domain, edge platform + observability/testkit scaffolding, ADCOS v2.0 public-client contract.
- **Wave 2** (PRs #5–#7): ADCOS integration adapters, webhook inbox, projection engine, intent compiler, decision read model, commerce domain, edge observation + offline outbox, platform/security primitives.
- **Wave 3** (PRs #8–#10): reconciliation engine, ADCOS compatibility suite, device action adapter, enterprise edge connector, payments/invoices/refunds, commerce-to-connectivity reference model.
- **Wave 4** (PRs #11–#14): customer web app, admin/ops console, mobile/edge UX shell, enterprise onboarding/API surface, authority conformance suite, failure/reordering/duplication suites, end-to-end dogfood + load/reliability suites.
- **Wave 5** (PRs #15–#16): security/threat-model verification, deployment/recovery verification, and the executable release gates themselves (RL-080/RL-081).
- **Wave 6** (PR #17): SLO operational wiring (MVP-3 remediation) — nine §11 SLO recorders, emission wiring, dogfood/load journey assertions.

Defects found en route are recorded with in-suite reproducers (RL-073-DEFECT-1, RL-074-F1..F3, RL-075-F1) and dispositioned in the accepted-risk registry; AR-001 and AR-002 were remediated by Wave 6, AR-003 by the post-campaign spec-status refresh, and AR-009-class inherent-infrastructure limits remain open by design until real infrastructure lands (see `docs/reports/accepted-risks.json`).

## Completed planning/setup

- Frozen RoamLink layered architecture.
- Frozen authority model and anti-duplication locks.
- ADCOS integration boundary and lifecycle mapping.
- Customer/ADCOS state separation.
- Mobile/edge capability model.
- Security and threat boundaries.
- Work-item inventory.
- Dependency graph for up to three concurrent workers.
- Definition of Done.
- Orchestrator/worker operating protocol.
- Repository/package/CI scaffolding.
- Architecture sanity-check script.

## Standing guidance

### External dependency gate

Before production ADCOS integration work, pin and verify the ADCOS Developer API contract/version actually available in the target environment. The RoamLink architecture must not assume ADCOS implementation details that are not exposed by that public contract. The in-tree compatibility suite (`tests/conformance`) encodes this discipline against the fake/real ADCOS switch.

### Accepted risks

The accepted-risk registry (`docs/reports/accepted-risks.json`) is the authoritative disposition record. High/critical entries carry exposure bounds, owners, review milestones, and remediation paths; AR-009-class items flip to closed as the corresponding real infrastructure lands (vault-backed secrets adapter, PostgreSQL persistence driver, anchored audit checkpoints, network-level load testing).

## Completion definition

See `spec/definition-of-done.md` and `spec/orchestrator.md`. The project is not complete until RL-080 and RL-081 pass — **both gates pass on main**; the machine-verifiable verdicts are committed at `docs/reports/mvp-gate.json` and `docs/reports/production-gate.json` (re-run them anytime with `pnpm mvp-gate` and `pnpm production-gate`).
