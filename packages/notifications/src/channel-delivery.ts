/**
 * Per-channel delivery attempts (RL-014, typed channel contracts).
 *
 * A ChannelDelivery is an IMMUTABLE, append-only record of ONE delivery
 * attempt of ONE notification through ONE channel (delivered | failed).
 * The notification's own state transitions (pending -> delivered/failed)
 * are derived facts the SERVICE computes from these attempts; the attempt
 * log itself is never edited (audit).
 */
import {
  ValidationError,
  parseNotificationId,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type NotificationId,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { isNotificationChannel, type NotificationChannel } from "./preferences.js";
import {
  NOTIFICATIONS_CONTRACT_VERSION,
  describeNotificationsVersionExpectation,
  isNotificationsRecordVersionCompatible,
} from "./version.js";

/** The closed delivery-outcome vocabulary. */
export const CHANNEL_DELIVERY_OUTCOMES = ["delivered", "failed"] as const;

export type ChannelDeliveryOutcome = (typeof CHANNEL_DELIVERY_OUTCOMES)[number];

export function isChannelDeliveryOutcome(value: unknown): value is ChannelDeliveryOutcome {
  return (
    typeof value === "string" &&
    (CHANNEL_DELIVERY_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Serialized (plain) form of a channel delivery attempt. */
export interface ChannelDeliveryRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly notificationId: NotificationId;
  readonly channel: NotificationChannel;
  readonly outcome: ChannelDeliveryOutcome;
  /** Optional typed diagnostic (closed charset; never credentials, RL-LOCK-016). */
  readonly detail?: string;
  readonly attemptedAt: UtcInstant;
  /** Immutable record: the revision is always 1. */
  readonly revision: Revision;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`ChannelDelivery rejected: ${label} - ${issue}`, {
    reason: "CHANNEL_DELIVERY_INVALID",
    details: [{ path: label, issue }],
  });
}

const DETAIL_PATTERN = /^[a-z][a-z0-9_.]{0,119}$/;

/** A validated, deeply frozen channel delivery attempt. */
export class ChannelDelivery {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly notificationId: NotificationId;
  readonly channel: NotificationChannel;
  readonly outcome: ChannelDeliveryOutcome;
  declare readonly detail?: string;
  readonly attemptedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: {
    readonly tenantId: string;
    readonly notificationId: string;
    readonly channel: string;
    readonly outcome: string;
    readonly detail?: string;
    readonly attemptedAt: string;
  }) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!["tenantId", "notificationId", "channel", "outcome", "detail", "attemptedAt"].includes(key)) {
        field(key, "unknown field (the channel-delivery vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    this.tenantId = parseTenantField(input.tenantId);
    this.notificationId = parseNotificationIdField(input.notificationId);
    if (!isNotificationChannel(input.channel)) {
      field("channel", "must be a member of the closed channel vocabulary");
    }
    this.channel = input.channel;
    if (!isChannelDeliveryOutcome(input.outcome)) {
      field("outcome", "must be delivered or failed");
    }
    this.outcome = input.outcome;
    if (input.detail !== undefined) {
      if (typeof input.detail !== "string" || !DETAIL_PATTERN.test(input.detail)) {
        field("detail", "must be a short lowercase diagnostic token (never credentials or free text, RL-LOCK-016)");
      }
      this.detail = input.detail;
    }
    this.attemptedAt = parseInstantField(input.attemptedAt, "attemptedAt");
    this.revision = 1 as Revision;
    Object.freeze(this);
  }

  toRecord(): ChannelDeliveryRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      notificationId: this.notificationId,
      channel: this.channel,
      outcome: this.outcome,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      attemptedAt: this.attemptedAt,
      revision: this.revision,
    });
  }
}

/** Validates a stored delivery record's contract version (fail-closed). */
export function assertChannelDeliveryRecordVersion(record: ChannelDeliveryRecord): void {
  if (!isNotificationsRecordVersionCompatible(record.contractVersion)) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

// --- shared field parsers ------------------------------------------------------

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseNotificationIdField(value: string): NotificationId {
  try {
    return parseNotificationId(value);
  } catch {
    field("notificationId", "must be a canonical lowercase UUID (the notified aggregate)");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}
