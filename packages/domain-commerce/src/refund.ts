/**
 * The CustomerRefund aggregate (RL-022, spec/data-model.md "Commerce").
 *
 * A CustomerRefund records the lifecycle of money returned to a customer
 * against one SUCCEEDED CustomerPayment. Its `customer_refund_state`
 * vocabulary is its own and is never merged with `customer_payment_state`,
 * `invoice_state`, `order_state` or any connectivity/delivery state
 * (spec/data-model.md "State separation", RL-LOCK-008).
 *
 * AUDIT COMPLETENESS: every refund carries a typed `reason_code` from a
 * CLOSED vocabulary plus the full command correlation on its event
 * (actor/command/correlation/idempotency key, chain-sequenced append-only
 * event log). Refunds are MONEY FACTS only - a refund never asserts that
 * connectivity was or was not delivered (`service_not_delivered` is a
 * customer-facing reason label, not a delivery-evidence claim; delivery
 * evidence is referenced separately, RL-023).
 *
 * State machine (validated transitions only; `succeeded`, `failed` and
 * `cancelled` are terminal):
 *
 *   pending ──succeed──> succeeded (terminal)
 *      │─────fail──────> failed (terminal)
 *      └────cancel─────> cancelled (terminal)
 *
 * PARTIAL REFUNDS: multiple refunds may attach to one payment; the SERVICE
 * enforces that the sum of PENDING+SUCCEEDED refund amounts never exceeds
 * the payment amount (same currency, integer minor units, no rounding).
 */
import {
  ValidationError,
  parseContractVersion,
  parseCustomerPaymentId,
  parseOrderId,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ContractVersion,
  type CustomerPaymentId,
  type CustomerRefundId,
  type OrderId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { parseMoneyValue, type MoneyValue } from "./money.js";
import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

/**
 * The CLOSED `customer_refund_state` vocabulary. Separate from
 * CUSTOMER_PAYMENT_STATES by name and values: a refund is never "captured";
 * a payment is never "partially_refunded" (the refund records carry that
 * fact instead - no merged enum).
 */
export const CUSTOMER_REFUND_STATES = ["pending", "succeeded", "failed", "cancelled"] as const;

export type CustomerRefundState = (typeof CUSTOMER_REFUND_STATES)[number];

export function isCustomerRefundState(value: unknown): value is CustomerRefundState {
  return (
    typeof value === "string" && (CUSTOMER_REFUND_STATES as readonly string[]).includes(value)
  );
}

/** The typed, explicit refund transitions. */
export const CUSTOMER_REFUND_TRANSITIONS = ["succeed", "fail", "cancel"] as const;

export type CustomerRefundTransition = (typeof CUSTOMER_REFUND_TRANSITIONS)[number];

/**
 * The closed refund reason-code vocabulary (typed audit facts; a label
 * explains the commercial decision, it never asserts delivery evidence).
 */
export const REFUND_REASON_CODES = [
  "customer_request",
  "service_not_delivered",
  "billing_error",
  "duplicate_charge",
  "goodwill",
  "other",
] as const;

export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

export function isRefundReasonCode(value: unknown): value is RefundReasonCode {
  return typeof value === "string" && (REFUND_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The closed refund failure-reason vocabulary (typed diagnostics).
 */
export const REFUND_FAILURE_REASONS = [
  "processor_error",
  "payment_instrument_unreachable",
  "compliance_hold",
  "cancelled_by_operator",
] as const;

export type RefundFailureReason = (typeof REFUND_FAILURE_REASONS)[number];

export function isRefundFailureReason(value: unknown): value is RefundFailureReason {
  return typeof value === "string" && (REFUND_FAILURE_REASONS as readonly string[]).includes(value);
}

export const MAX_REFUND_NOTE_LENGTH = 280;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

/** Serialized (plain) form of a customer refund. */
export interface CustomerRefundRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly refundId: CustomerRefundId;
  /** The SUCCEEDED payment this refund returns money from. */
  readonly paymentId: CustomerPaymentId;
  /** The payment's order (denormalized commercial origin). */
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  /** Exact refund amount (integer minor units, same currency as the payment). */
  readonly amount: MoneyValue;
  readonly reasonCode: RefundReasonCode;
  /** Optional human-facing note (printable, bounded). */
  readonly note?: string;
  readonly status: CustomerRefundState;
  /** Present only on the `fail` transition. */
  readonly failureReason?: RefundFailureReason;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link CustomerRefund} constructor. */
export interface CustomerRefundInput {
  readonly refundId: string;
  readonly tenantId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly ownerUserId: string;
  readonly amount: unknown;
  readonly reasonCode: string;
  readonly note?: string;
  readonly status: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "refundId",
  "tenantId",
  "paymentId",
  "orderId",
  "ownerUserId",
  "amount",
  "reasonCode",
  "note",
  "status",
  "failureReason",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`CustomerRefund rejected: ${label} - ${issue}`, {
    reason: "CUSTOMER_REFUND_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The CustomerRefund aggregate. Frozen deeply; transitions return new
 * instances with the revision bumped.
 */
export class CustomerRefund {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly refundId: CustomerRefundId;
  readonly paymentId: CustomerPaymentId;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  readonly amount: MoneyValue;
  readonly reasonCode: RefundReasonCode;
  declare readonly note?: string;
  readonly status: CustomerRefundState;
  declare readonly failureReason?: RefundFailureReason;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: CustomerRefundInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the refund vocabulary is closed; no delivery/connectivity fields exist on refunds, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.refundId = parseRefundIdField(input.refundId);
    this.tenantId = parseTenantField(input.tenantId);
    this.paymentId = parsePaymentRefField(input.paymentId);
    this.orderId = parseOrderRefField(input.orderId);
    this.ownerUserId = parseUserField(input.ownerUserId);
    this.amount = parseAmountField(input.amount);
    if (!isRefundReasonCode(input.reasonCode)) {
      field("reasonCode", "must be a member of the closed refund reason-code vocabulary (audit completeness)");
    }
    this.reasonCode = input.reasonCode;
    if (input.note !== undefined) {
      if (
        typeof input.note !== "string" ||
        !PRINTABLE_PATTERN.test(input.note) ||
        input.note.length > MAX_REFUND_NOTE_LENGTH
      ) {
        field("note", `must be printable text of at most ${MAX_REFUND_NOTE_LENGTH} characters`);
      }
      this.note = input.note;
    }
    if (!isCustomerRefundState(input.status)) {
      field("status", "must be pending, succeeded, failed or cancelled (the customer_refund_state vocabulary is closed and separate from payment state)");
    }
    this.status = input.status;
    if (input.failureReason !== undefined) {
      if (!isRefundFailureReason(input.failureReason)) {
        field("failureReason", "must be a member of the closed refund failure-reason vocabulary");
      }
      this.failureReason = input.failureReason;
    }
    if (this.status === "failed" && this.failureReason === undefined) {
      field("failureReason", "a failed refund must record its typed failure reason (audit completeness)");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** pending -> succeeded (terminal). A money fact; NEVER a delivery claim. */
  succeed(at: UtcInstant): CustomerRefund {
    if (this.status !== "pending") {
      field("status", "only a pending refund can succeed (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "succeeded", updatedAt: at });
  }

  /** pending -> failed (terminal) with a typed reason. */
  fail(at: UtcInstant, reason: RefundFailureReason): CustomerRefund {
    if (this.status !== "pending") {
      field("status", "only a pending refund can fail (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "failed", failureReason: reason, updatedAt: at });
  }

  /** pending -> cancelled (terminal). */
  cancel(at: UtcInstant): CustomerRefund {
    if (this.status !== "pending") {
      field("status", "only a pending refund can be cancelled (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "cancelled", updatedAt: at });
  }

  /** The next refund state after a typed transition (read-side helper). */
  static transitionFrom(
    status: CustomerRefundState,
    transition: CustomerRefundTransition,
  ): CustomerRefundState {
    switch (transition) {
      case "succeed":
        return status === "pending" ? "succeeded" : field("status", "only a pending refund can succeed");
      case "fail":
        return status === "pending" ? "failed" : field("status", "only a pending refund can fail");
      case "cancel":
        return status === "pending" ? "cancelled" : field("status", "only a pending refund can be cancelled");
    }
  }

  private with(overrides: {
    status?: CustomerRefundState;
    failureReason?: RefundFailureReason;
    updatedAt?: UtcInstant;
  }): CustomerRefund {
    return new CustomerRefund({
      refundId: this.refundId,
      tenantId: this.tenantId,
      paymentId: this.paymentId,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      amount: this.amount,
      reasonCode: this.reasonCode,
      ...(this.note !== undefined ? { note: this.note } : {}),
      status: overrides.status ?? this.status,
      ...(overrides.failureReason !== undefined
        ? { failureReason: overrides.failureReason }
        : this.failureReason !== undefined
          ? { failureReason: this.failureReason }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): CustomerRefundRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      refundId: this.refundId,
      paymentId: this.paymentId,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      amount: this.amount,
      reasonCode: this.reasonCode,
      ...(this.note !== undefined ? { note: this.note } : {}),
      status: this.status,
      ...(this.failureReason !== undefined ? { failureReason: this.failureReason } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: CustomerRefundRecord): CustomerRefund {
    return new CustomerRefund({
      refundId: record.refundId,
      tenantId: record.tenantId,
      paymentId: record.paymentId,
      orderId: record.orderId,
      ownerUserId: record.ownerUserId,
      amount: record.amount,
      reasonCode: record.reasonCode,
      ...(record.note !== undefined ? { note: record.note } : {}),
      status: record.status,
      ...(record.failureReason !== undefined ? { failureReason: record.failureReason } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored refund record's contract version (fail-closed). */
export function assertCustomerRefundRecordVersion(record: CustomerRefundRecord): void {
  if (!isDomainCommerceRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

// --- shared field parsers (keep error reason CUSTOMER_REFUND_INVALID) ---------

function parseRefundIdField(value: string): CustomerRefundId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field("refundId", "must be a canonical lowercase UUID");
  }
  return value as CustomerRefundId;
}

function parsePaymentRefField(value: string): CustomerPaymentId {
  try {
    return parseCustomerPaymentId(value);
  } catch {
    field("paymentId", "must be a canonical lowercase UUID (the refunded payment)");
  }
}

function parseOrderRefField(value: string): OrderId {
  try {
    return parseOrderId(value);
  } catch {
    field("orderId", "must be a canonical lowercase UUID (the payment's commercial order)");
  }
}

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
    field("ownerUserId", "must be a canonical lowercase UUID (the refunded customer)");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}

function parseAmountField(value: unknown): MoneyValue {
  try {
    return parseMoneyValue(value);
  } catch {
    field("amount", "must be a valid money value (integer minor units + currency; never a float)");
  }
}
