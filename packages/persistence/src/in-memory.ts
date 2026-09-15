/**
 * In-memory deterministic persistence adapter (RL-003).
 *
 * Implements {@link ./unit-of-work.js.UnitOfWorkFactory} and
 * {@link ./unit-of-work.js.PersistenceReader} with NO external dependencies
 * so the persistence ports run in CI and unit tests
 * (spec/repository-layout.md: PostgreSQL-compatible behind contracts; the
 * port must run on in-memory in CI).
 *
 * Determinism:
 *  - every time-dependent operation takes an explicit caller-supplied UTC
 *    instant; the adapter never reads an ambient clock;
 *  - record lists are ordered by recordId; outbox/inbox iteration follows
 *    insertion (arrival) order.
 *
 * Optimistic-transaction semantics:
 *  - `begin()` snapshots the committed state (repeatable reads + your own
 *    writes inside the unit of work);
 *  - `commit()` replays the recorded operations against a clone of the
 *    CURRENT committed state. The synchronous replay loop makes
 *    validate-and-swap atomic: when any operation's precondition no longer
 *    holds (a concurrent committer won a race) commit throws a typed
 *    ConflictError and NOTHING is applied;
 *  - results returned by views of an open unit of work are provisional until
 *    commit (a concurrent committer may turn an outbox enqueue into a no-op
 *    or an inbox admission into a duplicate audit row);
 *  - inbox sequence numbers are assigned at apply time in commit order.
 */
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  canonicalizeJson,
  epochMsOf,
  parseRevision,
  parseUtcInstant,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  buildInboxRecord,
  type InboxAdmitInput,
  type InboxAdmitResult,
  type InboxAdmissionState,
  type InboxReadRepository,
  type InboxRecord,
  type InboxRepository,
} from "./inbox.js";
import {
  buildOutboxRecord,
  claimOutboxRecord,
  completeOutboxDelivery,
  failOutboxAttempt,
  type OutboxDeliveryState,
  type OutboxEnqueueInput,
  type OutboxEnqueueOutcome,
  type OutboxReadRepository,
  type OutboxRecord,
  type OutboxRepository,
} from "./outbox.js";
import {
  buildVersionedRecord,
  nextRevision,
  parseRecordId,
  parseRepositoryName,
  type RecordReadRepository,
  type RecordRepository,
  type VersionedRecord,
} from "./optimistic-concurrency.js";
import type { PersistenceReader, UnitOfWork, UnitOfWorkFactory } from "./unit-of-work.js";

// --------------------------------------------------------------------------------
// Internal committed state
// --------------------------------------------------------------------------------

class PersistenceState {
  readonly outbox = new Map<string, OutboxRecord>();
  readonly inbox: InboxRecord[] = [];
  readonly inboxAdmitted = new Map<string, InboxRecord>();
  readonly records = new Map<string, Map<string, VersionedRecord>>();

  /** Deep clone with re-frozen records, for snapshots and commit replay. */
  static clone(state: PersistenceState): PersistenceState {
    const next = new PersistenceState();
    for (const [key, record] of state.outbox) {
      next.outbox.set(key, cloneOutboxRecord(record));
    }
    for (const record of state.inbox) {
      const copy = Object.freeze({ ...record });
      next.inbox.push(copy);
      if (copy.admissionState === "ADMITTED") {
        next.inboxAdmitted.set(copy.dedupeKey, copy);
      }
    }
    for (const [repository, records] of state.records) {
      const map = new Map<string, VersionedRecord>();
      for (const [recordId, record] of records) {
        map.set(recordId, cloneVersionedRecord(record));
      }
      next.records.set(repository, map);
    }
    return next;
  }
}

function cloneOutboxRecord(record: OutboxRecord): OutboxRecord {
  return Object.freeze({
    ...record,
    payloadBytes: new Uint8Array(record.payloadBytes),
    retryPolicy: Object.freeze({
      maxAttempts: record.retryPolicy.maxAttempts,
      backoffScheduleMs: Object.freeze([...record.retryPolicy.backoffScheduleMs]),
    }),
  });
}

function cloneVersionedRecord(record: VersionedRecord): VersionedRecord {
  return Object.freeze({
    recordId: record.recordId,
    version: record.version,
    value: structuredClone(record.value),
  });
}

function mustGetOutbox(state: PersistenceState, idempotencyKey: string): OutboxRecord {
  const record = state.outbox.get(idempotencyKey);
  if (record === undefined) {
    throw new NotFoundError("outbox record with this idempotency key does not exist", {
      reason: "OUTBOX_RECORD_UNKNOWN",
    });
  }
  return record;
}

// --------------------------------------------------------------------------------
// Shared operation appliers (used by unit-of-work views AND commit replay)
// --------------------------------------------------------------------------------

function applyOutboxEnqueue(
  state: PersistenceState,
  input: OutboxEnqueueInput,
): OutboxEnqueueOutcome {
  const record = buildOutboxRecord(input);
  const existing = state.outbox.get(record.idempotencyKey);
  if (existing !== undefined) {
    if (existing.payloadDigest === record.payloadDigest) {
      return { outcome: "ALREADY_ENQUEUED", record: existing };
    }
    throw new ConflictError(
      "outbox enqueue conflict: this idempotency key is already enqueued with a DIFFERENT payload digest (retries must reuse the same payload; never silently overwrite)",
      { reason: "OUTBOX_IDEMPOTENCY_CONFLICT" },
    );
  }
  state.outbox.set(record.idempotencyKey, record);
  return { outcome: "ENQUEUED", record };
}

function applyOutboxClaim(
  state: PersistenceState,
  keys: readonly string[],
  at: UtcInstant,
): readonly OutboxRecord[] {
  const claimed: OutboxRecord[] = [];
  for (const key of keys) {
    const record = mustGetOutbox(state, key);
    const next = claimOutboxRecord(record, at);
    state.outbox.set(key, next);
    claimed.push(next);
  }
  return claimed;
}

function applyOutboxDelivered(
  state: PersistenceState,
  idempotencyKey: string,
  at: UtcInstant,
): OutboxRecord {
  const record = mustGetOutbox(state, idempotencyKey);
  const next = completeOutboxDelivery(record, at);
  state.outbox.set(idempotencyKey, next);
  return next;
}

function applyOutboxAttemptFailed(
  state: PersistenceState,
  idempotencyKey: string,
  at: UtcInstant,
  reason: string | null,
): OutboxRecord {
  const record = mustGetOutbox(state, idempotencyKey);
  const next = failOutboxAttempt(record, at, reason === null ? undefined : reason);
  state.outbox.set(idempotencyKey, next);
  return next;
}

function applyInboxAdmit(state: PersistenceState, input: InboxAdmitInput): InboxAdmitResult {
  const original = state.inboxAdmitted.get(input.dedupeKey);
  if (original !== undefined) {
    const duplicate = buildInboxRecord(input, state.inbox.length + 1, "DUPLICATE");
    state.inbox.push(duplicate);
    return { outcome: "DUPLICATE", record: duplicate, original };
  }
  const admitted = buildInboxRecord(input, state.inbox.length + 1, "ADMITTED");
  state.inbox.push(admitted);
  state.inboxAdmitted.set(admitted.dedupeKey, admitted);
  return { outcome: "ADMITTED", record: admitted };
}

function applyInboxReject(state: PersistenceState, input: InboxAdmitInput): InboxRecord {
  const rejected = buildInboxRecord(input, state.inbox.length + 1, "REJECTED");
  state.inbox.push(rejected);
  return rejected;
}

function applyRecordInsert(
  state: PersistenceState,
  repository: string,
  record: VersionedRecord,
): VersionedRecord {
  let map = state.records.get(repository);
  if (map === undefined) {
    map = new Map<string, VersionedRecord>();
    state.records.set(repository, map);
  }
  if (map.has(record.recordId)) {
    throw new ConflictError("a record with this id already exists in the repository", {
      reason: "RECORD_ALREADY_EXISTS",
    });
  }
  const stored: VersionedRecord = Object.freeze({
    recordId: record.recordId,
    version: record.version,
    value: structuredClone(record.value),
  });
  map.set(record.recordId, stored);
  return stored;
}

function applyRecordCas(
  state: PersistenceState,
  repository: string,
  recordId: string,
  expectedVersion: Revision,
  nextValue: VersionedRecord["value"],
): VersionedRecord {
  // validate the incoming value exactly like an insert (fail-closed before mutating)
  canonicalizeJson(nextValue);
  const map = state.records.get(repository);
  if (map === undefined) {
    throw new ConflictError(
      "compare-and-swap target record does not exist (it was deleted concurrently, or never existed)",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
  const current = map.get(recordId);
  if (current === undefined) {
    throw new ConflictError(
      "compare-and-swap target record does not exist (it was deleted concurrently, or never existed)",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
  if (current.version !== expectedVersion) {
    throw new ConflictError(
      "optimistic-concurrency conflict: the stored version does not match the expected version (the record was changed concurrently, or does not exist); re-read and retry - never overwrite silently",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
  const next: VersionedRecord = Object.freeze({
    recordId: current.recordId,
    version: nextRevision(expectedVersion),
    value: structuredClone(nextValue),
  });
  map.set(recordId, next);
  return next;
}

function applyRecordDelete(
  state: PersistenceState,
  repository: string,
  recordId: string,
  expectedVersion: Revision,
): void {
  const map = state.records.get(repository);
  const current = map === undefined ? undefined : map.get(recordId);
  if (current === undefined || current.version !== expectedVersion || map === undefined) {
    throw new ConflictError(
      "compare-and-swap delete conflict: the record does not exist or its version does not match",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
  map.delete(recordId);
}

// --------------------------------------------------------------------------------
// Recorded operations (replayed at commit)
// --------------------------------------------------------------------------------

type PendingOp =
  | { readonly kind: "outbox-enqueue"; readonly input: OutboxEnqueueInput }
  | { readonly kind: "outbox-claim"; readonly keys: readonly string[]; readonly at: UtcInstant }
  | { readonly kind: "outbox-delivered"; readonly idempotencyKey: string; readonly at: UtcInstant }
  | {
      readonly kind: "outbox-attempt-failed";
      readonly idempotencyKey: string;
      readonly at: UtcInstant;
      readonly reason: string | null;
    }
  | { readonly kind: "inbox-admit"; readonly input: InboxAdmitInput }
  | { readonly kind: "inbox-reject"; readonly input: InboxAdmitInput }
  | {
      readonly kind: "record-insert";
      readonly repository: string;
      readonly record: VersionedRecord;
    }
  | {
      readonly kind: "record-cas";
      readonly repository: string;
      readonly recordId: string;
      readonly expectedVersion: Revision;
      readonly nextValue: VersionedRecord["value"];
    }
  | {
      readonly kind: "record-delete";
      readonly repository: string;
      readonly recordId: string;
      readonly expectedVersion: Revision;
    };

// --------------------------------------------------------------------------------
// Repository views
// --------------------------------------------------------------------------------

/** Everything a view needs from its owning scope (unit of work or reader). */
interface ViewContext {
  /** The state the view reads/writes (a unit of work's overlay, or live). */
  state(): PersistenceState;
  /** Records a pending operation (units of work only). */
  record(op: PendingOp): void;
  /** Refuses use after the unit of work settled (no-op for readers). */
  assertOpen(): void;
}

class OutboxView implements OutboxRepository {
  private readonly ctx: ViewContext;

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
  }

  async enqueue(input: OutboxEnqueueInput): Promise<OutboxEnqueueOutcome> {
    this.ctx.assertOpen();
    const outcome = applyOutboxEnqueue(this.ctx.state(), input);
    this.ctx.record({ kind: "outbox-enqueue", input });
    return outcome;
  }

  async claimDue(at: string, limit: number): Promise<readonly OutboxRecord[]> {
    this.ctx.assertOpen();
    const atInstant = parseUtcInstant(at);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new DomainError("outbox claim limit must be an integer >= 1", {
        reason: "OUTBOX_CLAIM_LIMIT_INVALID",
      });
    }
    const state = this.ctx.state();
    const due: string[] = [];
    for (const [key, record] of state.outbox) {
      if (due.length >= limit) break;
      if (record.deliveryState !== "PENDING") continue;
      const dueAt = record.nextAttemptAt;
      if (dueAt === null) continue;
      if (epochMsOf(dueAt) <= epochMsOf(atInstant)) due.push(key);
    }
    const claimed = applyOutboxClaim(state, due, atInstant);
    this.ctx.record({ kind: "outbox-claim", keys: due, at: atInstant });
    return claimed;
  }

  async markDelivered(idempotencyKey: string, at: string): Promise<OutboxRecord> {
    this.ctx.assertOpen();
    const atInstant = parseUtcInstant(at);
    const record = applyOutboxDelivered(this.ctx.state(), idempotencyKey, atInstant);
    this.ctx.record({ kind: "outbox-delivered", idempotencyKey, at: atInstant });
    return record;
  }

  async markAttemptFailed(
    idempotencyKey: string,
    at: string,
    reason?: string,
  ): Promise<OutboxRecord> {
    this.ctx.assertOpen();
    const atInstant = parseUtcInstant(at);
    const record = applyOutboxAttemptFailed(
      this.ctx.state(),
      idempotencyKey,
      atInstant,
      reason ?? null,
    );
    this.ctx.record({
      kind: "outbox-attempt-failed",
      idempotencyKey,
      at: atInstant,
      reason: reason ?? null,
    });
    return record;
  }

  async get(idempotencyKey: string): Promise<OutboxRecord | null> {
    this.ctx.assertOpen();
    return this.ctx.state().outbox.get(idempotencyKey) ?? null;
  }

  async list(deliveryState?: OutboxDeliveryState): Promise<readonly OutboxRecord[]> {
    this.ctx.assertOpen();
    return listOutbox(this.ctx.state(), deliveryState);
  }

  async count(deliveryState?: OutboxDeliveryState): Promise<number> {
    this.ctx.assertOpen();
    return listOutbox(this.ctx.state(), deliveryState).length;
  }
}

function listOutbox(
  state: PersistenceState,
  deliveryState?: OutboxDeliveryState,
): readonly OutboxRecord[] {
  const all = [...state.outbox.values()];
  return Object.freeze(
    deliveryState === undefined
      ? all
      : all.filter((record) => record.deliveryState === deliveryState),
  );
}

/** Read-only committed outbox view (no write methods exist on it at all). */
class OutboxReadView implements OutboxReadRepository {
  private readonly ctx: ViewContext;

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
  }

  async get(idempotencyKey: string): Promise<OutboxRecord | null> {
    return this.ctx.state().outbox.get(idempotencyKey) ?? null;
  }

  async list(deliveryState?: OutboxDeliveryState): Promise<readonly OutboxRecord[]> {
    return listOutbox(this.ctx.state(), deliveryState);
  }

  async count(deliveryState?: OutboxDeliveryState): Promise<number> {
    return listOutbox(this.ctx.state(), deliveryState).length;
  }
}

class InboxView implements InboxRepository {
  private readonly ctx: ViewContext;

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
  }

  async admit(input: InboxAdmitInput): Promise<InboxAdmitResult> {
    this.ctx.assertOpen();
    const result = applyInboxAdmit(this.ctx.state(), input);
    this.ctx.record({ kind: "inbox-admit", input });
    return result;
  }

  async recordRejection(input: InboxAdmitInput): Promise<InboxRecord> {
    this.ctx.assertOpen();
    const record = applyInboxReject(this.ctx.state(), input);
    this.ctx.record({ kind: "inbox-reject", input });
    return record;
  }

  async get(sequence: number): Promise<InboxRecord | null> {
    this.ctx.assertOpen();
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ValidationError("inbox sequence must be an integer >= 1", {
        reason: "INBOX_INPUT_INVALID",
        details: [{ path: "InboxRecord.sequence", issue: "not a positive integer" }],
      });
    }
    const record = this.ctx.state().inbox[sequence - 1];
    return record === undefined ? null : record;
  }

  async admitted(dedupeKey: string): Promise<InboxRecord | null> {
    this.ctx.assertOpen();
    return this.ctx.state().inboxAdmitted.get(dedupeKey) ?? null;
  }

  async list(admissionState?: InboxAdmissionState): Promise<readonly InboxRecord[]> {
    this.ctx.assertOpen();
    return listInbox(this.ctx.state(), admissionState);
  }

  async count(admissionState?: InboxAdmissionState): Promise<number> {
    this.ctx.assertOpen();
    return listInbox(this.ctx.state(), admissionState).length;
  }
}

function listInbox(
  state: PersistenceState,
  admissionState?: InboxAdmissionState,
): readonly InboxRecord[] {
  const all = [...state.inbox];
  return Object.freeze(
    admissionState === undefined
      ? all
      : all.filter((record) => record.admissionState === admissionState),
  );
}

/** Read-only committed inbox view (no write methods exist on it at all). */
class InboxReadView implements InboxReadRepository {
  private readonly ctx: ViewContext;

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
  }

  async get(sequence: number): Promise<InboxRecord | null> {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ValidationError("inbox sequence must be an integer >= 1", {
        reason: "INBOX_INPUT_INVALID",
        details: [{ path: "InboxRecord.sequence", issue: "not a positive integer" }],
      });
    }
    const record = this.ctx.state().inbox[sequence - 1];
    return record === undefined ? null : record;
  }

  async admitted(dedupeKey: string): Promise<InboxRecord | null> {
    return this.ctx.state().inboxAdmitted.get(dedupeKey) ?? null;
  }

  async list(admissionState?: InboxAdmissionState): Promise<readonly InboxRecord[]> {
    return listInbox(this.ctx.state(), admissionState);
  }

  async count(admissionState?: InboxAdmissionState): Promise<number> {
    return listInbox(this.ctx.state(), admissionState).length;
  }
}

class RecordsView implements RecordRepository {
  private readonly repository: string;
  private readonly ctx: ViewContext;

  constructor(repository: string, ctx: ViewContext) {
    this.repository = repository;
    this.ctx = ctx;
  }

  async insert(recordId: string, value: VersionedRecord["value"]): Promise<VersionedRecord> {
    this.ctx.assertOpen();
    const built = buildVersionedRecord(recordId, value);
    const stored = applyRecordInsert(this.ctx.state(), this.repository, built);
    this.ctx.record({ kind: "record-insert", repository: this.repository, record: built });
    return stored;
  }

  async compareAndSwap(
    recordId: string,
    expectedVersion: number,
    nextValue: VersionedRecord["value"],
  ): Promise<VersionedRecord> {
    this.ctx.assertOpen();
    const expected = parseRevision(expectedVersion);
    const id = parseRecordId(recordId);
    const next = applyRecordCas(this.ctx.state(), this.repository, id, expected, nextValue);
    this.ctx.record({
      kind: "record-cas",
      repository: this.repository,
      recordId: id,
      expectedVersion: expected,
      nextValue: nextValue,
    });
    return next;
  }

  async delete(recordId: string, expectedVersion: number): Promise<void> {
    this.ctx.assertOpen();
    const expected = parseRevision(expectedVersion);
    const id = parseRecordId(recordId);
    applyRecordDelete(this.ctx.state(), this.repository, id, expected);
    this.ctx.record({
      kind: "record-delete",
      repository: this.repository,
      recordId: id,
      expectedVersion: expected,
    });
  }

  async get(recordId: string): Promise<VersionedRecord | null> {
    this.ctx.assertOpen();
    const map = this.ctx.state().records.get(this.repository);
    return (map === undefined ? undefined : map.get(recordId)) ?? null;
  }

  async list(): Promise<readonly VersionedRecord[]> {
    this.ctx.assertOpen();
    const map = this.ctx.state().records.get(this.repository);
    const all = map === undefined ? [] : [...map.values()];
    return Object.freeze(
      [...all].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)),
    );
  }

  async count(): Promise<number> {
    this.ctx.assertOpen();
    const map = this.ctx.state().records.get(this.repository);
    return map === undefined ? 0 : map.size;
  }
}

/** Read-only committed record view (no write methods exist on it at all). */
class RecordsReadView implements RecordReadRepository {
  private readonly repository: string;
  private readonly ctx: ViewContext;

  constructor(repository: string, ctx: ViewContext) {
    this.repository = repository;
    this.ctx = ctx;
  }

  async get(recordId: string): Promise<VersionedRecord | null> {
    const map = this.ctx.state().records.get(this.repository);
    return (map === undefined ? undefined : map.get(recordId)) ?? null;
  }

  async list(): Promise<readonly VersionedRecord[]> {
    const map = this.ctx.state().records.get(this.repository);
    const all = map === undefined ? [] : [...map.values()];
    return Object.freeze(
      [...all].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)),
    );
  }

  async count(): Promise<number> {
    const map = this.ctx.state().records.get(this.repository);
    return map === undefined ? 0 : map.size;
  }
}

// --------------------------------------------------------------------------------
// The unit of work
// --------------------------------------------------------------------------------

type SettledState = "open" | "committed" | "discarded";

class InMemoryUnitOfWork implements UnitOfWork {
  private settled: SettledState = "open";
  private readonly ops: PendingOp[] = [];
  private readonly overlay: PersistenceState;
  private readonly committedStore: { state: PersistenceState };
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
  readonly records: (repository: string) => RecordRepository;

  constructor(store: { state: PersistenceState }) {
    this.committedStore = store;
    this.overlay = PersistenceState.clone(store.state);
    const ctx: ViewContext = {
      state: (): PersistenceState => this.openOverlay(),
      record: (op: PendingOp): void => this.recordOp(op),
      assertOpen: (): void => this.assertOpen(),
    };
    this.outbox = new OutboxView(ctx);
    this.inbox = new InboxView(ctx);
    const views = new Map<string, RecordRepository>();
    this.records = (repository: string): RecordRepository => {
      const name = parseRepositoryName(repository);
      let view = views.get(name);
      if (view === undefined) {
        view = new RecordsView(name, ctx);
        views.set(name, view);
      }
      return view;
    };
  }

  private openOverlay(): PersistenceState {
    this.assertOpen();
    return this.overlay;
  }

  private assertOpen(): void {
    if (this.settled !== "open") {
      throw new DomainError(
        "this unit of work is already settled (committed or discarded); open a new one",
        { reason: "UNIT_OF_WORK_SETTLED" },
      );
    }
  }

  private recordOp(op: PendingOp): void {
    this.assertOpen();
    this.ops.push(op);
  }

  async commit(): Promise<void> {
    if (this.settled !== "open") {
      throw new DomainError("cannot commit a settled unit of work", {
        reason: "UNIT_OF_WORK_SETTLED",
      });
    }
    try {
      // Replay every recorded operation against the CURRENT committed state.
      // The synchronous loop means validate-and-swap is atomic: any failure
      // leaves the store untouched.
      const virtual = PersistenceState.clone(this.committedStore.state);
      for (const op of this.ops) {
        this.replay(virtual, op);
      }
      this.committedStore.state = virtual;
      this.settled = "committed";
    } catch (error) {
      // A failed commit discards the unit of work entirely.
      this.settled = "discarded";
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (this.settled !== "open") return; // idempotent cleanup
    this.settled = "discarded";
  }

  /** Replays one operation; races surface as typed ConflictError. */
  private replay(state: PersistenceState, op: PendingOp): void {
    try {
      switch (op.kind) {
        case "outbox-enqueue":
          applyOutboxEnqueue(state, op.input);
          return;
        case "outbox-claim":
          applyOutboxClaim(state, op.keys, op.at);
          return;
        case "outbox-delivered":
          applyOutboxDelivered(state, op.idempotencyKey, op.at);
          return;
        case "outbox-attempt-failed":
          applyOutboxAttemptFailed(state, op.idempotencyKey, op.at, op.reason);
          return;
        case "inbox-admit":
          applyInboxAdmit(state, op.input);
          return;
        case "inbox-reject":
          applyInboxReject(state, op.input);
          return;
        case "record-insert":
          applyRecordInsert(state, op.repository, op.record);
          return;
        case "record-cas":
          applyRecordCas(state, op.repository, op.recordId, op.expectedVersion, op.nextValue);
          return;
        case "record-delete":
          applyRecordDelete(state, op.repository, op.recordId, op.expectedVersion);
          return;
      }
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof DomainError) {
        // The precondition held against the begin snapshot but not against the
        // current committed state: a concurrent committer won the race.
        throw new ConflictError(
          "commit conflict: a concurrent unit of work changed the state this unit of work depended on; nothing was applied",
          { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT", cause: error },
        );
      }
      throw error;
    }
  }
}

// --------------------------------------------------------------------------------
// Public factory
// --------------------------------------------------------------------------------

/** The in-memory persistence adapter: a UnitOfWorkFactory + PersistenceReader. */
export interface InMemoryPersistence extends UnitOfWorkFactory, PersistenceReader {}

function readOnlyContext(store: { state: PersistenceState }): ViewContext {
  return {
    state: (): PersistenceState => store.state,
    record(_op: PendingOp): void {
      throw new DomainError("committed reader views are read-only; open a unit of work to write", {
        reason: "READ_ONLY_VIEW",
      });
    },
    assertOpen(): void {
      // readers are never settled
    },
  };
}

/**
 * Creates a deterministic in-memory persistence adapter. Writes are ONLY
 * possible through `begin()`; reads see committed state exclusively.
 */
export function createInMemoryPersistence(): InMemoryPersistence {
  const store: { state: PersistenceState } = { state: new PersistenceState() };
  const reader = readOnlyContext(store);
  return {
    async begin(): Promise<UnitOfWork> {
      return new InMemoryUnitOfWork(store);
    },
    outbox: new OutboxReadView(reader),
    inbox: new InboxReadView(reader),
    records(repository: string): RecordReadRepository {
      return new RecordsReadView(parseRepositoryName(repository), reader);
    },
  };
}
