/**
 * The ProductVariant aggregate (RL-020, spec/data-model.md "Commerce").
 *
 * A variant is one offerable commercial form of a Product ("7-day pass",
 * "30-day 10GB plan"): a name, a per-product-unique SKU, a billing model, an
 * entitlement term in days and a catalog price (money - presentation-facing
 * commercial packaging only).
 *
 * A variant describes what the customer BUYS; it does NOT imply delivery -
 * no reservation, path, session, usage or settlement state lives here
 * (RL-LOCK-008). Commercial terms are RoamLink-authoritative; connectivity
 * execution remains ADCOS-authoritative (RL-LOCK-001/005).
 *
 * State machine (terminal state: retired):
 *
 *   active ──retire──> retired (terminal)
 *
 * Variants are created ACTIVE (offering a variant is a catalog fact; the
 * two-step draft/activate lifecycle lives on the PRODUCT).
 */
import {
  ValidationError,
  parseContractVersion,
  parseProductId,
  parseProductVariantId,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type ProductId,
  type ProductVariantId,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import type { MoneyValue } from "./money.js";
import { parseMoneyValue } from "./money.js";
import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

export const PRODUCT_VARIANT_STATUSES = ["active", "retired"] as const;

export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number];

export function isProductVariantStatus(value: unknown): value is ProductVariantStatus {
  return (
    typeof value === "string" && (PRODUCT_VARIANT_STATUSES as readonly string[]).includes(value)
  );
}

export const BILLING_MODELS = ["one_time", "recurring"] as const;

export type BillingModel = (typeof BILLING_MODELS)[number];

export function isBillingModel(value: unknown): value is BillingModel {
  return typeof value === "string" && (BILLING_MODELS as readonly string[]).includes(value);
}

export const MAX_VARIANT_NAME_LENGTH = 120;
export const MAX_TERM_DAYS = 3650; // ten years of recurring entitlement
export const SKU_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

/** Serialized (plain) form of a product variant. */
export interface ProductVariantRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly variantId: ProductVariantId;
  readonly productId: ProductId;
  readonly name: string;
  readonly sku: string;
  readonly billingModel: BillingModel;
  /** Entitlement term in days (the commercial term, never a delivery claim). */
  readonly termDays: number;
  readonly price: MoneyValue;
  readonly status: ProductVariantStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link ProductVariant} constructor. */
export interface ProductVariantInput {
  readonly variantId: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly billingModel: string;
  readonly termDays: number;
  readonly price: unknown;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "variantId",
  "tenantId",
  "productId",
  "name",
  "sku",
  "billingModel",
  "termDays",
  "price",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ProductVariant rejected: ${label} - ${issue}`, {
    reason: "PRODUCT_VARIANT_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

/**
 * The ProductVariant aggregate. Frozen deeply; transitions return new
 * instances.
 */
export class ProductVariant {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly variantId: ProductVariantId;
  readonly productId: ProductId;
  readonly name: string;
  readonly sku: string;
  readonly billingModel: BillingModel;
  readonly termDays: number;
  readonly price: MoneyValue;
  readonly status: ProductVariantStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: ProductVariantInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the variant vocabulary is closed; no connectivity/delivery fields exist on commerce records, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.variantId = parseField("variantId", "must be a canonical lowercase UUID", () =>
      parseProductVariantId(input.variantId),
    );
    this.tenantId = parseField("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'", () =>
      parseTenantId(input.tenantId),
    );
    this.productId = parseField("productId", "must be a canonical lowercase UUID (the owning product)", () =>
      parseProductId(input.productId),
    );
    if (
      typeof input.name !== "string" ||
      !PRINTABLE_PATTERN.test(input.name) ||
      input.name.trim().length === 0 ||
      input.name.length > MAX_VARIANT_NAME_LENGTH
    ) {
      field("name", `must be a non-empty printable name of at most ${MAX_VARIANT_NAME_LENGTH} characters`);
    }
    this.name = input.name;
    if (typeof input.sku !== "string" || !SKU_PATTERN.test(input.sku)) {
      field("sku", "must be a short lowercase slug (letter/digit start, then [a-z0-9-], max 64)");
    }
    this.sku = input.sku;
    if (!isBillingModel(input.billingModel)) {
      field("billingModel", "must be one_time or recurring");
    }
    this.billingModel = input.billingModel;
    if (
      typeof input.termDays !== "number" ||
      !Number.isInteger(input.termDays) ||
      input.termDays < 1 ||
      input.termDays > MAX_TERM_DAYS
    ) {
      field("termDays", `must be an integer between 1 and ${MAX_TERM_DAYS} (the commercial term)`);
    }
    this.termDays = input.termDays;
    this.price = parseField("price", "must be a valid money value", () => parseMoneyValue(input.price));
    if (!isProductVariantStatus(input.status)) {
      field("status", "must be active or retired");
    }
    this.status = input.status;
    this.createdAt = parseField(
      "createdAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.createdAt),
    );
    this.updatedAt = parseField(
      "updatedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.updatedAt),
    );
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** active -> retired (terminal). */
  retire(at: UtcInstant): ProductVariant {
    if (this.status !== "active") {
      field("status", "a retired variant is terminal");
    }
    return new ProductVariant({
      variantId: this.variantId,
      tenantId: this.tenantId,
      productId: this.productId,
      name: this.name,
      sku: this.sku,
      billingModel: this.billingModel,
      termDays: this.termDays,
      price: this.price,
      status: "retired",
      createdAt: this.createdAt,
      updatedAt: at,
      revision: this.revision + 1,
    });
  }

  toRecord(): ProductVariantRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      variantId: this.variantId,
      productId: this.productId,
      name: this.name,
      sku: this.sku,
      billingModel: this.billingModel,
      termDays: this.termDays,
      price: this.price,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: ProductVariantRecord): ProductVariant {
    return new ProductVariant({
      variantId: record.variantId,
      tenantId: record.tenantId,
      productId: record.productId,
      name: record.name,
      sku: record.sku,
      billingModel: record.billingModel,
      termDays: record.termDays,
      price: record.price,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored record's contract version (fail-closed). */
export function assertVariantRecordVersion(record: ProductVariantRecord): void {
  const version = parseContractVersion(record.contractVersion);
  if (!isDomainCommerceRecordVersionCompatible(version)) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}
