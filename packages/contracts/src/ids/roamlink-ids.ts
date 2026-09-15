/**
 * RoamLink-owned opaque identifiers (RL-002, spec/data-model.md "Identity rules").
 *
 * RoamLink IDs are opaque, globally unique identifiers and are never reused
 * for ADCOS NodeID, session ID, path ID or provider IDs. Foreign/canonical IDs
 * live in {@link ./foreign-refs.js} as explicitly separate reference types and
 * are not interchangeable with these (RL-LOCK-003).
 *
 * Canonical form: lowercase RFC 9562 UUID text (see {@link ./id-shapes.js}).
 * Generate with `crypto.randomUUID()`; parse with the `parse*` helpers.
 */
import type { Branded } from "../brand.js";
import { isCanonicalUuid, parseCanonicalUuidAs } from "./id-shapes.js";

// --- Experience domain (spec/data-model.md aggregates) -------------------------

export type UserId = Branded<"UserId">;
export type OrganizationId = Branded<"OrganizationId">;
export type MembershipId = Branded<"MembershipId">;
export type DeviceId = Branded<"DeviceId">;
export type DeviceCapabilitySnapshotId = Branded<"DeviceCapabilitySnapshotId">;
export type DeviceContextSnapshotId = Branded<"DeviceContextSnapshotId">;
export type ExperienceIntentId = Branded<"ExperienceIntentId">;
export type ExperienceIntentVersionId = Branded<"ExperienceIntentVersionId">;
export type ExperienceDecisionId = Branded<"ExperienceDecisionId">;
export type NotificationId = Branded<"NotificationId">;

// --- Commerce domain ------------------------------------------------------------

export type ProductId = Branded<"ProductId">;
export type ProductVariantId = Branded<"ProductVariantId">;
export type OrderId = Branded<"OrderId">;
export type OrderLineId = Branded<"OrderLineId">;
export type SubscriptionId = Branded<"SubscriptionId">;
export type CustomerPaymentId = Branded<"CustomerPaymentId">;
export type CustomerInvoiceId = Branded<"CustomerInvoiceId">;
export type CustomerRefundId = Branded<"CustomerRefundId">;

/** Union of all RoamLink-owned opaque identifiers. */
export type RoamLinkId =
  | UserId
  | OrganizationId
  | MembershipId
  | DeviceId
  | DeviceCapabilitySnapshotId
  | DeviceContextSnapshotId
  | ExperienceIntentId
  | ExperienceIntentVersionId
  | ExperienceDecisionId
  | NotificationId
  | ProductId
  | ProductVariantId
  | OrderId
  | OrderLineId
  | SubscriptionId
  | CustomerPaymentId
  | CustomerInvoiceId
  | CustomerRefundId;

// --- parsers (validate shape, never guess) --------------------------------------

export function parseUserId(value: unknown): UserId {
  return parseCanonicalUuidAs<UserId>(value, "UserId");
}
export function parseOrganizationId(value: unknown): OrganizationId {
  return parseCanonicalUuidAs<OrganizationId>(value, "OrganizationId");
}
export function parseMembershipId(value: unknown): MembershipId {
  return parseCanonicalUuidAs<MembershipId>(value, "MembershipId");
}
export function parseDeviceId(value: unknown): DeviceId {
  return parseCanonicalUuidAs<DeviceId>(value, "DeviceId");
}
export function parseDeviceCapabilitySnapshotId(value: unknown): DeviceCapabilitySnapshotId {
  return parseCanonicalUuidAs<DeviceCapabilitySnapshotId>(value, "DeviceCapabilitySnapshotId");
}
export function parseDeviceContextSnapshotId(value: unknown): DeviceContextSnapshotId {
  return parseCanonicalUuidAs<DeviceContextSnapshotId>(value, "DeviceContextSnapshotId");
}
export function parseExperienceIntentId(value: unknown): ExperienceIntentId {
  return parseCanonicalUuidAs<ExperienceIntentId>(value, "ExperienceIntentId");
}
export function parseExperienceIntentVersionId(value: unknown): ExperienceIntentVersionId {
  return parseCanonicalUuidAs<ExperienceIntentVersionId>(value, "ExperienceIntentVersionId");
}
export function parseExperienceDecisionId(value: unknown): ExperienceDecisionId {
  return parseCanonicalUuidAs<ExperienceDecisionId>(value, "ExperienceDecisionId");
}
export function parseNotificationId(value: unknown): NotificationId {
  return parseCanonicalUuidAs<NotificationId>(value, "NotificationId");
}
export function parseProductId(value: unknown): ProductId {
  return parseCanonicalUuidAs<ProductId>(value, "ProductId");
}
export function parseProductVariantId(value: unknown): ProductVariantId {
  return parseCanonicalUuidAs<ProductVariantId>(value, "ProductVariantId");
}
export function parseOrderId(value: unknown): OrderId {
  return parseCanonicalUuidAs<OrderId>(value, "OrderId");
}
export function parseOrderLineId(value: unknown): OrderLineId {
  return parseCanonicalUuidAs<OrderLineId>(value, "OrderLineId");
}
export function parseSubscriptionId(value: unknown): SubscriptionId {
  return parseCanonicalUuidAs<SubscriptionId>(value, "SubscriptionId");
}
export function parseCustomerPaymentId(value: unknown): CustomerPaymentId {
  return parseCanonicalUuidAs<CustomerPaymentId>(value, "CustomerPaymentId");
}
export function parseCustomerInvoiceId(value: unknown): CustomerInvoiceId {
  return parseCanonicalUuidAs<CustomerInvoiceId>(value, "CustomerInvoiceId");
}
export function parseCustomerRefundId(value: unknown): CustomerRefundId {
  return parseCanonicalUuidAs<CustomerRefundId>(value, "CustomerRefundId");
}

// --- type guards -----------------------------------------------------------------

export function isUserId(value: unknown): value is UserId {
  return isCanonicalUuid(value);
}
export function isOrganizationId(value: unknown): value is OrganizationId {
  return isCanonicalUuid(value);
}
export function isMembershipId(value: unknown): value is MembershipId {
  return isCanonicalUuid(value);
}
export function isDeviceId(value: unknown): value is DeviceId {
  return isCanonicalUuid(value);
}
export function isDeviceCapabilitySnapshotId(value: unknown): value is DeviceCapabilitySnapshotId {
  return isCanonicalUuid(value);
}
export function isDeviceContextSnapshotId(value: unknown): value is DeviceContextSnapshotId {
  return isCanonicalUuid(value);
}
export function isExperienceIntentId(value: unknown): value is ExperienceIntentId {
  return isCanonicalUuid(value);
}
export function isExperienceIntentVersionId(value: unknown): value is ExperienceIntentVersionId {
  return isCanonicalUuid(value);
}
export function isExperienceDecisionId(value: unknown): value is ExperienceDecisionId {
  return isCanonicalUuid(value);
}
export function isNotificationId(value: unknown): value is NotificationId {
  return isCanonicalUuid(value);
}
export function isProductId(value: unknown): value is ProductId {
  return isCanonicalUuid(value);
}
export function isProductVariantId(value: unknown): value is ProductVariantId {
  return isCanonicalUuid(value);
}
export function isOrderId(value: unknown): value is OrderId {
  return isCanonicalUuid(value);
}
export function isOrderLineId(value: unknown): value is OrderLineId {
  return isCanonicalUuid(value);
}
export function isSubscriptionId(value: unknown): value is SubscriptionId {
  return isCanonicalUuid(value);
}
export function isCustomerPaymentId(value: unknown): value is CustomerPaymentId {
  return isCanonicalUuid(value);
}
export function isCustomerInvoiceId(value: unknown): value is CustomerInvoiceId {
  return isCanonicalUuid(value);
}
export function isCustomerRefundId(value: unknown): value is CustomerRefundId {
  return isCanonicalUuid(value);
}
