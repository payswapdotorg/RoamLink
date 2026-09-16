/**
 * Tenant-scoped reference-model ports (RL-023): the store, the access
 * policy and the commercial-subject readers.
 *
 * MULTI-TENANCY BY CONSTRUCTION (RL-LOCK-018): every record carries its
 * Wave-0 TenantId and every read takes the tenant namespace FIRST; a read
 * through the wrong tenant returns undefined - no existence oracle.
 *
 * ALL WRITES are compare-and-swap on the record revision over the Wave-0
 * persistence primitives (RL-003): a session is ONE unit of work, so a
 * reference + its event commit atomically and a lost race is a typed
 * ConflictError - never a silent overwrite (RL-LOCK-014/017).
 *
 * The {@link CommercialSubjectReader} port is the commerce seam: the
 * composition layer binds domain-commerce's committed read views (orders +
 * subscriptions). The reference model verifies SUBJECT EXISTENCE and
 * commercial state through this port; it never writes commerce state and
 * never reads connectivity except through the evidence source.
 */
import type {
  ActorId,
  TenantId,
  UtcInstant,
} from "@roamlink/contracts";
import type { ConnectivityReferenceEventRecord } from "./events.js";
import type { ConnectivityReferenceRecord } from "./reference.js";

// ---------------------------------------------------------------------------
// Access policy (authorization seam)
// ---------------------------------------------------------------------------

/** The closed reference-model action vocabulary. */
export const CONNECTIVITY_REFERENCE_ACTIONS = [
  "connectivity_reference:read",
  "connectivity_reference:write",
] as const;

export type ConnectivityReferenceAction = (typeof CONNECTIVITY_REFERENCE_ACTIONS)[number];

export function isConnectivityReferenceAction(
  value: unknown,
): value is ConnectivityReferenceAction {
  return (
    typeof value === "string" &&
    (CONNECTIVITY_REFERENCE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The reference-model access policy port. `authorize` resolves
 * asynchronously and throws UnauthorizedError on denial (fail closed); the
 * production adapter delegates to @roamlink/auth at the composition layer.
 */
export interface ConnectivityReferenceAccessPolicy {
  authorize(
    actorId: ActorId,
    tenantId: TenantId,
    action: ConnectivityReferenceAction,
    at: UtcInstant,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// The commercial-subject seam (bound to domain-commerce read views)
// ---------------------------------------------------------------------------

/** The minimal commercial facts the reference model needs about a subject. */
export interface CommercialSubjectFacts {
  readonly subjectType: "order" | "subscription";
  readonly subjectId: string;
  /** The subject's own commercial state (order_state / customer_subscription_state). */
  readonly commercialState: string;
}

/**
 * The commercial-subject reader port. Implementations are tenant-scoped
 * and fail closed (undefined when the subject does not exist in the
 * tenant). domain-commerce's `CommerceReadViews.orders` /
 * `.subscriptions` bind here at the composition layer - via structural
 * compatibility, so this package owns no commerce types.
 */
export interface CommercialSubjectReader {
  findOrder(tenantId: TenantId, orderId: string): Promise<CommercialSubjectFacts | undefined>;
  findSubscription(
    tenantId: TenantId,
    subscriptionId: string,
  ): Promise<CommercialSubjectFacts | undefined>;
}

// ---------------------------------------------------------------------------
// Reader + repository interfaces
// ---------------------------------------------------------------------------

/** Tenant-scoped reference reads. */
export interface ConnectivityReferenceReader {
  findById(
    tenantId: TenantId,
    referenceId: string,
  ): Promise<ConnectivityReferenceRecord | undefined>;
  findBySubject(
    tenantId: TenantId,
    subjectType: "order" | "subscription",
    subjectId: string,
  ): Promise<ConnectivityReferenceRecord | undefined>;
  listByTenant(tenantId: TenantId): Promise<readonly ConnectivityReferenceRecord[]>;
}

/**
 * Tenant-scoped reference repository. `save` is compare-and-swap on the
 * record revision (insert at 1; a stale predecessor is a typed
 * ConflictError).
 */
export interface ConnectivityReferenceRepository extends ConnectivityReferenceReader {
  save(record: ConnectivityReferenceRecord): Promise<void>;
}

/**
 * Tenant-scoped reference-event repository. APPEND-ONLY + CHAINED per
 * aggregate (sequence must be exactly latest + 1); no mutation API exists.
 */
export interface ConnectivityReferenceEventRepository {
  findById(
    tenantId: TenantId,
    eventId: string,
  ): Promise<ConnectivityReferenceEventRecord | undefined>;
  listForAggregate(
    tenantId: TenantId,
    aggregateId: string,
  ): Promise<readonly ConnectivityReferenceEventRecord[]>;
  listByTenant(tenantId: TenantId): Promise<readonly ConnectivityReferenceEventRecord[]>;
  append(event: ConnectivityReferenceEventRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One atomic reference-model unit of work. */
export interface ConnectivityReferenceSession {
  readonly references: ConnectivityReferenceRepository;
  readonly events: ConnectivityReferenceEventRepository;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Committed-state reads only. */
export interface ConnectivityReferenceReadViews {
  readonly references: ConnectivityReferenceReader;
  readonly events: ConnectivityReferenceEventRepository;
}

/** The reference-model store port. */
export interface ConnectivityReferenceStore {
  begin(): Promise<ConnectivityReferenceSession>;
  readonly read: ConnectivityReferenceReadViews;
}
