/**
 * In-memory reference-model store over the Wave-0 persistence primitives
 * (RL-023).
 *
 * TEST/LOCAL-DEVELOPMENT DOUBLE with the semantics a durable
 * implementation must provide (mirrors @roamlink/domain-commerce's
 * in-memory store): sessions are persistence units of work (reference +
 * event commit atomically), writes are compare-and-swap on the record
 * revision, record keys are tenant-namespaced and every read re-verifies
 * the stored record's tenant (no existence oracle, RL-LOCK-018), and
 * events are append-only with per-aggregate chain continuity.
 */
import { ConflictError, ValidationError, type CanonicalJsonValue } from "@roamlink/contracts";
import {
  createInMemoryPersistence,
  type InMemoryPersistence,
  type RecordReadRepository,
  type UnitOfWork,
  type VersionedRecord,
} from "@roamlink/persistence";

import { ConnectivityReferenceEvent, type ConnectivityReferenceEventRecord } from "./events.js";
import type { ConnectivityReferenceRecord } from "./reference.js";
import type {
  ConnectivityReferenceEventRepository,
  ConnectivityReferenceReader,
  ConnectivityReferenceReadViews,
  ConnectivityReferenceRepository,
  ConnectivityReferenceSession,
  ConnectivityReferenceStore,
} from "./ports.js";

const REPOSITORY_NAMES = {
  references: "commerce-connectivity-references",
  events: "commerce-connectivity-events",
} as const;

function revisionConflict(detail: string): ConflictError {
  return new ConflictError(
    `optimistic-concurrency conflict: ${detail}; re-read and retry - never overwrite silently`,
    { reason: "REVISION_CONFLICT" },
  );
}

function chainConflict(): ConflictError {
  return new ConflictError(
    "reference event chain violation: the per-aggregate sequence must be exactly latest + 1 and the event id must be new (events are immutable; a replayed or out-of-order event is rejected, never silently applied)",
    { reason: "REFERENCE_EVENT_CHAIN_CONFLICT" },
  );
}

function recordKey(tenantId: string, entityId: string): string {
  const key = `${tenantId}:${entityId}`;
  if (key.length > 255) {
    throw new ValidationError("record key too long", {
      reason: "ID_INVALID",
      details: [{ path: "recordKey", issue: "tenant + entity exceeds 255 characters" }],
    });
  }
  return key;
}

function toStored(record: object): CanonicalJsonValue {
  return structuredClone(record) as unknown as CanonicalJsonValue;
}

function frozenCopy<T extends object>(value: T): T {
  return Object.freeze(structuredClone(value)) as T;
}

function decodeTenantScoped<T extends { readonly tenantId: string }>(
  stored: VersionedRecord,
  tenantId: string,
): T | undefined {
  const value = stored.value as Record<string, unknown>;
  if (value["tenantId"] !== tenantId) return undefined; // fail closed: no existence oracle
  return frozenCopy(value as unknown as T);
}

interface RevisionedRecord {
  readonly tenantId: string;
  readonly revision: number;
}

async function casSave(
  uow: UnitOfWork,
  repository: string,
  key: string,
  record: RevisionedRecord,
): Promise<void> {
  const records = uow.records(repository);
  const stored = await records.get(key);
  if (stored === null) {
    if (record.revision !== 1) {
      throw revisionConflict("a new record must carry revision 1");
    }
    await records.insert(key, toStored(record));
    return;
  }
  if (stored.version !== record.revision - 1) {
    throw revisionConflict(
      "the stored revision does not match the expected predecessor (the record changed concurrently)",
    );
  }
  await records.compareAndSwap(key, record.revision - 1, toStored(record));
}

// ---------------------------------------------------------------------------
// Session-scoped repository views
// ---------------------------------------------------------------------------

class ReferenceSessionView implements ConnectivityReferenceRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: ConnectivityReferenceRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.references,
      recordKey(record.tenantId, record.referenceId),
      record,
    );
  }

  async findById(tenantId: ConnectivityReferenceRecord["tenantId"], referenceId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.references)
      .get(recordKey(tenantId, referenceId));
    return stored === null
      ? undefined
      : decodeTenantScoped<ConnectivityReferenceRecord>(stored, tenantId);
  }

  async findBySubject(
    tenantId: ConnectivityReferenceRecord["tenantId"],
    subjectType: "order" | "subscription",
    subjectId: string,
  ) {
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.references).list()) {
      const record = decodeTenantScoped<ConnectivityReferenceRecord>(stored, tenantId);
      if (
        record !== undefined &&
        record.subjectType === subjectType &&
        record.subjectId === subjectId
      ) {
        return record;
      }
    }
    return undefined;
  }

  async listByTenant(tenantId: ConnectivityReferenceRecord["tenantId"]) {
    const out: ConnectivityReferenceRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.references).list()) {
      const record = decodeTenantScoped<ConnectivityReferenceRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.referenceId < b.referenceId ? -1 : 1)));
  }
}

class ReferenceEventSessionView implements ConnectivityReferenceEventRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async append(event: ConnectivityReferenceEventRecord): Promise<void> {
    ConnectivityReferenceEvent.fromRecord(event); // re-validate: fail closed
    const records = this.#uow.records(REPOSITORY_NAMES.events);
    const key = recordKey(event.tenantId, event.eventId);
    const stored = await records.get(key);
    if (stored !== null) {
      throw chainConflict();
    }
    const chain = await this.listForAggregate(event.tenantId, event.aggregateId);
    if (event.sequence !== chain.length + 1) {
      throw chainConflict();
    }
    await records.insert(key, toStored(event));
  }

  async findById(tenantId: ConnectivityReferenceEventRecord["tenantId"], eventId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.events)
      .get(recordKey(tenantId, eventId));
    return stored === null
      ? undefined
      : decodeTenantScoped<ConnectivityReferenceEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: ConnectivityReferenceEventRecord["tenantId"],
    aggregateId: string,
  ) {
    const out: ConnectivityReferenceEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<ConnectivityReferenceEventRecord>(stored, tenantId);
      if (record !== undefined && record.aggregateId === aggregateId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => a.sequence - b.sequence));
  }

  async listByTenant(tenantId: ConnectivityReferenceEventRecord["tenantId"]) {
    const out: ConnectivityReferenceEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<ConnectivityReferenceEventRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

// ---------------------------------------------------------------------------
// Committed-state readers
// ---------------------------------------------------------------------------

function listTenantScoped<T extends { readonly tenantId: string }>(
  repo: RecordReadRepository,
  tenantId: string,
): Promise<readonly T[]> {
  return (async () => {
    const out: T[] = [];
    for (const stored of await repo.list()) {
      const record = decodeTenantScoped<T>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  })();
}

class CommittedReferenceReader implements ConnectivityReferenceReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: ConnectivityReferenceRecord["tenantId"], referenceId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, referenceId));
    return stored === null
      ? undefined
      : decodeTenantScoped<ConnectivityReferenceRecord>(stored, tenantId);
  }

  async findBySubject(
    tenantId: ConnectivityReferenceRecord["tenantId"],
    subjectType: "order" | "subscription",
    subjectId: string,
  ) {
    const all = await listTenantScoped<ConnectivityReferenceRecord>(this.#repo, tenantId);
    return all.find(
      (record) => record.subjectType === subjectType && record.subjectId === subjectId,
    );
  }

  async listByTenant(tenantId: ConnectivityReferenceRecord["tenantId"]) {
    const all = await listTenantScoped<ConnectivityReferenceRecord>(this.#repo, tenantId);
    return Object.freeze([...all].sort((a, b) => (a.referenceId < b.referenceId ? -1 : 1)));
  }
}

class CommittedReferenceEventReader implements ConnectivityReferenceEventRepository {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async append(_event: ConnectivityReferenceEventRecord): Promise<void> {
    throw new ConflictError(
      "reference events are append-only through a session (committed-state readers never write)",
      { reason: "REFERENCE_EVENT_CHAIN_CONFLICT" },
    );
  }

  async findById(tenantId: ConnectivityReferenceEventRecord["tenantId"], eventId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, eventId));
    return stored === null
      ? undefined
      : decodeTenantScoped<ConnectivityReferenceEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: ConnectivityReferenceEventRecord["tenantId"],
    aggregateId: string,
  ) {
    const all = await listTenantScoped<ConnectivityReferenceEventRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((event) => event.aggregateId === aggregateId)
        .sort((a, b) => a.sequence - b.sequence),
    );
  }

  async listByTenant(tenantId: ConnectivityReferenceEventRecord["tenantId"]) {
    return listTenantScoped<ConnectivityReferenceEventRecord>(this.#repo, tenantId);
  }
}

// ---------------------------------------------------------------------------
// The session and the store
// ---------------------------------------------------------------------------

class InMemoryReferenceSession implements ConnectivityReferenceSession {
  readonly references: ConnectivityReferenceRepository;
  readonly events: ConnectivityReferenceEventRepository;
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
    this.references = new ReferenceSessionView(uow);
    this.events = new ReferenceEventSessionView(uow);
  }

  async commit(): Promise<void> {
    await this.#uow.commit();
  }

  async rollback(): Promise<void> {
    await this.#uow.rollback();
  }
}

/**
 * The in-memory reference-model store: sessions over persistence units of
 * work, committed-state readers over the persistence reader.
 */
export function createInMemoryConnectivityReferenceStore(): ConnectivityReferenceStore {
  const persistence: InMemoryPersistence = createInMemoryPersistence();

  const read: ConnectivityReferenceReadViews = {
    references: new CommittedReferenceReader(
      persistence.records(REPOSITORY_NAMES.references),
    ),
    events: new CommittedReferenceEventReader(persistence.records(REPOSITORY_NAMES.events)),
  };

  return {
    async begin(): Promise<ConnectivityReferenceSession> {
      const uow = await persistence.begin();
      return new InMemoryReferenceSession(uow);
    },
    read,
  };
}
