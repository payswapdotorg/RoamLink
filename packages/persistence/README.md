# @roamlink/persistence

Persistence/queue primitives (RL-003). Ports plus a deterministic in-memory
adapter; **no ORM coupling, no vendor driver, no domain logic**. It depends
only on `@roamlink/contracts` (spec/repository-layout.md dependency
direction). PostgreSQL-compatible drivers implement these same ports in
later work items; until then everything runs on the in-memory adapter in CI
and tests.

> **TL note (architecture review):** `packages/persistence` is an ADDITIVE
> package beside `contracts`, depending only on `contracts` - consistent with
> the repository-layout dependency direction (`contracts` is lowest-level;
> `adcos`, domain and service packages may build on shared foundations). The
> layout spec's package list predates it; the TL will ADR the addition at
> merge if required.

## Surface

| Module | Provides |
|---|---|
| `unit-of-work` | `UnitOfWork` / `UnitOfWorkFactory` / `PersistenceReader` ports - the atomic multi-repo transaction boundary |
| `outbox` | durable outbox record (idempotency key identity, canonical-JSON payload bytes + digest, PENDING→DELIVERING→DELIVERED/FAILED(+retryCount) state machine, next-attempt scheduling, retry policy) + repository ports |
| `inbox` | durable admission log (`ADMITTED`/`DUPLICATE`/`REJECTED`), dedupe-keyed single admission, repository ports |
| `optimistic-concurrency` | versioned records, compare-and-swap (`assertExpectedVersion`, `nextRevision`), `RecordRepository` ports |
| `migrations` | `Migration`/`MigrationVersion`, `MigrationRunner` + `AppliedVersionsLedger` ports, driver-free reference runner + in-memory ledger fake |
| `in-memory` | `createInMemoryPersistence()` - deterministic adapter implementing `UnitOfWorkFactory` + `PersistenceReader` |

SQL migration files live under `infra/migrations/` (see that folder's
README for the layout); no migration exists yet - the first lands with the
first service schema.

## Key design decisions

- **Transactional outbox by construction.** The ONLY way to write outbox or
  inbox records is through a `UnitOfWork` view, so "business write + outbox
  enqueue" commits atomically or not at all. The dual-write bug cannot be
  expressed against these ports (RL-LOCK-014).
- **Outbox identity = idempotency key.** At most one record per key; a
  duplicate enqueue with the same canonical payload digest is a no-op
  (`ALREADY_ENQUEUED`), a different digest for the same key is a typed
  `ConflictError` - never a silent overwrite.
- **Inbox = append-only admission log.** Exactly one `ADMITTED` record per
  dedupe key; duplicate arrivals become `DUPLICATE` audit rows and rejected
  arrivals become `REJECTED` rows that do not occupy the key (RL-LOCK-009:
  webhooks are signals, admission is not truth).
- **Optimistic concurrency is loud.** Every mutation is a compare-and-swap on
  the Wave-0 `Revision`; a mismatch throws the Wave-0 `ConflictError`.
- **Determinism.** All time-dependent operations take explicit UTC instants;
  the adapter never reads an ambient clock. Lists are deterministically
  ordered.
- **Commit semantics.** `commit()` replays recorded operations against the
  current committed state; when a concurrent committer won a race the commit
  throws a typed `ConflictError` and nothing is applied. A failed commit
  discards the unit of work; `rollback()` after settlement is a no-op.
  Results of an OPEN unit of work are provisional until commit.
- **Default outbox retry policy** (6 attempts; 1s/10s/1m/10m/1h backoff) is a
  RoamLink operational default, deliberately not the ADCOS webhook schedule;
  callers override per record.

## Consumption notes

- Exports TypeScript source (`src/index.ts`), erasable-syntax-only (enforced
  by lint), same internal-package pattern as `@roamlink/contracts`.
- Driver-backed implementations (PostgreSQL-compatible) must preserve the
  commit semantics documented in `src/unit-of-work.ts` - especially
  commit-time precondition revalidation surfacing as typed conflicts.

## Scope guard

This package must not gain domain aggregates, ADCOS client behavior, or
projection logic. Repositories are generic name-keyed record stores on
purpose: domain packages own their semantics and compose these primitives.
