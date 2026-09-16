/**
 * The reconciliation job store (RL-035).
 *
 * Jobs persist through the Wave-1 primitives (@roamlink/persistence): the
 * named-record repository `adcos-reconciliation-jobs` inside units of work,
 * with optimistic concurrency on every transition (typed ConflictError on a
 * lost race - never a silent overwrite). Reads see committed state only.
 */
import {
  ConflictError,
  DomainError,
  type CanonicalJsonValue,
} from "@roamlink/contracts";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import {
  applyReconciliationJobTransition,
  parseReconciliationJobRecord,
  type ReconciliationJobRecord,
} from "./job-record.js";

/** The named persistence repository holding the durable job records. */
export const RECONCILIATION_JOBS_REPOSITORY = "adcos-reconciliation-jobs";

/** A stored job plus its optimistic-concurrency version token. */
export interface StoredReconciliationJob {
  readonly record: ReconciliationJobRecord;
  readonly version: number;
}

export class ReconciliationJobStore {
  readonly #persistence: UnitOfWorkFactory;
  readonly #reader: PersistenceReader;

  constructor(persistence: UnitOfWorkFactory, reader: PersistenceReader) {
    this.#persistence = persistence;
    this.#reader = reader;
  }

  /** Creates a job at version 1; typed ConflictError if the id already exists. */
  async create(record: ReconciliationJobRecord): Promise<StoredReconciliationJob> {
    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork
        .records(RECONCILIATION_JOBS_REPOSITORY)
        .insert(record.job_id, record as unknown as CanonicalJsonValue);
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new ConflictError(
          "reconciliation job already exists: re-running a job id must go through runJob, not re-creation",
          { reason: "RECONCILIATION_JOB_EXISTS", cause: error },
        );
      }
      throw error;
    }
    return { record, version: 1 };
  }

  /** Reads the committed job (null when unknown). */
  async get(jobId: string): Promise<StoredReconciliationJob | null> {
    const stored = await this.#reader.records(RECONCILIATION_JOBS_REPOSITORY).get(jobId);
    if (stored === null) return null;
    return { record: parseReconciliationJobRecord(stored.value), version: stored.version };
  }

  /** All committed jobs, deterministically ordered by job id. */
  async list(): Promise<readonly StoredReconciliationJob[]> {
    const all = await this.#reader.records(RECONCILIATION_JOBS_REPOSITORY).list();
    return all.map((stored) => ({
      record: parseReconciliationJobRecord(stored.value),
      version: stored.version,
    }));
  }

  /**
   * Applies a lifecycle transition at the expected version (optimistic
   * concurrency). The next record must be a legal transition of the stored
   * one; a lost race surfaces as the typed ConflictError.
   */
  async transition(
    jobId: string,
    expectedVersion: number,
    current: ReconciliationJobRecord,
    next: Parameters<typeof applyReconciliationJobTransition>[1],
  ): Promise<StoredReconciliationJob> {
    const computed = applyReconciliationJobTransition(current, next);
    const unitOfWork = await this.#persistence.begin();
    try {
      const stored = await unitOfWork
        .records(RECONCILIATION_JOBS_REPOSITORY)
        .compareAndSwap(jobId, expectedVersion, computed as unknown as CanonicalJsonValue);
      await unitOfWork.commit();
      return { record: parseReconciliationJobRecord(stored.value), version: stored.version };
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new DomainError(
          "reconciliation job transition lost its optimistic-concurrency race; a concurrent runner won - its outcome stands (never overwrite silently)",
          { reason: "RECONCILIATION_JOB_RACE", cause: error },
        );
      }
      throw error;
    }
  }
}
