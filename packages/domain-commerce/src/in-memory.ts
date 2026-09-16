/**
 * In-memory commerce store over the Wave-0 persistence primitives
 * (RL-020/RL-021).
 *
 * TEST/LOCAL-DEVELOPMENT DOUBLE with the semantics a durable implementation
 * must provide - it delegates to `@roamlink/persistence`'s deterministic
 * in-memory adapter rather than reimplementing concurrency, so the proofs
 * that run here (tenant fail-closed, CAS conflicts, atomic multi-aggregate
 * commits, event chain continuity) exercise the SAME optimistic-concurrency
 * semantics production binds over PostgreSQL:
 *
 *  - a session is ONE persistence UnitOfWork: order + lines + events commit
 *    atomically, or not at all (transactional by construction);
 *  - writes are compare-and-swap on the record revision: `insert` at
 *    revision 1, `compareAndSwap(stored -> next)` afterwards; a concurrent
 *    committer that won the race surfaces as a typed ConflictError at commit
 *    (RL-LOCK-014 - never a silent overwrite);
 *  - record keys are tenant-namespaced (`<tenantId>:<entityId>`) and every
 *    read re-verifies the stored record's tenant, so a read through the
 *    wrong tenant finds nothing - no existence oracle (RL-LOCK-018);
 *  - events are append-only with per-aggregate chain continuity (sequence
 *    must be exactly latest + 1) and re-validated on append (fail closed).
 *
 * Stored values are the plain record forms; every read returns a
 * deep-frozen copy.
 */
import { ConflictError, ValidationError, type CanonicalJsonValue } from "@roamlink/contracts";
import {
  createInMemoryPersistence,
  type InMemoryPersistence,
  type RecordReadRepository,
  type UnitOfWork,
  type VersionedRecord,
} from "@roamlink/persistence";

import { CommerceEvent, type CommerceEventRecord } from "./events.js";
import type { OrderLineRecord, OrderRecord } from "./order.js";
import type { ProductRecord } from "./product.js";
import type { ProductVariantRecord } from "./product-variant.js";
import type { SubscriptionRecord } from "./subscription.js";
import type {
  CommerceEventReader,
  CommerceEventRepository,
  CommerceReadViews,
  CommerceSession,
  CommerceStore,
  OrderLineReader,
  OrderLineRepository,
  OrderReader,
  OrderRepository,
  ProductReader,
  ProductRepository,
  ProductVariantReader,
  ProductVariantRepository,
  SubscriptionReader,
  SubscriptionRepository,
} from "./ports.js";

const REPOSITORY_NAMES = {
  products: "commerce-products",
  variants: "commerce-variants",
  orders: "commerce-orders",
  orderLines: "commerce-order-lines",
  subscriptions: "commerce-subscriptions",
  events: "commerce-events",
} as const;

function revisionConflict(detail: string): ConflictError {
  return new ConflictError(
    `optimistic-concurrency conflict: ${detail}; re-read and retry - never overwrite silently`,
    { reason: "REVISION_CONFLICT" },
  );
}

function chainConflict(): ConflictError {
  return new ConflictError(
    "commerce event chain violation: the per-aggregate sequence must be exactly latest + 1 and the event id must be new (events are immutable; a replayed or out-of-order event is rejected, never silently applied)",
    { reason: "COMMERCE_EVENT_CHAIN_CONFLICT" },
  );
}

/** Builds the tenant-namespaced record key (foreign-ref safe charset). */
function recordKey(tenantId: string, entityId: string): string {
  const key = `${tenantId}:${entityId}`;
  if (key.length > 255) {
    throw new ValidationError("record key too long", {
      reason: "ID_INVALID",
      details: [{ path: "recordKey", issue: "tenant + entity exceeds 255 characters" }],
    });
  }
  return key;
}

/** Casts a plain record into the canonical JSON value type (records are JSON-native). */
function toStored(record: object): CanonicalJsonValue {
  return structuredClone(record) as unknown as CanonicalJsonValue;
}

function frozenCopy<T extends object>(value: T): T {
  return Object.freeze(structuredClone(value)) as T;
}

function decodeTenantScoped<T extends { readonly tenantId: string }>(
  stored: VersionedRecord,
  tenantId: string,
): T | undefined {
  const value = stored.value as Record<string, unknown>;
  if (value["tenantId"] !== tenantId) return undefined; // fail closed: no existence oracle
  return frozenCopy(value as unknown as T);
}

interface RevisionedRecord {
  readonly tenantId: string;
  readonly revision: number;
}

/**
 * Compare-and-swap save shared by every mutable-aggregate repository view:
 * revision 1 records insert; later revisions compare-and-swap from the
 * stored revision. Pre-checks against the unit-of-work's read view (your own
 * writes + the begin snapshot); concurrent races surface at commit as typed
 * ConflictErrors (persistence replay semantics).
 */
async function casSave(
  uow: UnitOfWork,
  repository: string,
  key: string,
  record: RevisionedRecord,
): Promise<void> {
  const records = uow.records(repository);
  const stored = await records.get(key);
  if (stored === null) {
    if (record.revision !== 1) {
      throw revisionConflict("a new record must carry revision 1");
    }
    await records.insert(key, toStored(record));
    return;
  }
  if (stored.version !== record.revision - 1) {
    throw revisionConflict(
      "the stored revision does not match the expected predecessor (the record changed concurrently)",
    );
  }
  await records.compareAndSwap(key, record.revision - 1, toStored(record));
}

// ---------------------------------------------------------------------------
// Session-scoped repository views
// ---------------------------------------------------------------------------

class ProductSessionView implements ProductRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: ProductRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.products,
      recordKey(record.tenantId, record.productId),
      record,
    );
  }

  async findById(tenantId: ProductRecord["tenantId"], productId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.products)
      .get(recordKey(tenantId, productId));
    return stored === null ? undefined : decodeTenantScoped<ProductRecord>(stored, tenantId);
  }

  async listByTenant(tenantId: ProductRecord["tenantId"]) {
    const out: ProductRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.products).list()) {
      const record = decodeTenantScoped<ProductRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

class ProductVariantSessionView implements ProductVariantRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: ProductVariantRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.variants,
      recordKey(record.tenantId, record.variantId),
      record,
    );
  }

  async findById(tenantId: ProductVariantRecord["tenantId"], variantId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.variants)
      .get(recordKey(tenantId, variantId));
    return stored === null ? undefined : decodeTenantScoped<ProductVariantRecord>(stored, tenantId);
  }

  async listByProduct(tenantId: ProductVariantRecord["tenantId"], productId: string) {
    const out: ProductVariantRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.variants).list()) {
      const record = decodeTenantScoped<ProductVariantRecord>(stored, tenantId);
      if (record !== undefined && record.productId === productId) out.push(record);
    }
    return Object.freeze(out);
  }

  async listByTenant(tenantId: ProductVariantRecord["tenantId"]) {
    const out: ProductVariantRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.variants).list()) {
      const record = decodeTenantScoped<ProductVariantRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

class OrderSessionView implements OrderRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: OrderRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.orders,
      recordKey(record.tenantId, record.orderId),
      record,
    );
  }

  async findById(tenantId: OrderRecord["tenantId"], orderId: string) {
    const stored = await this.#uow.records(REPOSITORY_NAMES.orders).get(recordKey(tenantId, orderId));
    return stored === null ? undefined : decodeTenantScoped<OrderRecord>(stored, tenantId);
  }

  async listByTenant(tenantId: OrderRecord["tenantId"]) {
    const out: OrderRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.orders).list()) {
      const record = decodeTenantScoped<OrderRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

class OrderLineSessionView implements OrderLineRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: OrderLineRecord): Promise<void> {
    if (record.revision !== 1) {
      throw revisionConflict("order lines are immutable (insert-only at revision 1)");
    }
    await this.#uow
      .records(REPOSITORY_NAMES.orderLines)
      .insert(recordKey(record.tenantId, record.lineId), toStored(record));
  }

  async findById(tenantId: OrderLineRecord["tenantId"], lineId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.orderLines)
      .get(recordKey(tenantId, lineId));
    return stored === null ? undefined : decodeTenantScoped<OrderLineRecord>(stored, tenantId);
  }

  async listForOrder(tenantId: OrderLineRecord["tenantId"], orderId: string) {
    const out: OrderLineRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.orderLines).list()) {
      const record = decodeTenantScoped<OrderLineRecord>(stored, tenantId);
      if (record !== undefined && record.orderId === orderId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.lineId < b.lineId ? -1 : 1)));
  }
}

class SubscriptionSessionView implements SubscriptionRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async save(record: SubscriptionRecord): Promise<void> {
    await casSave(
      this.#uow,
      REPOSITORY_NAMES.subscriptions,
      recordKey(record.tenantId, record.subscriptionId),
      record,
    );
  }

  async findById(tenantId: SubscriptionRecord["tenantId"], subscriptionId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.subscriptions)
      .get(recordKey(tenantId, subscriptionId));
    return stored === null ? undefined : decodeTenantScoped<SubscriptionRecord>(stored, tenantId);
  }

  async listByOwner(tenantId: SubscriptionRecord["tenantId"], ownerUserId: string) {
    const out: SubscriptionRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.subscriptions).list()) {
      const record = decodeTenantScoped<SubscriptionRecord>(stored, tenantId);
      if (record !== undefined && record.ownerUserId === ownerUserId) out.push(record);
    }
    return Object.freeze(out.sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : 1)));
  }

  async listByTenant(tenantId: SubscriptionRecord["tenantId"]) {
    const out: SubscriptionRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.subscriptions).list()) {
      const record = decodeTenantScoped<SubscriptionRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

class CommerceEventSessionView implements CommerceEventRepository {
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
  }

  async append(event: CommerceEventRecord): Promise<void> {
    CommerceEvent.fromRecord(event); // re-validate: fail closed on malformed input
    const records = this.#uow.records(REPOSITORY_NAMES.events);
    const key = recordKey(event.tenantId, event.eventId);
    const stored = await records.get(key);
    if (stored !== null) {
      throw chainConflict();
    }
    const chain = await this.listForAggregate(
      event.tenantId,
      event.aggregateType,
      event.aggregateId,
    );
    if (event.sequence !== chain.length + 1) {
      throw chainConflict();
    }
    await records.insert(key, toStored(event));
  }

  async findById(tenantId: CommerceEventRecord["tenantId"], eventId: string) {
    const stored = await this.#uow
      .records(REPOSITORY_NAMES.events)
      .get(recordKey(tenantId, eventId));
    return stored === null ? undefined : decodeTenantScoped<CommerceEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: CommerceEventRecord["tenantId"],
    aggregateType: CommerceEventRecord["aggregateType"],
    aggregateId: string,
  ) {
    const out: CommerceEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<CommerceEventRecord>(stored, tenantId);
      if (
        record !== undefined &&
        record.aggregateType === aggregateType &&
        record.aggregateId === aggregateId
      ) {
        out.push(record);
      }
    }
    return Object.freeze(out.sort((a, b) => a.sequence - b.sequence));
  }

  async listByTenant(tenantId: CommerceEventRecord["tenantId"]) {
    const out: CommerceEventRecord[] = [];
    for (const stored of await this.#uow.records(REPOSITORY_NAMES.events).list()) {
      const record = decodeTenantScoped<CommerceEventRecord>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  }
}

// ---------------------------------------------------------------------------
// Committed-state readers (the store's `read` views)
// ---------------------------------------------------------------------------

function listTenantScoped<T extends { readonly tenantId: string }>(
  repo: RecordReadRepository,
  tenantId: string,
): Promise<readonly T[]> {
  return (async () => {
    const out: T[] = [];
    for (const stored of await repo.list()) {
      const record = decodeTenantScoped<T>(stored, tenantId);
      if (record !== undefined) out.push(record);
    }
    return Object.freeze(out);
  })();
}

class CommittedProductReader implements ProductReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: ProductRecord["tenantId"], productId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, productId));
    return stored === null ? undefined : decodeTenantScoped<ProductRecord>(stored, tenantId);
  }

  listByTenant(tenantId: ProductRecord["tenantId"]) {
    return listTenantScoped<ProductRecord>(this.#repo, tenantId);
  }
}

class CommittedVariantReader implements ProductVariantReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: ProductVariantRecord["tenantId"], variantId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, variantId));
    return stored === null ? undefined : decodeTenantScoped<ProductVariantRecord>(stored, tenantId);
  }

  async listByProduct(tenantId: ProductVariantRecord["tenantId"], productId: string) {
    const all = await listTenantScoped<ProductVariantRecord>(this.#repo, tenantId);
    return Object.freeze(all.filter((variant) => variant.productId === productId));
  }

  listByTenant(tenantId: ProductVariantRecord["tenantId"]) {
    return listTenantScoped<ProductVariantRecord>(this.#repo, tenantId);
  }
}

class CommittedOrderReader implements OrderReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: OrderRecord["tenantId"], orderId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, orderId));
    return stored === null ? undefined : decodeTenantScoped<OrderRecord>(stored, tenantId);
  }

  listByTenant(tenantId: OrderRecord["tenantId"]) {
    return listTenantScoped<OrderRecord>(this.#repo, tenantId);
  }
}

class CommittedOrderLineReader implements OrderLineReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: OrderLineRecord["tenantId"], lineId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, lineId));
    return stored === null ? undefined : decodeTenantScoped<OrderLineRecord>(stored, tenantId);
  }

  async listForOrder(tenantId: OrderLineRecord["tenantId"], orderId: string) {
    const all = await listTenantScoped<OrderLineRecord>(this.#repo, tenantId);
    return Object.freeze(
      all.filter((line) => line.orderId === orderId).sort((a, b) => (a.lineId < b.lineId ? -1 : 1)),
    );
  }
}

class CommittedSubscriptionReader implements SubscriptionReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: SubscriptionRecord["tenantId"], subscriptionId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, subscriptionId));
    return stored === null ? undefined : decodeTenantScoped<SubscriptionRecord>(stored, tenantId);
  }

  async listByOwner(tenantId: SubscriptionRecord["tenantId"], ownerUserId: string) {
    const all = await listTenantScoped<SubscriptionRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter((subscription) => subscription.ownerUserId === ownerUserId)
        .sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : 1)),
    );
  }

  listByTenant(tenantId: SubscriptionRecord["tenantId"]) {
    return listTenantScoped<SubscriptionRecord>(this.#repo, tenantId);
  }
}

class CommittedEventReader implements CommerceEventReader {
  readonly #repo: RecordReadRepository;

  constructor(repo: RecordReadRepository) {
    this.#repo = repo;
  }

  async findById(tenantId: CommerceEventRecord["tenantId"], eventId: string) {
    const stored = await this.#repo.get(recordKey(tenantId, eventId));
    return stored === null ? undefined : decodeTenantScoped<CommerceEventRecord>(stored, tenantId);
  }

  async listForAggregate(
    tenantId: CommerceEventRecord["tenantId"],
    aggregateType: CommerceEventRecord["aggregateType"],
    aggregateId: string,
  ) {
    const all = await listTenantScoped<CommerceEventRecord>(this.#repo, tenantId);
    return Object.freeze(
      all
        .filter(
          (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
        )
        .sort((a, b) => a.sequence - b.sequence),
    );
  }

  listByTenant(tenantId: CommerceEventRecord["tenantId"]) {
    return listTenantScoped<CommerceEventRecord>(this.#repo, tenantId);
  }
}

// ---------------------------------------------------------------------------
// The session and the store
// ---------------------------------------------------------------------------

class InMemoryCommerceSession implements CommerceSession {
  readonly products: ProductRepository;
  readonly variants: ProductVariantRepository;
  readonly orders: OrderRepository;
  readonly orderLines: OrderLineRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly events: CommerceEventRepository;
  readonly #uow: UnitOfWork;

  constructor(uow: UnitOfWork) {
    this.#uow = uow;
    this.products = new ProductSessionView(uow);
    this.variants = new ProductVariantSessionView(uow);
    this.orders = new OrderSessionView(uow);
    this.orderLines = new OrderLineSessionView(uow);
    this.subscriptions = new SubscriptionSessionView(uow);
    this.events = new CommerceEventSessionView(uow);
  }

  async commit(): Promise<void> {
    await this.#uow.commit();
  }

  async rollback(): Promise<void> {
    await this.#uow.rollback();
  }
}

/**
 * The in-memory commerce store: sessions over persistence units of work,
 * committed-state readers over the persistence reader. Deterministic (no
 * ambient clock; record lists ordered by record key).
 */
export function createInMemoryCommerceStore(): CommerceStore {
  const persistence: InMemoryPersistence = createInMemoryPersistence();

  const read: CommerceReadViews = {
    products: new CommittedProductReader(persistence.records(REPOSITORY_NAMES.products)),
    variants: new CommittedVariantReader(persistence.records(REPOSITORY_NAMES.variants)),
    orders: new CommittedOrderReader(persistence.records(REPOSITORY_NAMES.orders)),
    orderLines: new CommittedOrderLineReader(persistence.records(REPOSITORY_NAMES.orderLines)),
    subscriptions: new CommittedSubscriptionReader(
      persistence.records(REPOSITORY_NAMES.subscriptions),
    ),
    events: new CommittedEventReader(persistence.records(REPOSITORY_NAMES.events)),
  };

  return {
    async begin(): Promise<CommerceSession> {
      const uow = await persistence.begin();
      return new InMemoryCommerceSession(uow);
    },
    read,
  };
}
