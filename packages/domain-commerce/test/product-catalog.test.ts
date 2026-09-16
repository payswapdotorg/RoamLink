/**
 * RL-020 tests: money value object, Product/ProductVariant aggregates,
 * catalog service lifecycle with events + idempotency, optimistic-
 * concurrency conflicts (CAS), the catalog read model, and the tenant
 * fail-closed boundary (RL-LOCK-018).
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  canonicalJsonDigest,
  parseUtcInstant,
} from "@roamlink/contracts";

import {
  buildCatalogView,
  parseMoneyValue,
  addMoney,
  multiplyMoney,
  moneyEquals,
  Product,
  ProductVariant,
} from "../src/index.js";
import { makeWorld, idAt, T0 } from "./helpers.js";

const UUID_A = idAt(100);
const UUID_B = idAt(101);
const UUID_C = idAt(102);
const VARIANT_1 = idAt(110);

const at = (iso: string) => parseUtcInstant(iso);
const VARIANT_2 = idAt(111);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe("Money value object", () => {
  it("parses and freezes valid values", () => {
    const money = parseMoneyValue({ amountMinorUnits: 1999, currency: "USD" });
    expect(money.amountMinorUnits).toBe(1999);
    expect(money.currency).toBe("USD");
    expect(Object.isFrozen(money)).toBe(true);
  });

  it("rejects unknown fields, non-integer amounts, negative amounts and bad currency shapes", () => {
    expect(() => parseMoneyValue({ amountMinorUnits: 1, currency: "USD", extra: 1 })).toThrow(
      ValidationError,
    );
    expect(() => parseMoneyValue({ amountMinorUnits: 1.5, currency: "USD" })).toThrow(
      ValidationError,
    );
    expect(() => parseMoneyValue({ amountMinorUnits: -1, currency: "USD" })).toThrow(
      ValidationError,
    );
    expect(() => parseMoneyValue({ amountMinorUnits: 1, currency: "usd" })).toThrow(ValidationError);
    expect(() => parseMoneyValue({ amountMinorUnits: 1, currency: "USDX" })).toThrow(
      ValidationError,
    );
    expect(() => parseMoneyValue(null)).toThrow(ValidationError);
  });

  it("adds same-currency amounts and refuses cross-currency addition", () => {
    const a = parseMoneyValue({ amountMinorUnits: 100, currency: "EUR" });
    const b = parseMoneyValue({ amountMinorUnits: 250, currency: "EUR" });
    expect(moneyEquals(addMoney(a, b), parseMoneyValue({ amountMinorUnits: 350, currency: "EUR" }))).toBe(
      true,
    );
    const c = parseMoneyValue({ amountMinorUnits: 1, currency: "USD" });
    expect(() => addMoney(a, c)).toThrow(ValidationError);
  });

  it("multiplies by integer quantities and rejects invalid quantities", () => {
    const unit = parseMoneyValue({ amountMinorUnits: 999, currency: "JPY" });
    expect(
      multiplyMoney(unit, 3).amountMinorUnits,
    ).toBe(2997);
    expect(() => multiplyMoney(unit, 0)).toThrow(ValidationError);
    expect(() => multiplyMoney(unit, 101)).toThrow(ValidationError);
    expect(() => multiplyMoney(unit, 1.5)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Product / ProductVariant aggregates
// ---------------------------------------------------------------------------

describe("Product aggregate", () => {
  it("validates the closed vocabulary (no connectivity/delivery fields, RL-LOCK-008)", () => {
    expect(() =>
      new Product({
        productId: UUID_A,
        tenantId: "org:00000000-0000-4000-8000-000000000001",
        name: "Global Traveler",
        status: "draft",
        createdAt: T0,
        updatedAt: T0,
        revision: 1,
        reservationId: "adcos:whatever", // unknown field must be rejected
      } as never),
    ).toThrow(ValidationError);
  });

  it("follows draft -> active -> retired with revision bumps and frozen instances", () => {
    const product = new Product({
      productId: UUID_A,
      tenantId: "org:00000000-0000-4000-8000-000000000001",
      name: "Global Traveler",
      status: "draft",
      createdAt: T0,
      updatedAt: T0,
      revision: 1,
    });
    const active = product.activate(at("2026-02-01T00:00:00.000Z"));
    expect(active.status).toBe("active");
    expect(active.revision).toBe(2);
    expect(product.status).toBe("draft"); // transitions return new instances
    const retired = active.retire(at("2026-03-01T00:00:00.000Z"));
    expect(retired.status).toBe("retired");
    expect(retired.revision).toBe(3);
  });

  it("proves the illegal transitions (terminal + skipping)", () => {
    const draft = new Product({
      productId: UUID_A,
      tenantId: "org:00000000-0000-4000-8000-000000000001",
      name: "P",
      status: "draft",
      createdAt: T0,
      updatedAt: T0,
      revision: 1,
    });
    const retired = draft.retire(at("2026-03-01T00:00:00.000Z"));
    expect(() => retired.activate(at("2026-04-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => retired.retire(at("2026-04-01T00:00:00.000Z"))).toThrow(ValidationError);
    const active = draft.activate(at("2026-02-01T00:00:00.000Z"));
    expect(() => active.activate(at("2026-04-01T00:00:00.000Z"))).toThrow(ValidationError);
  });
});

describe("ProductVariant aggregate", () => {
  const base = {
    tenantId: "org:00000000-0000-4000-8000-000000000001",
    productId: UUID_A,
    name: "7-Day Pass",
    sku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    price: { amountMinorUnits: 999, currency: "USD" },
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  } as const;

  it("validates SKU shape, billing model, term bounds and price", () => {
    expect(
      () =>
        new ProductVariant({
          ...base,
          variantId: VARIANT_1,
          sku: "Bad_SKU",
        } as never),
    ).toThrow(ValidationError);
    expect(
      () =>
        new ProductVariant({
          ...base,
          variantId: VARIANT_1,
          billingModel: "sometimes",
        } as never),
    ).toThrow(ValidationError);
    expect(
      () =>
        new ProductVariant({
          ...base,
          variantId: VARIANT_1,
          termDays: 0,
        } as never),
    ).toThrow(ValidationError);
    expect(
      () =>
        new ProductVariant({
          ...base,
          variantId: VARIANT_1,
          price: { amountMinorUnits: -5, currency: "USD" },
        } as never),
    ).toThrow(ValidationError);
  });

  it("is created active and retires terminally", () => {
    const variant = new ProductVariant({ ...base, variantId: VARIANT_1 } as never);
    expect(variant.status).toBe("active");
    const retired = variant.retire(at("2026-05-01T00:00:00.000Z"));
    expect(retired.status).toBe("retired");
    expect(retired.revision).toBe(2);
    expect(() => retired.retire(at("2026-06-01T00:00:00.000Z"))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// CatalogService: lifecycle, events, idempotency, CAS
// ---------------------------------------------------------------------------

describe("CatalogService", () => {
  it("creates a draft product, appends the chained event and replays idempotently", async () => {
    const world = makeWorld();
    const envelope = world.envelope();
    const outcome1 = await world.catalog.createProduct(envelope, {
      productId: UUID_A,
      name: "Global Traveler",
    });
    expect(outcome1).toEqual({ productId: UUID_A, status: "draft", revision: 1 });

    // Replay of the SAME envelope returns the recorded outcome and writes nothing new.
    const outcome2 = await world.catalog.createProduct(envelope, {
      productId: UUID_A,
      name: "Global Traveler",
    });
    expect(outcome2).toEqual(outcome1);

    const events = await world.store.read.events.listForAggregate(
      world.tenant,
      "product",
      UUID_A,
    );
    expect(events.map((event) => event.transition)).toEqual(["product.created"]);

    const record = await world.store.read.products.findById(world.tenant, UUID_A);
    expect(record?.status).toBe("draft");
    expect(record?.revision).toBe(1);
  });

  it("rejects a DIFFERENT command under a used idempotency key (RL-LOCK-014)", async () => {
    const world = makeWorld();
    const envelope = world.envelope({ key: "shared-key" });
    await world.catalog.createProduct(envelope, { productId: UUID_A, name: "One" });
    // Same envelope replays (recorded outcome, no second product):
    const replay = await world.catalog.createProduct(envelope, { productId: UUID_B, name: "Two" });
    expect(replay.productId).toBe(UUID_A);
    expect(await world.store.read.products.listByTenant(world.tenant)).toHaveLength(1);
    // A different envelope (different digest) under the same key conflicts:
    const different = world.envelope({ key: "shared-key" });
    await world.clock.advanceBy(1_000);
    const shifted = world.envelope({ key: "shared-key" });
    expect(shifted.idempotencyKey).toBe(different.idempotencyKey);
    await expect(
      world.catalog.createProduct(shifted, { productId: UUID_B, name: "Two" }),
    ).rejects.toThrow(ConflictError);
  });

  it("activates and retires products with CAS via expectedRevision", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    const activated = await world.catalog.activateProduct(world.envelope(), {
      productId: UUID_A,
      expectedRevision: 1,
    });
    expect(activated).toEqual({ productId: UUID_A, status: "active", revision: 2 });
    const retired = await world.catalog.retireProduct(world.envelope(), {
      productId: UUID_A,
      expectedRevision: 2,
    });
    expect(retired).toEqual({ productId: UUID_A, status: "retired", revision: 3 });

    const events = await world.store.read.events.listForAggregate(world.tenant, "product", UUID_A);
    expect(events.map((event) => event.transition)).toEqual([
      "product.created",
      "product.activated",
      "product.retired",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("rejects stale expectedRevision (typed conflict, never silent overwrite)", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    await expect(
      world.catalog.activateProduct(world.envelope(), {
        productId: UUID_A,
        expectedRevision: 99,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("detects a concurrent committer's race at session commit (real CAS through persistence)", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });

    // Two sessions begin from the same committed state; both observe revision 1.
    const sessionA = await world.store.begin();
    const sessionB = await world.store.begin();
    const maybeA = await sessionA.products.findById(world.tenant, UUID_A);
    const maybeB = await sessionB.products.findById(world.tenant, UUID_A);
    expect(maybeA).toBeDefined();
    expect(maybeB).toBeDefined();
    const storedA = maybeA as NonNullable<typeof maybeA>;
    const storedB = maybeB as NonNullable<typeof maybeB>;
    expect(storedA.revision).toBe(1);
    expect(storedB.revision).toBe(1);

    // A activates (revision 2) and commits first.
    await sessionA.products.save(Product.fromRecord(storedA).activate(at(T0)).toRecord());
    await sessionA.commit();

    // B writes revision 2 from ITS stale snapshot: commit must conflict atomically.
    await sessionB.products.save(Product.fromRecord(storedB).activate(at(T0)).toRecord());
    await expect(sessionB.commit()).rejects.toThrow(ConflictError);
    await sessionB.rollback();

    const final = await world.store.read.products.findById(world.tenant, UUID_A);
    expect(final?.revision).toBe(2); // A's write survived; B's was rejected whole
  });

  it("refuses to retire a product with active variants (explicit retirement, no cascade)", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    await world.catalog.activateProduct(world.envelope(), {
      productId: UUID_A,
      expectedRevision: 1,
    });
    await world.catalog.createVariant(world.envelope(), {
      variantId: VARIANT_1,
      productId: UUID_A,
      name: "7-Day Pass",
      sku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      price: { amountMinorUnits: 999, currency: "USD" },
    });
    await expect(
      world.catalog.retireProduct(world.envelope(), { productId: UUID_A, expectedRevision: 2 }),
    ).rejects.toThrow(ConflictError);
  });

  it("enforces per-product SKU uniqueness within a tenant", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    const input = {
      productId: UUID_A,
      name: "7-Day Pass",
      sku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      price: { amountMinorUnits: 999, currency: "USD" },
    };
    await world.catalog.createVariant(world.envelope(), { variantId: VARIANT_1, ...input });
    await expect(
      world.catalog.createVariant(world.envelope(), { variantId: VARIANT_2, ...input }),
    ).rejects.toThrow(ConflictError);
  });

  it("retires variants and forbids variants on retired products", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    await world.catalog.createVariant(world.envelope(), {
      variantId: VARIANT_1,
      productId: UUID_A,
      name: "V",
      sku: "v-1",
      billingModel: "recurring",
      termDays: 30,
      price: { amountMinorUnits: 1500, currency: "EUR" },
    });
    const retired = await world.catalog.retireVariant(world.envelope(), {
      variantId: VARIANT_1,
      expectedRevision: 1,
    });
    expect(retired).toEqual({ variantId: VARIANT_1, status: "retired", revision: 2 });

    await world.catalog.retireProduct(world.envelope(), {
      productId: UUID_A,
      expectedRevision: 1,
    });
    await expect(
      world.catalog.createVariant(world.envelope(), {
        variantId: VARIANT_2,
        productId: UUID_A,
        name: "V2",
        sku: "v-2",
        billingModel: "recurring",
        termDays: 30,
        price: { amountMinorUnits: 1500, currency: "EUR" },
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("delegates authorization to the policy seam (fail closed)", async () => {
    const world = makeWorld();
    world.policy.deny("catalog:write");
    await expect(
      world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" }),
    ).rejects.toThrow();
  });

  it("fails closed when the product is not in the command tenant", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "P" });
    const stranger = world.envelope({ tenantId: world.otherTenant });
    await expect(
      world.catalog.activateProduct(stranger, { productId: UUID_A, expectedRevision: 1 }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Catalog read model (RL-020)
// ---------------------------------------------------------------------------

describe("Catalog read model", () => {
  async function seedCatalog(world: ReturnType<typeof makeWorld>) {
    await world.catalog.createProduct(world.envelope(), { productId: UUID_A, name: "A Product" });
    await world.catalog.activateProduct(world.envelope(), {
      productId: UUID_A,
      expectedRevision: 1,
    });
    await world.catalog.createProduct(world.envelope(), { productId: UUID_B, name: "B Product" });
    await world.catalog.createVariant(world.envelope(), {
      variantId: VARIANT_1,
      productId: UUID_A,
      name: "Active variant",
      sku: "a-1",
      billingModel: "one_time",
      termDays: 7,
      price: { amountMinorUnits: 999, currency: "USD" },
    });
    await world.catalog.createVariant(world.envelope(), {
      variantId: VARIANT_2,
      productId: UUID_A,
      name: "Retired variant",
      sku: "a-2",
      billingModel: "one_time",
      termDays: 14,
      price: { amountMinorUnits: 1499, currency: "USD" },
    });
    await world.catalog.retireVariant(world.envelope(), {
      variantId: VARIANT_2,
      expectedRevision: 1,
    });
    // Orphan variant: its product stays DRAFT (UUID_B).
    await world.catalog.createVariant(world.envelope(), {
      variantId: UUID_C,
      productId: UUID_B,
      name: "Orphan variant",
      sku: "b-1",
      billingModel: "recurring",
      termDays: 30,
      price: { amountMinorUnits: 1999, currency: "USD" },
    });
  }

  it("shows only active products with their active variants, deterministically ordered", async () => {
    const world = makeWorld();
    await seedCatalog(world);
    const view = buildCatalogView({
      tenantId: world.tenant,
      computedAt: "2026-06-01T00:00:00.000Z",
      products: await world.store.read.products.listByTenant(world.tenant),
      variants: await world.store.read.variants.listByTenant(world.tenant),
    });

    expect(view.productCount).toBe(1); // draft B excluded
    expect(view.variantCount).toBe(1); // retired a-2 excluded, orphan b-1 excluded
    const entry = view.entries[0];
    expect(entry).toBeDefined();
    expect(entry?.product.productId).toBe(UUID_A);
    expect(entry?.variants.map((variant) => variant.variantId)).toEqual([VARIANT_1]);
  });

  it("is tenant-scoped: another tenant's records are invisible, not merged", async () => {
    const world = makeWorld();
    await seedCatalog(world);
    const view = buildCatalogView({
      tenantId: world.otherTenant,
      computedAt: "2026-06-01T00:00:00.000Z",
      products: await world.store.read.products.listByTenant(world.tenant),
      variants: await world.store.read.variants.listByTenant(world.tenant),
    });
    expect(view.productCount).toBe(0);
    expect(view.variantCount).toBe(0);
    expect(view.entries).toEqual([]);
  });

  it("is deterministic: identical inputs produce identical digests; different inputs differ", async () => {
    const world = makeWorld();
    await seedCatalog(world);
    const products = await world.store.read.products.listByTenant(world.tenant);
    const variants = await world.store.read.variants.listByTenant(world.tenant);
    const first = buildCatalogView({
      tenantId: world.tenant,
      computedAt: "2026-06-01T00:00:00.000Z",
      products,
      variants,
    });
    const second = buildCatalogView({
      tenantId: world.tenant,
      computedAt: "2026-06-02T00:00:00.000Z",
      products: [...products].reverse(),
      variants: [...variants].reverse(),
    });
    expect(second.inputDigest).toBe(first.inputDigest); // input order does not matter

    const changed = buildCatalogView({
      tenantId: world.tenant,
      computedAt: "2026-06-02T00:00:00.000Z",
      products: [...products, ...products], // different input set
      variants,
    });
    expect(changed.inputDigest).not.toBe(first.inputDigest);
    expect(first.inputDigest).toBe(
      canonicalJsonDigest({
        products: [...products].sort((a, b) => (a.productId < b.productId ? -1 : 1)),
        variants: [...variants].sort((a, b) => (a.variantId < b.variantId ? -1 : 1)),
      }),
    );
  });

  it("rejects malformed inputs (bad tenant, bad instant, non-array)", () => {
    expect(() =>
      buildCatalogView({
        tenantId: "not-a-tenant",
        computedAt: "2026-06-01T00:00:00.000Z",
        products: [],
        variants: [],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildCatalogView({
        tenantId: "org:00000000-0000-4000-8000-000000000001",
        computedAt: "2026-06-01",
        products: [],
        variants: [],
      } as never),
    ).toThrow(ValidationError);
    expect(() =>
      buildCatalogView({
        tenantId: "org:00000000-0000-4000-8000-000000000001",
        computedAt: "2026-06-01T00:00:00.000Z",
        products: "nope",
        variants: [],
      } as never),
    ).toThrow(ValidationError);
  });
});
