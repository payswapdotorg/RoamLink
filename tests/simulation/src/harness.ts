/**
 * The deterministic end-to-end simulation harness (RL-071).
 *
 * Composes the REAL public packages exactly like production composition
 * would - no ADCOS internals, only the §10 fake (the public-client test
 * double), the persistence primitives, the reconciliation boundary (the §8
 * composition point), the durable webhook inbox, the projection read
 * surface, the commerce domain and the commerce-to-connectivity reference
 * model:
 *
 *   FakeAdcos (§10: duplicates/reorder/drop/delay/faults)
 *     -> signed deliveries -> AdcosWebhookInboxService (admission)
 *     -> BoundaryWebhookProjector -> projection engine (writes, boundary-only)
 *     -> AdcosReconciliationEngine (sweep + drain + canonical repair)
 *     -> projection reader -> DeliveryEvidenceSource (composition binding)
 *     -> ConnectivityReferenceService (the honest read model)
 *
 * EVERYTHING is driven by the deterministic testkit clock/id generators -
 * no sleeps, no network, no ambient time or randomness.
 */
import type { CommandEnvelope } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore, type ProjectionReader } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import {
  CatalogService,
  OrderService,
  PaymentService,
  createInMemoryCommerceStore,
  InMemoryCommerceIdempotencyLedger,
  type CommerceStore,
} from "@roamlink/domain-commerce";
import {
  ConnectivityReferenceService,
  commerceReadViewsAsSubjectReader,
  createInMemoryConnectivityReferenceStore,
  type ConnectivityReferenceStore,
  type DeliveryEvidenceObservation,
  type DeliveryEvidenceSource,
} from "@roamlink/commerce-connectivity";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
  type Clock,
} from "@roamlink/testkit";
import type { UtcInstant } from "@roamlink/contracts";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import type { FakeAdcosDelivery } from "../../../packages/integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
export const T0 = "2026-01-15T08:30:00.000Z";
export const USER_TENANT = "usr:00000000-0000-4000-8000-000000000002" as never;
export const OWNER_USER = "00000000-0000-4000-8000-000000000002";

export interface SimulationOptions {
  readonly startAt?: string;
  /** FakeAdcos seed-probe resources for the compatibility gate. */
  readonly seedProbe?: boolean;
  /** A fixed compatibility gate status injected into the reconciler. */
  readonly compatibility?: { status(): "unknown" | "compatible" | "incompatible" };
}

export interface Simulation {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicUuidGenerator;
  readonly fake: FakeAdcos;
  readonly store: InMemoryProjectionStore;
  readonly boundary: ReturnType<typeof createAdcosReconciliationBoundary>;
  readonly commerce: {
    readonly store: CommerceStore;
    readonly catalog: CatalogService;
    readonly orders: OrderService;
    readonly payments: PaymentService;
  };
  readonly references: ConnectivityReferenceService;
  readonly referenceStore: ConnectivityReferenceStore;
  readonly evidenceSource: RecordingEvidenceSource;
  /** Admits every delivery the fake currently shows, in order. */
  admitAll: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<readonly string[]>;
  /** Admits + projects every current delivery (the async §6 step). */
  admitAndProject: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<void>;
  /** A fresh §5 command envelope from the deterministic generator. */
  envelope: (overrides?: { readonly key?: string; readonly orderVersion?: number }) => CommandEnvelope;
}

/**
 * The composition-layer binding: the boundary's exposed projection reader
 * (get/list/count only, spec §8) adapted to the reference model's read-only
 * evidence port. Records every read for simulation assertions.
 */
export class RecordingEvidenceSource implements DeliveryEvidenceSource {
  readonly #reader: ProjectionReader;
  readonly #clock: Clock;
  readonly reads: { readonly type: string; readonly id: string; readonly at: UtcInstant }[] = [];

  constructor(reader: ProjectionReader, clock: Clock) {
    this.#reader = reader;
    this.#clock = clock;
  }

  async get(
    canonicalResourceType: string,
    canonicalResourceId: string,
  ): Promise<DeliveryEvidenceObservation | null> {
    this.reads.push({
      type: canonicalResourceType,
      id: canonicalResourceId,
      at: this.#clock.now(),
    });
    const record = await this.#reader.get(canonicalResourceType as never, canonicalResourceId);
    if (record === null) return null;
    return {
      source_authority: record.source_authority,
      canonical_resource_type: record.canonical_resource_type,
      canonical_resource_id: record.canonical_resource_id,
      source_version: record.source_version,
      event_id: record.event_id,
      payload_digest: record.payload_digest,
      observed_at: record.observed_at,
      received_at: record.received_at,
      fresh_until: record.fresh_until,
      freshness_state: record.freshness_state,
      evidence_class: record.evidence_class,
      payload: record.payload,
    };
  }
}

/** Builds the full deterministic simulation world. */
export function makeSimulation(options: SimulationOptions = {}): Simulation {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const ids = new DeterministicUuidGenerator(1);
  const fake = new FakeAdcos({ seedProbe: options.seedProbe ?? false, now: () => clock.now() });
  const persistence = createInMemoryPersistence();
  const store = new InMemoryProjectionStore();
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const boundary = createAdcosReconciliationBoundary({
    client: fake,
    projectionStore: store,
    persistence,
    persistenceReader: persistence,
    verifier,
    clock,
    platformTenantId: PLATFORM_TENANT,
    jobIdGenerator: new DeterministicUuidGenerator(1),
    ...(options.compatibility !== undefined ? { compatibility: options.compatibility } : {}),
  });

  // Commerce world (same ledger discipline; deterministic ids).
  const commerceStore = createInMemoryCommerceStore();
  const ledger = new InMemoryCommerceIdempotencyLedger();
  const commerceDeps = {
    store: commerceStore,
    policy: { authorize: async () => undefined },
    ledger,
    now: () => clock.now(),
    generateId: () => ids.next(),
  };
  const commerce = {
    store: commerceStore,
    catalog: new CatalogService(commerceDeps),
    orders: new OrderService(commerceDeps),
    payments: new PaymentService(commerceDeps),
  };

  // Commerce-to-connectivity reference model over the boundary's reader.
  const referenceStore = createInMemoryConnectivityReferenceStore();
  const evidenceSource = new RecordingEvidenceSource(boundary.projections, clock);
  const references = new ConnectivityReferenceService({
    store: referenceStore,
    policy: { authorize: async () => undefined },
    ledger,
    subjects: commerceReadViewsAsSubjectReader(commerceStore.read),
    evidenceSource,
    now: () => clock.now(),
    generateId: () => ids.next(),
  });

  const toSpec = (delivery: FakeAdcosDelivery) => ({
    eventId: delivery.event.event_id,
    eventType: delivery.event.event_type,
    resourceId: delivery.event.resource_id,
    resourceKind: delivery.event.resource_kind,
    resourceVersion: delivery.event.resource_version,
    occurredAt: delivery.event.occurred_at,
    correlationId: delivery.event.correlation_id,
    environment: "sandbox" as const,
  });

  const admitAll = async (deliveries?: readonly FakeAdcosDelivery[]): Promise<readonly string[]> => {
    const list = deliveries ?? fake.deliveries();
    const outcomes: string[] = [];
    for (const delivery of list) {
      const signed = fakeWebhookDelivery({
        spec: toSpec(delivery),
        deliveryId: delivery.deliveryId,
        sequence: delivery.sequence,
        receivedAt: clock.now(),
      });
      const admission = await boundary.inbox.admitDelivery({
        headers: signed.headers,
        payload: signed.payload,
        receivedAt: clock.now(),
      });
      outcomes.push(admission.outcome);
    }
    return outcomes;
  };

  const admitAndProject = async (deliveries?: readonly FakeAdcosDelivery[]): Promise<void> => {
    await admitAll(deliveries);
    await boundary.inbox.processPending();
  };

  const envelope = (overrides?: { readonly key?: string; readonly orderVersion?: number }) =>
    fixtureCommandEnvelope({
      actorId: "actor-sim",
      tenantId: USER_TENANT,
      idempotencyKey: overrides?.key ?? `idem-${ids.next()}`,
      createdAt: clock.now(),
      ...(overrides?.orderVersion !== undefined ? { orderVersion: overrides.orderVersion } : {}),
    });

  return {
    clock,
    ids,
    fake,
    store,
    boundary,
    commerce,
    references,
    referenceStore,
    evidenceSource,
    admitAll,
    admitAndProject,
    envelope,
  };
}

// ---------------------------------------------------------------------------
// Shared commerce seeding (deterministic)
// ---------------------------------------------------------------------------

export const PRODUCT_ID = "00000000-0000-4000-8000-0000000000a1";
export const VARIANT_ID = "00000000-0000-4000-8000-0000000000a2";
export const ORDER_ID = "00000000-0000-4000-8000-0000000000a3";
export const PAYMENT_ID = "00000000-0000-4000-8000-0000000000a4";
export const REFERENCE_ID = "00000000-0000-4000-8000-0000000000a5";

/** Seeds + places one order (1 x 999 USD) in the simulation's commerce world. */
export async function seedPlacedOrder(simulation: Simulation): Promise<void> {
  await simulation.commerce.catalog.createProduct(simulation.envelope(), {
    productId: PRODUCT_ID,
    name: "Traveler Pass",
  });
  await simulation.commerce.catalog.activateProduct(simulation.envelope(), {
    productId: PRODUCT_ID,
    expectedRevision: 1,
  });
  await simulation.commerce.catalog.createVariant(simulation.envelope(), {
    variantId: VARIANT_ID,
    productId: PRODUCT_ID,
    name: "7-Day",
    sku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    price: { amountMinorUnits: 999, currency: "USD" },
  });
  await simulation.commerce.orders.createOrder(simulation.envelope({ orderVersion: 1 }), {
    orderId: ORDER_ID,
    ownerUserId: OWNER_USER,
  });
  await simulation.commerce.orders.addOrderLine(simulation.envelope({ orderVersion: 1 }), {
    orderId: ORDER_ID,
    lineId: simulation.ids.next(),
    variantId: VARIANT_ID,
    quantity: 1,
  });
  await simulation.commerce.orders.placeOrder(simulation.envelope({ orderVersion: 2 }), {
    orderId: ORDER_ID,
  });
}
