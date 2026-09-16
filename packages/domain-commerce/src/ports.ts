/**
 * Tenant-scoped commerce repository ports + the commerce access policy
 * (RL-020/RL-021).
 *
 * MULTI-TENANCY BY CONSTRUCTION (same discipline as @roamlink/auth and
 * @roamlink/domain-experience): every record carries its Wave-0 TenantId and
 * every port read takes the tenant namespace FIRST; a read through the wrong
 * tenant returns undefined/empty - no existence oracle, cross-tenant access
 * fails closed (RL-LOCK-018). The in-memory adapters PROVE this in tests.
 *
 * ALL WRITES go through compare-and-swap semantics on the record revision,
 * implemented over the Wave-0 persistence primitives (@roamlink/persistence
 * UnitOfWork + versioned record repositories, RL-003): a repository session
 * is ONE unit of work, so multi-aggregate writes (order + lines + events)
 * commit atomically or not at all, and a lost optimistic-concurrency race is
 * a TYPED ConflictError at commit - never a silent overwrite (RL-LOCK-014).
 *
 * The {@link CommerceAccessPolicy} port is the authorization seam: the
 * composition layer (Wave 2+) binds an adapter over @roamlink/auth's
 * authorization; this package never imports auth internals (RL-LOCK-019).
 */
import type {
  ActorId,
  OrderId,
  SubscriptionId,
  TenantId,
  UtcInstant,
  UserId,
} from "@roamlink/contracts";

import type { CommerceEventRecord } from "./events.js";
import type { OrderLineRecord, OrderRecord } from "./order.js";
import type { ProductRecord } from "./product.js";
import type { ProductVariantRecord } from "./product-variant.js";
import type { SubscriptionRecord } from "./subscription.js";

/** Marker: every persisted commerce record is tenant-scoped. */
export interface CommerceTenantScopedRecord {
  readonly tenantId: TenantId;
}

// ---------------------------------------------------------------------------
// Commerce access policy (authorization seam)
// ---------------------------------------------------------------------------

/** The closed commerce-action vocabulary checked by the policy port. */
export const COMMERCE_ACTIONS = [
  "catalog:read",
  "catalog:write",
  "order:read",
  "order:write",
  "subscription:read",
  "subscription:write",
] as const;

export type CommerceAction = (typeof COMMERCE_ACTIONS)[number];

export function isCommerceAction(value: unknown): value is CommerceAction {
  return (
    typeof value === "string" && (COMMERCE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The commerce access policy port. `authorize` resolves asynchronously and
 * throws UnauthorizedError on denial (fail closed); the production adapter
 * delegates to @roamlink/auth (composition layer, Wave 2+).
 */
export interface CommerceAccessPolicy {
  authorize(
    actorId: ActorId,
    tenantId: TenantId,
    action: CommerceAction,
    at: UtcInstant,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reader interfaces (committed-state reads for read models and services)
// ---------------------------------------------------------------------------

/** Tenant-scoped product reads. */
export interface ProductReader {
  findById(tenantId: TenantId, productId: string): Promise<ProductRecord | undefined>;
  listByTenant(tenantId: TenantId): Promise<readonly ProductRecord[]>;
}

/** Tenant-scoped variant reads. */
export interface ProductVariantReader {
  findById(tenantId: TenantId, variantId: string): Promise<ProductVariantRecord | undefined>;
  listByProduct(tenantId: TenantId, productId: string): Promise<readonly ProductVariantRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly ProductVariantRecord[]>;
}

/** Tenant-scoped order reads. */
export interface OrderReader {
  findById(tenantId: TenantId, orderId: OrderId): Promise<OrderRecord | undefined>;
  listByTenant(tenantId: TenantId): Promise<readonly OrderRecord[]>;
}

/** Tenant-scoped order-line reads. */
export interface OrderLineReader {
  findById(tenantId: TenantId, lineId: string): Promise<OrderLineRecord | undefined>;
  listForOrder(tenantId: TenantId, orderId: OrderId): Promise<readonly OrderLineRecord[]>;
}

/** Tenant-scoped subscription reads. */
export interface SubscriptionReader {
  findById(tenantId: TenantId, subscriptionId: SubscriptionId): Promise<SubscriptionRecord | undefined>;
  listByOwner(tenantId: TenantId, ownerUserId: UserId): Promise<readonly SubscriptionRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly SubscriptionRecord[]>;
}

/** Tenant-scoped commerce-event reads. */
export interface CommerceEventReader {
  findById(tenantId: TenantId, eventId: string): Promise<CommerceEventRecord | undefined>;
  listForAggregate(
    tenantId: TenantId,
    aggregateType: CommerceEventRecord["aggregateType"],
    aggregateId: string,
  ): Promise<readonly CommerceEventRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly CommerceEventRecord[]>;
}

// ---------------------------------------------------------------------------
// Write repositories (session-scoped: available only inside a CommerceSession)
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped product repository. `save` is compare-and-swap on the record
 * revision: inserting a record whose id already exists, or updating one
 * whose stored revision is not exactly `record.revision - 1`, is a typed
 * ConflictError.
 */
export interface ProductRepository extends ProductReader {
  save(record: ProductRecord): Promise<void>;
}

/** Tenant-scoped variant repository (same CAS discipline as products). */
export interface ProductVariantRepository extends ProductVariantReader {
  save(record: ProductVariantRecord): Promise<void>;
}

/** Tenant-scoped order repository (same CAS discipline). */
export interface OrderRepository extends OrderReader {
  save(record: OrderRecord): Promise<void>;
}

/**
 * Tenant-scoped order-line repository. Lines are IMMUTABLE: only inserts at
 * revision 1 are accepted; re-inserting an existing line id is a typed
 * ConflictError.
 */
export interface OrderLineRepository extends OrderLineReader {
  save(record: OrderLineRecord): Promise<void>;
}

/** Tenant-scoped subscription repository (same CAS discipline as products). */
export interface SubscriptionRepository extends SubscriptionReader {
  save(record: SubscriptionRecord): Promise<void>;
}

/**
 * Tenant-scoped commerce-event repository. Events are APPEND-ONLY and
 * CHAINED per aggregate: `append` accepts an event only when its sequence is
 * exactly latest + 1 for the (tenant, aggregateType, aggregateId) chain and
 * its id is new; anything else is a typed ConflictError. No mutation or
 * deletion API exists.
 */
export interface CommerceEventRepository extends CommerceEventReader {
  append(event: CommerceEventRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// The commerce store: session factory + committed-state readers
// ---------------------------------------------------------------------------

/**
 * One atomic commerce unit of work: every write made through the session's
 * repositories becomes visible together at `commit()`, or not at all after
 * `rollback()` / a failed commit (a lost race surfaces as a typed
 * ConflictError and NOTHING is applied).
 */
export interface CommerceSession {
  readonly products: ProductRepository;
  readonly variants: ProductVariantRepository;
  readonly orders: OrderRepository;
  readonly orderLines: OrderLineRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly events: CommerceEventRepository;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Committed-state reads only - read models consume these, never sessions. */
export interface CommerceReadViews {
  readonly products: ProductReader;
  readonly variants: ProductVariantReader;
  readonly orders: OrderReader;
  readonly orderLines: OrderLineReader;
  readonly subscriptions: SubscriptionReader;
  readonly events: CommerceEventReader;
}

/**
 * The commerce store port: opens atomic sessions and exposes committed-state
 * readers. The in-memory implementation (./in-memory.ts) runs over the
 * Wave-0 persistence in-memory adapter; durable implementations bind the
 * same persistence ports (RL-003).
 */
export interface CommerceStore {
  begin(): Promise<CommerceSession>;
  readonly read: CommerceReadViews;
}
