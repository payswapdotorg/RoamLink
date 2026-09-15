# Agent Instructions

Read `README.md` and every relevant file under `spec/` before implementing a work item.

The repository is the source of truth. Do not rely on conversation history or external prompts to reconstruct architecture.

## Mandatory rules

1. Follow `spec/architecture-lock.md` exactly.
2. Use `spec/authority-model.md` to determine state ownership.
3. Use `spec/dependency-graph.md` to determine whether work may run in parallel.
4. Implement only an assigned work item unless the orchestrator explicitly expands scope.
5. Never import ADCOS internal implementation modules. Use the public integration contract in `packages/adcos`.
6. Never create a second authority for identity, topology, path, routing, session, provider state or ADCOS commercial settlement.
7. Add failure, retry, duplication, reordering, stale and offline tests for stateful behavior.
8. Never store secrets in source, fixtures, projections, logs or telemetry.
9. Run the smallest relevant checks before handoff, then the full repository checks before merge.
10. Record blockers rather than inventing architecture.

## Worker handoff

Every worker handoff must state:
- work-item IDs;
- files/modules changed;
- architecture locks exercised;
- tests executed;
- known limitations;
- any required follow-up work item.

## Architectural change

When implementation appears to require changing a frozen rule, stop and create an ADR under `spec/adr/` describing the conflict, affected locks, compatibility impact, migration/rollback and proposed new invariant. Do not quietly alter the lock.
