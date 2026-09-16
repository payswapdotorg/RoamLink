/**
 * The /v1/notifications API resources (RL-014, spec/api.md).
 *
 * The PUBLIC response shapes for the notifications API surface. Per the
 * API contract: responses expose RoamLink state plus relevant ADCOS
 * REFERENCES/EVIDENCE, and never expose internal ADCOS implementation
 * types. The mapper is PURE: it takes committed records (+ optional
 * evidence summaries the composition layer resolves from the
 * commerce-connectivity reference model) and produces the wire shape.
 *
 * Evidence summaries are STRUCTURAL inputs (freshness + evidence class +
 * canonical resource references): they are references to ADCOS-derived
 * state with provenance - exactly what the API contract wants exposed -
 * and never raw provider/carrier internals (RL-LOCK-006/010).
 */
import type { UtcInstant } from "@roamlink/contracts";

import type { ChannelDeliveryRecord } from "./channel-delivery.js";
import type {
  NotificationRecord,
  NotificationRelatedRef,
  TransitionOrigin,
} from "./notification.js";
import type { NotificationChannel } from "./preferences.js";

/** The freshness/evidence summary inlined into a related reference. */
export interface RelatedEvidenceSummary {
  readonly freshnessState: "FRESH" | "STALE" | "UNKNOWN";
  readonly observedAt: UtcInstant | null;
  readonly receivedAt: UtcInstant | null;
  readonly freshUntil: UtcInstant | null;
  readonly evidenceClass: string;
  readonly canonicalResourceType: string;
  readonly canonicalResourceId: string;
}

/** One related reference on the wire (kind + id + optional evidence). */
export interface RelatedRefApiResource {
  readonly kind: NotificationRelatedRef["kind"];
  readonly id: string;
  readonly evidence?: RelatedEvidenceSummary;
}

/** The source block: WHICH durable RoamLink transition caused this. */
export interface NotificationSourceApiResource {
  readonly origin: TransitionOrigin["origin"];
  readonly aggregateType: TransitionOrigin["aggregateType"];
  readonly aggregateId: string;
  readonly transition: string;
  readonly eventId: string;
  readonly occurredAt: UtcInstant;
}

/** One channel delivery attempt on the wire. */
export interface ChannelDeliveryApiResource {
  readonly channel: NotificationChannel;
  readonly outcome: "delivered" | "failed";
  readonly detail?: string;
  readonly attemptedAt: UtcInstant;
}

/** The /v1/notifications/{id} response resource. */
export interface NotificationApiResource {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly recipientUserId: string;
  readonly topic: NotificationRecord["topic"];
  readonly severity: NotificationRecord["severity"];
  readonly title: string;
  readonly body: string;
  readonly state: NotificationRecord["status"];
  readonly source: NotificationSourceApiResource;
  readonly related: readonly RelatedRefApiResource[];
  readonly channels: readonly ChannelDeliveryApiResource[];
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly deliveredAt?: UtcInstant;
  readonly readAt?: UtcInstant;
}

/**
 * Options for the mapper: the delivery attempts to include and an optional
 * evidence resolver (composition layer binds it to the
 * commerce-connectivity reference read model).
 */
export interface ToNotificationApiResourceOptions {
  readonly deliveries?: readonly ChannelDeliveryRecord[];
  /** Resolves the evidence summary for a related reference (optional). */
  readonly evidenceFor?: (ref: NotificationRelatedRef) => RelatedEvidenceSummary | undefined;
}

/**
 * Maps a committed notification record to the /v1/notifications wire
 * shape. Pure: the same record + deliveries + resolver produce the same
 * resource. No ADCOS implementation type is ever exposed - only the
 * evidence summaries explicitly provided.
 */
export function toNotificationApiResource(
  record: NotificationRecord,
  options?: ToNotificationApiResourceOptions,
): NotificationApiResource {
  const evidenceFor = options?.evidenceFor;
  const deliveries = options?.deliveries ?? [];
  return Object.freeze({
    notificationId: record.notificationId,
    tenantId: record.tenantId,
    recipientUserId: record.recipientUserId,
    topic: record.topic,
    severity: record.severity,
    title: record.title,
    body: record.body,
    state: record.status,
    source: Object.freeze({
      origin: record.source.origin,
      aggregateType: record.source.aggregateType,
      aggregateId: record.source.aggregateId,
      transition: record.source.transition,
      eventId: record.source.eventId,
      occurredAt: record.source.occurredAt,
    }),
    related: Object.freeze(
      record.relatedRefs.map((ref) => {
        const evidence = evidenceFor?.(ref);
        return Object.freeze({
          kind: ref.kind,
          id: ref.id,
          ...(evidence !== undefined ? { evidence } : {}),
        });
      }),
    ),
    channels: Object.freeze(
      deliveries.map((delivery) =>
        Object.freeze({
          channel: delivery.channel,
          outcome: delivery.outcome,
          ...(delivery.detail !== undefined ? { detail: delivery.detail } : {}),
          attemptedAt: delivery.attemptedAt,
        }),
      ),
    ),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.deliveredAt !== undefined ? { deliveredAt: record.deliveredAt } : {}),
    ...(record.readAt !== undefined ? { readAt: record.readAt } : {}),
  });
}

/** Maps many records (list responses) under the same options. */
export function toNotificationApiResources(
  records: readonly NotificationRecord[],
  options?: ToNotificationApiResourceOptions,
): readonly NotificationApiResource[] {
  return Object.freeze(records.map((record) => toNotificationApiResource(record, options)));
}
