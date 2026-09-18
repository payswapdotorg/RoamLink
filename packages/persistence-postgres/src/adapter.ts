/**
 * The real PostgreSQL persistence adapter (RL-091).
 *
 * Implements the @roamlink/persistence ports (`UnitOfWorkFactory`,
 * `PersistenceReader`) against REAL PostgreSQL SQL through the driver seam
 * (`./driver.ts`). The in-memory adapter in @roamlink/persistence remains
 * the semantic reference; this adapter preserves its observable contract:
 *
 *  1. One `UnitOfWork` = ONE real database transaction spanning awaits.
 *     Every write made through its views executes inside that transaction,
 *     so "business write + outbox enqueue" commits atomically or not at all
 *     (transactional outbox by construction).
 *  2. Optimistic concurrency is LOUD: every mutation is a conditional SQL
 *     statement (CAS on the stored version/state), so a lost race - or a
 *     missing row - throws the typed Wave-0 ConflictError. Postgres
 *     serialization failures (40001) and deadlocks (40P01) surface as the
 *     same typed conflict.
 *  3. The inbox is an append-only admission log with the dedupe key owned
 *     by a PARTIAL UNIQUE INDEX on the ADMITTED rows: exactly one admitted
 *     record per key is enforced by the database itself; later arrivals
 *     become DUPLICATE audit rows and rejected arrivals never occupy the
 *     key (RL-LOCK-009).
 *  4. The outbox delivery state machine is applied through the SHARED pure
 *     transition functions of the port package (`claimOutboxRecord`,
 *     `completeOutboxDelivery`, `failOutboxAttempt`), so the SQL adapter
 *     cannot drift from the closed state machine.
 *  5. Determinism: every time-dependent operation takes an explicit
 *     caller-supplied UTC instant; lists have deterministic order.
 *
 * Concurrency notes (documented deltas, never weakenings):
 *  - `claimDue` uses `FOR UPDATE SKIP LOCKED`, so concurrent delivery
 *     workers claim DISJOINT sets (never the same record twice - no
 *     double-delivery) instead of failing each other with spurious
 *     conflicts. The never-double-claim invariant is strictly stronger
 *     than the in-memory replay's conflict semantics.
 *  - Inbox sequences come from a real IDENTITY column: monotonic in
 *     commit/arrival order, but a rolled-back transaction burns its
 *     sequence value (gaps are possible). The ordering signal the port
 *     documents is preserved; exact 1-based contiguity is not guaranteed
 *     by a real database and consumers must not rely on it (the port's
 *     `get(sequence)` lookup is unaffected).
 */
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  canonicalizeJson,
  nowUtc,
  parseRevision,
  parseUtcInstant,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  buildInboxRecord,
  buildOutboxRecord,
  buildVersionedRecord,
  completeOutboxDelivery,
  failOutboxAttempt,
  parseRecordId,
  parseRepositoryName,
  type InboxAdmitInput,
  type InboxAdmitResult,
  type InboxAdmissionState,
  type InboxReadRepository,
  type InboxRecord,
  type InboxRepository,
  type OutboxDeliveryState,
  type OutboxEnqueueInput,
  type OutboxEnqueueOutcome,
  type OutboxReadRepository,
  type OutboxRecord,
  type OutboxRepository,
  type PersistenceReader,
  type RecordReadRepository,
  type RecordRepository,
  type UnitOfWork,
  type UnitOfWorkFactory,
  type VersionedRecord,
} from "@roamlink/persistence";

import {
  SqlUniqueViolation,
  mapSqlError,
  type SqlDriver,
  type SqlTransaction,
} from "./driver.js";
import {
  INBOX_COLUMNS,
  OUTBOX_COLUMNS,
  RECORD_COLUMNS,
  inboxFromRow,
  instantToParam,
  jsonToParam,
  outboxFromRow,
  outboxUpdateParams,
  recordFromRow,
} from "./sql-state.js";

// --------------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------------

const OUTBOX_TABLE = "roamlink_outbox";
const INBOX_TABLE = "roamlink_inbox";
const RECORDS_TABLE = "roamlink_records";

function mustRow(rows: readonly Record<string, unknown>[], what: string): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(`${what} does not exist`, { reason: "OUTBOX_RECORD_UNKNOWN" });
  }
  return row;
}

/** Parses an instant argument that may come as string or UtcInstant. */
function parseAt(at: string): UtcInstant {
  return parseUtcInstant(at);
}

// --------------------------------------------------------------------------------
// Outbox view (write view inside a unit of work)
// --------------------------------------------------------------------------------

class PostgresOutboxView implements OutboxRepository {
  readonly #tx: SqlTransaction;
  readonly #assertOpen: () => void;

  constructor(tx: SqlTransaction, assertOpen: () => void) {
    this.#tx = tx;
    this.#assertOpen = assertOpen;
  }

  async enqueue(input: OutboxEnqueueInput): Promise<OutboxEnqueueOutcome> {
    this.#assertOpen();
    const record = buildOutboxRecord(input); // validates + canonicalizes + digests
    const existing = await this.#tx.query(
      `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1`,
      [record.idempotencyKey],
    ).catch(mapSqlError);
    const prior = existing.rows[0];
    if (prior !== undefined) {
      const priorRecord = outboxFromRow(prior);
      if (priorRecord.payloadDigest === record.payloadDigest) {
        return { outcome: "ALREADY_ENQUEUED", record: priorRecord };
      }
      throw new ConflictError(
        "outbox enqueue conflict: this idempotency key is already enqueued with a DIFFERENT payload digest (retries must reuse the same payload; never silently overwrite)",
        { reason: "OUTBOX_IDEMPOTENCY_CONFLICT" },
      );
    }
    // The INSERT is fenced by a SAVEPOINT: when a CONCURRENT transaction wins
    // the unique-index race, the failed INSERT would otherwise abort this
    // transaction (25P02 on every following statement). Rolling back to the
    // savepoint keeps the unit of work usable so the raced arrival can be
    // re-read and answered with the typed idempotency semantics.
    await this.#tx.query("SAVEPOINT roamlink_outbox_enqueue").catch(mapSqlError);
    let inserted: boolean;
    try {
      await this.#tx.query(
        `INSERT INTO ${OUTBOX_TABLE}
           (idempotency_key, payload_bytes, payload_digest, created_at, delivery_state,
            retry_count, next_attempt_at, delivered_at, last_error_reason,
            retry_max_attempts, retry_backoff_ms)
         VALUES ($1, $2, $3, $4::timestamptz, 'PENDING', 0, $4::timestamptz, NULL, NULL, $5, $6::jsonb)`,
        [
          record.idempotencyKey,
          Buffer.from(record.payloadBytes),
          record.payloadDigest,
          instantToParam(record.createdAt),
          record.retryPolicy.maxAttempts,
          jsonToParam(record.retryPolicy.backoffScheduleMs as unknown as CanonicalJsonValue),
        ],
      ).catch(mapSqlError);
      inserted = true;
    } catch (error) {
      if (!(error instanceof SqlUniqueViolation)) throw error;
      await this.#tx.query("ROLLBACK TO SAVEPOINT roamlink_outbox_enqueue").catch(mapSqlError);
      inserted = false;
    }
    await this.#tx.query("RELEASE SAVEPOINT roamlink_outbox_enqueue").catch(mapSqlError);
    if (!inserted) {
      // A concurrent transaction inserted it first (the unique index kept one
      // record per key); answer with the idempotent replay semantics.
      const raced = await this.#tx.query(
        `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1`,
        [record.idempotencyKey],
      ).catch(mapSqlError);
      const racedRecord = outboxFromRow(mustRow(raced.rows, "outbox record"));
      if (racedRecord.payloadDigest === record.payloadDigest) {
        return { outcome: "ALREADY_ENQUEUED", record: racedRecord };
      }
      throw new ConflictError(
        "outbox enqueue conflict: this idempotency key is already enqueued with a DIFFERENT payload digest (retries must reuse the same payload; never silently overwrite)",
        { reason: "OUTBOX_IDEMPOTENCY_CONFLICT" },
      );
    }
    return { outcome: "ENQUEUED", record };
  }

  async claimDue(at: string, limit: number): Promise<readonly OutboxRecord[]> {
    this.#assertOpen();
    const atInstant = parseAt(at);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new DomainError("outbox claim limit must be an integer >= 1", {
        reason: "OUTBOX_CLAIM_LIMIT_INVALID",
      });
    }
    const claimed = await this.#tx.query(
      `UPDATE ${OUTBOX_TABLE} SET delivery_state = 'DELIVERING'
       WHERE idempotency_key IN (
         SELECT idempotency_key FROM ${OUTBOX_TABLE}
         WHERE delivery_state = 'PENDING' AND next_attempt_at <= $1::timestamptz
         ORDER BY next_attempt_at ASC, created_at ASC, idempotency_key ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${OUTBOX_COLUMNS}`,
      [instantToParam(atInstant), limit],
    ).catch(mapSqlError);
    return Object.freeze(claimed.rows.map(outboxFromRow));
  }

  async markDelivered(idempotencyKey: string, at: string): Promise<OutboxRecord> {
    this.#assertOpen();
    const atInstant = parseAt(at);
    const current = await this.#lockedRecord(idempotencyKey);
    const next = completeOutboxDelivery(current, atInstant); // shared closed state machine
    await this.#writeTransition(idempotencyKey, current.deliveryState, next);
    return next;
  }

  async markAttemptFailed(
    idempotencyKey: string,
    at: string,
    reason?: string,
  ): Promise<OutboxRecord> {
    this.#assertOpen();
    const atInstant = parseAt(at);
    const current = await this.#lockedRecord(idempotencyKey);
    const next = failOutboxAttempt(current, atInstant, reason); // shared closed state machine
    await this.#writeTransition(idempotencyKey, current.deliveryState, next);
    return next;
  }

  async #lockedRecord(idempotencyKey: string): Promise<OutboxRecord> {
    const rows = await this.#tx.query(
      `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    ).catch(mapSqlError);
    return outboxFromRow(mustRow(rows.rows, "outbox record with this idempotency key"));
  }

  async #writeTransition(
    idempotencyKey: string,
    expectedState: OutboxDeliveryState,
    next: OutboxRecord,
  ): Promise<void> {
    const params = outboxUpdateParams(next);
    const updated = await this.#tx.query(
      `UPDATE ${OUTBOX_TABLE} SET
         delivery_state = $2, retry_count = $3, next_attempt_at = $4::timestamptz,
         delivered_at = $5::timestamptz, last_error_reason = $6
       WHERE idempotency_key = $1 AND delivery_state = $7`,
      [idempotencyKey, ...params, expectedState],
    ).catch(mapSqlError);
    if (updated.rowCount === 0) {
      throw new ConflictError(
        "outbox transition conflict: the record's delivery state changed concurrently; nothing was written",
        { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
      );
    }
  }

  async get(idempotencyKey: string): Promise<OutboxRecord | null> {
    this.#assertOpen();
    const rows = await this.#tx.query(
      `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : outboxFromRow(row);
  }

  async list(deliveryState?: OutboxDeliveryState): Promise<readonly OutboxRecord[]> {
    this.#assertOpen();
    return listOutboxSql(this.#tx, deliveryState);
  }

  async count(deliveryState?: OutboxDeliveryState): Promise<number> {
    this.#assertOpen();
    return countOutboxSql(this.#tx, deliveryState);
  }
}

// --------------------------------------------------------------------------------
// Shared outbox/inbox read SQL (unit-of-work views and committed readers)
// --------------------------------------------------------------------------------

type Executor = Pick<SqlTransaction, "query">;

async function listOutboxSql(
  exec: Executor,
  deliveryState?: OutboxDeliveryState,
): Promise<readonly OutboxRecord[]> {
  const rows =
    deliveryState === undefined
      ? await exec
          .query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE}
             ORDER BY created_at ASC, idempotency_key ASC`,
          )
          .catch(mapSqlError)
      : await exec
          .query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE delivery_state = $1
             ORDER BY created_at ASC, idempotency_key ASC`,
            [deliveryState],
          )
          .catch(mapSqlError);
  return Object.freeze(rows.rows.map(outboxFromRow));
}

async function countOutboxSql(
  exec: Executor,
  deliveryState?: OutboxDeliveryState,
): Promise<number> {
  const rows =
    deliveryState === undefined
      ? await exec.query(`SELECT count(*)::int AS n FROM ${OUTBOX_TABLE}`).catch(mapSqlError)
      : await exec
          .query(`SELECT count(*)::int AS n FROM ${OUTBOX_TABLE} WHERE delivery_state = $1`, [
            deliveryState,
          ])
          .catch(mapSqlError);
  return readCount(rows.rows, "outbox");
}

async function listInboxSql(
  exec: Executor,
  admissionState?: InboxAdmissionState,
): Promise<readonly InboxRecord[]> {
  const rows =
    admissionState === undefined
      ? await exec
          .query(`SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} ORDER BY sequence ASC`)
          .catch(mapSqlError)
      : await exec
          .query(
            `SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} WHERE admission_state = $1 ORDER BY sequence ASC`,
            [admissionState],
          )
          .catch(mapSqlError);
  return Object.freeze(rows.rows.map(inboxFromRow));
}

async function countInboxSql(
  exec: Executor,
  admissionState?: InboxAdmissionState,
): Promise<number> {
  const rows =
    admissionState === undefined
      ? await exec.query(`SELECT count(*)::int AS n FROM ${INBOX_TABLE}`).catch(mapSqlError)
      : await exec
          .query(`SELECT count(*)::int AS n FROM ${INBOX_TABLE} WHERE admission_state = $1`, [
            admissionState,
          ])
          .catch(mapSqlError);
  return readCount(rows.rows, "inbox");
}

function readCount(rows: readonly Record<string, unknown>[], what: string): number {
  const row = rows[0];
  const n = row === undefined ? undefined : row["n"];
  if (typeof n !== "number") {
    throw new NotFoundError(`count aggregation for the ${what} table returned no row`, {
      reason: "SQL_ROW_CORRUPT",
    });
  }
  return n;
}

// --------------------------------------------------------------------------------
// Inbox view
// --------------------------------------------------------------------------------

const INBOX_INSERT_SQL = `INSERT INTO ${INBOX_TABLE}
  (source, external_event_id, received_at, dedupe_key, admission_state)
  VALUES ($1, $2, $3::timestamptz, $4, $5)
  RETURNING ${INBOX_COLUMNS}`;

class PostgresInboxView implements InboxRepository {
  readonly #tx: SqlTransaction;
  readonly #assertOpen: () => void;

  constructor(tx: SqlTransaction, assertOpen: () => void) {
    this.#tx = tx;
    this.#assertOpen = assertOpen;
  }

  async admit(input: InboxAdmitInput): Promise<InboxAdmitResult> {
    this.#assertOpen();
    // Validate exactly like the port builder (fail closed before any SQL;
    // parseUtcInstant below re-derives the same canonical instant).
    buildInboxRecord(input, 1, "ADMITTED");

    // Lock the admitted row for this dedupe key, if one exists.
    const admitted = await this.#tx
      .query(
        `SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE}
         WHERE dedupe_key = $1 AND admission_state = 'ADMITTED' FOR UPDATE`,
        [input.dedupeKey],
      )
      .catch(mapSqlError);
    const originalRow = admitted.rows[0];
    if (originalRow !== undefined) {
      const original = inboxFromRow(originalRow);
      const duplicate = await this.#insert(input, "DUPLICATE");
      return { outcome: "DUPLICATE", record: duplicate, original };
    }

    // The ADMITTED insert is fenced by a SAVEPOINT: when a CONCURRENT
    // transaction admits this key between our SELECT and our INSERT, the
    // partial unique index rejects our insert and would otherwise abort this
    // transaction (25P02 on every following statement). Rolling back to the
    // savepoint keeps the unit of work usable so the raced arrival can be
    // re-read and recorded as a DUPLICATE audit row.
    await this.#tx.query("SAVEPOINT roamlink_inbox_admit").catch(mapSqlError);
    let admittedRecord: InboxRecord;
    try {
      admittedRecord = await this.#insert(input, "ADMITTED");
    } catch (error) {
      if (!(error instanceof SqlUniqueViolation)) throw error;
      await this.#tx.query("ROLLBACK TO SAVEPOINT roamlink_inbox_admit").catch(mapSqlError);
      // A concurrent transaction admitted this key; the partial unique index
      // kept exactly one admission - answer with the duplicate semantics.
      const raced = await this.#tx
        .query(
          `SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE}
           WHERE dedupe_key = $1 AND admission_state = 'ADMITTED'`,
          [input.dedupeKey],
        )
        .catch(mapSqlError);
      const original = inboxFromRow(mustRow(raced.rows, "admitted inbox record"));
      const duplicate = await this.#insert(input, "DUPLICATE");
      return { outcome: "DUPLICATE", record: duplicate, original };
    }
    await this.#tx.query("RELEASE SAVEPOINT roamlink_inbox_admit").catch(mapSqlError);
    return { outcome: "ADMITTED", record: admittedRecord };
  }

  async recordRejection(input: InboxAdmitInput): Promise<InboxRecord> {
    this.#assertOpen();
    // Rejections never occupy the dedupe key: no uniqueness check, plain row.
    buildInboxRecord(input, 1, "REJECTED");
    return this.#insert(input, "REJECTED");
  }

  async #insert(input: InboxAdmitInput, state: InboxAdmissionState): Promise<InboxRecord> {
    const rows = await this.#tx
      .query(INBOX_INSERT_SQL, [
        input.source,
        input.externalEventId,
        instantToParam(parseUtcInstant(input.receivedAt)),
        input.dedupeKey,
        state,
      ])
      .catch(mapSqlError);
    return inboxFromRow(mustRow(rows.rows, "inserted inbox record"));
  }

  async get(sequence: number): Promise<InboxRecord | null> {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ValidationError("inbox sequence must be an integer >= 1", {
        reason: "INBOX_INPUT_INVALID",
      });
    }
    const rows = await this.#tx
      .query(`SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} WHERE sequence = $1`, [sequence])
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : inboxFromRow(row);
  }

  async admitted(dedupeKey: string): Promise<InboxRecord | null> {
    this.#assertOpen();
    const rows = await this.#tx
      .query(
        `SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} WHERE dedupe_key = $1 AND admission_state = 'ADMITTED'`,
        [dedupeKey],
      )
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : inboxFromRow(row);
  }

  async list(admissionState?: InboxAdmissionState): Promise<readonly InboxRecord[]> {
    this.#assertOpen();
    return listInboxSql(this.#tx, admissionState);
  }

  async count(admissionState?: InboxAdmissionState): Promise<number> {
    this.#assertOpen();
    return countInboxSql(this.#tx, admissionState);
  }
}

// --------------------------------------------------------------------------------
// Records view (versioned compare-and-swap store)
// --------------------------------------------------------------------------------

class PostgresRecordsView implements RecordRepository {
  readonly #repository: string;
  readonly #tx: SqlTransaction;
  readonly #assertOpen: () => void;

  constructor(repository: string, tx: SqlTransaction, assertOpen: () => void) {
    this.#repository = repository;
    this.#tx = tx;
    this.#assertOpen = assertOpen;
  }

  async insert(recordId: string, value: CanonicalJsonValue): Promise<VersionedRecord> {
    this.#assertOpen();
    const built = buildVersionedRecord(recordId, value); // validates + freezes
    const repository = parseRepositoryName(this.#repository);
    try {
      await this.#tx
        .query(
          `INSERT INTO ${RECORDS_TABLE} (repository, record_id, version, value)
           VALUES ($1, $2, 1, $3::jsonb)`,
          [repository, built.recordId, jsonToParam(built.value)],
        )
        .catch(mapSqlError);
    } catch (error) {
      if (error instanceof SqlUniqueViolation) {
        throw new ConflictError("a record with this id already exists in the repository", {
          reason: "RECORD_ALREADY_EXISTS",
        });
      }
      throw error;
    }
    return built;
  }

  async compareAndSwap(
    recordId: string,
    expectedVersion: number,
    nextValue: CanonicalJsonValue,
  ): Promise<VersionedRecord> {
    this.#assertOpen();
    const expected = parseRevision(expectedVersion);
    const id = parseRecordId(recordId);
    const repository = parseRepositoryName(this.#repository);
    canonicalizeJson(nextValue); // fail closed before mutating (matches the reference)
    const updated = await this.#tx
      .query(
        `UPDATE ${RECORDS_TABLE} SET version = version + 1, value = $3::jsonb, updated_at = now()
         WHERE repository = $1 AND record_id = $2 AND version = $4
         RETURNING ${RECORD_COLUMNS}`,
        [repository, id, jsonToParam(nextValue), expected],
      )
      .catch(mapSqlError);
    const row = updated.rows[0];
    if (row === undefined) {
      throw new ConflictError(
        "compare-and-swap conflict: the record does not exist or its stored version does not match the expected version (it was changed concurrently); re-read and retry - never overwrite silently",
        { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
      );
    }
    return recordFromRow(row);
  }

  async delete(recordId: string, expectedVersion: number): Promise<void> {
    this.#assertOpen();
    const expected = parseRevision(expectedVersion);
    const id = parseRecordId(recordId);
    const repository = parseRepositoryName(this.#repository);
    const deleted = await this.#tx
      .query(
        `DELETE FROM ${RECORDS_TABLE}
         WHERE repository = $1 AND record_id = $2 AND version = $3`,
        [repository, id, expected],
      )
      .catch(mapSqlError);
    if (deleted.rowCount === 0) {
      throw new ConflictError(
        "compare-and-swap delete conflict: the record does not exist or its version does not match",
        { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
      );
    }
  }

  async get(recordId: string): Promise<VersionedRecord | null> {
    this.#assertOpen();
    const rows = await this.#tx
      .query(
        `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE repository = $1 AND record_id = $2`,
        [parseRepositoryName(this.#repository), parseRecordId(recordId)],
      )
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : recordFromRow(row);
  }

  async list(): Promise<readonly VersionedRecord[]> {
    this.#assertOpen();
    const rows = await this.#tx
      .query(
        `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE repository = $1 ORDER BY record_id ASC`,
        [parseRepositoryName(this.#repository)],
      )
      .catch(mapSqlError);
    return Object.freeze(rows.rows.map(recordFromRow));
  }

  async count(): Promise<number> {
    this.#assertOpen();
    const rows = await this.#tx
      .query(`SELECT count(*)::int AS n FROM ${RECORDS_TABLE} WHERE repository = $1`, [
        parseRepositoryName(this.#repository),
      ])
      .catch(mapSqlError);
    return readCount(rows.rows, "records");
  }
}

// --------------------------------------------------------------------------------
// The unit of work + factory + reader
// --------------------------------------------------------------------------------

type SettledState = "open" | "committed" | "discarded";

class PostgresUnitOfWork implements UnitOfWork {
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
  readonly records: (repository: string) => RecordRepository;
  #settled: SettledState = "open";
  readonly #tx: SqlTransaction;
  readonly #views = new Map<string, RecordRepository>();

  constructor(tx: SqlTransaction) {
    this.#tx = tx;
    const assertOpen = (): void => this.#assertOpen();
    this.outbox = new PostgresOutboxView(tx, assertOpen);
    this.inbox = new PostgresInboxView(tx, assertOpen);
    this.records = (repository: string): RecordRepository => {
      const name = parseRepositoryName(repository);
      let view = this.#views.get(name);
      if (view === undefined) {
        view = new PostgresRecordsView(name, tx, assertOpen);
        this.#views.set(name, view);
      }
      return view;
    };
  }

  #assertOpen(): void {
    if (this.#settled !== "open") {
      throw new DomainError(
        "this unit of work is already settled (committed or discarded); open a new one",
        { reason: "UNIT_OF_WORK_SETTLED" },
      );
    }
  }

  async commit(): Promise<void> {
    if (this.#settled !== "open") {
      throw new DomainError("cannot commit a settled unit of work", {
        reason: "UNIT_OF_WORK_SETTLED",
      });
    }
    try {
      await this.#tx.commit();
      this.#settled = "committed";
    } catch (error) {
      this.#settled = "discarded";
      mapSqlError(error); // typed rethrow
    }
  }

  async rollback(): Promise<void> {
    if (this.#settled !== "open") return; // idempotent cleanup
    this.#settled = "discarded";
    await this.#tx.rollback();
  }
}

/** The PostgreSQL persistence adapter: a UnitOfWorkFactory + PersistenceReader. */
export interface PostgresPersistence extends UnitOfWorkFactory, PersistenceReader {}

/**
 * Creates the real PostgreSQL persistence adapter over a {@link SqlDriver}.
 * The underlying schema (roamlink_records / roamlink_outbox / roamlink_inbox)
 * is owned by the infra/migrations set (RL-092); the adapter fails loudly
 * when the schema is missing - it never creates tables implicitly.
 */
export function createPostgresPersistence(driver: SqlDriver): PostgresPersistence {
  return {
    async begin(): Promise<UnitOfWork> {
      const tx = await driver.begin();
      return new PostgresUnitOfWork(tx);
    },
    outbox: new PostgresCommittedOutbox(driver),
    inbox: new PostgresCommittedInbox(driver),
    records(repository: string): RecordReadRepository {
      return new PostgresCommittedRecords(driver, parseRepositoryName(repository));
    },
  };
}

// --------------------------------------------------------------------------------
// Committed-state readers (autocommit reads; never see uncommitted writes)
// --------------------------------------------------------------------------------

class PostgresCommittedOutbox implements OutboxReadRepository {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  async get(idempotencyKey: string): Promise<OutboxRecord | null> {
    const rows = await this.#driver
      .query(`SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1`, [
        idempotencyKey,
      ])
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : outboxFromRow(row);
  }

  list(deliveryState?: OutboxDeliveryState): Promise<readonly OutboxRecord[]> {
    return listOutboxSql(this.#driver, deliveryState);
  }

  count(deliveryState?: OutboxDeliveryState): Promise<number> {
    return countOutboxSql(this.#driver, deliveryState);
  }
}

class PostgresCommittedInbox implements InboxReadRepository {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  async get(sequence: number): Promise<InboxRecord | null> {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ValidationError("inbox sequence must be an integer >= 1", {
        reason: "INBOX_INPUT_INVALID",
      });
    }
    const rows = await this.#driver
      .query(`SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} WHERE sequence = $1`, [sequence])
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : inboxFromRow(row);
  }

  async admitted(dedupeKey: string): Promise<InboxRecord | null> {
    const rows = await this.#driver
      .query(
        `SELECT ${INBOX_COLUMNS} FROM ${INBOX_TABLE} WHERE dedupe_key = $1 AND admission_state = 'ADMITTED'`,
        [dedupeKey],
      )
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : inboxFromRow(row);
  }

  list(admissionState?: InboxAdmissionState): Promise<readonly InboxRecord[]> {
    return listInboxSql(this.#driver, admissionState);
  }

  count(admissionState?: InboxAdmissionState): Promise<number> {
    return countInboxSql(this.#driver, admissionState);
  }
}

class PostgresCommittedRecords implements RecordReadRepository {
  readonly #driver: SqlDriver;
  readonly #repository: string;

  constructor(driver: SqlDriver, repository: string) {
    this.#driver = driver;
    this.#repository = repository;
  }

  async get(recordId: string): Promise<VersionedRecord | null> {
    const rows = await this.#driver
      .query(
        `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE repository = $1 AND record_id = $2`,
        [this.#repository, parseRecordId(recordId)],
      )
      .catch(mapSqlError);
    const row = rows.rows[0];
    return row === undefined ? null : recordFromRow(row);
  }

  async list(): Promise<readonly VersionedRecord[]> {
    const rows = await this.#driver
      .query(
        `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE repository = $1 ORDER BY record_id ASC`,
        [this.#repository],
      )
      .catch(mapSqlError);
    return Object.freeze(rows.rows.map(recordFromRow));
  }

  async count(): Promise<number> {
    const rows = await this.#driver
      .query(`SELECT count(*)::int AS n FROM ${RECORDS_TABLE} WHERE repository = $1`, [
        this.#repository,
      ])
      .catch(mapSqlError);
    return readCount(rows.rows, "records");
  }
}

// --------------------------------------------------------------------------------
// Health/readiness wiring (consumed by the host; RL-089/RL-100)
// --------------------------------------------------------------------------------

/**
 * A health check compatible with the @roamlink/observability HealthRegistry
 * (name/run/HealthCheckOutput shape). `SELECT 1` proves the connection is
 * alive; any failure reports `down` with a SUPPRESSED detail (never driver
 * text, which may carry credentials - RL-LOCK-016).
 */
export function databaseHealthCheck(driver: SqlDriver): {
  readonly name: string;
  readonly run: () => Promise<{
    readonly name: string;
    readonly state: "healthy" | "down";
    readonly detail?: string;
    readonly checkedAt: UtcInstant;
  }>;
} {
  return {
    name: "database",
    run: async () => {
      const checkedAt = nowUtc();
      try {
        await driver.ping();
        return { name: "database", state: "healthy", checkedAt };
      } catch {
        return { name: "database", state: "down", detail: "the database did not answer its liveness probe", checkedAt };
      }
    },
  };
}
