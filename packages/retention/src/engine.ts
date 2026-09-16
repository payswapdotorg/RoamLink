/**
 * The retention enforcement engine (RL-054).
 *
 * The enforcement layer for spec/data-model.md "Privacy" and spec/mobile.md
 * "Device privacy", driving the persistence-backed store:
 *
 *  - ADMISSION (`admit`): every classified write passes
 *    {@link parseClassifiedRecord} - purpose limitation, stricter-control
 *    consent, minimization bounds and the RL-LOCK-016 no-secrets scan - and
 *    the record + its `retained` audit row commit ATOMICALLY in one unit of
 *    work (the record never exists unaudited).
 *  - EXPIRY SWEEP (`sweepExpired`): bounded sweeps of records whose
 *    policy-computed expiry has passed; per-category erasure semantics
 *    (hard-delete or privacy tombstone) apply with their audit row in the
 *    same atomic unit. A concurrent sweep race is a typed error - never a
 *    double-erasure.
 *  - EXPLICIT ERASURE (`requestErasure`): actor-triggered erasure using the
 *    same semantics, audited with the actor.
 *  - ACCESS CONTROL (`authorizeAccess`): purpose-declaration, expiry,
 *    tombstone and consent checks - every decision audited (grants and
 *    denials, spec/security.md "Audit").
 *
 * Ordering guarantee: the record write and its audit row commit together;
 * an audit row NEVER exists without its record effect (a crash can never
 * produce a false audit claim).
 */
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  parseForeignRefAs,
  parseTenantId,
  parseUtcInstant,
  type CanonicalJsonValue,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import type { UnitOfWorkFactory } from "@roamlink/persistence";

import {
  parseRetentionDecisionRecord,
  type RetentionDecisionRecord,
  type RetentionRefusalReason,
} from "./audit.js";
import {
  parseRetentionPurpose,
} from "./classification.js";
import {
  parseClassifiedRecord,
  storedRecordValue,
  tombstoneRecord,
  type ClassifiedRecordInput,
  type StoredRetentionRecord,
} from "./record.js";
import type { RetentionPolicy } from "./policy.js";
import { retentionRuleFor } from "./policy.js";
import {
  RETENTION_AUDIT_REPOSITORY,
  RETENTION_RECORDS_REPOSITORY,
  type PersistenceRetentionRecordStore,
} from "./store.js";

/** One swept record and the erasure action applied to it. */
export interface RetentionSweepOutcome {
  readonly recordId: string;
  readonly dataCategory: StoredRetentionRecord["dataCategory"];
  readonly action: "hard-deleted" | "tombstoned";
}

/** The report of one expiry sweep. */
export interface RetentionSweepReport {
  readonly inspected: number;
  readonly swept: readonly RetentionSweepOutcome[];
}

/** The result of one access authorization. */
export interface RetentionAccessDecision {
  readonly allowed: boolean;
  /** Present iff not allowed (closed refusal vocabulary). */
  readonly refusalReason?: RetentionRefusalReason;
}

/** Options for {@link RetentionEnforcementEngine}. */
export interface RetentionEnforcementEngineOptions {
  readonly persistence: UnitOfWorkFactory;
  readonly policy: RetentionPolicy;
  readonly recordStore: PersistenceRetentionRecordStore;
  /** Deterministic decision-id source (inject in tests). */
  readonly decisionIdGenerator: () => string;
}

const DEFAULT_SWEEP_LIMIT = 100;
const MAX_SWEEP_LIMIT = 1000;

function auditValue(record: RetentionDecisionRecord): CanonicalJsonValue {
  // parse first (fail-closed), then hand the parsed value to persistence.
  return parseRetentionDecisionRecord(record) as unknown as CanonicalJsonValue;
}

/**
 * The engine. All operations take explicit UTC instants (deterministic under
 * the testkit clock).
 */
export class RetentionEnforcementEngine {
  readonly #persistence: UnitOfWorkFactory;
  readonly #policy: RetentionPolicy;
  readonly #recordStore: PersistenceRetentionRecordStore;
  readonly #decisionIdGenerator: () => string;

  constructor(options: RetentionEnforcementEngineOptions) {
    this.#persistence = options.persistence;
    this.#policy = options.policy;
    this.#recordStore = options.recordStore;
    this.#decisionIdGenerator = options.decisionIdGenerator;
  }

  /** The bound policy. */
  get policy(): RetentionPolicy {
    return this.#policy;
  }

  /**
   * Admits one classified record: full policy validation (classification,
   * purpose limitation, stricter-control consent, minimization, RL-LOCK-016
   * secret scan) then an ATOMIC insert + `retained` audit row. Invalid
   * records are refused with a typed error and an audit row recording the
   * rejection (secret material vs invalid classification).
   */
  async admit(
    input: unknown,
    at: UtcInstant | string,
    actor: string | null = null,
  ): Promise<StoredRetentionRecord> {
    const instant = parseUtcInstant(at);
    let record: StoredRetentionRecord;
    try {
      record = { ...parseClassifiedRecord(this.#policy, input as ClassifiedRecordInput), tombstonedAt: null };
    } catch (error) {
      if (error instanceof ValidationError) {
        const secret =
          error.reason === "RETENTION_SECRET_MATERIAL_DETECTED" ||
          error.message.includes("secret-shaped material");
        const refusalReason: RetentionRefusalReason = secret
          ? "secret-material-detected"
          : "invalid-classification";
        await this.#appendAudit({
          decidedAt: instant,
          decision: secret ? "rejected-secret-material" : "rejected-invalid-record",
          recordId: this.#readRecordId(input),
          tenantId: this.#readTenantId(input),
          dataCategory: this.#readCategory(input),
          refusalReason,
          actor,
        });
      }
      throw error;
    }

    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork
        .records(RETENTION_RECORDS_REPOSITORY)
        .insert(record.recordId, storedRecordValue(record));
      const decisionId = this.#decisionIdGenerator();
      await unitOfWork
        .records(RETENTION_AUDIT_REPOSITORY)
        .insert(
          decisionId,
          auditValue({
            decisionId,
            decidedAt: instant,
            decision: "retained",
            recordId: record.recordId,
            tenantId: record.tenantId,
            dataCategory: record.dataCategory,
            actor,
          }),
        );
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
    return record;
  }

  /**
   * Sweeps EXPIRED live records (policy-computed expiry <= `at`) up to
   * `limit`, applying the category's erasure semantics atomically with the
   * audit row. Tombstones are skipped (already erased); hard-deleted records
   * are absent. A concurrent sweep race is a typed error - never a double
   * erasure.
   */
  async sweepExpired(
    at: UtcInstant | string,
    limit = DEFAULT_SWEEP_LIMIT,
  ): Promise<RetentionSweepReport> {
    const instant = parseUtcInstant(at);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP_LIMIT) {
      throw new ValidationError(`the sweep limit must be an integer between 1 and ${MAX_SWEEP_LIMIT}`, {
        reason: "RETENTION_SWEEP_INVALID",
        details: [{ path: "limit", issue: "out of bounds" }],
      });
    }
    const all = await this.#recordStore.list();
    const due = all.filter(
      (stored) =>
        stored.record.tombstonedAt === null && parseUtcInstant(stored.record.expiresAt) <= instant,
    );
    const swept: RetentionSweepOutcome[] = [];
    for (const target of due.slice(0, limit)) {
      const outcome = await this.#erase(target.record, target.version, instant, "expired", null);
      swept.push(outcome);
    }
    return Object.freeze({ inspected: all.length, swept: Object.freeze(swept) });
  }

  /**
   * Explicit erasure request (user/tenant right): applies the category's
   * erasure semantics immediately - regardless of the retention window -
   * with the requesting actor on the audit row. Idempotent for already
   * tombstoned records (the data is already gone; no double audit claim).
   */
  async requestErasure(
    recordId: string,
    at: UtcInstant | string,
    actor: string | null = null,
  ): Promise<{ action: "hard-deleted" | "tombstoned" | "already-tombstoned" }> {
    const instant = parseUtcInstant(at);
    const id = parseForeignRefAs(recordId, "RetentionRecordId");
    const stored = await this.#recordStore.get(id);
    if (stored === null) {
      throw new NotFoundError("no retention record exists under this id", {
        reason: "RETENTION_RECORD_NOT_FOUND",
      });
    }
    if (stored.record.tombstonedAt !== null) {
      return { action: "already-tombstoned" };
    }
    const outcome = await this.#erase(stored.record, stored.version, instant, "erasure", actor);
    return { action: outcome.action };
  }

  /**
   * Authorizes one access to a record for a purpose: the purpose must be
   * declared on the record, the record must be live and unexpired, and
   * stricter-control categories must carry their explicit consent grant.
   * Every decision (grant and denial) is audited. Unknown records are a
   * typed NotFoundError (nothing to authorize against - including
   * hard-deleted data, which no longer exists).
   */
  async authorizeAccess(
    recordId: string,
    purpose: string,
    at: UtcInstant | string,
    actor: string | null = null,
  ): Promise<RetentionAccessDecision> {
    const instant = parseUtcInstant(at);
    const id = parseForeignRefAs(recordId, "RetentionRecordId");
    const parsedPurpose = parseRetentionPurpose(purpose);
    const stored = await this.#recordStore.get(id);
    if (stored === null) {
      throw new NotFoundError("no retention record exists under this id", {
        reason: "RETENTION_RECORD_NOT_FOUND",
      });
    }
    const record = stored.record;

    let refusalReason: RetentionRefusalReason | null = null;
    if (record.tombstonedAt !== null) {
      refusalReason = "record-tombstoned";
    } else if (parseUtcInstant(record.expiresAt) <= instant) {
      refusalReason = "record-expired";
    } else if (!record.purposes.includes(parsedPurpose)) {
      refusalReason = "purpose-not-declared";
    } else if (retentionRuleFor(this.#policy, record.dataCategory).requiresExplicitConsent && !record.consent) {
      refusalReason = "consent-required";
    }

    const decision: RetentionAccessDecision = refusalReason === null
      ? { allowed: true }
      : { allowed: false, refusalReason };
    await this.#appendAudit({
      decidedAt: instant,
      decision: decision.allowed ? "access-granted" : "access-denied",
      recordId: record.recordId,
      tenantId: record.tenantId,
      dataCategory: record.dataCategory,
      ...(decision.allowed ? {} : { refusalReason: decision.refusalReason }),
      actor,
    });
    return decision;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  async #erase(
    record: StoredRetentionRecord,
    version: number,
    at: UtcInstant,
    cause: "expired" | "erasure",
    actor: string | null,
  ): Promise<RetentionSweepOutcome> {
    const rule = retentionRuleFor(this.#policy, record.dataCategory);
    const unitOfWork = await this.#persistence.begin();
    try {
      const action: RetentionSweepOutcome["action"] =
        rule.erasureSemantics === "tombstone" ? "tombstoned" : "hard-deleted";
      if (rule.erasureSemantics === "tombstone") {
        await unitOfWork
          .records(RETENTION_RECORDS_REPOSITORY)
          .compareAndSwap(record.recordId, version, storedRecordValue(tombstoneRecord(record, at)));
      } else {
        await unitOfWork.records(RETENTION_RECORDS_REPOSITORY).delete(record.recordId, version);
      }
      const decisionId = this.#decisionIdGenerator();
      await unitOfWork
        .records(RETENTION_AUDIT_REPOSITORY)
        .insert(
          decisionId,
          auditValue({
            decisionId,
            decidedAt: at,
            decision:
              cause === "expired"
                ? action === "tombstoned"
                  ? "expired-tombstoned"
                  : "expired-hard-deleted"
                : "erasure-applied",
            recordId: record.recordId,
            tenantId: record.tenantId,
            dataCategory: record.dataCategory,
            actor,
          }),
        );
      await unitOfWork.commit();
      return { recordId: record.recordId, dataCategory: record.dataCategory, action };
    } catch (error) {
      await unitOfWork.rollback();
      if (error instanceof ConflictError) {
        throw new DomainError(
          "the erasure lost its optimistic-concurrency race; the concurrent outcome stands (never erase twice or overwrite silently)",
          { reason: "RETENTION_ERASE_RACE", cause: error },
        );
      }
      throw error;
    }
  }

  async #appendAudit(
    decision: Omit<RetentionDecisionRecord, "decisionId">,
  ): Promise<void> {
    // Single-row units of work for standalone audit appends (rejections and
    // access decisions): there is no paired record write to be atomic with.
    const decisionId = this.#decisionIdGenerator();
    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork
        .records(RETENTION_AUDIT_REPOSITORY)
        .insert(decisionId, auditValue({ ...decision, decisionId }));
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
  }

  #readRecordId(input: unknown): string {
    if (input === null || typeof input !== "object") return "-";
    const candidate = (input as Record<string, unknown>)["recordId"];
    if (typeof candidate !== "string") return "-";
    try {
      return parseForeignRefAs(candidate, "RetentionRecordId");
    } catch {
      return "-";
    }
  }

  #readTenantId(input: unknown): TenantId {
    const fallback: TenantId = parseTenantId("usr:00000000-0000-4000-8000-000000000000");
    if (input === null || typeof input !== "object") return fallback;
    const candidate = (input as Record<string, unknown>)["tenantId"];
    if (typeof candidate !== "string") return fallback;
    try {
      return parseTenantId(candidate);
    } catch {
      return fallback;
    }
  }

  #readCategory(input: unknown): StoredRetentionRecord["dataCategory"] | null {
    if (input === null || typeof input !== "object") return null;
    const candidate = (input as Record<string, unknown>)["dataCategory"];
    const categories: readonly string[] = [
      "location",
      "network-identifiers",
      "diagnostics",
      "usage",
      "telemetry",
    ];
    return typeof candidate === "string" && categories.includes(candidate)
      ? (candidate as StoredRetentionRecord["dataCategory"])
      : null;
  }
}
