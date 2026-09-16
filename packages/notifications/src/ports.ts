/**
 * Tenant-scoped notifications-domain ports (RL-014): the store, the access
 * policy and the read views.
 *
 * MULTI-TENANCY BY CONSTRUCTION (RL-LOCK-018): every record carries its
 * Wave-0 TenantId and every read takes the tenant namespace FIRST; a read
 * through the wrong tenant returns undefined/empty - no existence oracle.
 *
 * ALL WRITES are compare-and-swap on the record revision over the Wave-0
 * persistence primitives (RL-003). Channel deliveries and case messages
 * are IMMUTABLE inserts; notifications, preferences and support cases CAS
 * via their revisions (RL-LOCK-017).
 *
 * The {@link NotificationAccessPolicy} port is the authorization seam,
 * including the `support_case:internal` action that gates the
 * customer/internal visibility boundary on case messages.
 */
import type { ActorId, NotificationId, TenantId, UtcInstant, UserId } from "@roamlink/contracts";

import type { ChannelDeliveryRecord } from "./channel-delivery.js";
import type { NotificationsEventRecord } from "./events.js";
import type { NotificationRecord } from "./notification.js";
import type { NotificationPreferencesRecord } from "./preferences.js";
import type { SupportCaseMessageRecord, SupportCaseRecord } from "./support-case.js";
import type { SupportCaseId } from "./ids.js";

// ---------------------------------------------------------------------------
// Access policy (authorization seam)
// ---------------------------------------------------------------------------

/** The closed notifications-domain action vocabulary. */
export const NOTIFICATION_ACTIONS = [
  "notification:read",
  "notification:write",
  "support_case:read",
  "support_case:write",
  /** Gates INTERNAL-visibility case messages (the visibility boundary). */
  "support_case:internal",
  "preference:read",
  "preference:write",
] as const;

export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];

export function isNotificationAction(value: unknown): value is NotificationAction {
  return (
    typeof value === "string" && (NOTIFICATION_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The notifications access policy port. `authorize` resolves asynchronously
 * and throws UnauthorizedError on denial (fail closed).
 */
export interface NotificationAccessPolicy {
  authorize(
    actorId: ActorId,
    tenantId: TenantId,
    action: NotificationAction,
    at: UtcInstant,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Readers + repositories
// ---------------------------------------------------------------------------

/** Tenant-scoped notification reads. */
export interface NotificationReader {
  findById(tenantId: TenantId, notificationId: NotificationId): Promise<NotificationRecord | undefined>;
  listByRecipient(tenantId: TenantId, recipientUserId: UserId): Promise<readonly NotificationRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly NotificationRecord[]>;
  listByRelatedRef(
    tenantId: TenantId,
    ref: { readonly kind: string; readonly id: string },
  ): Promise<readonly NotificationRecord[]>;
}

/** Tenant-scoped notification repository (CAS on revision). */
export interface NotificationRepository extends NotificationReader {
  save(record: NotificationRecord): Promise<void>;
}

/** Tenant-scoped channel-delivery reads. */
export interface ChannelDeliveryReader {
  listForNotification(
    tenantId: TenantId,
    notificationId: NotificationId,
  ): Promise<readonly ChannelDeliveryRecord[]>;
}

/** Channel deliveries are IMMUTABLE (insert-only at revision 1). */
export interface ChannelDeliveryRepository extends ChannelDeliveryReader {
  save(record: ChannelDeliveryRecord): Promise<void>;
}

/** Tenant-scoped preferences reads. */
export interface NotificationPreferencesReader {
  findForUser(tenantId: TenantId, userId: UserId): Promise<NotificationPreferencesRecord | undefined>;
}

/** Tenant-scoped preferences repository (CAS on revision). */
export interface NotificationPreferencesRepository extends NotificationPreferencesReader {
  save(record: NotificationPreferencesRecord): Promise<void>;
}

/** Tenant-scoped support-case reads. */
export interface SupportCaseReader {
  findById(tenantId: TenantId, supportCaseId: SupportCaseId): Promise<SupportCaseRecord | undefined>;
  listByRequester(tenantId: TenantId, requesterUserId: UserId): Promise<readonly SupportCaseRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly SupportCaseRecord[]>;
  listByRelatedRef(
    tenantId: TenantId,
    ref: { readonly kind: string; readonly id: string },
  ): Promise<readonly SupportCaseRecord[]>;
}

/** Tenant-scoped support-case repository (CAS on revision). */
export interface SupportCaseRepository extends SupportCaseReader {
  save(record: SupportCaseRecord): Promise<void>;
}

/** Tenant-scoped case-message reads. */
export interface SupportCaseMessageReader {
  listForCase(tenantId: TenantId, supportCaseId: SupportCaseId): Promise<readonly SupportCaseMessageRecord[]>;
}

/** Case messages are IMMUTABLE (insert-only at revision 1). */
export interface SupportCaseMessageRepository extends SupportCaseMessageReader {
  save(record: SupportCaseMessageRecord): Promise<void>;
}

/** Tenant-scoped notifications-event reads. */
export interface NotificationsEventReader {
  findById(tenantId: TenantId, eventId: string): Promise<NotificationsEventRecord | undefined>;
  listForAggregate(
    tenantId: TenantId,
    aggregateType: NotificationsEventRecord["aggregateType"],
    aggregateId: string,
  ): Promise<readonly NotificationsEventRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly NotificationsEventRecord[]>;
}

/**
 * Notifications events are APPEND-ONLY and CHAINED per aggregate; no
 * mutation or deletion API exists.
 */
export interface NotificationsEventRepository extends NotificationsEventReader {
  append(event: NotificationsEventRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One atomic notifications-domain unit of work. */
export interface NotificationsSession {
  readonly notifications: NotificationRepository;
  readonly channelDeliveries: ChannelDeliveryRepository;
  readonly preferences: NotificationPreferencesRepository;
  readonly supportCases: SupportCaseRepository;
  readonly supportCaseMessages: SupportCaseMessageRepository;
  readonly events: NotificationsEventRepository;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Committed-state reads only. */
export interface NotificationsReadViews {
  readonly notifications: NotificationReader;
  readonly channelDeliveries: ChannelDeliveryReader;
  readonly preferences: NotificationPreferencesReader;
  readonly supportCases: SupportCaseReader;
  readonly supportCaseMessages: SupportCaseMessageReader;
  readonly events: NotificationsEventReader;
}

/** The notifications-domain store port. */
export interface NotificationsStore {
  begin(): Promise<NotificationsSession>;
  readonly read: NotificationsReadViews;
}
