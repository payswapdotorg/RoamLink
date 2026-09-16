/**
 * The CustomerInvoice aggregate (RL-022, spec/data-model.md "Commerce").
 *
 * A CustomerInvoice is the ISSUED BILLING DOCUMENT for a commercial order:
 * the order's snapshotted total under a tenant-unique invoice number. Its
 * `invoice_state` vocabulary is its own (`issued`, `reconciled`, `voided`)
 * and is NEVER merged with `customer_payment_state`, `order_state` or any
 * connectivity/delivery state (spec/data-model.md "State separation",
 * RL-LOCK-008).
 *
 * RECONCILIATION is an explicit, commanded transition (`issued ->
 * reconciled`) that may only be applied when the SUCCEEDED payments minus
 * SUCCEEDED refunds for the order fully cover the invoice total in the same
 * currency - the service computes that coverage from the payment/refund
 * records and refuses otherwise (typed ConflictError). The invoice never
 * stores payment state: `reconciled` records the fact that reconciliation
 * was proven at transition time, and the event payload carries the payment
 * ids that constituted the proof (audit).
 *
 * Money is integer minor units + ISO-4217-style alpha-3 code; the invoice
 * total is an exact snapshot of the order total at issue time - corrections
 * are credit notes/new invoices, never silent edits.
 */
import {
  ValidationError,
  parseContractVersion,
  parseOrderId,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ContractVersion,
  type CustomerInvoiceId,
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
 * The CLOSED `invoice_state` vocabulary. Separate from
 * CUSTOMER_PAYMENT_STATES by name and values: an invoice is never
 * "succeeded"; a payment is never "reconciled".
 */
export const CUSTOMER_INVOICE_STATES = ["issued", "reconciled", "voided"] as const;

export type InvoiceState = (typeof CUSTOMER_INVOICE_STATES)[number];

export function isInvoiceState(value: unknown): value is InvoiceState {
  return typeof value === "string" && (CUSTOMER_INVOICE_STATES as readonly string[]).includes(value);
}

/** The typed, explicit invoice transitions. */
export const CUSTOMER_INVOICE_TRANSITIONS = ["reconcile", "void"] as const;

export type CustomerInvoiceTransition = (typeof CUSTOMER_INVOICE_TRANSITIONS)[number];

/** Tenant-unique human-facing invoice number (validated, service-enforced unique). */
export const INVOICE_NUMBER_PATTERN = /^INV-[0-9]{4}-[0-9]{6}$/;

/** Serialized (plain) form of a customer invoice. */
export interface CustomerInvoiceRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly invoiceId: CustomerInvoiceId;
  readonly invoiceNumber: string;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  /** Exact snapshot of the order total at issue time. */
  readonly totalAmount: MoneyValue;
  readonly status: InvoiceState;
  readonly issuedAt: UtcInstant;
  /** Present once reconciled (the reconciliation proof instant). */
  readonly reconciledAt?: UtcInstant;
  /** Present once voided. */
  readonly voidedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link CustomerInvoice} constructor. */
export interface CustomerInvoiceInput {
  readonly invoiceId: string;
  readonly tenantId: string;
  readonly invoiceNumber: string;
  readonly orderId: string;
  readonly ownerUserId: string;
  readonly totalAmount: unknown;
  readonly status: string;
  readonly issuedAt: string;
  readonly reconciledAt?: string;
  readonly voidedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "invoiceId",
  "tenantId",
  "invoiceNumber",
  "orderId",
  "ownerUserId",
  "totalAmount",
  "status",
  "issuedAt",
  "reconciledAt",
  "voidedAt",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`CustomerInvoice rejected: ${label} - ${issue}`, {
    reason: "CUSTOMER_INVOICE_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The CustomerInvoice aggregate. Frozen deeply; transitions return new
 * instances with the revision bumped.
 */
export class CustomerInvoice {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly invoiceId: CustomerInvoiceId;
  readonly invoiceNumber: string;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  readonly totalAmount: MoneyValue;
  readonly status: InvoiceState;
  readonly issuedAt: UtcInstant;
  declare readonly reconciledAt?: UtcInstant;
  declare readonly voidedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: CustomerInvoiceInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the invoice vocabulary is closed; no payment or delivery state lives on an invoice)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.invoiceId = parseInvoiceIdField(input.invoiceId);
    this.tenantId = parseTenantField(input.tenantId);
    if (typeof input.invoiceNumber !== "string" || !INVOICE_NUMBER_PATTERN.test(input.invoiceNumber)) {
      field("invoiceNumber", "must match INV-<4-digit year>-<6-digit sequence> (tenant-unique)");
    }
    this.invoiceNumber = input.invoiceNumber;
    this.orderId = parseOrderRefField(input.orderId);
    this.ownerUserId = parseUserField(input.ownerUserId);
    this.totalAmount = parseTotalField(input.totalAmount);
    if (!isInvoiceState(input.status)) {
      field("status", "must be issued, reconciled or voided (the invoice_state vocabulary is closed and separate from payment state)");
    }
    this.status = input.status;
    this.issuedAt = parseInstantField(input.issuedAt, "issuedAt");
    if (input.reconciledAt !== undefined) {
      this.reconciledAt = parseInstantField(input.reconciledAt, "reconciledAt");
    }
    if (input.voidedAt !== undefined) {
      this.voidedAt = parseInstantField(input.voidedAt, "voidedAt");
    }
    if (this.status === "reconciled" && this.reconciledAt === undefined) {
      field("reconciledAt", "a reconciled invoice must record its reconciliation proof instant");
    }
    if (this.status === "voided" && this.voidedAt === undefined) {
      field("voidedAt", "a voided invoice must record its void instant");
    }
    if (this.reconciledAt !== undefined && this.voidedAt !== undefined) {
      field("reconciledAt", "an invoice is reconciled or voided, never both");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /**
   * issued -> reconciled. The service applies this ONLY after computing full
   * payment coverage (succeeded payments minus succeeded refunds, same
   * currency); the aggregate records the proof instant.
   */
  reconcile(at: UtcInstant): CustomerInvoice {
    if (this.status !== "issued") {
      field("status", "only an issued invoice can be reconciled (reconciled and voided are terminal)");
    }
    return this.with({ status: "reconciled", reconciledAt: at, updatedAt: at });
  }

  /** issued -> voided (terminal). A reconciled invoice is never voided. */
  void(at: UtcInstant): CustomerInvoice {
    if (this.status !== "issued") {
      field("status", "only an issued invoice can be voided (a reconciled invoice is settled history; corrections are credit notes)");
    }
    return this.with({ status: "voided", voidedAt: at, updatedAt: at });
  }

  /** The next invoice state after a typed transition (read-side helper). */
  static transitionFrom(
    status: InvoiceState,
    transition: CustomerInvoiceTransition,
  ): InvoiceState {
    switch (transition) {
      case "reconcile":
        return status === "issued" ? "reconciled" : field("status", "only an issued invoice can be reconciled");
      case "void":
        return status === "issued" ? "voided" : field("status", "only an issued invoice can be voided");
    }
  }

  private with(overrides: {
    status?: InvoiceState;
    reconciledAt?: UtcInstant;
    voidedAt?: UtcInstant;
    updatedAt?: UtcInstant;
  }): CustomerInvoice {
    return new CustomerInvoice({
      invoiceId: this.invoiceId,
      tenantId: this.tenantId,
      invoiceNumber: this.invoiceNumber,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      totalAmount: this.totalAmount,
      status: overrides.status ?? this.status,
      issuedAt: this.issuedAt,
      ...(overrides.reconciledAt !== undefined
        ? { reconciledAt: overrides.reconciledAt }
        : this.reconciledAt !== undefined
          ? { reconciledAt: this.reconciledAt }
          : {}),
      ...(overrides.voidedAt !== undefined
        ? { voidedAt: overrides.voidedAt }
        : this.voidedAt !== undefined
          ? { voidedAt: this.voidedAt }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): CustomerInvoiceRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      invoiceId: this.invoiceId,
      invoiceNumber: this.invoiceNumber,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      totalAmount: this.totalAmount,
      status: this.status,
      issuedAt: this.issuedAt,
      ...(this.reconciledAt !== undefined ? { reconciledAt: this.reconciledAt } : {}),
      ...(this.voidedAt !== undefined ? { voidedAt: this.voidedAt } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: CustomerInvoiceRecord): CustomerInvoice {
    return new CustomerInvoice({
      invoiceId: record.invoiceId,
      tenantId: record.tenantId,
      invoiceNumber: record.invoiceNumber,
      orderId: record.orderId,
      ownerUserId: record.ownerUserId,
      totalAmount: record.totalAmount,
      status: record.status,
      issuedAt: record.issuedAt,
      ...(record.reconciledAt !== undefined ? { reconciledAt: record.reconciledAt } : {}),
      ...(record.voidedAt !== undefined ? { voidedAt: record.voidedAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored invoice record's contract version (fail-closed). */
export function assertCustomerInvoiceRecordVersion(record: CustomerInvoiceRecord): void {
  if (!isDomainCommerceRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

// --- shared field parsers (keep error reason CUSTOMER_INVOICE_INVALID) --------

function parseInvoiceIdField(value: string): CustomerInvoiceId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field("invoiceId", "must be a canonical lowercase UUID");
  }
  return value as CustomerInvoiceId;
}

function parseOrderRefField(value: string): OrderId {
  try {
    return parseOrderId(value);
  } catch {
    field("orderId", "must be a canonical lowercase UUID (the billed order)");
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
    field("ownerUserId", "must be a canonical lowercase UUID (the billed customer)");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}

function parseTotalField(value: unknown): MoneyValue {
  try {
    return parseMoneyValue(value);
  } catch {
    field("totalAmount", "must be a valid money value (the snapshotted order total)");
  }
}
