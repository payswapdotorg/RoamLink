# Current State

**Baseline:** implementation-ready architecture v1.0.0
**Implementation status:** no production feature implementation started
**Repository state:** greenfield

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

## First implementation wave

1. Orchestrator completes RL-001/RL-002 as the shared contract gate.
2. Worker A takes RL-004/RL-010/RL-011.
3. Worker B takes RL-003/RL-030.
4. Worker C takes RL-040 plus platform/security scaffolding compatible with RL-002.

Do not start higher waves until their dependency gates pass.

## External dependency gate

Before production ADCOS integration work, the orchestrator must pin and verify the ADCOS Developer API contract/version actually available in the target environment. The RoamLink architecture must not assume ADCOS implementation details that are not exposed by that public contract.

## Completion definition

See `spec/definition-of-done.md` and `spec/orchestrator.md`. The project is not complete until RL-080 and RL-081 pass.
