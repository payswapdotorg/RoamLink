/**
 * Commerce services (RL-020/RL-021): envelope-gated, idempotent,
 * CAS-aware use cases for the catalog (products/variants), orders (with
 * lines) and subscriptions (with supersession).
 *
 * Discipline (mirrors the experience domain's service layer):
 *  - every mutating command takes a full §5 CommandEnvelope; the envelope's
 *    tenant IS the tenant of every read and write (no confused-deputy
 *    splits between envelope tenant and record tenant);
 *  - idempotency (RL-LOCK-014): the envelope's idempotency key is admitted
 *    first; a replay of the same envelope (same canonical digest) returns
 *    the recorded outcome and performs NO writes; a different command
 *    under the same key is a typed ConflictError;
 *  - optimistic concurrency: ORDER mutations CAS via the envelope's
 *    `orderVersion` field (the §5 contract's own field for order
 *    aggregates); catalog and subscription mutations CAS via explicit
 *    `expectedRevision` inputs (the closed envelope schema carries no field
 *    for those aggregates);
 *  - every transition appends an immutable, chain-sequenced commerce event
 *    carrying the full command correlation, in the SAME session (atomic
 *    with the state change);
 *  - authorization is delegated to the CommerceAccessPolicy seam (fail
 *    closed);
 *  - the service never invents connectivity semantics: no reservation,
 *    session, path, usage or payment state is created or implied
 *    (RL-LOCK-008; RL-022/RL-023 are Wave 3).
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseOrderId,
  parseSubscriptionId,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type OrderId,
  type SubscriptionId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  admitCommerceCommand,
  commitCommerceCommand,
  type CommerceIdempotencyLedger,
} from "./idempotency.js";
import { CommerceEvent, type CommerceEventRecord } from "./events.js";
import type {
  CommerceAccessPolicy,
  CommerceSession,
  CommerceStore,
} from "./ports.js";
import { Order, OrderLine, sumLineAmounts } from "./order.js";
import { Product } from "./product.js";
import { ProductVariant as Variant } from "./product-variant.js";
import { Subscription } from "./subscription.js";

/** Dependencies shared by all commerce services. */
export interface CommerceServiceDeps {
  readonly store: CommerceStore;
  readonly policy: CommerceAccessPolicy;
  readonly ledger: CommerceIdempotencyLedger;
  /** Explicit time source (never ambient; deterministic in tests). */
  readonly now: () => UtcInstant;
  /** Supplies fresh entity ids (deterministic in tests). */
  readonly generateId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`commerce command rejected: ${issue}`, {
    reason: "COMMERCE_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

// ---------------------------------------------------------------------------
// Event recording helper (session-scoped, chain-sequenced)
// ---------------------------------------------------------------------------

async function nextSequenceFor(
  session: CommerceSession,
  tenantId: TenantId,
  aggregateType: CommerceEventRecord["aggregateType"],
  aggregateId: string,
): Promise<number> {
  const chain = await session.events.listForAggregate(tenantId, aggregateType, aggregateId);
  return chain.length + 1;
}

async function recordEvent(
  session: CommerceSession,
  envelope: CommandEnvelope,
  aggregateType: CommerceEventRecord["aggregateType"],
  aggregateId: string,
  aggregateRevision: number,
  transition: CommerceEventRecord["transition"],
  payload: object,
  at: UtcInstant,
  generateId: () => string,
): Promise<void> {
  const sequence = await nextSequenceFor(session, envelope.tenantId, aggregateType, aggregateId);
  const event = new CommerceEvent({
    eventId: generateId(),
    tenantId: envelope.tenantId,
    aggregateType,
    aggregateId,
    aggregateRevision,
    sequence,
    transition,
    payload,
    actorId: envelope.actorId,
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    occurredAt: at,
  });
  await session.events.append(event.toRecord());
}

// ---------------------------------------------------------------------------
// CatalogService (RL-020)
// ---------------------------------------------------------------------------

/** Catalog use cases: product/variant lifecycle with events + idempotency. */
export class CatalogService {
  readonly #deps: CommerceServiceDeps;

  constructor(deps: CommerceServiceDeps) {
    this.#deps = deps;
  }

  /** Creates a DRAFT product (catalog:write). */
  async createProduct(
    envelope: CommandEnvelope,
    input: {
      readonly productId: string;
      readonly name: string;
      readonly description?: string;
    },
  ): Promise<{ readonly productId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly productId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "catalog:write", this.#deps.now());

    const at = this.#deps.now();
    const product = new Product({
      productId: input.productId,
      tenantId: envelope.tenantId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: "draft",
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });

    const session = await this.#deps.store.begin();
    try {
      await recordEvent(
        session,
        envelope,
        "product",
        product.productId,
        product.revision,
        "product.created",
        { record: product.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.products.save(product.toRecord());
      await session.commit();
    } catch (error) {
      await session.rollback();
      throw error;
    }

    const outcome: CanonicalJsonValue = Object.freeze({
      productId: product.productId,
      status: product.status,
      revision: product.revision,
    });
    await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
    return outcome as unknown as Outcome;
  }

  /** draft -> active (catalog:write; CAS via expectedRevision). */
  async activateProduct(
    envelope: CommandEnvelope,
    input: { readonly productId: string; readonly expectedRevision: number },
  ): Promise<{ readonly productId: string; readonly status: string; readonly revision: number }> {
    return this.transitionProduct(envelope, input, "activate");
  }

  /** draft|active -> retired, terminal (catalog:write; CAS via expectedRevision). */
  async retireProduct(
    envelope: CommandEnvelope,
    input: { readonly productId: string; readonly expectedRevision: number },
  ): Promise<{ readonly productId: string; readonly status: string; readonly revision: number }> {
    return this.transitionProduct(envelope, input, "retire");
  }

  async #findProduct(session: CommerceSession, tenantId: TenantId, productId: string) {
    const record = await session.products.findById(tenantId, productId);
    if (record === undefined) {
      throw new NotFoundError("product not found in the command tenant", {
        reason: "PRODUCT_NOT_FOUND",
      });
    }
    return Product.fromRecord(record);
  }

  private async transitionProduct(
    envelope: CommandEnvelope,
    input: { readonly productId: string; readonly expectedRevision: number },
    transition: "activate" | "retire",
  ): Promise<{ readonly productId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly productId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "catalog:write", this.#deps.now());

    if (
      typeof input.expectedRevision !== "number" ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      commandInvalid("expectedRevision must be a positive integer (the observed product revision)");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const product = await this.#findProduct(session, envelope.tenantId, input.productId);
      if (product.revision !== input.expectedRevision) {
        throw new ConflictError(
          "product optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the product changed concurrently); re-read and retry - never overwrite silently",
          { reason: "REVISION_CONFLICT" },
        );
      }
      const next = transition === "activate" ? product.activate(at) : product.retire(at);
      if (transition === "retire") {
        const activeVariants = await session.variants
          .listByProduct(envelope.tenantId, product.productId)
          .then((all) => all.filter((variant) => variant.status === "active"));
        if (activeVariants.length > 0) {
          throw new ConflictError(
            "the product still has active variants; retire them first (retirement is explicit, never cascaded)",
            { reason: "PRODUCT_HAS_ACTIVE_VARIANTS" },
          );
        }
      }
      await recordEvent(
        session,
        envelope,
        "product",
        product.productId,
        next.revision,
        transition === "activate" ? "product.activated" : "product.retired",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.products.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        productId: next.productId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * Creates an ACTIVE variant of a non-retired product (catalog:write).
   * SKU uniqueness is enforced per (tenant, product).
   */
  async createVariant(
    envelope: CommandEnvelope,
    input: {
      readonly variantId: string;
      readonly productId: string;
      readonly name: string;
      readonly sku: string;
      readonly billingModel: string;
      readonly termDays: number;
      readonly price: { readonly amountMinorUnits: number; readonly currency: string };
    },
  ): Promise<{ readonly variantId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly variantId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "catalog:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const product = await this.#findProduct(session, envelope.tenantId, input.productId);
      if (product.status === "retired") {
        throw new ConflictError("a retired product cannot gain variants", {
          reason: "PRODUCT_RETIRED",
        });
      }
      const siblings = await session.variants.listByProduct(envelope.tenantId, input.productId);
      if (siblings.some((variant) => variant.sku === input.sku)) {
        throw new ConflictError(
          "the product already has a variant with this SKU in this tenant (SKUs are unique per product)",
          { reason: "VARIANT_SKU_CONFLICT" },
        );
      }
      const variant = new Variant({
        variantId: input.variantId,
        tenantId: envelope.tenantId,
        productId: product.productId,
        name: input.name,
        sku: input.sku,
        billingModel: input.billingModel,
        termDays: input.termDays,
        price: input.price,
        status: "active",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordEvent(
        session,
        envelope,
        "product_variant",
        variant.variantId,
        variant.revision,
        "product_variant.created",
        { record: variant.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.variants.save(variant.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        variantId: variant.variantId,
        status: variant.status,
        revision: variant.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** active -> retired, terminal (catalog:write; CAS via expectedRevision). */
  async retireVariant(
    envelope: CommandEnvelope,
    input: { readonly variantId: string; readonly expectedRevision: number },
  ): Promise<{ readonly variantId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly variantId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "catalog:write", this.#deps.now());

    if (
      typeof input.expectedRevision !== "number" ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      commandInvalid("expectedRevision must be a positive integer (the observed variant revision)");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const record = await session.variants.findById(envelope.tenantId, input.variantId);
      if (record === undefined) {
        throw new NotFoundError("variant not found in the command tenant", {
          reason: "VARIANT_NOT_FOUND",
        });
      }
      const variant = Variant.fromRecord(record);
      if (variant.revision !== input.expectedRevision) {
        throw new ConflictError(
          "variant optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the variant changed concurrently); re-read and retry - never overwrite silently",
          { reason: "REVISION_CONFLICT" },
        );
      }
      const next = variant.retire(at);
      await recordEvent(
        session,
        envelope,
        "product_variant",
        variant.variantId,
        next.revision,
        "product_variant.retired",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.variants.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        variantId: next.variantId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// OrderService (RL-021)
// ---------------------------------------------------------------------------

/** Order use cases: draft orders, immutable lines, place/complete/cancel. */
export class OrderService {
  readonly #deps: CommerceServiceDeps;

  constructor(deps: CommerceServiceDeps) {
    this.#deps = deps;
  }

  async #findOrder(session: CommerceSession, tenantId: TenantId, orderId: string): Promise<Order> {
    const record = await session.orders.findById(tenantId, parseOrderId(orderId));
    if (record === undefined) {
      throw new NotFoundError("order not found in the command tenant", {
        reason: "ORDER_NOT_FOUND",
      });
    }
    return Order.fromRecord(record);
  }

  private expectOrderRevision(envelope: CommandEnvelope, current: number): void {
    if (envelope.orderVersion !== current) {
      throw new ConflictError(
        "order optimistic-concurrency conflict: the envelope's orderVersion does not match the stored order revision (the order changed concurrently); re-read and retry - never overwrite silently",
        { reason: "REVISION_CONFLICT" },
      );
    }
  }

  /** Creates a DRAFT order with zero lines (order:write). */
  async createOrder(
    envelope: CommandEnvelope,
    input: { readonly orderId: string; readonly ownerUserId: string },
  ): Promise<{ readonly orderId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly orderId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "order:write", this.#deps.now());

    const at = this.#deps.now();
    const order = new Order({
      orderId: input.orderId,
      tenantId: envelope.tenantId,
      ownerUserId: input.ownerUserId,
      status: "draft",
      lineCount: 0,
      totalAmount: { amountMinorUnits: 0, currency: "XXX" }, // no lines yet: XSC (no currency)
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });

    const session = await this.#deps.store.begin();
    try {
      await recordEvent(
        session,
        envelope,
        "order",
        order.orderId,
        order.revision,
        "order.created",
        { record: order.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.orders.save(order.toRecord());
      await session.commit();
    } catch (error) {
      await session.rollback();
      throw error;
    }

    const outcome: CanonicalJsonValue = Object.freeze({
      orderId: order.orderId,
      status: order.status,
      revision: order.revision,
    });
    await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
    return outcome as unknown as Outcome;
  }

  /**
   * Appends an immutable line to a DRAFT order (order:write). The variant
   * must be active in the command tenant; its commercial terms are
   * snapshotted. CAS via the envelope's `orderVersion`.
   */
  async addOrderLine(
    envelope: CommandEnvelope,
    input: {
      readonly orderId: string;
      readonly lineId: string;
      readonly variantId: string;
      readonly quantity: number;
    },
  ): Promise<{ readonly orderId: string; readonly lineId: string; readonly revision: number }> {
    type Outcome = { readonly orderId: string; readonly lineId: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "order:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const order = await this.#findOrder(session, envelope.tenantId, input.orderId);
      this.expectOrderRevision(envelope, order.revision);
      if (order.status !== "draft") {
        throw new ConflictError("lines can only be added to a draft order", {
          reason: "ORDER_NOT_DRAFT",
        });
      }
      const variantRecord = await session.variants.findById(envelope.tenantId, input.variantId);
      if (variantRecord === undefined) {
        throw new NotFoundError("variant not found in the command tenant", {
          reason: "VARIANT_NOT_FOUND",
        });
      }
      const variant = Variant.fromRecord(variantRecord);
      if (variant.status !== "active") {
        throw new ConflictError("only an active variant can be ordered", {
          reason: "VARIANT_NOT_ACTIVE",
        });
      }
      const productRecord = await session.products.findById(envelope.tenantId, variant.productId);
      if (productRecord === undefined || productRecord.status === "retired") {
        throw new ConflictError("the variant's product is not orderable in this tenant", {
          reason: "PRODUCT_NOT_ORDERABLE",
        });
      }

      const line = new OrderLine({
        lineId: input.lineId,
        tenantId: envelope.tenantId,
        orderId: order.orderId,
        productId: variant.productId,
        variantId: variant.variantId,
        variantSku: variant.sku,
        billingModel: variant.billingModel,
        termDays: variant.termDays,
        quantity: input.quantity,
        unitPrice: variant.price,
        createdAt: at,
      });

      const existingLines = await session.orderLines.listForOrder(envelope.tenantId, order.orderId);
      const totalAmount =
        existingLines.length === 0
          ? line.lineAmount
          : sumLineAmounts([...existingLines.map((l) => l.lineAmount), line.lineAmount]);
      const nextOrder = new Order({
        orderId: order.orderId,
        tenantId: order.tenantId,
        ownerUserId: order.ownerUserId,
        status: order.status,
        lineCount: existingLines.length + 1,
        totalAmount,
        createdAt: order.createdAt,
        updatedAt: at,
        revision: order.revision + 1,
      });

      await recordEvent(
        session,
        envelope,
        "order",
        order.orderId,
        nextOrder.revision,
        "order.line_added",
        { line: line.toRecord(), order: nextOrder.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.orderLines.save(line.toRecord());
      await session.orders.save(nextOrder.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        orderId: nextOrder.orderId,
        lineId: line.lineId,
        revision: nextOrder.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** draft -> placed (order:write; CAS via envelope.orderVersion). */
  async placeOrder(
    envelope: CommandEnvelope,
    input: { readonly orderId: string },
  ): Promise<{ readonly orderId: string; readonly status: string; readonly revision: number }> {
    return this.transitionOrder(envelope, input, "place");
  }

  /** placed -> completed (order:write; CAS via envelope.orderVersion). */
  async completeOrder(
    envelope: CommandEnvelope,
    input: { readonly orderId: string },
  ): Promise<{ readonly orderId: string; readonly status: string; readonly revision: number }> {
    return this.transitionOrder(envelope, input, "complete");
  }

  /** draft|placed -> cancelled (order:write; CAS via envelope.orderVersion). */
  async cancelOrder(
    envelope: CommandEnvelope,
    input: { readonly orderId: string; readonly reason?: string },
  ): Promise<{ readonly orderId: string; readonly status: string; readonly revision: number }> {
    return this.transitionOrder(envelope, input, "cancel", input.reason);
  }

  private async transitionOrder(
    envelope: CommandEnvelope,
    input: { readonly orderId: string; readonly reason?: string },
    transition: "place" | "complete" | "cancel",
    reason?: string,
  ): Promise<{ readonly orderId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly orderId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "order:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const order = await this.#findOrder(session, envelope.tenantId, input.orderId);
      this.expectOrderRevision(envelope, order.revision);
      const next =
        transition === "place"
          ? order.place(at)
          : transition === "complete"
            ? order.complete(at)
            : order.cancel(at, reason);
      await recordEvent(
        session,
        envelope,
        "order",
        order.orderId,
        next.revision,
        transition === "place"
          ? "order.placed"
          : transition === "complete"
            ? "order.completed"
            : "order.cancelled",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.orders.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        orderId: next.orderId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// SubscriptionService (RL-021)
// ---------------------------------------------------------------------------

/** Subscription use cases: start, activate/suspend/resume/cancel/expire, supersede. */
export class SubscriptionService {
  readonly #deps: CommerceServiceDeps;

  constructor(deps: CommerceServiceDeps) {
    this.#deps = deps;
  }

  async #findSubscription(
    session: CommerceSession,
    tenantId: TenantId,
    subscriptionId: string,
  ): Promise<Subscription> {
    const record = await session.subscriptions.findById(
      tenantId,
      parseSubscriptionId(subscriptionId),
    );
    if (record === undefined) {
      throw new NotFoundError("subscription not found in the command tenant", {
        reason: "SUBSCRIPTION_NOT_FOUND",
      });
    }
    return Subscription.fromRecord(record);
  }

  private expectRevision(expected: number, current: number): void {
    if (expected !== current) {
      throw new ConflictError(
        "subscription optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the subscription changed concurrently); re-read and retry - never overwrite silently",
        { reason: "REVISION_CONFLICT" },
      );
    }
  }

  /**
   * Starts a PENDING subscription for an active variant (subscription:write).
   * Commercial terms are snapshotted from the variant; the commercial term
   * clock starts at ACTIVATION, not here.
   */
  async startSubscription(
    envelope: CommandEnvelope,
    input: {
      readonly subscriptionId: string;
      readonly ownerUserId: string;
      readonly variantId: string;
      readonly originOrderId?: string;
      readonly originOrderLineId?: string;
    },
  ): Promise<{ readonly subscriptionId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly subscriptionId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "subscription:write", this.#deps.now());

    if ((input.originOrderId === undefined) !== (input.originOrderLineId === undefined)) {
      commandInvalid("origin order and origin line references appear together or not at all");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const variantRecord = await session.variants.findById(envelope.tenantId, input.variantId);
      if (variantRecord === undefined) {
        throw new NotFoundError("variant not found in the command tenant", {
          reason: "VARIANT_NOT_FOUND",
        });
      }
      const variant = Variant.fromRecord(variantRecord);
      if (variant.status !== "active") {
        throw new ConflictError("only an active variant can be subscribed", {
          reason: "VARIANT_NOT_ACTIVE",
        });
      }
      if (input.originOrderId !== undefined) {
        const order = await session.orders.findById(
          envelope.tenantId,
          input.originOrderId as OrderId,
        );
        if (order === undefined) {
          throw new NotFoundError("origin order not found in the command tenant", {
            reason: "ORDER_NOT_FOUND",
          });
        }
        const lines = await session.orderLines.listForOrder(
          envelope.tenantId,
          input.originOrderId as OrderId,
        );
        if (!lines.some((line) => line.lineId === input.originOrderLineId)) {
          throw new NotFoundError("origin order line not found on the origin order", {
            reason: "ORDER_LINE_NOT_FOUND",
          });
        }
      }

      const subscription = new Subscription({
        subscriptionId: input.subscriptionId,
        tenantId: envelope.tenantId,
        ownerUserId: input.ownerUserId,
        variantId: variant.variantId,
        variantSku: variant.sku,
        billingModel: variant.billingModel,
        termDays: variant.termDays,
        ...(input.originOrderId !== undefined ? { originOrderId: input.originOrderId } : {}),
        ...(input.originOrderLineId !== undefined
          ? { originOrderLineId: input.originOrderLineId }
          : {}),
        status: "pending",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordEvent(
        session,
        envelope,
        "subscription",
        subscription.subscriptionId,
        subscription.revision,
        "subscription.created",
        { record: subscription.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.subscriptions.save(subscription.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        subscriptionId: subscription.subscriptionId,
        status: subscription.status,
        revision: subscription.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * Applies a typed subscription transition (subscription:write; CAS via
   * expectedRevision). Expiry additionally requires the commercial term to
   * have elapsed (the aggregate enforces it).
   */
  async transitionSubscription(
    envelope: CommandEnvelope,
    input: {
      readonly subscriptionId: string;
      readonly expectedRevision: number;
      readonly transition: "activate" | "suspend" | "resume" | "cancel" | "expire";
    },
  ): Promise<{ readonly subscriptionId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly subscriptionId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "subscription:write", this.#deps.now());

    if (
      typeof input.expectedRevision !== "number" ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      commandInvalid("expectedRevision must be a positive integer (the observed subscription revision)");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const subscription = await this.#findSubscription(
        session,
        envelope.tenantId,
        input.subscriptionId,
      );
      this.expectRevision(input.expectedRevision, subscription.revision);
      const next =
        input.transition === "activate"
          ? subscription.activate(at)
          : input.transition === "suspend"
            ? subscription.suspend(at)
            : input.transition === "resume"
              ? subscription.resume(at)
              : input.transition === "cancel"
                ? subscription.cancel(at)
                : subscription.expire(at);
      const transitionEvent: CommerceEventRecord["transition"] =
        input.transition === "activate"
          ? "subscription.activated"
          : input.transition === "suspend"
            ? "subscription.suspended"
            : input.transition === "resume"
              ? "subscription.resumed"
              : input.transition === "cancel"
                ? "subscription.cancelled"
                : "subscription.expired";
      await recordEvent(
        session,
        envelope,
        "subscription",
        subscription.subscriptionId,
        next.revision,
        transitionEvent,
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.subscriptions.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        subscriptionId: next.subscriptionId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * SUPERSESSION of a subscription change (subscription:write): the current
   * subscription is marked `superseded` (explicit forward pointer) and a NEW
   * subscription is created with the new variant's terms, carrying the back
   * pointer - both in ONE atomic session. Historical terms are never
   * rewritten (the same discipline as ExperienceIntent supersession).
   */
  async changeSubscription(
    envelope: CommandEnvelope,
    input: {
      readonly currentSubscriptionId: string;
      readonly currentExpectedRevision: number;
      readonly newSubscriptionId: string;
      readonly newVariantId: string;
    },
  ): Promise<{
    readonly supersededSubscriptionId: string;
    readonly replacementSubscriptionId: string;
    readonly replacementStatus: string;
  }> {
    type Outcome = {
      readonly supersededSubscriptionId: string;
      readonly replacementSubscriptionId: string;
      readonly replacementStatus: string;
    };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "subscription:write", this.#deps.now());

    if (
      typeof input.currentExpectedRevision !== "number" ||
      !Number.isInteger(input.currentExpectedRevision) ||
      input.currentExpectedRevision < 1
    ) {
      commandInvalid("currentExpectedRevision must be a positive integer (the observed subscription revision)");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const current = await this.#findSubscription(
        session,
        envelope.tenantId,
        input.currentSubscriptionId,
      );
      this.expectRevision(input.currentExpectedRevision, current.revision);

      const variantRecord = await session.variants.findById(envelope.tenantId, input.newVariantId);
      if (variantRecord === undefined) {
        throw new NotFoundError("variant not found in the command tenant", {
          reason: "VARIANT_NOT_FOUND",
        });
      }
      const variant = Variant.fromRecord(variantRecord);
      if (variant.status !== "active") {
        throw new ConflictError("only an active variant can be subscribed", {
          reason: "VARIANT_NOT_ACTIVE",
        });
      }
      if (variant.variantId === current.variantId) {
        throw new ConflictError(
          "a subscription change requires a different variant (use the typed transitions for suspend/resume/cancel)",
          { reason: "SUBSCRIPTION_CHANGE_NOOP" },
        );
      }

      const superseded = current.supersede(input.newSubscriptionId as SubscriptionId, at);
      const replacement = new Subscription({
        subscriptionId: input.newSubscriptionId,
        tenantId: envelope.tenantId,
        ownerUserId: current.ownerUserId,
        variantId: variant.variantId,
        variantSku: variant.sku,
        billingModel: variant.billingModel,
        termDays: variant.termDays,
        ...(current.originOrderId !== undefined ? { originOrderId: current.originOrderId } : {}),
        ...(current.originOrderLineId !== undefined
          ? { originOrderLineId: current.originOrderLineId }
          : {}),
        status: "pending",
        supersedes: current.subscriptionId,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });

      await recordEvent(
        session,
        envelope,
        "subscription",
        current.subscriptionId,
        superseded.revision,
        "subscription.superseded",
        { record: superseded.toRecord(), replacementSubscriptionId: replacement.subscriptionId },
        at,
        this.#deps.generateId,
      );
      await recordEvent(
        session,
        envelope,
        "subscription",
        replacement.subscriptionId,
        replacement.revision,
        "subscription.created",
        { record: replacement.toRecord(), supersedesSubscriptionId: current.subscriptionId },
        at,
        this.#deps.generateId,
      );
      await session.subscriptions.save(superseded.toRecord());
      await session.subscriptions.save(replacement.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        supersededSubscriptionId: superseded.subscriptionId,
        replacementSubscriptionId: replacement.subscriptionId,
        replacementStatus: replacement.status,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }
}
