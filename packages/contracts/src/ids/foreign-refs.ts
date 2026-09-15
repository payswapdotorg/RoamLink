/**
 * Foreign canonical reference types (RL-002, RL-LOCK-003).
 *
 * These reference ADCOS-owned (or other foreign) canonical identifiers.
 * They are EXPLICIT, separately-named types and are never interchangeable
 * with RoamLink-owned IDs (see {@link ./roamlink-ids.js}). RoamLink stores
 * them only in explicitly named reference fields.
 *
 * These types carry NO authority: they are opaque references to state owned
 * by the external system. The reference charset is intentionally conservative
 * (see {@link ./id-shapes.js}); if the pinned ADCOS public contract (RL-030)
 * defines a wider grammar, widen it through an additive contract change.
 */
import type { Branded } from "../brand.js";
import { isForeignRefShaped, parseForeignRefAs } from "./id-shapes.js";

/** Reference to an ADCOS canonical ConnectivityIntent (ADCOS-authoritative). */
export type AdcosIntentRef = Branded<"AdcosIntentRef">;
/** Reference to an ADCOS Contract (accepted-offer result). */
export type AdcosContractRef = Branded<"AdcosContractRef">;
/** Reference to an ADCOS Lease (grant/renew/revoke lifecycle). */
export type AdcosLeaseRef = Branded<"AdcosLeaseRef">;
/** Generic reference to an ADCOS canonical resource (projection records). */
export type AdcosResourceId = Branded<"AdcosResourceId">;
/** Reference to an ADCOS Offer. */
export type AdcosOfferRef = Branded<"AdcosOfferRef">;
/** Reference to an ADCOS Reservation. */
export type AdcosReservationRef = Branded<"AdcosReservationRef">;
/** Reference to an ADCOS logical Session (ADCOS-authoritative, projected only). */
export type AdcosSessionRef = Branded<"AdcosSessionRef">;
/** Reference to an ADCOS NetworkPath (ADCOS-authoritative, projected only). */
export type AdcosPathRef = Branded<"AdcosPathRef">;
/** ADCOS webhook event identifier (dedupe key for the inbox, RL-033). */
export type AdcosEventId = Branded<"AdcosEventId">;
/** ADCOS webhook delivery identifier. */
export type AdcosDeliveryId = Branded<"AdcosDeliveryId">;

/** Union of all foreign reference types. */
export type AdcosRef =
  | AdcosIntentRef
  | AdcosContractRef
  | AdcosLeaseRef
  | AdcosResourceId
  | AdcosOfferRef
  | AdcosReservationRef
  | AdcosSessionRef
  | AdcosPathRef
  | AdcosEventId
  | AdcosDeliveryId;

// --- parsers --------------------------------------------------------------------

export function parseAdcosIntentRef(value: unknown): AdcosIntentRef {
  return parseForeignRefAs<AdcosIntentRef>(value, "AdcosIntentRef");
}
export function parseAdcosContractRef(value: unknown): AdcosContractRef {
  return parseForeignRefAs<AdcosContractRef>(value, "AdcosContractRef");
}
export function parseAdcosLeaseRef(value: unknown): AdcosLeaseRef {
  return parseForeignRefAs<AdcosLeaseRef>(value, "AdcosLeaseRef");
}
export function parseAdcosResourceId(value: unknown): AdcosResourceId {
  return parseForeignRefAs<AdcosResourceId>(value, "AdcosResourceId");
}
export function parseAdcosOfferRef(value: unknown): AdcosOfferRef {
  return parseForeignRefAs<AdcosOfferRef>(value, "AdcosOfferRef");
}
export function parseAdcosReservationRef(value: unknown): AdcosReservationRef {
  return parseForeignRefAs<AdcosReservationRef>(value, "AdcosReservationRef");
}
export function parseAdcosSessionRef(value: unknown): AdcosSessionRef {
  return parseForeignRefAs<AdcosSessionRef>(value, "AdcosSessionRef");
}
export function parseAdcosPathRef(value: unknown): AdcosPathRef {
  return parseForeignRefAs<AdcosPathRef>(value, "AdcosPathRef");
}
export function parseAdcosEventId(value: unknown): AdcosEventId {
  return parseForeignRefAs<AdcosEventId>(value, "AdcosEventId");
}
export function parseAdcosDeliveryId(value: unknown): AdcosDeliveryId {
  return parseForeignRefAs<AdcosDeliveryId>(value, "AdcosDeliveryId");
}

// --- type guards ------------------------------------------------------------------

export function isAdcosIntentRef(value: unknown): value is AdcosIntentRef {
  return isForeignRefShaped(value);
}
export function isAdcosContractRef(value: unknown): value is AdcosContractRef {
  return isForeignRefShaped(value);
}
export function isAdcosLeaseRef(value: unknown): value is AdcosLeaseRef {
  return isForeignRefShaped(value);
}
export function isAdcosResourceId(value: unknown): value is AdcosResourceId {
  return isForeignRefShaped(value);
}
export function isAdcosOfferRef(value: unknown): value is AdcosOfferRef {
  return isForeignRefShaped(value);
}
export function isAdcosReservationRef(value: unknown): value is AdcosReservationRef {
  return isForeignRefShaped(value);
}
export function isAdcosSessionRef(value: unknown): value is AdcosSessionRef {
  return isForeignRefShaped(value);
}
export function isAdcosPathRef(value: unknown): value is AdcosPathRef {
  return isForeignRefShaped(value);
}
export function isAdcosEventId(value: unknown): value is AdcosEventId {
  return isForeignRefShaped(value);
}
export function isAdcosDeliveryId(value: unknown): value is AdcosDeliveryId {
  return isForeignRefShaped(value);
}
