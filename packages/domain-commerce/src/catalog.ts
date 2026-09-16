/**
 * The catalog read model (RL-020).
 *
 * A PURE, immutable projection of committed product/variant records into the
 * customer-facing catalog: which experiences are OFFERABLE right now. Read
 * models never mutate domain state and never exercise authority (the same
 * discipline as RL-013's decision read model): the view references records;
 * it does not create, reserve or deliver anything (RL-LOCK-008).
 *
 * Determinism: the same committed inputs + computedAt always produce a
 * byte-identical view (canonical input digest, stable ordering by
 * productId/productName then variantId), so catalogs can be cached,
 * compared and audited. Freshness is explicit: `computedAt` is
 * caller-supplied and every entry carries its source record's `updatedAt`.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  parseTenantId,
  parseUtcInstant,
  type Digest,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import type { ProductRecord } from "./product.js";
import type { ProductVariantRecord } from "./product-variant.js";

/** One offerable product with its offerable variants. */
export interface CatalogEntry {
  readonly product: ProductRecord;
  /** Active variants of an active product, ordered by variantId. */
  readonly variants: readonly ProductVariantRecord[];
}

/** The immutable tenant-scoped catalog view. */
export interface CatalogView {
  readonly tenantId: TenantId;
  readonly computedAt: UtcInstant;
  /** Active products ordered by (name, productId). */
  readonly entries: readonly CatalogEntry[];
  readonly productCount: number;
  readonly variantCount: number;
  /** Deterministic digest over the exact input records (provenance). */
  readonly inputDigest: Digest;
}

/** Input for {@link buildCatalogView}. */
export interface CatalogViewInput {
  readonly tenantId: string;
  readonly computedAt: string;
  /** All committed product records (pre-tenant-filtering is allowed). */
  readonly products: readonly ProductRecord[];
  /** All committed variant records (pre-tenant-filtering is allowed). */
  readonly variants: readonly ProductVariantRecord[];
}

function invalid(label: string, issue: string): never {
  throw new ValidationError(`CatalogView rejected: ${label} - ${issue}`, {
    reason: "CATALOG_VIEW_INVALID",
    details: [{ path: label, issue }],
  });
}

function sameTenant<T extends { readonly tenantId: unknown }>(
  record: T,
  tenantId: TenantId,
): boolean {
  return record.tenantId === tenantId;
}

/**
 * Builds the tenant-scoped catalog view. Inclusion rules:
 *  - only records of the given tenant are considered (fail closed: other
 *    tenants' records are invisible, not merged);
 *  - only ACTIVE products appear, and only with their ACTIVE variants
 *    (draft/retired products and retired variants are catalog-invisible);
 *  - a variant whose (same-tenant) product is missing or not active never
 *    appears, even if the variant itself is active.
 */
export function buildCatalogView(input: CatalogViewInput): CatalogView {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid("$", "input must be an object");
  }
  const tenantId = parseTenantIdOrInvalid(input.tenantId);
  const computedAt = parseUtcInstantOrInvalid(input.computedAt);
  if (!Array.isArray(input.products)) {
    invalid("products", "must be an array of committed product records");
  }
  if (!Array.isArray(input.variants)) {
    invalid("variants", "must be an array of committed variant records");
  }

  const tenantProducts = input.products.filter(
    (product) => sameTenant(product, tenantId) && product.status === "active",
  );
  const tenantVariants = input.variants.filter((variant) => sameTenant(variant, tenantId));

  const activeProductsById = new Map<string, ProductRecord>();
  for (const product of tenantProducts) {
    activeProductsById.set(product.productId, product);
  }

  const variantsByProduct = new Map<string, ProductVariantRecord[]>();
  for (const variant of tenantVariants) {
    if (variant.status !== "active") continue;
    if (!activeProductsById.has(variant.productId)) continue; // no orphan variants in the catalog
    const bucket = variantsByProduct.get(variant.productId) ?? [];
    bucket.push(variant);
    variantsByProduct.set(variant.productId, bucket);
  }

  const entries: CatalogEntry[] = [];
  for (const product of tenantProducts) {
    const variants = (variantsByProduct.get(product.productId) ?? []).sort((a, b) =>
      a.variantId < b.variantId ? -1 : 1,
    );
    entries.push(
      Object.freeze({
        product: Object.freeze(structuredClone(product)),
        variants: Object.freeze(variants.map((variant) => Object.freeze(structuredClone(variant)))),
      }),
    );
  }
  entries.sort((a, b) =>
    a.product.name === b.product.name
      ? a.product.productId < b.product.productId
        ? -1
        : 1
      : a.product.name < b.product.name
        ? -1
        : 1,
  );

  const variantCount = entries.reduce((total, entry) => total + entry.variants.length, 0);

  // Deterministic provenance digest: the exact committed inputs, sorted
  // canonically (records keyed by id, arrays ordered deterministically).
  const digestInput = {
    products: [...input.products]
      .filter((product) => sameTenant(product, tenantId))
      .sort((a, b) => (a.productId < b.productId ? -1 : 1)),
    variants: [...input.variants]
      .filter((variant) => sameTenant(variant, tenantId))
      .sort((a, b) => (a.variantId < b.variantId ? -1 : 1)),
  };

  return Object.freeze({
    tenantId,
    computedAt,
    entries: Object.freeze(entries),
    productCount: entries.length,
    variantCount,
    inputDigest: canonicalJsonDigest(digestInput),
  });
}

// --- helpers -----------------------------------------------------------------

function parseTenantIdOrInvalid(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    invalid("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseUtcInstantOrInvalid(value: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    invalid("computedAt", "must be a UTC instant with a zone designator");
  }
}
