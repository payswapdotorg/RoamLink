/**
 * RL-023 tests: the commerce-to-connectivity reference model.
 *
 * Proves:
 *  - the reference aggregate's legal/illegal transitions and the
 *    UNEVIDENCED/EVIDENCED invariants (evidence present iff EVIDENCED);
 *  - RL-LOCK-008 THE core invariant: a PAID + INVOICED + RECONCILED order
 *    with no linked evidence is presented as exactly that - commercial
 *    state + UNEVIDENCED - and nothing in the view can say "delivered";
 *  - freshness transitions presented to the read model (RL-LOCK-010):
 *    FRESH at t0 -> STALE after the guarantee expires -> FRESH again after
 *    a relink with a newer observation; UNKNOWN when the observation lacks
 *    timestamps (absence is presented, never hidden, never guessed);
 *  - evidence enters ONLY through the read-only source port; a missing
 *    projection is a typed NotFound (absence is not evidence);
 *  - relink snapshots are immutable: the event chain keeps every
 *    observation with the previous snapshot's digest (audit);
 *  - state-separation drift guards (fail when someone merges enums):
 *    delivery_evidence_state is a separate vocabulary, disjoint from
 *    order/payment/subscription states, and the linkable canonical
 *    resource vocabulary is pinned to the projection §8 vocabulary;
 *  - envelope-gated idempotency (RL-LOCK-014) and CAS (RL-LOCK-017);
 *  - tenant fail-closed boundaries (RL-LOCK-018).
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  canonicalJsonDigest,
  parseOrderId,
  parseUtcInstant,
} from "@roamlink/contracts";
import {
  CatalogService,
  CUSTOMER_PAYMENT_STATES,
  InMemoryCommerceIdempotencyLedger,
  ORDER_STATUSES,
  OrderService,
  PaymentService,
  SUBSCRIPTION_STATUSES,
  createInMemoryCommerceStore,
  type CommerceReadViews,
} from "@roamlink/domain-commerce";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";

import {
  commerceReadViewsAsSubjectReader,
  createInMemoryConnectivityReferenceStore,
  describeSubjectConnectivity,
  ConnectivityReference,
  ConnectivityReferenceService,
  DELIVERY_EVIDENCE_STATES,
  LINKABLE_CANONICAL_RESOURCE_TYPES,
  parseDeliveryEvidence,
  type DeliveryEvidence,
  type DeliveryEvidenceObservation,
  type DeliveryEvidenceSource,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const OWNER = parseOrderId("00000000-0000-4000-8000-000000000002");
const TENANT = "usr:00000000-0000-4000-8000-000000000002" as never;
const OTHER_TENANT = "usr:00000000-0000-4000-8000-000000000099" as never;

const PRODUCT = new DeterministicUuidGenerator(200).next();
const VARIANT = new DeterministicUuidGenerator(210).next();
const ORDER = parseOrderId(new DeterministicUuidGenerator(220).next());
const PAYMENT = new DeterministicUuidGenerator(300).next();
const INVOICE = new DeterministicUuidGenerator(400).next();
const REFERENCE = new DeterministicUuidGenerator(600).next();

const at = (iso: string) => parseUtcInstant(iso);

// ---------------------------------------------------------------------------
// The deterministic world: commerce store + services, a §8-shaped fake
// evidence source (the composition layer binds the projection reader to
// the port - domain packages never import the projection package),
// reference store + service (with the REAL commerce adapter bound).
// ---------------------------------------------------------------------------

/**
 * A §8-shaped in-memory evidence source standing in for the integration
 * boundary's exposed projection reader (get/list/count only). Observations
 * are stored in the exact snake_case §8 field shape the port consumes.
 */
class FakeEvidenceSource implements DeliveryEvidenceSource {
  readonly #observations = new Map<string, DeliveryEvidenceObservation>();

  set(observation: DeliveryEvidenceObservation): this {
    this.#observations.set(
      `${observation.canonical_resource_type}:${observation.canonical_resource_id}`,
      Object.freeze(structuredClone(observation)),
    );
    return this;
  }

  async get(
    canonicalResourceType: string,
    canonicalResourceId: string,
  ): Promise<DeliveryEvidenceObservation | null> {
    return this.#observations.get(`${canonicalResourceType}:${canonicalResourceId}`) ?? null;
  }
}

function makeWorld(startAt: string = T0) {
  const clock = new DeterministicClock(startAt);
  const ids = new DeterministicUuidGenerator(7_000);
  const commerceStore = createInMemoryCommerceStore();
  const commerceViews: CommerceReadViews = commerceStore.read;
  const ledger = new InMemoryCommerceIdempotencyLedger();
  const referenceStore = createInMemoryConnectivityReferenceStore();
  const evidenceSource = new FakeEvidenceSource();

  const commerceDeps = {
    store: commerceStore,
    policy: { authorize: async () => undefined },
    ledger,
    now: () => clock.now(),
    generateId: () => ids.next(),
  };
  const catalog = new CatalogService(commerceDeps);
  const orders = new OrderService(commerceDeps);
  const payments = new PaymentService(commerceDeps);

  const service = new ConnectivityReferenceService({
    store: referenceStore,
    policy: { authorize: async () => undefined },
    ledger,
    subjects: commerceReadViewsAsSubjectReader(commerceViews),
    evidenceSource,
    now: () => clock.now(),
    generateId: () => ids.next(),
  });

  const envelope = (overrides?: {
    readonly key?: string;
    readonly tenantId?: string;
    readonly orderVersion?: number;
  }) =>
    fixtureCommandEnvelope({
      actorId: "actor-1",
      tenantId: overrides?.tenantId ?? TENANT,
      idempotencyKey: overrides?.key ?? `idem-${ids.next()}`,
      createdAt: clock.now(),
      ...(overrides?.orderVersion !== undefined
        ? { orderVersion: overrides.orderVersion }
        : {}),
    });

  return { clock, ids, commerceStore, evidenceSource, referenceStore, catalog, orders, payments, service, envelope };
}

type World = ReturnType<typeof makeWorld>;

/** Seeds a PLACED order (1 x 999 USD) in the world's commerce store. */
async function seedPlacedOrder(world: World) {
  await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "Traveler" });
  await world.catalog.activateProduct(world.envelope(), { productId: PRODUCT, expectedRevision: 1 });
  await world.catalog.createVariant(world.envelope(), {
    variantId: VARIANT,
    productId: PRODUCT,
    name: "7-Day Pass",
    sku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    price: { amountMinorUnits: 999, currency: "USD" },
  });
  await world.orders.createOrder(world.envelope({ key: "seed-order", orderVersion: 1 }), {
    orderId: ORDER,
    ownerUserId: OWNER,
  });
  await world.orders.addOrderLine(world.envelope({ key: "seed-line", orderVersion: 1 }), {
    orderId: ORDER,
    lineId: new DeterministicUuidGenerator(230).next(),
    variantId: VARIANT,
    quantity: 1,
  });
  await world.orders.placeOrder(world.envelope({ key: "seed-place", orderVersion: 2 }), {
    orderId: ORDER,
  });
}

/**
 * Seeds a §8-shaped observation into the world's fake evidence source
 * (freshUntil default 08:31:00; null timestamps for UNKNOWN).
 */
function applyObservation(
  world: World,
  options?: {
    readonly resourceId?: string;
    readonly observedAt?: string | null;
    readonly receivedAt?: string | null;
    readonly freshUntil?: string | null;
    readonly freshnessState?: "FRESH" | "STALE" | "UNKNOWN";
    readonly payload?: Record<string, unknown>;
    readonly evidenceClass?: "AUTHENTICATED" | "OBSERVED" | "REPORTED" | "DERIVED" | "INFERRED" | "STALE" | "UNKNOWN";
    readonly sourceVersion?: number;
  },
) {
  const resourceId = options?.resourceId ?? "contract-77";
  const payload = options?.payload ?? { status: "active", region: "eu-west" };
  const observation = {
    source_authority: "adcos",
    canonical_resource_type: "connectivity_contract",
    canonical_resource_id: resourceId,
    source_version: options?.sourceVersion ?? 3,
    event_id: `evt-${resourceId}`,
    payload_digest: canonicalJsonDigest(payload),
    observed_at: options?.observedAt === undefined ? T0 : options.observedAt,
    received_at: options?.receivedAt === undefined ? T0 : options.receivedAt,
    fresh_until: options?.freshUntil === undefined ? "2026-01-15T08:31:00.000Z" : options.freshUntil,
    freshness_state: options?.freshnessState ?? "FRESH",
    evidence_class: options?.evidenceClass ?? "AUTHENTICATED",
    payload,
  } as DeliveryEvidenceObservation;
  world.evidenceSource.set(observation);
  return observation;
}

async function seededReference(world: World) {
  await seedPlacedOrder(world);
  await world.service.createReference(world.envelope(), {
    referenceId: REFERENCE,
    subjectType: "order",
    subjectId: ORDER,
  });
}

// ---------------------------------------------------------------------------
// Aggregate + evidence validation
// ---------------------------------------------------------------------------

describe("ConnectivityReference aggregate", () => {
  const base = {
    tenantId: TENANT,
    subjectType: "order" as const,
    subjectId: ORDER,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  const evidence: DeliveryEvidence = parseDeliveryEvidence({
    evidenceClass: "AUTHENTICATED",
    observedAt: T0,
    receivedAt: T0,
    freshUntil: "2026-01-15T08:31:00.000Z",
    freshnessState: "FRESH",
    canonicalResourceType: "connectivity_contract",
    canonicalResourceId: "contract-77",
    sourceVersion: 3,
    eventId: "evt-contract-77",
    payloadDigest: canonicalJsonDigest({ status: "active" }),
    payload: { status: "active" },
  });

  it("creates UNEVIDENCED and proves the legal transitions", () => {
    const reference = new ConnectivityReference({
      ...base,
      referenceId: REFERENCE,
      status: "active",
      deliveryEvidenceState: "UNEVIDENCED",
    });
    expect(reference.deliveryEvidenceState).toBe("UNEVIDENCED");
    const evidenced = reference.link(evidence, at("2026-02-01T00:00:00.000Z"));
    expect(evidenced.deliveryEvidenceState).toBe("EVIDENCED");
    expect(evidenced.revision).toBe(2);
    // relink replaces the snapshot (stays EVIDENCED, revision bumps again)
    const relinked = evidenced.link(evidence, at("2026-02-02T00:00:00.000Z"));
    expect(relinked.deliveryEvidenceState).toBe("EVIDENCED");
    expect(relinked.revision).toBe(3);
    const retired = relinked.retire(at("2026-02-03T00:00:00.000Z"));
    expect(retired.status).toBe("retired");
  });

  it("proves every illegal transition and the evidence invariants", () => {
    // EVIDENCED without evidence is a structural lie - rejected
    expect(
      () =>
        new ConnectivityReference({
          ...base,
          referenceId: REFERENCE,
          status: "active",
          deliveryEvidenceState: "EVIDENCED",
        }),
    ).toThrow(ValidationError);
    // UNEVIDENCED with evidence is equally rejected
    expect(
      () =>
        new ConnectivityReference({
          ...base,
          referenceId: REFERENCE,
          status: "active",
          deliveryEvidenceState: "UNEVIDENCED",
          evidence,
        }),
    ).toThrow(ValidationError);
    // retired is terminal
    const retired = new ConnectivityReference({
      ...base,
      referenceId: REFERENCE,
      status: "retired",
      deliveryEvidenceState: "UNEVIDENCED",
      updatedAt: T0,
    });
    expect(() => retired.retire(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => retired.link(evidence, at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    // foreign states are rejected on the evidence vocabulary
    expect(
      () =>
        new ConnectivityReference({
          ...base,
          referenceId: REFERENCE,
          status: "active",
          deliveryEvidenceState: "placed", // order_state token - foreign
        }),
    ).toThrow(ValidationError);
    expect(
      () =>
        new ConnectivityReference({
          ...base,
          referenceId: REFERENCE,
          status: "active",
          deliveryEvidenceState: "succeeded", // payment state token - foreign
        }),
    ).toThrow(ValidationError);
  });

  it("parses delivery evidence with a closed vocabulary and rejects drift", () => {
    expect(() =>
      parseDeliveryEvidence({
        evidenceClass: "AUTHENTICATED",
        observedAt: T0,
        receivedAt: T0,
        freshUntil: "2026-01-15T08:31:00.000Z",
        freshnessState: "FRESH",
        canonicalResourceType: "network_path", // NOT a linkable §8 resource
        canonicalResourceId: "path-1",
        sourceVersion: 1,
        eventId: null,
        payloadDigest: canonicalJsonDigest({}),
        payload: {},
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseDeliveryEvidence({
        evidenceClass: "MAYBE", // not in the frozen vocabulary
        observedAt: null,
        receivedAt: null,
        freshUntil: null,
        freshnessState: "UNKNOWN",
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: "contract-77",
        sourceVersion: null,
        eventId: null,
        payloadDigest: canonicalJsonDigest({}),
        payload: {},
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Service: create / link / retire
// ---------------------------------------------------------------------------

describe("ConnectivityReferenceService.createReference", () => {
  it("creates an active UNEVIDENCED reference for an existing in-tenant subject", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    const result = await world.service.createReference(world.envelope(), {
      referenceId: REFERENCE,
      subjectType: "order",
      subjectId: ORDER,
    });
    expect(result).toMatchObject({
      referenceId: REFERENCE,
      deliveryEvidenceState: "UNEVIDENCED",
      revision: 1,
    });
    const events = await world.referenceStore.read.events.listForAggregate(
      TENANT,
      REFERENCE,
    );
    expect(events.map((event) => event.transition)).toEqual(["connectivity_reference.created"]);
  });

  it("fails closed when the subject does not exist (or exists in another tenant)", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await expect(
      world.service.createReference(world.envelope(), {
        referenceId: REFERENCE,
        subjectType: "order",
        subjectId: "00000000-0000-4000-8000-00000000dead",
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      world.service.createReference(world.envelope({ tenantId: OTHER_TENANT }), {
        referenceId: REFERENCE,
        subjectType: "order",
        subjectId: ORDER, // exists, but only in TENANT
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("allows ONE active reference per subject (typed conflict on a second)", async () => {
    const world = makeWorld();
    await seededReference(world);
    await expect(
      world.service.createReference(world.envelope(), {
        referenceId: new DeterministicUuidGenerator(601).next(),
        subjectType: "order",
        subjectId: ORDER,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("ConnectivityReferenceService.linkDeliveryEvidence", () => {
  it("links a FRESH §8 observation through the read-only source port", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world);
    const linked = await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    expect(linked).toMatchObject({
      deliveryEvidenceState: "EVIDENCED",
      freshnessState: "FRESH",
      revision: 2,
    });
  });

  it("a MISSING projection is a typed NotFound - absence is presented, never guessed", async () => {
    const world = makeWorld();
    await seededReference(world);
    await expect(
      world.service.linkDeliveryEvidence(world.envelope(), {
        referenceId: REFERENCE,
        expectedRevision: 1,
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: "never-projected",
      }),
    ).rejects.toThrow(NotFoundError);
    // the reference remains UNEVIDENCED - no partial state was applied
    const view = await world.service.describeSubject(TENANT, "order", ORDER);
    expect(view.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(view.evidence).toBeNull();
  });

  it("relinks capture a NEW immutable snapshot and keep the previous digest on the chain", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world, { payload: { status: "active" } });
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    // a newer observation arrives
    applyObservation(world, {
      payload: { status: "active", region: "eu-west-2" },
      sourceVersion: 4,
    });
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 2,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const events = await world.referenceStore.read.events.listForAggregate(
      TENANT,
      REFERENCE,
    );
    expect(events.map((event) => event.transition)).toEqual([
      "connectivity_reference.created",
      "connectivity_reference.evidence_linked",
      "connectivity_reference.evidence_linked",
    ]);
    const last = events[2]?.payload as {
      previousEvidence?: { payloadDigest?: string };
    };
    expect(last.previousEvidence?.payloadDigest).toBe(canonicalJsonDigest({ status: "active" }));
  });

  it("enforces CAS and refuses retired references", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world);
    await expect(
      world.service.linkDeliveryEvidence(world.envelope(), {
        referenceId: REFERENCE,
        expectedRevision: 99, // stale
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: "contract-77",
      }),
    ).rejects.toThrow(ConflictError);
    await world.service.retireReference(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
    });
    await expect(
      world.service.linkDeliveryEvidence(world.envelope(), {
        referenceId: REFERENCE,
        expectedRevision: 2,
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: "contract-77",
      }),
    ).rejects.toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Freshness presented to the read model (RL-LOCK-010)
// ---------------------------------------------------------------------------

describe("read-model freshness transitions (FRESH / STALE / UNKNOWN)", () => {
  it("FRESH at first, STALE once the guarantee expires, FRESH again after relink", async () => {
    const world = makeWorld();
    await seededReference(world);
    // fresh_until = 08:31:00; the world clock starts at 08:30:00
    await applyObservation(world);
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });

    const fresh = await world.service.describeSubject(TENANT, "order", ORDER, at(T0));
    expect(fresh.deliveryEvidenceState).toBe("EVIDENCED");
    expect(fresh.evidence?.freshness.freshnessState).toBe("FRESH");

    // one second past the guarantee: STALE, presented - never hidden
    const stale = await world.service.describeSubject(
      TENANT,
      "order",
      ORDER,
      at("2026-01-15T08:31:00.001Z"),
    );
    expect(stale.evidence?.freshness.freshnessState).toBe("STALE");

    // a newer observation with a longer guarantee relinks -> FRESH again
    applyObservation(world, {
      payload: { status: "active", region: "eu-west-2" },
      freshUntil: "2026-01-15T09:00:00.000Z",
      sourceVersion: 4,
    });
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 2,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const renewed = await world.service.describeSubject(
      TENANT,
      "order",
      ORDER,
      at("2026-01-15T08:45:00.000Z"),
    );
    expect(renewed.evidence?.freshness.freshnessState).toBe("FRESH");
    // ... and degrades again after the NEW guarantee expires
    const staleAgain = await world.service.describeSubject(
      TENANT,
      "order",
      ORDER,
      at("2026-01-15T09:00:00.001Z"),
    );
    expect(staleAgain.evidence?.freshness.freshnessState).toBe("STALE");
  });

  it("UNKNOWN freshness is presented when the observation lacks timestamps (a valid state)", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world, {
      observedAt: null,
      receivedAt: null,
      freshUntil: null,
      freshnessState: "UNKNOWN",
    });
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const view = await world.service.describeSubject(TENANT, "order", ORDER, at(T0));
    expect(view.deliveryEvidenceState).toBe("EVIDENCED");
    expect(view.evidence?.freshness.freshnessState).toBe("UNKNOWN");
    expect(view.evidence?.freshness.observedAt).toBeNull();
    expect(view.evidence?.freshness.receivedAt).toBeNull();
  });

  it("the pure view exposes commercial state + evidence side by side, never a blend", () => {
    const view = describeSubjectConnectivity(
      { subjectType: "order", subjectId: ORDER, commercialState: "placed" },
      undefined,
      at(T0),
    );
    expect(view).toEqual({
      subjectType: "order",
      subjectId: ORDER,
      commercialState: "placed",
      referenceStatus: "none",
      deliveryEvidenceState: "UNEVIDENCED",
      evidence: null,
      presentedAt: T0,
    });
    // and the view type carries no combined-status field at all
    expect(Object.keys(view).sort()).toEqual(
      [
        "commercialState",
        "deliveryEvidenceState",
        "evidence",
        "presentedAt",
        "referenceStatus",
        "subjectId",
        "subjectType",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// RL-LOCK-008: payment is not delivery (the cross-package core invariant)
// ---------------------------------------------------------------------------

describe("payment is not delivery (RL-LOCK-008, RL-023)", () => {
  it("a paid + invoiced + reconciled order with NO reference is UNEVIDENCED, not delivered", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT,
      orderId: ORDER,
      amount: { amountMinorUnits: 999, currency: "USD" },
    });
    await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT,
      expectedRevision: 1,
      transition: "succeed",
    });
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await world.payments.reconcileInvoice(world.envelope(), {
      invoiceId: INVOICE,
      expectedRevision: 1,
    });

    const view = await world.service.describeSubject(TENANT, "order", ORDER);
    // the honest answer: commercial state says placed; evidence says NONE.
    expect(view.commercialState).toBe("placed");
    expect(view.referenceStatus).toBe("none");
    expect(view.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(view.evidence).toBeNull();
  });

  it("even an EVIDENCED reference never claims the ORDER is delivered: states stay separate", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world);
    await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const view = await world.service.describeSubject(TENANT, "order", ORDER, at(T0));
    expect(view.commercialState).toBe("placed"); // order_state, untouched
    expect(view.deliveryEvidenceState).toBe("EVIDENCED"); // evidence fact
    expect(view.evidence?.freshness.freshnessState).toBe("FRESH"); // quality fact
  });
});

// ---------------------------------------------------------------------------
// State-separation drift guards (tests that FAIL when enums get merged)
// ---------------------------------------------------------------------------

describe("state-separation drift guards", () => {
  it("delivery_evidence_state is its own vocabulary, disjoint from the commerce state families", () => {
    expect(DELIVERY_EVIDENCE_STATES).toEqual(["UNEVIDENCED", "EVIDENCED"]);
    for (const orderState of ORDER_STATUSES) {
      expect(DELIVERY_EVIDENCE_STATES).not.toContain(orderState);
    }
    for (const paymentState of CUSTOMER_PAYMENT_STATES) {
      expect(DELIVERY_EVIDENCE_STATES).not.toContain(paymentState.toUpperCase());
    }
    for (const subscriptionState of SUBSCRIPTION_STATUSES) {
      expect(DELIVERY_EVIDENCE_STATES).not.toContain(subscriptionState.toUpperCase());
    }
    // and no commerce state vocabulary swallowed the evidence tokens
    expect(ORDER_STATUSES).not.toContain("UNEVIDENCED");
    expect(ORDER_STATUSES).not.toContain("EVIDENCED");
    expect(CUSTOMER_PAYMENT_STATES).not.toContain("UNEVIDENCED");
    expect(SUBSCRIPTION_STATUSES).not.toContain("EVIDENCED");
  });

  it("the linkable canonical-resource vocabulary is pinned to the §8 canonical resource types (the projection vocabulary - pinned textually here; the architecture suite cross-checks the real projection source)", () => {
    expect([...LINKABLE_CANONICAL_RESOURCE_TYPES].sort()).toEqual(
      [
        "connectivity_intent",
        "connectivity_contract",
        "connectivity_lease",
        "contract_usage",
        "contract_assurance",
        "webhook_endpoint",
      ].sort(),
    );
  });

  it("payment state can never be written into a reference record (fail-closed parse)", () => {
    expect(
      () =>
        new ConnectivityReference({
          referenceId: REFERENCE,
          tenantId: TENANT,
          subjectType: "order",
          subjectId: ORDER,
          status: "active",
          deliveryEvidenceState: "UNEVIDENCED",
          paymentState: "succeeded", // a merged-enum attempt
          createdAt: T0,
          updatedAt: T0,
          revision: 1,
        } as never),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Idempotency + events (RL-LOCK-014 / audit)
// ---------------------------------------------------------------------------

describe("reference command idempotency and events", () => {
  it("duplicate create/link commands replay the recorded outcome with NO second effect", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    const createEnvelope = world.envelope({ key: "create-once" });
    const first = await world.service.createReference(createEnvelope, {
      referenceId: REFERENCE,
      subjectType: "order",
      subjectId: ORDER,
    });
    const replay = await world.service.createReference(createEnvelope, {
      referenceId: REFERENCE,
      subjectType: "order",
      subjectId: ORDER,
    });
    expect(replay).toEqual(first);

    await applyObservation(world);
    const linkEnvelope = world.envelope({ key: "link-once" });
    const linked = await world.service.linkDeliveryEvidence(linkEnvelope, {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const linkedReplay = await world.service.linkDeliveryEvidence(linkEnvelope, {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    expect(linkedReplay).toEqual(linked);

    // exactly one created event + one linked event on the chain
    const events = await world.referenceStore.read.events.listForAggregate(
      TENANT,
      REFERENCE,
    );
    expect(events.map((event) => event.transition)).toEqual([
      "connectivity_reference.created",
      "connectivity_reference.evidence_linked",
    ]);
  });

  it("a DIFFERENT command under a used key is a typed conflict", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    const envelope = world.envelope({ key: "shared-key" });
    await world.service.createReference(envelope, {
      referenceId: REFERENCE,
      subjectType: "order",
      subjectId: ORDER,
    });
    await world.clock.advanceBy(1_000);
    const different = world.envelope({ key: "shared-key" });
    await expect(
      world.service.createReference(different, {
        referenceId: new DeterministicUuidGenerator(601).next(),
        subjectType: "order",
        subjectId: ORDER,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("events carry the full command correlation and stay chain-sequenced", async () => {
    const world = makeWorld();
    await seededReference(world);
    await applyObservation(world);
    const linkEnvelope = world.envelope();
    await world.service.linkDeliveryEvidence(linkEnvelope, {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    const events = await world.referenceStore.read.events.listForAggregate(
      TENANT,
      REFERENCE,
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.commandId).toBe(linkEnvelope.commandId);
    expect(events[1]?.correlationId).toBe(linkEnvelope.correlationId);
    expect(events[1]?.idempotencyKey).toBe(linkEnvelope.idempotencyKey);
    expect(events[1]?.sequence).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The evidence source port discipline
// ---------------------------------------------------------------------------

describe("DeliveryEvidenceSource port discipline", () => {
  it("the service consumes the §8 observation shape through the port; absent resources return null (absence, never a guess)", async () => {
    const world = makeWorld();
    const applied = applyObservation(world);
    expect(applied.payload_digest).toMatch(/^[0-9a-f]{64}$/);

    await seededReference(world);
    const linked = await world.service.linkDeliveryEvidence(world.envelope(), {
      referenceId: REFERENCE,
      expectedRevision: 1,
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-77",
    });
    expect(linked).toMatchObject({ freshnessState: "FRESH", deliveryEvidenceState: "EVIDENCED" });

    // the port's absent-resource contract is null - the service surfaces it
    // as a typed NotFound (proved elsewhere); the fake honours the same
    // contract the integration boundary's exposed reader provides.
    const missing = await world.evidenceSource.get("connectivity_contract", "missing");
    expect(missing).toBeNull();
  });
});
