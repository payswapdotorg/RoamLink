/**
 * The Order and OrderLine aggregates (RL-021, spec/data-model.md
 * "Commerce").
 *
 * An Order expresses COMMERCIAL INTENT ONLY: a customer's decision to buy
 * offerable connectivity experiences at snapshotted commercial terms. It
 * does NOT imply delivery (RL-LOCK-008 "payment is not delivery"): no
 * reservation, session, path, usage or settlement state lives here, and no
 * order transition ever authorizes connectivity. Fulfillment references are
 * Wave 3 (RL-023 commerce-to-connectivity reference model); payments are
 * RL-022 with a SEPARATE `customer_payment_state` (spec/data-model.md
 * "State separation" - never collapse the enums).
 *
 * Order state machine (validated transitions only, terminal states:
 * completed, cancelled):
 *
 *   draft ──place──> placed ──complete──> completed (terminal)
 *     │                 │
 *     └────cancel───────┴──> cancelled (terminal)
 *
 * `order_state` is its own vocabulary; the read-side derived customer
 * status is RL-013's concern, never a mutation here.
 *
 * OrderLine is an IMMUTABLE snapshot of the commercial terms at order time
 * (variant, quantity, unit price, billing model, term): once created it is
 * never updated - corrections are new orders/lines, never silent edits. The
 * order carries denormalized `lineCount`/`totalAmount` maintained by the
 * service in the SAME atomic unit of work as the line insert.
 */
import {
  ValidationError,
  parseContractVersion,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ContractVersion,
  type OrderId,
  type OrderLineId,
  type ProductId,
  type ProductVariantId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { addMoney, multiplyMoney, parseMoneyValue, type MoneyValue } from "./money.js";
import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

export const ORDER_STATUSES = ["draft", "placed", "completed", "cancelled"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** The typed, explicit order transitions. */
export const ORDER_TRANSITIONS = ["place", "complete", "cancel"] as const;

export type OrderTransition = (typeof ORDER_TRANSITIONS)[number];

export const ORDER_MAX_LINES = 100;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
export const MAX_CANCEL_REASON_LENGTH = 280;

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** Serialized (plain) form of an order. */
export interface OrderRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  readonly status: OrderStatus;
  /** Present only when the cancellation carried a reason. */
  readonly cancelReason?: string;
  /** Denormalized line count (maintained with the lines atomically). */
  readonly lineCount: number;
  /** Denormalized order total = sum of line amounts (same currency). */
  readonly totalAmount: MoneyValue;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Order} constructor. */
export interface OrderInput {
  readonly orderId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly status: string;
  readonly cancelReason?: string;
  readonly lineCount: number;
  readonly totalAmount: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_ORDER_INPUT_FIELDS = new Set([
  "orderId",
  "tenantId",
  "ownerUserId",
  "status",
  "cancelReason",
  "lineCount",
  "totalAmount",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Order rejected: ${label} - ${issue}`, {
    reason: "ORDER_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The Order aggregate. Frozen deeply; transitions return new instances with
 * the revision bumped (the service persists via compare-and-swap on that
 * revision).
 */
export class Order {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly orderId: OrderId;
  readonly ownerUserId: UserId;
  readonly status: OrderStatus;
  declare readonly cancelReason?: string;
  readonly lineCount: number;
  readonly totalAmount: MoneyValue;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: OrderInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_ORDER_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the order vocabulary is closed; no connectivity/delivery fields exist on commerce records, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.orderId = parseIdField<OrderId>(input.orderId, "orderId", "must be a canonical lowercase UUID");
    this.tenantId = parseTenantField(input.tenantId);
    this.ownerUserId = parseUserField(input.ownerUserId);
    if (!isOrderStatus(input.status)) {
      field("status", "must be draft, placed, completed or cancelled");
    }
    this.status = input.status;
    if (input.cancelReason !== undefined) {
      if (
        typeof input.cancelReason !== "string" ||
        !PRINTABLE_PATTERN.test(input.cancelReason) ||
        input.cancelReason.length > MAX_CANCEL_REASON_LENGTH
      ) {
        field("cancelReason", `must be printable text of at most ${MAX_CANCEL_REASON_LENGTH} characters`);
      }
      this.cancelReason = input.cancelReason;
    }
    if (
      typeof input.lineCount !== "number" ||
      !Number.isInteger(input.lineCount) ||
      input.lineCount < 0 ||
      input.lineCount > ORDER_MAX_LINES
    ) {
      field("lineCount", `must be an integer between 0 and ${ORDER_MAX_LINES}`);
    }
    this.lineCount = input.lineCount;
    this.totalAmount = parseTotalAmount(input.totalAmount);
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** draft -> placed. Requires at least one line (the commercial content). */
  place(at: UtcInstant): Order {
    if (this.status !== "draft") {
      field("status", "only a draft order can be placed");
    }
    if (this.lineCount < 1) {
      field("lineCount", "an order with zero lines expresses nothing commercial and cannot be placed");
    }
    return this.with({ status: "placed", updatedAt: at });
  }

  /** placed -> completed. Completion is commercial bookkeeping, never delivery. */
  complete(at: UtcInstant): Order {
    if (this.status !== "placed") {
      field("status", "only a placed order can be completed");
    }
    return this.with({ status: "completed", updatedAt: at });
  }

  /** draft|placed -> cancelled (terminal). */
  cancel(at: UtcInstant, reason?: string): Order {
    if (this.status === "completed" || this.status === "cancelled") {
      field("status", "a completed or cancelled order is terminal");
    }
    return this.with({
      status: "cancelled",
      updatedAt: at,
      ...(reason !== undefined ? { cancelReason: reason } : {}),
    });
  }

  /** The next order state after a typed transition (read-side helper). */
  static transitionFrom(status: OrderStatus, transition: OrderTransition): OrderStatus {
    switch (transition) {
      case "place":
        return status === "draft" ? "placed" : field("status", "only a draft order can be placed");
      case "complete":
        return status === "placed" ? "completed" : field("status", "only a placed order can be completed");
      case "cancel":
        return status === "draft" || status === "placed"
          ? "cancelled"
          : field("status", "a completed or cancelled order is terminal");
    }
  }

  private with(overrides: {
    status?: OrderStatus;
    updatedAt?: UtcInstant;
    cancelReason?: string;
  }): Order {
    return new Order({
      orderId: this.orderId,
      tenantId: this.tenantId,
      ownerUserId: this.ownerUserId,
      status: overrides.status ?? this.status,
      ...(overrides.cancelReason !== undefined
        ? { cancelReason: overrides.cancelReason }
        : this.cancelReason !== undefined
          ? { cancelReason: this.cancelReason }
          : {}),
      lineCount: this.lineCount,
      totalAmount: this.totalAmount,
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): OrderRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      orderId: this.orderId,
      ownerUserId: this.ownerUserId,
      status: this.status,
      ...(this.cancelReason !== undefined ? { cancelReason: this.cancelReason } : {}),
      lineCount: this.lineCount,
      totalAmount: this.totalAmount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: OrderRecord): Order {
    return new Order({
      orderId: record.orderId,
      tenantId: record.tenantId,
      ownerUserId: record.ownerUserId,
      status: record.status,
      ...(record.cancelReason !== undefined ? { cancelReason: record.cancelReason } : {}),
      lineCount: record.lineCount,
      totalAmount: record.totalAmount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored order record's contract version (fail-closed). */
export function assertOrderRecordVersion(record: OrderRecord): void {
  if (!isDomainCommerceRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

// ---------------------------------------------------------------------------
// OrderLine
// ---------------------------------------------------------------------------

/** Serialized (plain) form of an order line. */
export interface OrderLineRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly lineId: OrderLineId;
  readonly orderId: OrderId;
  readonly productId: ProductId;
  readonly variantId: ProductVariantId;
  readonly variantSku: string;
  readonly billingModel: string;
  readonly termDays: number;
  readonly quantity: number;
  /** Unit price snapshotted from the variant at order time. */
  readonly unitPrice: MoneyValue;
  /** unitPrice x quantity (same currency). */
  readonly lineAmount: MoneyValue;
  readonly createdAt: UtcInstant;
  /** Immutable record: the revision is always 1. */
  readonly revision: Revision;
}

/** Input accepted by the {@link OrderLine} constructor. */
export interface OrderLineInput {
  readonly lineId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly variantSku: string;
  readonly billingModel: string;
  readonly termDays: number;
  readonly quantity: number;
  readonly unitPrice: unknown;
  readonly createdAt: string;
}

const ALLOWED_LINE_INPUT_FIELDS = new Set([
  "lineId",
  "tenantId",
  "orderId",
  "productId",
  "variantId",
  "variantSku",
  "billingModel",
  "termDays",
  "quantity",
  "unitPrice",
  "createdAt",
]);

function lineField(label: string, issue: string): never {
  throw new ValidationError(`OrderLine rejected: ${label} - ${issue}`, {
    reason: "ORDER_LINE_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * An immutable order line (commercial terms snapshot). There are NO state
 * transitions: the constructor is the only creator, records are insert-only
 * and corrections are new lines/orders - never silent edits.
 */
export class OrderLine {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly lineId: OrderLineId;
  readonly orderId: OrderId;
  readonly productId: ProductId;
  readonly variantId: ProductVariantId;
  readonly variantSku: string;
  readonly billingModel: string;
  readonly termDays: number;
  readonly quantity: number;
  readonly unitPrice: MoneyValue;
  readonly lineAmount: MoneyValue;
  readonly createdAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: OrderLineInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      lineField("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_LINE_INPUT_FIELDS.has(key)) {
        lineField(key, "unknown field (the line vocabulary is closed; lines are immutable snapshots, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.lineId = parseLineIdField(input.lineId);
    this.tenantId = parseTenantField(input.tenantId);
    this.orderId = parseIdField<OrderId>(input.orderId, "orderId", "must be a canonical lowercase UUID (the owning order)");
    this.productId = parseIdField<ProductId>(input.productId, "productId", "must be a canonical lowercase UUID (the line's product)");
    this.variantId = parseIdField<ProductVariantId>(input.variantId, "variantId", "must be a canonical lowercase UUID (the line's variant)");
    if (typeof input.variantSku !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.variantSku)) {
      lineField("variantSku", "must be the variant's slug (letter/digit start, then [a-z0-9-], max 64)");
    }
    this.variantSku = input.variantSku;
    if (input.billingModel !== "one_time" && input.billingModel !== "recurring") {
      lineField("billingModel", "must be one_time or recurring (snapshotted from the variant)");
    }
    this.billingModel = input.billingModel;
    if (
      typeof input.termDays !== "number" ||
      !Number.isInteger(input.termDays) ||
      input.termDays < 1 ||
      input.termDays > 3650
    ) {
      lineField("termDays", "must be an integer between 1 and 3650 (snapshotted from the variant)");
    }
    this.termDays = input.termDays;
    if (
      typeof input.quantity !== "number" ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > 100
    ) {
      lineField("quantity", "must be an integer between 1 and 100");
    }
    this.quantity = input.quantity;
    this.unitPrice = parseUnitPrice(input.unitPrice);
    this.lineAmount = multiplyMoney(this.unitPrice, this.quantity);
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.revision = 1 as Revision;
    Object.freeze(this);
  }

  toRecord(): OrderLineRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      lineId: this.lineId,
      orderId: this.orderId,
      productId: this.productId,
      variantId: this.variantId,
      variantSku: this.variantSku,
      billingModel: this.billingModel,
      termDays: this.termDays,
      quantity: this.quantity,
      unitPrice: this.unitPrice,
      lineAmount: this.lineAmount,
      createdAt: this.createdAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: OrderLineRecord): OrderLine {
    return new OrderLine({
      lineId: record.lineId,
      tenantId: record.tenantId,
      orderId: record.orderId,
      productId: record.productId,
      variantId: record.variantId,
      variantSku: record.variantSku,
      billingModel: record.billingModel,
      termDays: record.termDays,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      createdAt: record.createdAt,
    });
  }
}

/** Validates a stored line record's contract version (fail-closed). */
export function assertOrderLineRecordVersion(record: OrderLineRecord): void {
  if (!isDomainCommerceRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    lineField("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

/** Sums line amounts into an order total (single currency enforced). */
export function sumLineAmounts(amounts: readonly MoneyValue[]): MoneyValue {
  if (amounts.length === 0) {
    throw new ValidationError("Order total rejected: amounts - an empty sum has no currency", {
      reason: "ORDER_INVALID",
      details: [{ path: "amounts", issue: "at least one line amount is required" }],
    });
  }
  let total = parseMoneyValue(amounts[0]);
  for (let index = 1; index < amounts.length; index += 1) {
    total = addMoney(total, parseMoneyValue(amounts[index]));
  }
  return total;
}

// --- shared field parsers --------------------------------------------------

function parseIdField<T extends string>(value: string, label: string, issue: string): T {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field(label, issue);
  }
  return value as T;
}

function parseLineIdField(value: string): OrderLineId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    lineField("lineId", "must be a canonical lowercase UUID");
  }
  return value as OrderLineId;
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
    field("ownerUserId", "must be a canonical lowercase UUID (the ordering customer)");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}

function parseTotalAmount(value: unknown): MoneyValue {
  try {
    return parseMoneyValue(value);
  } catch {
    field("totalAmount", "must be a valid money value (the sum of the line amounts)");
  }
}

function parseUnitPrice(value: unknown): MoneyValue {
  try {
    return parseMoneyValue(value);
  } catch {
    lineField("unitPrice", "must be a valid money value snapshotted from the variant");
  }
}
