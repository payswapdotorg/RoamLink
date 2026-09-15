/**
 * The transaction boundary port (RL-003).
 *
 * A `UnitOfWork` is ONE atomic unit of work spanning multiple repositories:
 * every write made through its views (named record repositories, the outbox,
 * the inbox) becomes visible together at `commit()`, or not at all after
 * `rollback()` / a failed commit.
 *
 * Transactional-outbox by construction: the ONLY way to enqueue outbox
 * records or admit inbox records is through a UnitOfWork view, so
 * "business write + outbox enqueue" is committed atomically or discarded
 * atomically - the classic dual-write bug cannot be expressed.
 *
 * Commit semantics (ports must honor all of these):
 *  1. `commit()` applies all pending writes atomically. When any
 *     optimistic-concurrency precondition no longer holds against the
 *     committed state (a concurrent unit of work won a race), commit throws
 *     a typed ConflictError and NOTHING is applied.
 *  2. A failed `commit()` discards the unit of work (it is settled-discarded;
 *     a subsequent `rollback()` is a no-op).
 *  3. `rollback()` discards pending writes; calling it after the unit of work
 *     is settled is a no-op (safe for finally-cleanup paths).
 *  4. Calling `commit()` on a settled unit of work throws (double commit /
 *     commit-after-rollback are programming errors).
 *  5. Repository views of a settled unit of work refuse further writes.
 *
 * Results returned by repository views of an OPEN unit of work are
 * provisional until commit: a concurrent committer may have changed the
 * outcome (that surfaces as the typed commit conflict of rule 1, or - for
 * idempotent operations - as a no-op).
 *
 * No ORM coupling: PostgreSQL-compatible drivers implement these ports
 * later; the in-memory deterministic adapter (./in-memory.ts) runs in CI and
 * tests (spec/repository-layout.md "Runtime baseline").
 */
import type { InboxRepository, InboxReadRepository } from "./inbox.js";
import type { OutboxRepository, OutboxReadRepository } from "./outbox.js";
import type { RecordReadRepository, RecordRepository } from "./optimistic-concurrency.js";

/** One atomic unit of work over multiple repositories. */
export interface UnitOfWork {
  /** The transactional outbox view (enqueue is atomic with business writes). */
  readonly outbox: OutboxRepository;
  /** The transactional inbox view. */
  readonly inbox: InboxRepository;
  /**
   * A named record repository view bound to this unit of work (read-your-
   * own-writes). Multiple names give the multi-repo atomic commit.
   */
  records(repository: string): RecordRepository;
  /** Atomically applies all writes made through this unit of work. */
  commit(): Promise<void>;
  /** Discards all writes made through this unit of work. */
  rollback(): Promise<void>;
}

/** Opens units of work. */
export interface UnitOfWorkFactory {
  begin(): Promise<UnitOfWork>;
}

/**
 * Read-only views over COMMITTED state only - never uncommitted writes.
 * Projections and read models consume these (spec/architecture.md "Projection
 * model": projections are disposable; canonical state is not).
 */
export interface PersistenceReader {
  readonly outbox: OutboxReadRepository;
  readonly inbox: InboxReadRepository;
  records(repository: string): RecordReadRepository;
}
