# Definition of Done

A work item is complete only when all applicable requirements pass.

## Architecture

- Correct work-item ID and scope recorded.
- Correct authority owns every mutated state.
- No duplicate ADCOS identity/session/path/routing/provider authority.
- Dependency direction matches the architecture lock.
- Any required ADR exists and is approved.

## Correctness

- Happy path implemented.
- Retries are idempotent.
- Duplicate and reordered events are safe.
- Timeouts and partial failure are explicit.
- Offline behavior is defined where applicable.
- Unknown/stale state is not converted to a false success.

## Security

- Tenant/actor authorization tested.
- Sensitive data minimized.
- Secrets excluded from logs and persistent projections.
- Webhook authentication/replay protections tested where applicable.

## Testing

- Unit tests for domain rules.
- Contract tests for cross-module boundaries.
- Failure/recovery tests for stateful integration.
- Architecture conformance tests for affected locks.
- Deterministic test data and reproducible local commands.

## Operations

- Structured logs and correlation IDs where applicable.
- Metrics/traces for externally meaningful operations.
- Health/readiness semantics defined.
- Migration/rollback behavior documented when state changes.

## Handoff

The PR/commit description states:

1. Work items completed.
2. Architecture sections/locks exercised.
3. Tests run and results.
4. Known limitations.
5. Follow-up work items, if any.

A green test suite alone is not sufficient for completion.
