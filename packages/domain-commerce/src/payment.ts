/**
 * The CustomerPayment aggregate (RL-022, spec/data-model.md "Commerce").
 *
 * A CustomerPayment records a CUSTOMER-FACING PAYMENT against a commercial
 * order: the money movement on the RoamLink commerce side only. It is its
 * own aggregate with its own `customer_payment_state` vocabulary, which is
 * NEVER merged with `order_state`, `customer_subscription_state` or any
 * connectivity/delivery state (spec/data-model.md "State separation",
 * RL-LOCK-008 "payment is not delivery"):
 *
 *  - a succeeded payment NEVER implies that the order's experiences were
 *    delivered, activated or are billable-final - delivery evidence is
 *    referenced separately (RL-023 commerce-connectivity), never inferred
 *    here;
 *  - no reservation, session, path, usage or settlement state lives on a
 *    payment (ADCOS owns connectivity, RL-LOCK-001/005);
 *  - the closed constructor vocabulary rejects any delivery-shaped field.
 *
 * State machine (validated transitions only; `succeeded`, `failed` and
 * `cancelled` are terminal):
 *
 *   pending ──succeed──> succeeded (terminal)
 *      │─────fail──────> failed (terminal)
 *      └────cancel─────> cancelled (terminal)
 *
 * Money is integer MINOR units + ISO-4217-style alpha-3 code (./money.ts);
 * floats never appear and no rounding ever happens - a payment amount is
 * exact or rejected.
 */
import {
  ValidationError,
  parseContractVersion,
  parseOrderId,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ContractVersion,
  type CustomerPaymentId,
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
 * The CLOSED `customer_payment_state` vocabulary. Deliberately disjoint from
 * ORDER_STATUSES in both name and values; a payment is never "placed",
 * "completed" or "active" and an order is never "succeeded".
 */
export const CUSTOMER_PAYMENT_STATES = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type CustomerPaymentState = (typeof CUSTOMER_PAYMENT_STATES)[number];

export function isCustomerPaymentState(value: unknown): value is CustomerPaymentState {
  return (
    typeof value === "string" &&
    (CUSTOMER_PAYMENT_STATES as readonly string[]).includes(value)
  );
}

/** The typed, explicit payment transitions. */
export const CUSTOMER_PAYMENT_TRANSITIONS = ["succeed", "fail", "cancel"] as const;

export type CustomerPaymentTransition = (typeof CUSTOMER_PAYMENT_TRANSITIONS)[number];

/**
 * The closed failure-reason vocabulary (typed diagnostics, never free text
 * that could smuggle settlement/connectivity semantics onto a payment).
 */
export const PAYMENT_FAILURE_REASONS = [
  "declined_by_processor",
  "insufficient_funds",
  "expired_payment_instrument",
  "processor_error",
  "fraud_suspected",
  "cancelled_by_customer",
] as const;

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

export function isPaymentFailureReason(value: unknown): value is PaymentFailureReason {
  return (
    typeof value === "string" && (PAYMENT_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The closed payment-method vocabulary. Method labels are PRESENTATION
 * metadata only - they carry no processor/provider authority (RL-LOCK-006).
 */
export const PAYMENT_METHODS = ["card", "wallet", "bank_transfer", "voucher"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export const MAX_PAYMENT_REFERENCE_LENGTH = 120;

/** Serialized (plain) form of a customer payment. */
export interface CustomerPaymentRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly paymentId: CustomerPaymentId;
  /** The commercial order this payment settles money against. */
  readonly orderId: OrderId;
  /** The paying customer (snapshotted from the order at recording time). */
  readonly ownerUserId: UserId;
  /** Exact integer minor units + currency (no floats, no rounding). */
  readonly amount: MoneyValue;
  readonly method?: PaymentMethod;
  /** Free-form provider reference id (opaque, never parsed for state). */
  readonly providerReference?: string;
  readonly status: CustomerPaymentState;
  /** Present only on the `fail` transition. */
  readonly failureReason?: PaymentFailureReason;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link CustomerPayment} constructor. */
export interface CustomerPaymentInput {
  readonly paymentId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly ownerUserId: string;
  readonly amount: unknown;
  readonly method?: string;
  readonly providerReference?: string;
  readonly status: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "paymentId",
  "tenantId",
  "orderId",
  "ownerUserId",
  "amount",
  "method",
  "providerReference",
  "status",
  "failureReason",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`CustomerPayment rejected: ${label} - ${issue}`, {
    reason: "CUSTOMER_PAYMENT_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The CustomerPayment aggregate. Frozen deeply; transitions return new
 * instances with the revision bumped (the service persists via
 * compare-and-swap on that revision, RL-LOCK-017).
 */
export class CustomerPayment {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly paymentId: CustomerPaymentId;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  readonly amount: MoneyValue;
  declare readonly method?: PaymentMethod;
  declare readonly providerReference?: string;
  readonly status: CustomerPaymentState;
  declare readonly failureReason?: PaymentFailureReason;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: CustomerPaymentInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the payment vocabulary is closed; no delivery/connectivity fields exist on payments, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.paymentId = parsePaymentIdField(input.paymentId);
    this.tenantId = parseTenantField(input.tenantId);
    this.orderId = parseOrderRefField(input.orderId);
    this.ownerUserId = parseUserField(input.ownerUserId);
    this.amount = parseAmountField(input.amount);
    if (input.method !== undefined) {
      if (!isPaymentMethod(input.method)) {
        field("method", "must be card, wallet, bank_transfer or voucher (presentation metadata only)");
      }
      this.method = input.method;
    }
    if (input.providerReference !== undefined) {
      if (
        typeof input.providerReference !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/.test(input.providerReference)
      ) {
        field("providerReference", "must be a short opaque reference string (safe charset, max 120)");
      }
      this.providerReference = input.providerReference;
    }
    if (!isCustomerPaymentState(input.status)) {
      field("status", "must be pending, succeeded, failed or cancelled (the customer_payment_state vocabulary is closed and separate from order/subscription state)");
    }
    this.status = input.status;
    if (input.failureReason !== undefined) {
      if (!isPaymentFailureReason(input.failureReason)) {
        field("failureReason", "must be a member of the closed payment failure-reason vocabulary");
      }
      this.failureReason = input.failureReason;
    }
    if (this.status === "failed" && this.failureReason === undefined) {
      field("failureReason", "a failed payment must record its typed failure reason (audit completeness)");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** pending -> succeeded (terminal). Money facts only; NEVER a delivery claim. */
  succeed(at: UtcInstant): CustomerPayment {
    if (this.status !== "pending") {
      field("status", "only a pending payment can succeed (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "succeeded", updatedAt: at });
  }

  /** pending -> failed (terminal) with a typed reason. */
  fail(at: UtcInstant, reason: PaymentFailureReason): CustomerPayment {
    if (this.status !== "pending") {
      field("status", "only a pending payment can fail (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "failed", failureReason: reason, updatedAt: at });
  }

  /** pending -> cancelled (terminal). */
  cancel(at: UtcInstant): CustomerPayment {
    if (this.status !== "pending") {
      field("status", "only a pending payment can be cancelled (succeeded, failed and cancelled are terminal)");
    }
    return this.with({ status: "cancelled", updatedAt: at });
  }

  /** The next payment state after a typed transition (read-side helper). */
  static transitionFrom(
    status: CustomerPaymentState,
    transition: CustomerPaymentTransition,
  ): CustomerPaymentState {
    switch (transition) {
      case "succeed":
        return status === "pending" ? "succeeded" : field("status", "only a pending payment can succeed");
      case "fail":
        return status === "pending" ? "failed" : field("status", "only a pending payment can fail");
      case "cancel":
        return status === "pending" ? "cancelled" : field("status", "only a pending payment can be cancelled");
    }
  }

  private with(overrides: {
    status?: CustomerPaymentState;
    failureReason?: PaymentFailureReason;
    updatedAt?: UtcInstant;
  }): CustomerPayment {
    return new CustomerPayment({
      paymentId: this.paymentId,
      tenantId: this.tenantId,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      amount: this.amount,
      ...(this.method !== undefined ? { method: this.method } : {}),
      ...(this.providerReference !== undefined
        ? { providerReference: this.providerReference }
        : {}),
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

  toRecord(): CustomerPaymentRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      paymentId: this.paymentId,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      amount: this.amount,
      ...(this.method !== undefined ? { method: this.method } : {}),
      ...(this.providerReference !== undefined
        ? { providerReference: this.providerReference }
        : {}),
      status: this.status,
      ...(this.failureReason !== undefined ? { failureReason: this.failureReason } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: CustomerPaymentRecord): CustomerPayment {
    return new CustomerPayment({
      paymentId: record.paymentId,
      tenantId: record.tenantId,
      orderId: record.orderId,
      ownerUserId: record.ownerUserId,
      amount: record.amount,
      ...(record.method !== undefined ? { method: record.method } : {}),
      ...(record.providerReference !== undefined
        ? { providerReference: record.providerReference }
        : {}),
      status: record.status,
      ...(record.failureReason !== undefined ? { failureReason: record.failureReason } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored payment record's contract version (fail-closed). */
export function assertCustomerPaymentRecordVersion(record: CustomerPaymentRecord): void {
  if (!isDomainCommerceRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

// --- shared field parsers (keep error reason CUSTOMER_PAYMENT_INVALID) --------

function parsePaymentIdField(value: string): CustomerPaymentId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field("paymentId", "must be a canonical lowercase UUID");
  }
  return value as CustomerPaymentId;
}

function parseOrderRefField(value: string): OrderId {
  try {
    return parseOrderId(value);
  } catch {
    field("orderId", "must be a canonical lowercase UUID (the commercial order being paid)");
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
    field("ownerUserId", "must be a canonical lowercase UUID (the paying customer)");
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
