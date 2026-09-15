/**
 * Optimistic-concurrency primitives (RL-003).
 *
 * Mutable state is guarded by a version token: the Wave-0 `Revision`
 * (contracts/versioning). Every mutation is a compare-and-swap (CAS): the
 * caller states the version it observed; the store swaps in the next value
 * only when the stored version still matches. A mismatch is a TYPED Wave-0
 * ConflictError - never a silent overwrite (RL-LOCK-014 retries stay safe
 * because a lost race is loudly visible).
 *
 * The record store is generic by design: named repositories hold
 * canonical-JSON-valued records keyed by caller-chosen ids, so domain
 * packages can persist their aggregates behind these ports without this
 * package knowing anything about domain semantics (no ORM coupling,
 * spec/repository-layout.md runtime baseline: PostgreSQL-compatible drivers
 * can implement the same ports later).
 */
import {
  ConflictError,
  ValidationError,
  canonicalizeJson,
  isForeignRefShaped,
  parseRevision,
  type CanonicalJsonValue,
  type Revision,
} from "@roamlink/contracts";

/** A versioned record in a named repository. `version` is the CAS token. */
export interface VersionedRecord {
  readonly recordId: string;
  readonly version: Revision;
  readonly value: CanonicalJsonValue;
}

function parseRecordId(recordId: string): string {
  if (typeof recordId !== "string" || !isForeignRefShaped(recordId)) {
    throw new ValidationError(
      "recordId must match the safe foreign-reference charset (1-255 chars, starts alphanumeric)",
      {
        reason: "ID_INVALID",
        details: [{ path: "recordId", issue: "not a safe reference string" }],
      },
    );
  }
  return recordId;
}

/**
 * The core compare-and-swap precondition check. `actual === null` means "the
 * record does not exist". Throws the typed Wave-0 conflict error on mismatch;
 * returns silently when the expectation holds.
 */
export function assertExpectedVersion(expected: Revision, actual: Revision | null): void {
  if (actual === null || actual !== expected) {
    throw new ConflictError(
      "optimistic-concurrency conflict: the stored version does not match the expected version (the record was changed concurrently, or does not exist); re-read and retry - never overwrite silently",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
}

/** The next version token after `version` (monotonic, +1). */
export function nextRevision(version: Revision): Revision {
  return parseRevision(version + 1);
}

/** Transactional record writes - available only through a UnitOfWork. */
export interface RecordWriteRepository {
  /** Inserts a new record at version 1. Typed ConflictError if it exists. */
  insert(recordId: string, value: CanonicalJsonValue): Promise<VersionedRecord>;
  /**
   * Compare-and-swap: replaces the value only when the stored version equals
   * `expectedVersion` (a positive integer). Mismatch/absence -> typed
   * ConflictError, no write.
   */
  compareAndSwap(
    recordId: string,
    expectedVersion: number,
    nextValue: CanonicalJsonValue,
  ): Promise<VersionedRecord>;
  /** Compare-and-swap delete. Mismatch/absence -> typed ConflictError. */
  delete(recordId: string, expectedVersion: number): Promise<void>;
}

/** Read-only view over committed records of one named repository. */
export interface RecordReadRepository {
  get(recordId: string): Promise<VersionedRecord | null>;
  /** All records, deterministically ordered by recordId. */
  list(): Promise<readonly VersionedRecord[]>;
  count(): Promise<number>;
}

/**
 * Transactional record view: writes plus read-your-own-writes reads over the
 * unit-of-work state. Available only through a UnitOfWork.
 */
export interface RecordRepository extends RecordWriteRepository, RecordReadRepository {}

/** Validates that a stored value is canonicalizable JSON (throws otherwise). */
function assertCanonicalValue(value: CanonicalJsonValue): void {
  canonicalizeJson(value); // throws a path-precise ValidationError for non-JSON input
}

/** Builds a frozen, validated version-1 record. */
export function buildVersionedRecord(
  recordId: string,
  value: CanonicalJsonValue,
): VersionedRecord {
  assertCanonicalValue(value);
  return Object.freeze({
    recordId: parseRecordId(recordId),
    version: parseRevision(1),
    value,
  });
}

/** Validates a repository name (lowercase slug, like inbox sources). */
export function parseRepositoryName(repository: string): string {
  if (typeof repository !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(repository)) {
    throw new ValidationError(
      "repository name must be a lowercase slug (letter, then letters/digits/hyphens, max 64 chars)",
      {
        reason: "ID_INVALID",
        details: [{ path: "repository", issue: "not a lowercase slug" }],
      },
    );
  }
  return repository;
}

export { parseRecordId };
