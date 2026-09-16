/**
 * RL-021 tests: Order + OrderLine aggregates and lifecycle (with the
 * §5-envelope `orderVersion` CAS), Subscription lifecycle with term
 * arithmetic and expiry proofs, SUPERSESSION of subscription changes,
 * event sourcing (append-only + chain continuity + command correlation),
 * idempotent command replay, and the tenant fail-closed boundary.
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseOrderId,
  parseSubscriptionId,
  parseUserId,
  parseUtcInstant,
} from "@roamlink/contracts";

import {
  Order,
  OrderLine,
  Subscription,
  utcInstantPlusDays,
  type CommerceEventRecord,
} from "../src/index.js";
import { makeWorld, idAt, T0 } from "./helpers.js";

const PRODUCT = idAt(200);
const VARIANT_7D = idAt(210);
const VARIANT_30D = idAt(211);
const ORDER = parseOrderId(idAt(220));
const LINE_1 = idAt(230);
const LINE_2 = idAt(231);
const SUB_1 = parseSubscriptionId(idAt(240));
const SUB_2 = parseSubscriptionId(idAt(241));
const OWNER = parseUserId("00000000-0000-4000-8000-000000000002");

const ORG_TENANT = "org:00000000-0000-4000-8000-000000000001";

const at = (iso: string) => parseUtcInstant(iso);

async function seedCatalog(world: ReturnType<typeof makeWorld>) {
  await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "Traveler" });
  await world.catalog.activateProduct(world.envelope(), {
    productId: PRODUCT,
    expectedRevision: 1,
  });
  await world.catalog.createVariant(world.envelope(), {
    variantId: VARIANT_7D,
    productId: PRODUCT,
    name: "7-Day Pass",
    sku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    price: { amountMinorUnits: 999, currency: "USD" },
  });
  await world.catalog.createVariant(world.envelope(), {
    variantId: VARIANT_30D,
    productId: PRODUCT,
    name: "30-Day Plan",
    sku: "plan-30d",
    billingModel: "recurring",
    termDays: 30,
    price: { amountMinorUnits: 2999, currency: "USD" },
  });
}

async function seededOrder(world: ReturnType<typeof makeWorld>) {
  await seedCatalog(world);
  await world.orders.createOrder(world.envelope({ orderVersion: 1 }), {
    orderId: ORDER,
    ownerUserId: OWNER,
  });
}

// ---------------------------------------------------------------------------
// Order aggregate + lines
// ---------------------------------------------------------------------------

describe("Order aggregate", () => {
  const base = {
    tenantId: ORG_TENANT,
    ownerUserId: OWNER,
    lineCount: 1,
    totalAmount: { amountMinorUnits: 999, currency: "USD" },
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  } as const;

  it("validates the closed vocabulary (RL-LOCK-008: no delivery fields)", () => {
    expect(
      () =>
        new Order({
          ...base,
          orderId: ORDER,
          status: "draft",
          sessionRef: "adcos:session",
        } as never),
    ).toThrow(ValidationError);
  });

  it("proves the legal transitions: draft -> placed -> completed", () => {
    const draft = new Order({ ...base, orderId: ORDER, status: "draft" });
    const placed = draft.place(at("2026-02-01T00:00:00.000Z"));
    expect(placed.status).toBe("placed");
    expect(placed.revision).toBe(2);
    const completed = placed.complete(at("2026-02-02T00:00:00.000Z"));
    expect(completed.status).toBe("completed");
    expect(completed.revision).toBe(3);
  });

  it("proves every illegal transition (the full truth table)", () => {
    const draft = new Order({ ...base, orderId: ORDER, status: "draft", lineCount: 0, totalAmount: { amountMinorUnits: 0, currency: "XXX" } });
    // placing with zero lines expresses nothing commercial
    expect(() => draft.place(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    const draftWithLine = new Order({ ...base, orderId: ORDER, status: "draft" });
    expect(() => draftWithLine.complete(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    const placed = draftWithLine.place(at("2026-02-01T00:00:00.000Z"));
    expect(() => placed.place(at("2026-02-03T00:00:00.000Z"))).toThrow(ValidationError);
    const completed = placed.complete(at("2026-02-02T00:00:00.000Z"));
    expect(() => completed.cancel(at("2026-02-04T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => completed.complete(at("2026-02-04T00:00:00.000Z"))).toThrow(ValidationError);
    const cancelled = draftWithLine.cancel(at("2026-02-04T00:00:00.000Z"), "customer asked");
    expect(cancelled.cancelReason).toBe("customer asked");
    expect(() => cancelled.place(at("2026-02-05T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => cancelled.cancel(at("2026-02-05T00:00:00.000Z"))).toThrow(ValidationError);
  });
});

describe("OrderLine aggregate", () => {
  it("snapshots commercial terms and computes the line amount (immutable, revision 1)", () => {
    const line = new OrderLine({
      lineId: LINE_1,
      tenantId: ORG_TENANT,
      orderId: ORDER,
      productId: PRODUCT,
      variantId: VARIANT_7D,
      variantSku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      quantity: 3,
      unitPrice: { amountMinorUnits: 999, currency: "USD" },
      createdAt: T0,
    });
    expect(line.lineAmount).toEqual({ amountMinorUnits: 2997, currency: "USD" });
    expect(line.revision).toBe(1);
    expect(Object.isFrozen(line)).toBe(true);
  });

  it("rejects invalid quantities and unit prices", () => {
    const base = {
      lineId: LINE_1,
      tenantId: ORG_TENANT,
      orderId: ORDER,
      productId: PRODUCT,
      variantId: VARIANT_7D,
      variantSku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      createdAt: T0,
    };
    expect(
      () => new OrderLine({ ...base, quantity: 0, unitPrice: { amountMinorUnits: 999, currency: "USD" } }),
    ).toThrow(ValidationError);
    expect(
      () => new OrderLine({ ...base, quantity: 1, unitPrice: { amountMinorUnits: -1, currency: "USD" } }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// OrderService
// ---------------------------------------------------------------------------

describe("OrderService", () => {
  it("creates a draft order, adds snapshotted lines and maintains totals atomically", async () => {
    const world = makeWorld();
    await seededOrder(world);

    const line1 = await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 2,
    });
    expect(line1).toEqual({ orderId: ORDER, lineId: LINE_1, revision: 2 });
    const line2 = await world.orders.addOrderLine(world.envelope({ orderVersion: 2 }), {
      orderId: ORDER,
      lineId: LINE_2,
      variantId: VARIANT_30D,
      quantity: 1,
    });
    expect(line2).toEqual({ orderId: ORDER, lineId: LINE_2, revision: 3 });

    const order = await world.store.read.orders.findById(world.tenant, ORDER);
    expect(order?.lineCount).toBe(2);
    expect(order?.totalAmount).toEqual({ amountMinorUnits: 4997, currency: "USD" });

    const lines = await world.store.read.orderLines.listForOrder(world.tenant, ORDER);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.unitPrice).toEqual({ amountMinorUnits: 999, currency: "USD" });
    expect(lines[0]?.variantSku).toBe("pass-7d");
  });

  it("refuses lines on non-draft orders and unknown/retired variants", async () => {
    const world = makeWorld();
    await seededOrder(world);
    await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 1,
    });
    await world.orders.placeOrder(world.envelope({ orderVersion: 2 }), { orderId: ORDER });
    await expect(
      world.orders.addOrderLine(world.envelope({ orderVersion: 3 }), {
        orderId: ORDER,
        lineId: LINE_2,
        variantId: VARIANT_30D,
        quantity: 1,
      }),
    ).rejects.toThrow(ConflictError);

    await world.catalog.retireVariant(world.envelope(), {
      variantId: VARIANT_30D,
      expectedRevision: 1,
    });
    const order2 = parseOrderId(idAt(250));
    await world.orders.createOrder(world.envelope(), { orderId: order2, ownerUserId: OWNER });
    await expect(
      world.orders.addOrderLine(world.envelope(), {
        orderId: order2,
        lineId: LINE_2,
        variantId: VARIANT_30D,
        quantity: 1,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("enforces CAS via the envelope's orderVersion (stale command conflicts)", async () => {
    const world = makeWorld();
    await seededOrder(world);
    await expect(
      world.orders.addOrderLine(world.envelope({ orderVersion: 42 }), {
        orderId: ORDER,
        lineId: LINE_1,
        variantId: VARIANT_7D,
        quantity: 1,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("places, completes and cancels through the service with chained events", async () => {
    const world = makeWorld();
    await seededOrder(world);
    await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 1,
    });
    const placed = await world.orders.placeOrder(world.envelope({ orderVersion: 2 }), {
      orderId: ORDER,
    });
    expect(placed).toEqual({ orderId: ORDER, status: "placed", revision: 3 });
    const completed = await world.orders.completeOrder(world.envelope({ orderVersion: 3 }), {
      orderId: ORDER,
    });
    expect(completed).toEqual({ orderId: ORDER, status: "completed", revision: 4 });

    const events = await world.store.read.events.listForAggregate(world.tenant, "order", ORDER);
    expect(events.map((event) => event.transition)).toEqual([
      "order.created",
      "order.line_added",
      "order.placed",
      "order.completed",
    ]);
  });

  it("cannot place an empty order through the service", async () => {
    const world = makeWorld();
    await seededOrder(world);
    await expect(
      world.orders.placeOrder(world.envelope({ orderVersion: 1 }), { orderId: ORDER }),
    ).rejects.toThrow(ValidationError);
  });

  it("replays an addOrderLine command idempotently (same envelope, single line, single event)", async () => {
    const world = makeWorld();
    await seededOrder(world);
    const envelope = world.envelope({ orderVersion: 1 });
    const first = await world.orders.addOrderLine(envelope, {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 2,
    });
    const replay = await world.orders.addOrderLine(envelope, {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 2,
    });
    expect(replay).toEqual(first);

    const lines = await world.store.read.orderLines.listForOrder(world.tenant, ORDER);
    expect(lines).toHaveLength(1);
    const order = await world.store.read.orders.findById(world.tenant, ORDER);
    expect(order?.lineCount).toBe(1);
    const events = await world.store.read.events.listForAggregate(world.tenant, "order", ORDER);
    expect(events.filter((event) => event.transition === "order.line_added")).toHaveLength(1);
  });

  it("is tenant-scoped: another tenant sees neither the order nor its lines", async () => {
    const world = makeWorld();
    await seededOrder(world);
    await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
      orderId: ORDER,
      lineId: LINE_1,
      variantId: VARIANT_7D,
      quantity: 1,
    });

    expect(await world.store.read.orders.findById(world.otherTenant, ORDER)).toBeUndefined();
    expect(await world.store.read.orderLines.listForOrder(world.otherTenant, ORDER)).toEqual([]);
    expect(await world.store.read.orders.listByTenant(world.otherTenant)).toEqual([]);

    const stranger = world.envelope({ tenantId: world.otherTenant, orderVersion: 2 });
    await expect(
      world.orders.addOrderLine(stranger, {
        orderId: ORDER,
        lineId: LINE_2,
        variantId: VARIANT_7D,
        quantity: 1,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Subscription aggregate + service
// ---------------------------------------------------------------------------

describe("Subscription aggregate", () => {
  const base = {
    tenantId: ORG_TENANT,
    ownerUserId: OWNER,
    variantId: VARIANT_7D,
    variantSku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  } as const;

  it("proves the legal lifecycle: pending -> active -> suspended -> resumed -> expired", () => {
    const pending = new Subscription({ ...base, subscriptionId: SUB_1, status: "pending" });
    const activated = pending.activate(at("2026-02-01T00:00:00.000Z"));
    expect(activated.status).toBe("active");
    expect(activated.startAt).toBe("2026-02-01T00:00:00.000Z");
    expect(activated.endAt).toBe("2026-02-08T00:00:00.000Z"); // start + 7 days
    const suspended = activated.suspend(at("2026-02-03T00:00:00.000Z"));
    expect(suspended.status).toBe("suspended");
    const resumed = suspended.resume(at("2026-02-04T00:00:00.000Z"));
    expect(resumed.status).toBe("active");
    const expired = resumed.expire(at("2026-02-08T00:00:00.000Z")); // term elapsed
    expect(expired.status).toBe("expired");
  });

  it("proves the illegal transitions (truth table)", () => {
    const pending = new Subscription({ ...base, subscriptionId: SUB_1, status: "pending" });
    expect(() => pending.suspend(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => pending.resume(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => pending.expire(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => pending.supersede(SUB_2, at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);

    const active = new Subscription({
      ...base,
      subscriptionId: SUB_1,
      status: "active",
      startAt: "2026-02-01T00:00:00.000Z",
      endAt: "2026-02-08T00:00:00.000Z",
    });
    expect(() => active.activate(at("2026-02-02T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => active.expire(at("2026-02-07T23:59:59.999Z"))).toThrow(ValidationError); // term not elapsed

    const expired = new Subscription({
      ...base,
      subscriptionId: SUB_1,
      status: "expired",
      startAt: "2026-02-01T00:00:00.000Z",
      endAt: "2026-02-08T00:00:00.000Z",
    });
    expect(() => expired.cancel(at("2026-02-09T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => expired.suspend(at("2026-02-09T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => expired.supersede(SUB_2, at("2026-02-09T00:00:00.000Z"))).toThrow(ValidationError);
  });

  it("refuses resume after the term elapsed (terms never extend)", () => {
    const suspendedPastTerm = new Subscription({
      ...base,
      subscriptionId: SUB_1,
      status: "suspended",
      startAt: "2026-02-01T00:00:00.000Z",
      endAt: "2026-02-08T00:00:00.000Z",
    });
    expect(() => suspendedPastTerm.resume(at("2026-02-09T00:00:00.000Z"))).toThrow(ValidationError);
  });

  it("computes pure day arithmetic and validates term-bound pairing", () => {
    expect(utcInstantPlusDays(at("2026-02-01T00:00:00.000Z"), 30)).toBe("2026-03-03T00:00:00.000Z");
    expect(() => utcInstantPlusDays(at("2026-02-01T00:00:00.000Z"), -1)).toThrow(ValidationError);
    expect(
      () =>
        new Subscription({
          ...base,
          subscriptionId: SUB_1,
          status: "active",
          startAt: "2026-02-01T00:00:00.000Z",
        } as never),
    ).toThrow(ValidationError); // term bounds appear together
  });
});

describe("SubscriptionService", () => {
  async function startSubscription(world: ReturnType<typeof makeWorld>) {
    await seedCatalog(world);
    return world.subscriptions.startSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      ownerUserId: OWNER,
      variantId: VARIANT_30D,
    });
  }

  it("starts a pending subscription (terms snapshotted from the variant)", async () => {
    const world = makeWorld();
    const outcome = await startSubscription(world);
    expect(outcome).toEqual({ subscriptionId: SUB_1, status: "pending", revision: 1 });

    const record = await world.store.read.subscriptions.findById(world.tenant, SUB_1);
    expect(record?.termDays).toBe(30);
    expect(record?.billingModel).toBe("recurring");
    expect(record?.variantSku).toBe("plan-30d");
    expect(record?.startAt).toBeUndefined(); // the term starts at ACTIVATION
  });

  it("activates with the commercial term clock and walks the lifecycle through the service", async () => {
    const world = makeWorld();
    await startSubscription(world);
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 1,
      transition: "activate",
    });
    const record = await world.store.read.subscriptions.findById(world.tenant, SUB_1);
    expect(record?.status).toBe("active");
    expect(record?.startAt).toBe(T0);
    expect(record?.endAt).toBe("2026-02-14T08:30:00.000Z");

    await world.clock.advanceBy(86_400_000); // +1 day
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 2,
      transition: "suspend",
    });
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 3,
      transition: "resume",
    });
    const resumed = await world.store.read.subscriptions.findById(world.tenant, SUB_1);
    expect(resumed?.status).toBe("active");
    expect(resumed?.endAt).toBe("2026-02-14T08:30:00.000Z"); // resume never extends the term
  });

  it("rejects expiry before the term elapsed (through the service, fail closed)", async () => {
    const world = makeWorld();
    await startSubscription(world);
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 1,
      transition: "activate",
    });
    await expect(
      world.subscriptions.transitionSubscription(world.envelope(), {
        subscriptionId: SUB_1,
        expectedRevision: 2,
        transition: "expire",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("requires the observed revision (typed conflict on stale expectedRevision)", async () => {
    const world = makeWorld();
    await startSubscription(world);
    await expect(
      world.subscriptions.transitionSubscription(world.envelope(), {
        subscriptionId: SUB_1,
        expectedRevision: 7,
        transition: "activate",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("SUPERSEDES a plan change: old marked superseded-by, new carries supersedes, atomically", async () => {
    const world = makeWorld();
    await startSubscription(world);
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 1,
      transition: "activate",
    });

    const change = await world.subscriptions.changeSubscription(world.envelope(), {
      currentSubscriptionId: SUB_1,
      currentExpectedRevision: 2,
      newSubscriptionId: SUB_2,
      newVariantId: VARIANT_7D,
    });
    expect(change).toEqual({
      supersededSubscriptionId: SUB_1,
      replacementSubscriptionId: SUB_2,
      replacementStatus: "pending",
    });

    const old = await world.store.read.subscriptions.findById(world.tenant, SUB_1);
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe(SUB_2);
    expect(old?.endAt).toBe("2026-02-14T08:30:00.000Z"); // historical terms preserved

    const replacement = await world.store.read.subscriptions.findById(world.tenant, SUB_2);
    expect(replacement?.status).toBe("pending");
    expect(replacement?.supersedes).toBe(SUB_1);
    expect(replacement?.termDays).toBe(7);
    expect(replacement?.variantSku).toBe("pass-7d");

    // both chains carry their events
    const oldEvents = await world.store.read.events.listForAggregate(
      world.tenant,
      "subscription",
      SUB_1,
    );
    expect(oldEvents.map((event) => event.transition)).toEqual([
      "subscription.created",
      "subscription.activated",
      "subscription.superseded",
    ]);
    const newEvents = await world.store.read.events.listForAggregate(
      world.tenant,
      "subscription",
      SUB_2,
    );
    expect(newEvents.map((event) => event.transition)).toEqual(["subscription.created"]);
  });

  it("refuses supersession of terminal subscriptions and no-op plan changes", async () => {
    const world = makeWorld();
    await startSubscription(world);
    await world.subscriptions.transitionSubscription(world.envelope(), {
      subscriptionId: SUB_1,
      expectedRevision: 1,
      transition: "cancel",
    });
    await expect(
      world.subscriptions.changeSubscription(world.envelope(), {
        currentSubscriptionId: SUB_1,
        currentExpectedRevision: 2,
        newSubscriptionId: SUB_2,
        newVariantId: VARIANT_7D,
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      world.subscriptions.changeSubscription(world.envelope(), {
        currentSubscriptionId: SUB_1,
        currentExpectedRevision: 2,
        newSubscriptionId: SUB_2,
        newVariantId: VARIANT_30D,
      }),
    ).rejects.toThrow(ConflictError); // no-op plan change (same variant) is a typed conflict
  });

  it("replays subscription commands idempotently", async () => {
    const world = makeWorld();
    await seedCatalog(world);
    const envelope = world.envelope();
    const first = await world.subscriptions.startSubscription(envelope, {
      subscriptionId: SUB_1,
      ownerUserId: OWNER,
      variantId: VARIANT_30D,
    });
    const replay = await world.subscriptions.startSubscription(envelope, {
      subscriptionId: SUB_1,
      ownerUserId: OWNER,
      variantId: VARIANT_30D,
    });
    expect(replay).toEqual(first);
    const all = await world.store.read.subscriptions.listByTenant(world.tenant);
    expect(all).toHaveLength(1);
  });

  it("is tenant-scoped: cross-tenant reads and commands fail closed", async () => {
    const world = makeWorld();
    await startSubscription(world);
    expect(await world.store.read.subscriptions.findById(world.otherTenant, SUB_1)).toBeUndefined();
    expect(await world.store.read.subscriptions.listByOwner(world.otherTenant, OWNER)).toEqual([]);
    const stranger = world.envelope({ tenantId: world.otherTenant });
    await expect(
      world.subscriptions.transitionSubscription(stranger, {
        subscriptionId: SUB_1,
        expectedRevision: 1,
        transition: "activate",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Event sourcing discipline
// ---------------------------------------------------------------------------

describe("Commerce event sourcing", () => {
  it("carries full command correlation and post-transition state in every event", async () => {
    const world = makeWorld();
    const envelope = world.envelope();
    await world.catalog.createProduct(envelope, { productId: PRODUCT, name: "P" });

    const events = await world.store.read.events.listByTenant(world.tenant);
    const created = events.find(
      (event) => event.transition === "product.created",
    ) as CommerceEventRecord;
    expect(created.actorId).toBe(envelope.actorId);
    expect(created.commandId).toBe(envelope.commandId);
    expect(created.correlationId).toBe(envelope.correlationId);
    expect(created.idempotencyKey).toBe(envelope.idempotencyKey);
    expect(created.tenantId).toBe(world.tenant);
    expect((created.payload as { record: { status: string } }).record.status).toBe("draft");
  });

  it("is append-only with strict per-aggregate chain continuity (out-of-order rejected)", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "P" });
    const events = await world.store.read.events.listForAggregate(
      world.tenant,
      "product",
      PRODUCT,
    );
    expect(events.map((event) => event.sequence)).toEqual([1]);

    const first = events[0];
    expect(first).toBeDefined();
    const session = await world.store.begin();
    // sequence gap (3 instead of 2)
    await expect(
      session.events.append({
        ...first,
        eventId: idAt(300),
        sequence: 3,
      } as CommerceEventRecord),
    ).rejects.toThrow(ConflictError);
    // duplicate event id
    await expect(session.events.append(first as CommerceEventRecord)).rejects.toThrow(ConflictError);
    // replay of sequence 1
    await expect(
      session.events.append({ ...first, eventId: idAt(301), sequence: 1 } as CommerceEventRecord),
    ).rejects.toThrow(ConflictError);
    await session.rollback();
  });

  it("keeps other tenants' events invisible", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "P" });
    expect(await world.store.read.events.listByTenant(world.otherTenant)).toEqual([]);
    expect(
      await world.store.read.events.listForAggregate(world.otherTenant, "product", PRODUCT),
    ).toEqual([]);
  });
});
