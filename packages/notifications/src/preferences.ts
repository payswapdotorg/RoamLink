/**
 * Notification channels and per-user preferences (RL-014, "notification
 * preferences/channels as typed contracts").
 *
 * Channels are a CLOSED vocabulary; preferences are per (tenant, user)
 * records mapping each topic to the set of ENABLED channels. The record is
 * versioned with a monotonic revision (RL-LOCK-017) and resolved through
 * {@link resolveEffectiveChannels}, which applies the documented DEFAULT
 * (in_app enabled, everything else disabled) for topics the record does
 * not mention. An EMPTY channel set is an explicit mute: notifications on
 * that topic are recorded but SUPPRESSED at creation (they remain durable
 * history - suppression is a state, never a deletion).
 */
import {
  ValidationError,
  parseTenantId,
  parseUserId,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UserId,
} from "@roamlink/contracts";

import {
  isNotificationTopic,
  NOTIFICATION_TOPICS,
  type NotificationTopic,
} from "./notification.js";
import {
  NOTIFICATIONS_CONTRACT_VERSION,
  describeNotificationsVersionExpectation,
  isNotificationsRecordVersionCompatible,
} from "./version.js";

/** The closed notification-channel vocabulary (typed contracts, RL-014). */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "push", "webhook"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return (
    typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

/** The factory default: in-app only, opt-in for the other channels. */
export const DEFAULT_TOPIC_CHANNELS: readonly NotificationChannel[] = Object.freeze(["in_app"]);

/** Per-topic enabled channels (sparse: unmentioned topics use the default). */
export type TopicChannels = Readonly<Partial<Record<NotificationTopic, readonly NotificationChannel[]>>>;

/** Serialized (plain) form of a preferences record. */
export interface NotificationPreferencesRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly channelsByTopic: TopicChannels;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: Revision;
}

/** Input accepted by the {@link NotificationPreferences} constructor. */
export interface NotificationPreferencesInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly channelsByTopic: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`NotificationPreferences rejected: ${label} - ${issue}`, {
    reason: "NOTIFICATION_PREFERENCES_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseTopicChannels(value: unknown): TopicChannels {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("channelsByTopic", "must be an object mapping topics to enabled-channel arrays");
  }
  const record = value as Record<string, unknown>;
  const out: Partial<Record<NotificationTopic, readonly NotificationChannel[]>> = {};
  for (const key of Object.keys(record)) {
    if (!isNotificationTopic(key)) {
      field(`channelsByTopic.${key}`, "unknown topic (the notification-topic vocabulary is closed)");
    }
    const channels = record[key];
    if (!Array.isArray(channels)) {
      field(`channelsByTopic.${key}`, "must be an array of enabled channels (empty = muted)");
    }
    const parsed: NotificationChannel[] = [];
    for (const channel of channels) {
      if (!isNotificationChannel(channel)) {
        field(`channelsByTopic.${key}[]`, "must be a member of the closed channel vocabulary");
      }
      if (parsed.includes(channel)) {
        field(`channelsByTopic.${key}[]`, "duplicated channel entry");
      }
      parsed.push(channel);
    }
    out[key as NotificationTopic] = Object.freeze(parsed);
  }
  return Object.freeze(out);
}

/** The per-user notification preferences aggregate (revisioned, CAS-aware). */
export class NotificationPreferences {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly channelsByTopic: TopicChannels;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: Revision;

  constructor(input: NotificationPreferencesInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!["tenantId", "userId", "channelsByTopic", "createdAt", "updatedAt", "revision"].includes(key)) {
        field(key, "unknown field (the preferences vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    this.tenantId = parseTenantField(input.tenantId);
    this.userId = parseUserField(input.userId);
    this.channelsByTopic = parseTopicChannels(input.channelsByTopic);
    this.createdAt = input.createdAt;
    this.updatedAt = input.updatedAt;
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /**
   * Replaces the per-topic channel map (a new revision). Preferences are
   * replaced wholesale - partial edits are composed by the caller.
   */
  replace(channelsByTopic: TopicChannels, updatedAt: string): NotificationPreferences {
    return new NotificationPreferences({
      tenantId: this.tenantId,
      userId: this.userId,
      channelsByTopic,
      createdAt: this.createdAt,
      updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): NotificationPreferencesRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      userId: this.userId,
      channelsByTopic: this.channelsByTopic,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: NotificationPreferencesRecord): NotificationPreferences {
    return new NotificationPreferences({
      tenantId: record.tenantId,
      userId: record.userId,
      channelsByTopic: record.channelsByTopic,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored preferences record's contract version (fail-closed). */
export function assertNotificationPreferencesRecordVersion(
  record: NotificationPreferencesRecord,
): void {
  if (!isNotificationsRecordVersionCompatible(record.contractVersion)) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

/**
 * The effective channels for a topic: the recorded set when the topic is
 * mentioned, the documented default otherwise. An empty recorded set is an
 * explicit mute (resolves to zero channels).
 */
export function resolveEffectiveChannels(
  preferences: NotificationPreferencesRecord | undefined,
  topic: NotificationTopic,
): readonly NotificationChannel[] {
  if (preferences === undefined) {
    return DEFAULT_TOPIC_CHANNELS;
  }
  const recorded = preferences.channelsByTopic[topic];
  return recorded === undefined ? DEFAULT_TOPIC_CHANNELS : recorded;
}

/** True when the topic is effectively muted (zero channels). */
export function isTopicMuted(
  preferences: NotificationPreferencesRecord | undefined,
  topic: NotificationTopic,
): boolean {
  return resolveEffectiveChannels(preferences, topic).length === 0;
}

/** All valid topics (helper for exhaustive preference construction). */
export const ALL_NOTIFICATION_TOPICS: readonly NotificationTopic[] = NOTIFICATION_TOPICS;

// --- shared field parsers ------------------------------------------------------

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseUserField(value: string): UserId {
  try {
    return parseUserId(value);
  } catch {
    field("userId", "must be a canonical lowercase UUID (the preferring customer)");
  }
}
