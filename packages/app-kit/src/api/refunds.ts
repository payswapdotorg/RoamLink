/**
 * The customer refund read mirror (PA-002, closes RL-115-F4; additive to
 * the application API surface; RL-LOCK-017 additive-change tolerance).
 *
 * apps/web may import ONLY this package - the refund READ contract is
 * mirrored here so the customer order-journey surface never imports
 * @roamlink/domain-commerce (tests/architecture wave4-a boundary fence).
 * Every state vocabulary below is a CONTRACT MIRROR of the owning domain
 * read model, drift-guarded by tests/architecture:
 *
 *  - customer refund states   <- packages/domain-commerce/src/refund-read.ts
 *                                (REFUND_READ_STATES, itself the mirror of
 *                                the CustomerRefund aggregate's
 *                                CUSTOMER_REFUND_STATES)
 *  - refund reason codes      <- packages/domain-commerce/src/refund-read.ts
 *                                (REFUND_READ_REASON_CODES)
 *  - refund failure reasons   <- packages/domain-commerce/src/refund-read.ts
 *                                (REFUND_READ_FAILURE_REASONS)
 *
 * PA-002: the order journey read (OrderDetailResource) gains the READ-ONLY
 * refund section additively. The section is ADDITIVE on the wire
 * (RL-LOCK-017): an older payload without it parses to the honest null
 * section ("not available" - the order journey surface composes no refund
 * read), which stays DISTINCT from an empty section (the read is composed
 * and no refunds exist for this order). Refunds are MONEY FACTS ONLY: a
 * refund state never asserts that connectivity was or was not delivered
 * (RL-LOCK-008 "payment is not delivery").
 *
 * The mirror carries NO refund command, request flow or write vocabulary:
 * refund EXECUTION (the succeed/fail/cancel transitions and the
 * partial-refund bounds) lives upstream in the CustomerRefund aggregate's
 * commerce-operations surface. The customer surface renders the recorded
 * state read-only - it never composes a refund button (no write contract
 * backs one). Content-level invariants (a failed refund carrying its typed
 * failure reason) are enforced by the OWNING domain record parser in
 * packages/domain-commerce; this mirror parses the wire shape and the
 * closed vocabularies, exactly like the enterprise mirrors.
 */

import { ValidationError } from "@roamlink/contracts";

import {
  asEnum,
  asNonNegativeInt,
  asObject,
  asOptionalString,
  asString,
  rejectUnknownFields,
  requireFields,
} from "./parse-kit.js";
import { parseFreshnessView } from "./resources.js";
import type { FreshnessView, MoneyView } from "./resources.js";

/**
 * The closed `customer_refund_state` vocabulary, mirrored from the owning
 * domain read model (REFUND_READ_STATES <- the aggregate's
 * CUSTOMER_REFUND_STATES): pending / succeeded / failed / cancelled -
 * never collapsed, never merged with payment/invoice/order states
 * (RL-LOCK-008).
 */
export const CUSTOMER_REFUND_RESOURCE_STATES = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type CustomerRefundResourceState = (typeof CUSTOMER_REFUND_RESOURCE_STATES)[number];

/**
 * The closed refund reason-code vocabulary, mirrored from the owning domain
 * read model (REFUND_READ_REASON_CODES <- the aggregate's
 * REFUND_REASON_CODES): typed audit facts; a label explains the commercial
 * decision, it never asserts delivery evidence.
 */
export const REFUND_REASON_RESOURCE_CODES = [
  "customer_request",
  "service_not_delivered",
  "billing_error",
  "duplicate_charge",
  "goodwill",
  "other",
] as const;

export type RefundReasonResourceCode = (typeof REFUND_REASON_RESOURCE_CODES)[number];

/**
 * The closed refund failure-reason vocabulary, mirrored from the owning
 * domain read model (REFUND_READ_FAILURE_REASONS <- the aggregate's
 * REFUND_FAILURE_REASONS): typed diagnostics a failed refund carries.
 */
export const CUSTOMER_REFUND_FAILURE_RESOURCE_REASONS = [
  "processor_error",
  "payment_instrument_unreachable",
  "compliance_hold",
  "cancelled_by_operator",
] as const;

export type CustomerRefundFailureResourceReason =
  (typeof CUSTOMER_REFUND_FAILURE_RESOURCE_REASONS)[number];

/**
 * The READ-ONLY refund view (PA-002, closes RL-115-F4): one row per
 * refund recorded against this order's payments. `note` is the optional
 * human-facing reason summary; `failureReason` rides only with the
 * `failed` state (the owning domain record enforces this fail-closed).
 * Freshness is the SAME FreshnessView contract every other read carries
 * (never redefined here) and PAIRS with the state at render - a stale read
 * keeps its content PAIRED with the stale badge (spec/ux-architecture.md
 * §14).
 */
export interface RefundView {
  readonly refundId: string;
  /** The SUCCEEDED payment this refund returns money from (parent reference). */
  readonly paymentId: string;
  readonly state: CustomerRefundResourceState;
  /** Exact refund amount (integer minor units + ISO-4217-style code). */
  readonly amount: MoneyView;
  readonly reasonCode: RefundReasonResourceCode;
  /** Optional human-facing reason summary (the aggregate's bounded note). */
  readonly note?: string;
  /** Present only when the state is `failed` (the domain's invariant). */
  readonly failureReason?: CustomerRefundFailureResourceReason;
  readonly freshness: FreshnessView;
}

function refundField(label: string, issue: string): never {
  throw new ValidationError(`RefundView rejected: ${label} - ${issue}`, {
    reason: "REFUND_VIEW_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseRefundAmount(label: string, value: unknown): MoneyView {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["amountMinor", "currency"]);
  requireFields(label, record, ["amountMinor", "currency"]);
  const currency = asString(`${label}.currency`, record["currency"]);
  if (!/^[A-Z]{3}$/.test(currency)) {
    refundField(`${label}.currency`, "must be an ISO-4217-style code (3 uppercase letters)");
  }
  return Object.freeze({
    amountMinor: asNonNegativeInt(`${label}.amountMinor`, record["amountMinor"]),
    currency,
  });
}

/**
 * Parses the order journey's refund section. Null (or an older payload
 * without the field - RL-LOCK-017 additive tolerance) parses to the honest
 * null section: the surface composes no refund read, never a guessed
 * refund. A present section must be an array of well-formed views with
 * UNIQUE refund ids (exactly one view per refund), closed state/reason
 * vocabularies and money-fact amounts (integer minor units, never floats).
 */
export function parseRefundSection(
  label: string,
  value: unknown,
): readonly RefundView[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    refundField(label, "must be an array of refund views (or null)");
  }
  const views: RefundView[] = [];
  const seenIds = new Set<string>();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const record = asObject(entryLabel, entry);
    rejectUnknownFields(entryLabel, record, [
      "refundId",
      "paymentId",
      "amount",
      "state",
      "reasonCode",
      "note",
      "failureReason",
      "freshness",
    ]);
    requireFields(entryLabel, record, [
      "refundId",
      "paymentId",
      "amount",
      "state",
      "reasonCode",
      "freshness",
    ]);
    const refundId = asString(`${entryLabel}.refundId`, record["refundId"]);
    if (seenIds.has(refundId)) {
      refundField(entryLabel, `duplicate refund id '${refundId}' (exactly one view per refund)`);
    }
    seenIds.add(refundId);
    const failureReason =
      record["failureReason"] === null || record["failureReason"] === undefined
        ? undefined
        : (asEnum(
            `${entryLabel}.failureReason`,
            CUSTOMER_REFUND_FAILURE_RESOURCE_REASONS,
            record["failureReason"],
          ) as CustomerRefundFailureResourceReason);
    const note = asOptionalString(`${entryLabel}.note`, record["note"]);
    views.push(
      Object.freeze({
        refundId,
        paymentId: asString(`${entryLabel}.paymentId`, record["paymentId"]),
        state: asEnum(`${entryLabel}.state`, CUSTOMER_REFUND_RESOURCE_STATES, record["state"]),
        amount: parseRefundAmount(`${entryLabel}.amount`, record["amount"]),
        reasonCode: asEnum(`${entryLabel}.reasonCode`, REFUND_REASON_RESOURCE_CODES, record["reasonCode"]),
        ...(note !== undefined ? { note } : {}),
        ...(failureReason !== undefined ? { failureReason } : {}),
        freshness: parseFreshnessView(`${entryLabel}.freshness`, record["freshness"]),
      }),
    );
  });
  return Object.freeze(views);
}
