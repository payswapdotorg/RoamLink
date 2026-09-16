/**
 * The Product aggregate (RL-020, spec/data-model.md "Commerce").
 *
 * A Product describes an OFFERABLE CONNECTIVITY EXPERIENCE as commercial
 * packaging - what a customer can order. It does NOT imply delivery: no
 * reservation, path, session, usage or settlement state lives here
 * (RL-LOCK-008 "payment is not delivery"; connectivity state belongs to
 * ADCOS, RL-LOCK-001/005). Fulfillment references are Wave 3 (RL-023).
 *
 * State machine (validated transitions only, terminal state: retired):
 *
 *   draft ──activate──> active ──retire──> retired (terminal)
 *     └────────────retire──────────^
 *
 * Mutable header + optimistic-concurrency revision (RL-003 CAS token, used by
 * services through explicit expected-revision inputs). Transitions return
 * NEW frozen instances with the revision bumped.
 */
import {
  ValidationError,
  parseContractVersion,
  parseProductId,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type ProductId,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

export const PRODUCT_STATUSES = ["draft", "active", "retired"] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export function isProductStatus(value: unknown): value is ProductStatus {
  return typeof value === "string" && (PRODUCT_STATUSES as readonly string[]).includes(value);
}

export const MAX_PRODUCT_NAME_LENGTH = 120;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 1000;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

/** Serialized (plain) form of a product. */
export interface ProductRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly name: string;
  readonly description?: string;
  readonly status: ProductStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Product} constructor. */
export interface ProductInput {
  readonly productId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "productId",
  "tenantId",
  "name",
  "description",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Product rejected: ${label} - ${issue}`, {
    reason: "PRODUCT_INVALID",
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

function parseBoundedText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string" || !PRINTABLE_PATTERN.test(value)) {
    field(label, "must be printable text without control characters");
  }
  if (value.length > maxLength) {
    field(label, `must be at most ${maxLength} characters`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    field(label, "must not be empty");
  }
  return value;
}

/**
 * The Product aggregate. Frozen deeply; transitions return new instances.
 */
export class Product {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly name: string;
  declare readonly description?: string;
  readonly status: ProductStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: ProductInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the product vocabulary is closed; no connectivity/delivery fields exist on commerce records, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.productId = parseField("productId", "must be a canonical lowercase UUID", () =>
      parseProductId(input.productId),
    );
    this.tenantId = parseField("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'", () =>
      parseTenantId(input.tenantId),
    );
    this.name = parseBoundedText(input.name, "name", MAX_PRODUCT_NAME_LENGTH, false);
    if (input.description !== undefined) {
      this.description = parseBoundedText(
        input.description,
        "description",
        MAX_PRODUCT_DESCRIPTION_LENGTH,
        false,
      );
    }
    if (!isProductStatus(input.status)) {
      field("status", "must be draft, active or retired");
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

  /** draft -> active. */
  activate(at: UtcInstant): Product {
    if (this.status !== "draft") {
      field("status", "only a draft product can be activated");
    }
    return this.with({ status: "active", updatedAt: at });
  }

  /** draft|active -> retired (terminal). */
  retire(at: UtcInstant): Product {
    if (this.status === "retired") {
      field("status", "a retired product is terminal");
    }
    return this.with({ status: "retired", updatedAt: at });
  }

  private with(overrides: {
    status?: ProductStatus;
    updatedAt?: UtcInstant;
  }): Product {
    return new Product({
      productId: this.productId,
      tenantId: this.tenantId,
      name: this.name,
      ...(this.description !== undefined ? { description: this.description } : {}),
      status: overrides.status ?? this.status,
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): ProductRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      productId: this.productId,
      name: this.name,
      ...(this.description !== undefined ? { description: this.description } : {}),
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: ProductRecord): Product {
    return new Product({
      productId: record.productId,
      tenantId: record.tenantId,
      name: record.name,
      ...(record.description !== undefined ? { description: record.description } : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored product record's contract version (fail-closed). */
export function assertProductRecordVersion(record: ProductRecord): void {
  const version = parseContractVersion(record.contractVersion);
  if (!isDomainCommerceRecordVersionCompatible(version)) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}
