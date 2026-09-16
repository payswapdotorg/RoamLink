/**
 * The persistence-backed retention record + audit stores (RL-054).
 *
 * Classified records persist through the Wave-1 primitives
 * (@roamlink/persistence) inside units of work: the named repositories
 * `retention-records` and `retention-audit`, with optimistic concurrency on
 * every transition (a lost race is a typed ConflictError - never a silent
 * overwrite). Tombstones are CAS payload replacements; hard deletes are CAS
 * deletes. The audit repository is written INSERT-ONLY (the store exposes no
 * mutation path for audit rows).
 *
 * The in-memory persistence adapter runs this store in CI/tests
 * (spec/repository-layout.md runtime baseline); a PostgreSQL-compatible
 * driver implements the same ports later.
 */
import {
  ConflictError,
  DomainError,
  parseForeignRefAs,
  parseUtcInstant,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";

import {
  parseRetentionDecisionRecord,
  type RetentionAuditStore,
  type RetentionDecisionRecord,
} from "./audit.js";
import {
  parseStoredRetentionRecord,
  storedRecordValue,
  type StoredRetentionRecord,
} from "./record.js";
import type { RetentionPolicy } from "./policy.js";

/** The named persistence repository holding the classified records. */
export const RETENTION_RECORDS_REPOSITORY = "retention-records";

/** The named persistence repository holding the append-only audit trail. */
export const RETENTION_AUDIT_REPOSITORY = "retention-audit";

/** A stored record plus its optimistic-concurrency version token. */
export interface VersionedRetentionRecord {
  readonly record: StoredRetentionRecord;
  readonly version: number;
}

/**
 * Parses a stored value back into a record: the persistence key (the
 * record id) is re-injected because `storedRecordValue` deliberately keeps
 * the id out of the value (it IS the key).
 */
function parseStored(policy: RetentionPolicy, value: unknown, recordId: string): StoredRetentionRecord {
  return parseStoredRetentionRecord(policy, { ...(value as Record<string, unknown>), recordId });
}

/**
 * The retention record store: durable, transactional, optimistic-concurrent.
 * Every write happens inside a unit of work so a record transition is
 * atomic with its audit append (see the engine, which composes both).
 */
export class PersistenceRetentionRecordStore {
  readonly #persistence: UnitOfWorkFactory;
  readonly #reader: PersistenceReader;
  readonly #policy: RetentionPolicy;

  constructor(
    persistence: UnitOfWorkFactory,
    reader: PersistenceReader,
    policy: RetentionPolicy,
  ) {
    this.#persistence = persistence;
    this.#reader = reader;
    this.#policy = policy;
  }

  /** The bound policy (the engine reuses it for record parsing). */
  get policy(): RetentionPolicy {
    return this.#policy;
  }

  /** Inserts a new classified record at version 1. */
  async insert(record: StoredRetentionRecord): Promise<VersionedRetentionRecord> {
    const unitOfWork = await this.#persistence.begin();
    try {
      const stored = await unitOfWork
        .records(RETENTION_RECORDS_REPOSITORY)
        .insert(record.recordId, storedRecordValue(record));
      await unitOfWork.commit();
      return { record, version: stored.version };
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new ConflictError(
          "a retention record with this id already exists (records are inserted once; erasure never re-creates them)",
          { reason: "RETENTION_RECORD_EXISTS", cause: error },
        );
      }
      throw error;
    }
  }

  /** Reads the committed record (null when unknown). */
  async get(recordId: string): Promise<VersionedRetentionRecord | null> {
    const id = parseForeignRefAs(recordId, "RetentionRecordId");
    const stored = await this.#reader.records(RETENTION_RECORDS_REPOSITORY).get(id);
    if (stored === null) return null;
    return {
      record: parseStored(this.#policy, stored.value, id),
      version: stored.version,
    };
  }

  /** All committed records, deterministically ordered by record id. */
  async list(): Promise<readonly VersionedRetentionRecord[]> {
    const all = await this.#reader.records(RETENTION_RECORDS_REPOSITORY).list();
    return all.map((stored) => ({
      record: parseStored(this.#policy, stored.value, stored.recordId),
      version: stored.version,
    }));
  }

  /**
   * Replaces the record at the expected version (tombstone transitions);
   * a lost race is the typed ConflictError.
   */
  async compareAndSwap(
    recordId: string,
    expectedVersion: number,
    next: StoredRetentionRecord,
  ): Promise<VersionedRetentionRecord> {
    const unitOfWork = await this.#persistence.begin();
    try {
      const stored = await unitOfWork
        .records(RETENTION_RECORDS_REPOSITORY)
        .compareAndSwap(recordId, expectedVersion, storedRecordValue(next));
      await unitOfWork.commit();
      return {
        record: parseStored(this.#policy, stored.value, stored.recordId),
        version: stored.version,
      };
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new DomainError(
          "the retention record transition lost its optimistic-concurrency race; the concurrent outcome stands (never overwrite silently)",
          { reason: "RETENTION_RECORD_RACE", cause: error },
        );
      }
      throw error;
    }
  }

  /** Deletes the record at the expected version (hard-delete erasure). */
  async delete(recordId: string, expectedVersion: number): Promise<void> {
    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork.records(RETENTION_RECORDS_REPOSITORY).delete(recordId, expectedVersion);
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new DomainError(
          "the retention record delete lost its optimistic-concurrency race; the concurrent outcome stands",
          { reason: "RETENTION_RECORD_RACE", cause: error },
        );
      }
      throw error;
    }
  }
}

/**
 * The persistence-backed audit store: INSERT-ONLY rows in the
 * `retention-audit` repository. There is no update or delete path - the
 * audit trail of retention decisions is append-only by construction.
 */
export class PersistenceRetentionAuditStore implements RetentionAuditStore {
  readonly #persistence: UnitOfWorkFactory;
  readonly #reader: PersistenceReader;

  constructor(persistence: UnitOfWorkFactory, reader: PersistenceReader) {
    this.#persistence = persistence;
    this.#reader = reader;
  }

  async append(record: RetentionDecisionRecord): Promise<void> {
    const validated = parseRetentionDecisionRecord(record);
    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork
        .records(RETENTION_AUDIT_REPOSITORY)
        .insert(validated.decisionId, validated as unknown as CanonicalJsonValue);
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new ConflictError(
          "a retention audit record with this decisionId already exists (audit ids are unique)",
          { reason: "RETENTION_AUDIT_DUPLICATE", cause: error },
        );
      }
      throw error;
    }
  }

  async byRecordId(recordId: string): Promise<readonly RetentionDecisionRecord[]> {
    const id = parseForeignRefAs(recordId, "RetentionRecordId");
    const all = await this.#reader.records(RETENTION_AUDIT_REPOSITORY).list();
    return Object.freeze(
      all
        .map((stored) => parseRetentionDecisionRecord(stored.value))
        .filter((record) => record.recordId === id)
        .sort((a, b) =>
          a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0,
        ),
    );
  }

  async list(): Promise<readonly RetentionDecisionRecord[]> {
    const all = await this.#reader.records(RETENTION_AUDIT_REPOSITORY).list();
    return Object.freeze(
      all
        .map((stored) => parseRetentionDecisionRecord(stored.value))
        .sort((a, b) =>
          a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0,
        ),
    );
  }
}

/** Re-exported for engine consumers needing explicit instants. */
export function parseRetentionInstant(at: string | UtcInstant): UtcInstant {
  return parseUtcInstant(at);
}
