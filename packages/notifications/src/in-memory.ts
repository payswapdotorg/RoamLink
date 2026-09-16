/**
 * In-memory notifications store over the Wave-0 persistence primitives
 * (RL-014).
 *
 * TEST/LOCAL-DEVELOPMENT DOUBLE with the semantics a durable
 * implementation must provide (same discipline as the sibling domain
 * packages): sessions are persistence units of work (multi-record writes
 * commit atomically), mutable aggregates CAS on the record revision,
 * channel deliveries and case messages are immutable inserts, events are
 * append-only with per-aggregate chain continuity, and every read is
 * tenant-namespaced and fail-closed (RL-LOCK-018).
 */
import { ConflictError, ValidationError, type CanonicalJsonValue } from "@roamlink/contracts";
import {
  createInMemoryPersistence,
  type InMemoryPersistence,
  type RecordReadRepository,
  type UnitOfWork,
  type VersionedRecord,
} from "@roamlink/persistence";

import type { ChannelDeliveryRecord } from "./channel-delivery.js";
import { NotificationsEvent, type NotificationsEventRecord } from "./events.js";

import type { NotificationRecord } from "./notification.js";
import type { NotificationPreferencesRecord } from "./preferences.js";
import type {
  ChannelDeliveryReader,
  ChannelDeliveryRepository,
  NotificationPreferencesReader,
  NotificationPreferencesRepository,
  NotificationReader,
  NotificationRepository,
  NotificationsEventReader,
  NotificationsEventRepository,
  NotificationsReadViews,
  NotificationsSession,
  NotificationsStore,
  SupportCaseMessageReader,
  SupportCaseMessageRepository,
  SupportCaseReader,
  SupportCaseRepository,
} from "./ports.js";
import type { SupportCaseMessageRecord, SupportCaseRecord } from "./support-case.js";

const REPOSITORY_NAMES = {
  notifications: "notifications-notifications",
  channelDeliveries: "notifications-channel-deliveries",
  preferences: "notifications-preferences",
  supportCases: "notifications-support-cases",
  supportCaseMessages: "notifications-support-case-messages",
  events: "notifications-events",
} as const;

function revisionConflict(detail: string): ConflictError {
  return new ConflictError(
    `optimistic-concurrency conflict: ${detail}; re-read and retry - never overwrite silently`,
    { reason: "REVISION_CONFLICT" },
  );
}

function chainConflict(): ConflictError {
  return new ConflictError(
    "notifications event chain violation: the per-aggregate sequence must be exactly latest + 1 and the event id must be new (events are immutable)",
    { reason: "NOTIFICATIONS_EVENT_CHAIN_CONFLICT" },
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

async function insertImmutable(
  uow: UnitOfWork,
  repository: string,
  record: RevisionedRecord,
  entityId: string,
): Promise<void> {
  if (record.revision !== 1) {
    throw revisionConflict("the record is immutable (insert-only at revision 1)");
  }
  await uow.records(repository).insert(recordKey(record.tenantId, entityId), toStored(record));
}

// ---------------------------------------------------------------------------
// Session-scoped repository views
// ---------------------------------------------------------------------------

class NotificationSessionView implements NotificationRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: NotificationRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.notifications,
      recordKey(record.tenantId, record.notificationId),
      record,
    );
  }

  async findById(tenantId: NotificationRecord["tenantId"], notificationId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.notifications)
      .get(recordKey(tenantId, notificationId));
    return stored === null ? undefined : decodeTenantScoped<NotificationRecord>(stored, tenantId);
  }

  async listByRecipient(tenantId: NotificationRecord["tenantId"], recipientUserId: string) {
    const out: NotificationRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.notifications).list()) {
      const record = decodeTenantScoped<NotificationRecord>(stored, tenantId);
      if (record !== undefined && record.recipientUserId === recipientUserId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async listByTenant(tenantId: NotificationRecord["tenantId"]) {
    const out: NotificationRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.notifications).list()) {
      const record = decodeTenantScoped<NotificationRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }

  async listByRelatedRef(
    tenantId: NotificationRecord["tenantId"],
    ref: { readonly kind: string; readonly id: string },
  ) {
    const out: NotificationRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.notifications).list()) {
      const record = decodeTenantScoped<NotificationRecord>(stored, tenantId);
      if (
        record !== undefined &&
        record.relatedRefs.some((related) => related.kind === ref.kind && related.id === ref.id)
      ) {
        out.push(record);
      }
    }
    return Object.freeze(out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }
}

class ChannelDeliverySessionView implements ChannelDeliveryRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: ChannelDeliveryRecord): Promise<void> {
    // one delivery attempt per (notification, channel, attemptedAt): key by
    // notification + channel + attempt ordinal encoded in attemptedAt epoch
    const key = `${record.notificationId}:${record.channel}:${new Date(record.attemptedAt).getTime()}`;
    await insertImmutable(this.#uow, REPOSITORY_NAMES.channelDeliveries, record, key);
  }

  async listForNotification(
    tenantId: ChannelDeliveryRecord["tenantId"],
    notificationId: string,
  ) {
    const out: ChannelDeliveryRecord[] = [];
    const prefix = `${notificationId}:`;
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.channelDeliveries).list()) {
      const record = decodeTenantScoped<ChannelDeliveryRecord>(stored, tenantId);
      if (record !== undefined && record.notificationId === notificationId) {
        void prefix;
        out.push(record);
      }
    }
    return Object.freeze(
      out.sort((a, b) => (a.attemptedAt < b.attemptedAt ? -1 : a.attemptedAt > b.attemptedAt ? 1 : 0)),
    );
  }
}

class PreferencesSessionView implements NotificationPreferencesRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: NotificationPreferencesRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.preferences,
      recordKey(record.tenantId, record.userId),
      record,
    );
  }

  async findForUser(tenantId: NotificationPreferencesRecord["tenantId"], userId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.preferences)
      .get(recordKey(tenantId, userId));
    return stored === null
      ? undefined
      : decodeTenantScoped<NotificationPreferencesRecord>(stored, tenantId);
  }
}

class SupportCaseSessionView implements SupportCaseRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: SupportCaseRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.supportCases,
      recordKey(record.tenantId, record.supportCaseId),
      record,
    );
  }

  async findById(tenantId: SupportCaseRecord["tenantId"], supportCaseId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.supportCases)
      .get(recordKey(tenantId, supportCaseId));
    return stored === null ? undefined : decodeTenantScoped<SupportCaseRecord>(stored, tenantId);
  }

  async listByRequester(tenantId: SupportCaseRecord["tenantId"], requesterUserId: string) {
    const out: SupportCaseRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.supportCases).list()) {
      const record = decodeTenantScoped<SupportCaseRecord>(stored, tenantId);
      if (record !== undefined && record.requesterUserId === requesterUserId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async listByTenant(tenantId: SupportCaseRecord["tenantId"]) {
    const out: SupportCaseRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.supportCases).list()) {
      const record = decodeTenantScoped<SupportCaseRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }

  async listByRelatedRef(
    tenantId: SupportCaseRecord["tenantId"],
    ref: { readonly kind: string; readonly id: string },
  ) {
    const out: SupportCaseRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.supportCases).list()) {
      const record = decodeTenantScoped<SupportCaseRecord>(stored, tenantId);
      if (
        record !== undefined &&
        record.relatedRefs.some((related) => related.kind === ref.kind && related.id === ref.id)
      ) {
        out.push(record);
      }
    }
    return Object.freeze(out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }
}

class SupportCaseMessageSessionView implements SupportCaseMessageRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: SupportCaseMessageRecord): Promise<void> {
    await insertImmutable(this.#uow, REPOSITORY_NAMES.supportCaseMessages, record, record.messageId);
  }

  async listForCase(tenantId: SupportCaseMessageRecord["tenantId"], supportCaseId: string) {
    const out: SupportCaseMessageRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.supportCaseMessages).list()) {
      const record = decodeTenantScoped<SupportCaseMessageRecord>(stored, tenantId);
      if (record !== undefined && record.supportCaseId === supportCaseId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
  }
}

class NotificationsEventSessionView implements NotificationsEventRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async append(event: NotificationsEventRecord): Promise<void> {
    NotificationsEvent.fromRecord(event); // re-validate: fail closed
    const records = this.#uow.records(REPOSITORY_NAMES.events);
    const key = recordKey(event.tenantId, event.eventId);
    const stored = await records.get(key);
    if (stored !== null) {
      throw chainConflict();
    }
    const chain = await this.listForAggregate(event.tenantId, event.aggregateType, event.aggregateId);
    if (event.sequence !== chain.length + 1) {
      throw chainConflict();
    }
    await records.insert(key, toStored(event));
  }

  async findById(tenantId: NotificationsEventRecord["tenantId"], eventId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.events)
      .get(recordKey(tenantId, eventId));
    return stored === null
      ? undefined
      : decodeTenantScoped<NotificationsEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: NotificationsEventRecord["tenantId"],
    aggregateType: NotificationsEventRecord["aggregateType"],
    aggregateId: string,
  ) {
    const out: NotificationsEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<NotificationsEventRecord>(stored, tenantId);
      if (
        record !== undefined &&
        record.aggregateType === aggregateType &&
        record.aggregateId === aggregateId
      ) {
        out.push(record);
      }
    }
    return Object.freeze(out.sort((a, b) => a.sequence - b.sequence));
  }

  async listByTenant(tenantId: NotificationsEventRecord["tenantId"]) {
    const out: NotificationsEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<NotificationsEventRecord>(stored, tenantId);
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

class CommittedNotificationReader implements NotificationReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: NotificationRecord["tenantId"], notificationId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, notificationId));
    return stored === null ? undefined : decodeTenantScoped<NotificationRecord>(stored, tenantId);
  }

  async listByRecipient(tenantId: NotificationRecord["tenantId"], recipientUserId: string) {
    const all = await listTenantScoped<NotificationRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((notification) => notification.recipientUserId === recipientUserId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  listByTenant(tenantId: NotificationRecord["tenantId"]) {
    return listTenantScoped<NotificationRecord>(this.#repo, tenantId);
  }

  async listByRelatedRef(
    tenantId: NotificationRecord["tenantId"],
    ref: { readonly kind: string; readonly id: string },
  ) {
    const all = await listTenantScoped<NotificationRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((notification) =>
          notification.relatedRefs.some((related) => related.kind === ref.kind && related.id === ref.id),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }
}

class CommittedChannelDeliveryReader implements ChannelDeliveryReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async listForNotification(
    tenantId: ChannelDeliveryRecord["tenantId"],
    notificationId: string,
  ) {
    const all = await listTenantScoped<ChannelDeliveryRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((delivery) => delivery.notificationId === notificationId)
        .sort((a, b) => (a.attemptedAt < b.attemptedAt ? -1 : a.attemptedAt > b.attemptedAt ? 1 : 0)),
    );
  }
}

class CommittedPreferencesReader implements NotificationPreferencesReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findForUser(tenantId: NotificationPreferencesRecord["tenantId"], userId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, userId));
    return stored === null
      ? undefined
      : decodeTenantScoped<NotificationPreferencesRecord>(stored, tenantId);
  }
}

class CommittedSupportCaseReader implements SupportCaseReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: SupportCaseRecord["tenantId"], supportCaseId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, supportCaseId));
    return stored === null ? undefined : decodeTenantScoped<SupportCaseRecord>(stored, tenantId);
  }

  async listByRequester(tenantId: SupportCaseRecord["tenantId"], requesterUserId: string) {
    const all = await listTenantScoped<SupportCaseRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((supportCase) => supportCase.requesterUserId === requesterUserId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  listByTenant(tenantId: SupportCaseRecord["tenantId"]) {
    return listTenantScoped<SupportCaseRecord>(this.#repo, tenantId);
  }

  async listByRelatedRef(
    tenantId: SupportCaseRecord["tenantId"],
    ref: { readonly kind: string; readonly id: string },
  ) {
    const all = await listTenantScoped<SupportCaseRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((supportCase) =>
          supportCase.relatedRefs.some((related) => related.kind === ref.kind && related.id === ref.id),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }
}

class CommittedSupportCaseMessageReader implements SupportCaseMessageReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async listForCase(tenantId: SupportCaseMessageRecord["tenantId"], supportCaseId: string) {
    const all = await listTenantScoped<SupportCaseMessageRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((message) => message.supportCaseId === supportCaseId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    );
  }
}

class CommittedNotificationsEventReader implements NotificationsEventReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: NotificationsEventRecord["tenantId"], eventId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, eventId));
    return stored === null
      ? undefined
      : decodeTenantScoped<NotificationsEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: NotificationsEventRecord["tenantId"],
    aggregateType: NotificationsEventRecord["aggregateType"],
    aggregateId: string,
  ) {
    const all = await listTenantScoped<NotificationsEventRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter(
          (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
        )
        .sort((a, b) => a.sequence - b.sequence),
    );
  }

  listByTenant(tenantId: NotificationsEventRecord["tenantId"]) {
    return listTenantScoped<NotificationsEventRecord>(this.#repo, tenantId);
  }
}

// ---------------------------------------------------------------------------
// The session and the store
// ---------------------------------------------------------------------------

class InMemoryNotificationsSession implements NotificationsSession {
  readonly notifications: NotificationRepository;
  readonly channelDeliveries: ChannelDeliveryRepository;
  readonly preferences: NotificationPreferencesRepository;
  readonly supportCases: SupportCaseRepository;
  readonly supportCaseMessages: SupportCaseMessageRepository;
  readonly events: NotificationsEventRepository;
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
    this.notifications = new NotificationSessionView(uow);
    this.channelDeliveries = new ChannelDeliverySessionView(uow);
    this.preferences = new PreferencesSessionView(uow);
    this.supportCases = new SupportCaseSessionView(uow);
    this.supportCaseMessages = new SupportCaseMessageSessionView(uow);
    this.events = new NotificationsEventSessionView(uow);
  }

  async commit(): Promise<void> {
    await this.#uow.commit();
  }

  async rollback(): Promise<void> {
    await this.#uow.rollback();
  }
}

/** The in-memory notifications store. */
export function createInMemoryNotificationsStore(): NotificationsStore {
  const persistence: InMemoryPersistence = createInMemoryPersistence();

  const read: NotificationsReadViews = {
    notifications: new CommittedNotificationReader(
      persistence.records(REPOSITORY_NAMES.notifications),
    ),
    channelDeliveries: new CommittedChannelDeliveryReader(
      persistence.records(REPOSITORY_NAMES.channelDeliveries),
    ),
    preferences: new CommittedPreferencesReader(
      persistence.records(REPOSITORY_NAMES.preferences),
    ),
    supportCases: new CommittedSupportCaseReader(
      persistence.records(REPOSITORY_NAMES.supportCases),
    ),
    supportCaseMessages: new CommittedSupportCaseMessageReader(
      persistence.records(REPOSITORY_NAMES.supportCaseMessages),
    ),
    events: new CommittedNotificationsEventReader(
      persistence.records(REPOSITORY_NAMES.events),
    ),
  };

  return {
    async begin(): Promise<NotificationsSession> {
      const uow = await persistence.begin();
      return new InMemoryNotificationsSession(uow);
    },
    read,
  };
}
