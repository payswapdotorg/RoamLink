/**
 * Shared deterministic world for the domain-commerce tests.
 */
import {
  UnauthorizedError,
  tenantIdFromUser,
  parseUserId,
  type ActorId,
  type CommandEnvelope,
  type TenantId,
} from "@roamlink/contracts";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";

import {
  CatalogService,
  InMemoryCommerceIdempotencyLedger,
  OrderService,
  SubscriptionService,
  createInMemoryCommerceStore,
  type CommerceAccessPolicy,
  type CommerceAction,
  type CommerceServiceDeps,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";

const OWNER = parseUserId("00000000-0000-4000-8000-000000000002");
const TENANT = tenantIdFromUser(OWNER);
const ACTOR = `usr:${OWNER}` as ActorId;

const OTHER_OWNER = parseUserId("00000000-0000-4000-8000-000000000099");
const OTHER_TENANT = tenantIdFromUser(OTHER_OWNER);

/** Fail-closed stub policy with an explicit deny set. */
class StubPolicy implements CommerceAccessPolicy {
  readonly denied = new Set<string>();
  private readonly defaultAllow: boolean;

  constructor(defaultAllow = true) {
    this.defaultAllow = defaultAllow;
  }

  deny(action: CommerceAction): this {
    this.denied.add(action);
    return this;
  }

  async authorize(
    actorId: ActorId,
    _tenantId: TenantId,
    action: CommerceAction,
  ): Promise<void> {
    if (!this.defaultAllow || this.denied.has(action) || actorId !== ACTOR) {
      throw new UnauthorizedError("commerce policy denied the action", {
        reason: "COMMERCE_POLICY_DENIED",
      });
    }
  }
}

function makeWorld() {
  const clock = new DeterministicClock(T0);
  const ids = new DeterministicUuidGenerator(7_000);
  const policy = new StubPolicy();
  const ledger = new InMemoryCommerceIdempotencyLedger();
  const store = createInMemoryCommerceStore();

  const deps: CommerceServiceDeps = {
    store,
    policy,
    ledger,
    now: () => clock.now(),
    generateId: () => ids.next(),
  };

  const catalog = new CatalogService(deps);
  const orders = new OrderService(deps);
  const subscriptions = new SubscriptionService(deps);

  const envelope = (overrides?: {
    readonly key?: string;
    readonly tenantId?: string;
    readonly orderVersion?: number;
  }): CommandEnvelope =>
    fixtureCommandEnvelope({
      actorId: ACTOR,
      tenantId: overrides?.tenantId ?? TENANT,
      idempotencyKey: overrides?.key ?? `key-${ids.next()}`,
      createdAt: clock.now(),
      ...(overrides?.orderVersion !== undefined
        ? { orderVersion: overrides.orderVersion }
        : {}),
    });

  return {
    clock,
    ids,
    policy,
    ledger,
    store,
    catalog,
    orders,
    subscriptions,
    envelope,
    tenant: TENANT,
    otherTenant: OTHER_TENANT,
  };
}

/** Deterministic entity id at a fixed seed (stable across runs). */
function idAt(seed: number): string {
  return new DeterministicUuidGenerator(seed).next();
}

export { makeWorld, idAt, T0, TENANT, OTHER_TENANT, ACTOR, StubPolicy };
