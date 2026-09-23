/**
 * The customer refund READ MODEL record (PA-002, closes RL-115-F4;
 * spec/architecture.md §2 Layer B "customer-facing payment state, invoices,
 * refunds"; spec/data-model.md "Commerce" — the CustomerRefund aggregate).
 *
 * READ-ONLY BY CONSTRUCTION: this module deliberately owns NO refund
 * command, transition or write path. Refund EXECUTION (the succeed/fail/
 * cancel transitions and their bounds) lives upstream in the commerce
 * operations surface of the CustomerRefund aggregate
 * (packages/domain-commerce/src/refund.ts) — this record surfaces the
 * CURRENT read-side view of each refund, the same way the enterprise
 * policy/integration reads surface their upstream records. A parsed record
 * is a frozen observation; nothing here can create, advance or cancel a
 * refund.
 *
 * MIRRORED, NEVER REDEFINED: the closed vocabularies below are the
 * aggregate's own, mirrored member-for-member (the `satisfies` proofs pin
 * every read-model member to the aggregate's vocabulary at compile time,
 * and the package tests pin the full bidirectional equality at runtime):
 *
 *  - `REFUND_READ_STATES`        <- `CUSTOMER_REFUND_STATES`
 *    (pending / succeeded / failed / cancelled). The `customer_refund_state`
 *    vocabulary is its OWN and is never merged with `customer_payment_state`,
 *    `invoice_state`, `order_state` or any connectivity/delivery state
 *    (spec/data-model.md "State separation", RL-LOCK-008). A refund is never
 *    "captured"; a payment is never "partially_refunded".
 *  - `REFUND_READ_REASON_CODES`  <- `REFUND_REASON_CODES`
 *    (typed audit facts; a label explains the commercial decision, it never
 *    asserts delivery evidence).
 *  - `REFUND_READ_FAILURE_REASONS` <- `REFUND_FAILURE_REASONS`
 *    (typed diagnostics; a failed refund MUST record its failure reason —
 *    the aggregate's audit-completeness invariant, mirrored here).
 *
 * Freshness is first-class (RL-LOCK-010): the read record carries the SAME
 * `Freshness` contract from @roamlink/contracts every other read model
 * carries — used DIRECTLY, never redefined. A stale read of a succeeded
 * refund is a legal record: the state word stays PAIRED with the freshness
 * facts at render (spec/ux-architecture.md §14), so no coupling between
 * refund state and freshness state is imposed here — the render pairs them.
 *
 * Honest-state invariants (mirroring the aggregate, fail-closed):
 *  - a `failed` record MUST carry its typed `failureReason`, and a
 *    non-failed record MUST NOT carry one (the aggregate records the reason
 *    on the fail transition only);
 *  - the amount is a money value (integer minor units + ISO-4217-style
 *    code, same currency as the refunded payment — never a float);
 *  - an optional note is printable and bounded (the aggregate's bound);
 *  - the parent payment reference is a typed CustomerPaymentId and the
 *    refund id a typed CustomerRefundId (opaque, never reused);
 *  - unknown fields reject (the record carries exactly its contract
 *    fields — no delivery/connectivity fields exist on refunds,
 *    RL-LOCK-008).
 */
import {
  ValidationError,
  parseContractVersion,
  parseCustomerPaymentId,
  parseCustomerRefundId,
  parseFreshness,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type CustomerPaymentId,
  type CustomerRefundId,
  type Freshness,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { parseMoneyValue, type MoneyValue } from "./money.js";
import {
  MAX_REFUND_NOTE_LENGTH,
  type CustomerRefundState,
  type RefundFailureReason,
  type RefundReasonCode,
} from "./refund.js";
import {
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

/**
 * The closed `customer_refund_state` vocabulary, mirrored member-for-member
 * from the CustomerRefund aggregate (`CUSTOMER_REFUND_STATES`). ADDITIVE
 * within the major only (RL-LOCK-017) — a future refund state is a new
 * member, never a free-form label, and never a value borrowed from another
 * state family.
 */
export const REFUND_READ_STATES = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly CustomerRefundState[];

export type RefundReadState = (typeof REFUND_READ_STATES)[number];

export function isRefundReadState(value: unknown): value is RefundReadState {
  return (
    typeof value === "string" && (REFUND_READ_STATES as readonly string[]).includes(value)
  );
}

/**
 * The closed refund reason-code vocabulary, mirrored member-for-member from
 * the aggregate (`REFUND_REASON_CODES`): typed audit facts — a label
 * explains the commercial decision, it never asserts delivery evidence.
 */
export const REFUND_READ_REASON_CODES = [
  "customer_request",
  "service_not_delivered",
  "billing_error",
  "duplicate_charge",
  "goodwill",
  "other",
] as const satisfies readonly RefundReasonCode[];

export type RefundReadReasonCode = (typeof REFUND_READ_REASON_CODES)[number];

export function isRefundReadReasonCode(value: unknown): value is RefundReadReasonCode {
  return (
    typeof value === "string" &&
    (REFUND_READ_REASON_CODES as readonly string[]).includes(value)
  );
}

/**
 * The closed refund failure-reason vocabulary, mirrored member-for-member
 * from the aggregate (`REFUND_FAILURE_REASONS`): typed diagnostics a failed
 * refund must record (audit completeness).
 */
export const REFUND_READ_FAILURE_REASONS = [
  "processor_error",
  "payment_instrument_unreachable",
  "compliance_hold",
  "cancelled_by_operator",
] as const satisfies readonly RefundFailureReason[];

export type RefundReadFailureReason = (typeof REFUND_READ_FAILURE_REASONS)[number];

export function isRefundReadFailureReason(value: unknown): value is RefundReadFailureReason {
  return (
    typeof value === "string" &&
    (REFUND_READ_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/** Serialized (plain) form of one customer refund read record. */
export interface RefundReadRecord {
  readonly contractVersion: ContractVersion;
  /** The tenant boundary (tenant-scoped reads fail closed, RL-LOCK-018). */
  readonly tenantId: TenantId;
  readonly refundId: CustomerRefundId;
  /** The SUCCEEDED payment this refund returns money from (parent reference). */
  readonly paymentId: CustomerPaymentId;
  /** Exact refund amount (integer minor units, same currency as the payment). */
  readonly amount: MoneyValue;
  readonly reasonCode: RefundReadReasonCode;
  /** Optional human-facing note (printable, bounded — the aggregate's bound). */
  readonly note?: string;
  readonly state: RefundReadState;
  /** Present only on the `failed` state (the aggregate's audit completeness). */
  readonly failureReason?: RefundReadFailureReason;
  /** The observation facts backing the read (first-class, RL-LOCK-010). */
  readonly freshness: Freshness;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  /** Monotonic revision of the read record (publication ordering). */
  readonly revision: Revision;
}

/** Input accepted by {@link parseRefundReadRecord}. */
export interface RefundReadInput {
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly refundId: string;
  readonly paymentId: string;
  readonly amount: unknown;
  readonly reasonCode: string;
  readonly note?: string;
  readonly state: string;
  readonly failureReason?: string;
  readonly freshness: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_FIELDS = new Set([
  "contractVersion",
  "tenantId",
  "refundId",
  "paymentId",
  "amount",
  "reasonCode",
  "note",
  "state",
  "failureReason",
  "freshness",
  "createdAt",
  "updatedAt",
  "revision",
]);

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

function field(label: string, issue: string): never {
  throw new ValidationError(`RefundReadRecord rejected: ${label} - ${issue}`, {
    reason: "REFUND_READ_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes ONE customer refund read record. Fail-closed on
 * unknown fields, version drift, unknown ids, out-of-vocabulary states,
 * reason codes and failure reasons, and malformed money; the honest-state
 * invariants keep the aggregate's discipline (a failed refund carries its
 * typed failure reason — and only a failed refund does).
 */
export function parseRefundReadRecord(value: unknown): RefundReadRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the refund read record carries exactly its contract fields; no delivery/connectivity fields exist on refunds, RL-LOCK-008)");
    }
  }

  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isDomainCommerceRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    field("tenantId", "must be a RoamLink tenant id ('org:<uuid>' or 'usr:<uuid>')");
  }
  let refundId: CustomerRefundId;
  try {
    refundId = parseCustomerRefundId(input["refundId"]);
  } catch {
    field("refundId", "must be a canonical lowercase UUID");
  }
  let paymentId: CustomerPaymentId;
  try {
    paymentId = parseCustomerPaymentId(input["paymentId"]);
  } catch {
    field("paymentId", "must be a canonical lowercase UUID (the refunded payment)");
  }
  let amount: MoneyValue;
  try {
    amount = parseMoneyValue(input["amount"]);
  } catch {
    field("amount", "must be a valid money value (integer minor units + currency; never a float)");
  }

  if (!isRefundReadReasonCode(input["reasonCode"])) {
    field("reasonCode", "must be a member of the closed refund reason-code vocabulary (audit completeness)");
  }
  const reasonCode = input["reasonCode"];

  let note: string | undefined;
  if (input["note"] !== undefined) {
    if (
      typeof input["note"] !== "string" ||
      input["note"].length === 0 ||
      input["note"].length > MAX_REFUND_NOTE_LENGTH ||
      !PRINTABLE_PATTERN.test(input["note"])
    ) {
      field("note", `must be printable text of 1-${MAX_REFUND_NOTE_LENGTH} characters`);
    }
    note = input["note"];
  }

  if (!isRefundReadState(input["state"])) {
    field("state", "must be pending, succeeded, failed or cancelled (the customer_refund_state vocabulary is closed and separate from payment/invoice/order state, RL-LOCK-008)");
  }
  const state = input["state"];

  // Honest-state invariant (mirroring the aggregate): a failed refund MUST
  // record its typed failure reason, and ONLY a failed refund carries one.
  let failureReason: RefundReadFailureReason | undefined;
  if (input["failureReason"] !== undefined) {
    if (!isRefundReadFailureReason(input["failureReason"])) {
      field("failureReason", "must be a member of the closed refund failure-reason vocabulary");
    }
    failureReason = input["failureReason"];
  }
  if (state === "failed" && failureReason === undefined) {
    field("failureReason", "a failed refund must record its typed failure reason (audit completeness)");
  }
  if (state !== "failed" && failureReason !== undefined) {
    field("failureReason", `only a failed refund carries a failure reason (this record is '${state}')`);
  }

  let freshness: Freshness;
  try {
    freshness = parseFreshness(input["freshness"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("freshness", error.message);
    }
    throw error;
  }

  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    field("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let updatedAt: UtcInstant;
  try {
    updatedAt = parseUtcInstant(input["updatedAt"]);
  } catch {
    field("updatedAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    field("revision", "must be a positive integer (the read record's publication revision)");
  }

  return Object.freeze({
    contractVersion,
    tenantId,
    refundId,
    paymentId,
    amount,
    reasonCode,
    state,
    freshness,
    ...(note !== undefined ? { note } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    createdAt,
    updatedAt,
    revision,
  });
}

/**
 * Parses a SECTION of refund read records (the order journey's refund
 * section value). Fail-closed: the value must be an array of well-formed
 * records and DUPLICATE refund ids reject (one read record per refund —
 * the projection discipline never presents the same refund twice).
 */
export function parseRefundReadSection(value: unknown): readonly RefundReadRecord[] {
  if (!Array.isArray(value)) {
    field("refunds", "must be an array of refund read records");
  }
  const records: RefundReadRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const record = parseRefundReadRecord(entry);
    if (seenIds.has(record.refundId)) {
      field("refundId", `duplicate refund id '${record.refundId}' (exactly one read record per refund)`);
    }
    seenIds.add(record.refundId);
    records.push(record);
  }
  return Object.freeze(records);
}
