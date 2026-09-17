/**
 * RL-072 dogfood scenario 1: NEW CUSTOMER ONBOARDING -> FIRST USABLE
 * CONNECTIVITY.
 *
 * One customer, one correlation-ID family, the REAL packages composed end
 * to end (the §10 ADCOS fake is the only external stand-in):
 *
 *   tenant + customer (RL-004)
 *     -> device + evidence-tagged snapshots (RL-010)
 *     -> product catalog -> order + payment (RL-020/021/022)
 *     -> ExperienceIntent authoring (RL-011)
 *     -> compilation to the ADCOS ConnectivityIntent command (RL-012)
 *     -> offer selection -> contract activation -> reservation (RL-031/032)
 *     -> connectivity state flows back via signed webhooks (RL-033)
 *     -> projections (RL-034)
 *     -> commerce-to-connectivity evidence (RL-023) + decision read model (RL-013)
 *     -> notification delivered from a durable RoamLink transition (RL-014).
 *
 * Assertions are ARCHITECTURAL (authority, evidence, freshness, idempotency,
 * no fabricated truth) - never on package internals:
 *   - ADCOS is the only connectivity authority: every connectivity fact the
 *     customer reads is a projection carrying source_authority=adcos,
 *     AUTHENTICATED evidence, canonical refs and a payload digest
 *     (RL-LOCK-001/009/010);
 *   - payment is not delivery: a SUCCEEDED payment plus an UNEVIDENCED
 *     reference is the honest state until ADCOS truth arrives (RL-LOCK-008);
 *   - absence is presented, never guessed: linking evidence before any
 *   - projection exists is a typed NotFound, never a fabricated delivery
 *     (RL-LOCK-010);
 *   - retries never duplicate: replayed §5 envelopes and replayed ADCOS
 *     commands replay the original outcome (RL-LOCK-014).
 */
import { describe, expect, it } from "vitest";
import { parseAdcosSignatureRef } from "@roamlink/adcos";
import { NotFoundError, parseExperienceDecisionId } from "@roamlink/contracts";
import {
  TIME_TO_USABLE_CONNECTIVITY_MS_METRIC,
  INTENT_SATISFACTION_RATE_METRIC,
  CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC,
  evaluateProductSlo,
  logSloEvaluation,
  makeCorrelationContext,
} from "@roamlink/observability";
import { buildExperienceDecision, intentSatisfactionOf } from "@roamlink/domain-experience";
import { computeRefundableAmount } from "@roamlink/domain-commerce";
import type { IntentCommandInput } from "@roamlink/integration";
import { compileExperienceIntent } from "@roamlink/intent-compiler";

import {
  instantPlusMs,
  journeyIntentPayload,
  makeDogfoodWorld,
  msBetween,
  must,
  registerCustomer,
  enrollJourneyDevice,
  STEP_MS,
  type DogfoodWorld,
  type JourneyCustomer,
} from "../src/world.js";

const PRODUCT_ID = "00000000-0000-4000-8000-0000000000a1";
const VARIANT_ID = "00000000-0000-4000-8000-0000000000a2";
const ORDER_ID = "00000000-0000-4000-8000-0000000000a3";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000a4";
const INTENT_ID = "00000000-0000-4000-8000-0000000000a5";
const REFERENCE_ID = "00000000-0000-4000-8000-0000000000a6";
const NOTIFICATION_ID = "00000000-0000-4000-8000-0000000000a7";

/** Seeds the catalog leg: one active 14-day traveler pass (24.99 USD). */
async function seedCatalog(world: DogfoodWorld, customer: JourneyCustomer) {
  const env = () => world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId });
  await world.commerce.catalog.createProduct(env(), {
    productId: PRODUCT_ID,
    name: "Traveler Pass",
    description: "Connectivity experience pass for international travel",
  });
  await world.commerce.catalog.activateProduct(env(), {
    productId: PRODUCT_ID,
    expectedRevision: 1,
  });
  await world.commerce.catalog.createVariant(env(), {
    variantId: VARIANT_ID,
    productId: PRODUCT_ID,
    name: "Ghana 14-Day",
    sku: "pass-ghana-14d",
    billingModel: "one_time",
    termDays: 14,
    price: { amountMinorUnits: 2499, currency: "USD" },
  });
}

/** Places the paid order: order placed, payment recorded + succeeded. */
async function placePaidOrder(world: DogfoodWorld, customer: JourneyCustomer) {
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  await world.commerce.orders.createOrder(
    world.envelope({ ...actor, orderVersion: 1 }),
    { orderId: ORDER_ID, ownerUserId: customer.userId },
  );
  await world.commerce.orders.addOrderLine(
    world.envelope({ ...actor, orderVersion: 1 }),
    { orderId: ORDER_ID, lineId: world.ids.next(), variantId: VARIANT_ID, quantity: 1 },
  );
  await world.commerce.orders.placeOrder(world.envelope({ ...actor, orderVersion: 2 }), {
    orderId: ORDER_ID,
  });
  await world.commerce.payments.recordPayment(
    world.envelope(actor),
    { paymentId: PAYMENT_ID, orderId: ORDER_ID, amount: { amountMinorUnits: 2499, currency: "USD" } },
  );
  await world.commerce.payments.transitionPayment(world.envelope(actor), {
    paymentId: PAYMENT_ID,
    expectedRevision: 1,
    transition: "succeed",
  });
}

describe("RL-072 scenario 1: new customer onboarding -> first usable connectivity", () => {
  it("walks the full lifecycle with authority, evidence, freshness and no fabricated truth", async () => {
    const world = makeDogfoodWorld("onboarding");

    // --- 1. tenant + customer (RL-004) --------------------------------------
    const customer = await registerCustomer(world, 0x11);
    const user = await world.auth.users.findById(customer.tenantId, customer.userId);
    expect(user?.status).toBe("active");
    // The user record carries no credential material (identity authority only).
    expect(Object.keys(user ?? {}).some((key) => /password|secret|hash/i.test(key))).toBe(false);

    // --- 2. device + evidence-tagged snapshots (RL-010) ---------------------
    const deviceId = await enrollJourneyDevice(world, customer, 0x11);
    const capabilities = await world.experience.registry.latestCapabilitySnapshot(
      customer.tenantId,
      deviceId,
    );
    expect(capabilities?.capabilities["wifi_observation"]).toMatchObject({
      status: "available",
      evidenceClass: "OBSERVED",
    });

    // --- 3. product catalog (RL-020) ----------------------------------------
    await seedCatalog(world, customer);
  
    // --- 4. order + payment (RL-021/022) ------------------------------------
    await placePaidOrder(world, customer);
    // §11 "time to usable connectivity" start marker: the paid order is the
    // journey's commitment instant (measured below when first usable
    // connectivity lands).
    const paidAt = world.clock.now();
    // Three deterministic hops between the paid order and the evidence link:
    // the journey's activation legs (submission, offer selection,
    // activation, reservation, webhook projection) consume real clock time.
    world.clock.advanceBy(3 * STEP_MS);
    const placedOrder = await world.commerce.store.read.orders.findById(
      customer.tenantId,
      ORDER_ID as never,
    );
    expect(placedOrder?.status).toBe("placed");
    expect(placedOrder?.totalAmount).toEqual({ amountMinorUnits: 2499, currency: "USD" });
    const payment = await world.commerce.store.read.payments.findById(
      customer.tenantId,
      PAYMENT_ID as never,
    );
    expect(payment?.status).toBe("succeeded");

    // NO FABRICATED TRUTH (RL-LOCK-008): payment succeeded, but delivery is
    // UNEVIDENCED until ADCOS truth arrives. The reference model presents
    // exactly that state - payment is not delivery.
    const reference = await world.references.createReference(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
      { referenceId: REFERENCE_ID, subjectType: "order", subjectId: ORDER_ID },
    );
    expect(reference.deliveryEvidenceState).toBe("UNEVIDENCED");
    const unevidenced = await world.references.describeSubject(
      customer.tenantId,
      "order",
      ORDER_ID as never,
    );
    expect(unevidenced.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(unevidenced.commercialState).toBe("placed");

    // Absence is presented, never guessed (RL-LOCK-010): linking evidence
    // before ANY projection exists is a typed NotFound - not a fake delivery.
    await expect(
      world.references.linkDeliveryEvidence(
        world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
        {
          referenceId: REFERENCE_ID,
          expectedRevision: reference.revision,
          canonicalResourceType: "connectivity_contract",
          canonicalResourceId: "contract-that-does-not-exist",
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // --- 5. ExperienceIntent authoring (RL-011) ------------------------------
    await world.experience.intents.createIntent(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
      {
        intentId: INTENT_ID,
        ownerUserId: customer.userId,
        deviceId,
        payload: journeyIntentPayload(),
        rationale: "Travel to Ghana for two weeks; keep work traffic reliable",
      },
    );
    await world.experience.intents.transitionIntent(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId, intentVersion: 1 }),
      { intentId: INTENT_ID, transition: "activate" },
    );

    // --- 6. compilation to the ADCOS ConnectivityIntent command (RL-012) ----
    const intentRecord = await world.experience.intents.getIntent(customer.tenantId, INTENT_ID);
    expect(intentRecord.status).toBe("active");
    const versions = await world.experience.intents.listVersions(customer.tenantId, INTENT_ID);
    const currentVersion = must(
      versions.find((version) => version.intentVersionId === intentRecord.currentVersionId),
      "current intent version",
    );
    expect(currentVersion?.versionNumber).toBe(1);
    const compiled = compileExperienceIntent(intentRecord.toRecord(), currentVersion, {
      at: world.clock.now(),
      commandId: world.ids.next(),
      actorId: customer.actorId,
    });
    // Traceability: the command carries the source intent identity (§4).
    expect(compiled.payload.sourceIntentId).toBe(INTENT_ID);
    expect(compiled.payload.sourceIntentVersionId).toBe(currentVersion.intentVersionId);
    expect(compiled.payload.sourceIntentVersionNumber).toBe(1);
    expect(compiled.model.requirements.length).toBeGreaterThan(0);
    // Authority: the compiler translates experience into technology-neutral
    // requirements only - it never invents network facts (all dimensions are
    // from the closed vocabulary, hard constraints are classified).
    for (const requirement of compiled.model.requirements) {
      expect([
        "locality",
        "reliability",
        "latency",
        "cost",
        "privacy",
        "technology",
        "mobility",
        "usage",
      ]).toContain(requirement.dimension);
      expect(["hard", "soft"]).toContain(requirement.classification);
    }
    expect(compiled.model.hardRequirements.length).toBeGreaterThan(0);

    // --- 7. submission through the one integration boundary (RL-031) -------
    // The §9 compatibility gate runs first; mutations fail closed without it.
    const report = await world.adcos.intents.runCompatibilityCheck(undefined, world.clock.now());
    expect(report.status).toBe("compatible");
    expect(world.compatibility.status()).toBe("compatible");

    const submission = await world.adcos.intents.submit(
      compiled.payload as unknown as IntentCommandInput,
    );
    const adcosIntentId = (submission.document as Record<string, unknown>)["id"] as string;
    expect(adcosIntentId).toMatch(/intent-/);
    // RL-LOCK-014: the submitted command's idempotency key is derived from the
    // source intent version + digest - a retry with the same input replays.
    expect(submission.envelope.toPlain().idempotencyKey).toContain(currentVersion.intentVersionId);

    // --- 8. offer selection -> activation -> reservation (RL-032) -----------
    const context = {
      actorId: customer.actorId,
      tenantId: customer.tenantId,
      correlationId: world.correlation.next(),
    };
    const contract = await world.adcos.offers.selectOffers(
      adcosIntentId,
      { offers: [{ offer: "offer-ghana-primary" }], recorded_at: world.clock.now() },
      context,
    );
    const contractId = (contract.document as Record<string, unknown>)["id"] as string;
    expect((contract.document as Record<string, unknown>)["state"]).toBe("OFFER_SELECTED");

    const activated = await world.adcos.offers.activateContract(
      adcosIntentId,
      {
        activated_at: world.clock.now(),
        signature_refs: [parseAdcosSignatureRef("sig-activation-1")],
      },
      context,
    );
    expect((activated.document as Record<string, unknown>)["state"]).toBe("CONTRACT_ACTIVE");

    const lease = await world.adcos.offers.createReservation(
      contractId,
      { granted_at: world.clock.now() },
      context,
    );
    const leaseId = (lease.document as Record<string, unknown>)["id"] as string;
    expect((lease.document as Record<string, unknown>)["status"]).toBe("granted");

    // --- 9. connectivity state flows back via webhooks (RL-033/034) --------
    // ADCOS emitted the truth as signed events; RoamLink admits them durably
    // and projects them. Nothing about connectivity was invented locally.
    const beforeCount = await world.boundary.projections.count("connectivity_intent");
    expect(beforeCount).toBe(0);
    const admissions = await world.admitAll();
    expect(admissions.every((outcome) => outcome === "ADMITTED")).toBe(true);
    const processing = await world.boundary.inbox.processPending();
    expect(processing.applied).toBeGreaterThan(0);

    const intentProjection = must(
    await world.boundary.projections.get("connectivity_intent", adcosIntentId),
    "intent projection",
  );
    expect(intentProjection).not.toBeNull();
    const contractProjection = must(
      await world.boundary.projections.get("connectivity_contract", contractId),
      "contract projection",
    );
    const leaseProjection = must(
      await world.boundary.projections.get("connectivity_lease", leaseId),
      "lease projection",
    );

    // Authority + evidence + freshness on every projection (RL-LOCK-010):
    for (const projection of [intentProjection, contractProjection, leaseProjection]) {
      expect(projection.source_authority).toBe("adcos");
      expect(projection.evidence_class).toBe("AUTHENTICATED");
      expect(projection.freshness_state).toBe("FRESH");
      expect(projection.observed_at).not.toBeNull();
      expect(projection.received_at).not.toBeNull();
      expect(projection.fresh_until).not.toBeNull();
      expect(projection.payload_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(projection.source_version).toBeGreaterThan(0);
    }
    // Each projection advanced exactly once per distinct canonical version:
    // the intent/lease resources saw one event each; the contract saw the
    // offers-selected (v1) then activated (v2) events - two honest advances,
    // no skipped versions, no replays.
    expect(intentProjection.projection_version).toBe(1);
    expect(intentProjection.source_version).toBe(1);
    expect(contractProjection.projection_version).toBe(2);
    expect(contractProjection.source_version).toBe(2);
    expect(leaseProjection.projection_version).toBe(1);
    expect(leaseProjection.source_version).toBe(1);
    // The contract projection carries the ADCOS signal truth: the activated
    // event at version 2 (the event envelope IS the projected fact; the full
    // canonical document arrives through reconciliation's canonical reads).
    expect((contractProjection.payload as Record<string, unknown>)["event_type"]).toBe(
      "connectivity_contract.activated",
    );
    expect((contractProjection.payload as Record<string, unknown>)["resource_version"]).toBe(2);

    // --- 10. evidence -> the honest commerce read model (RL-023) -----------
    const linked = await world.references.linkDeliveryEvidence(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
      {
        referenceId: REFERENCE_ID,
        expectedRevision: reference.revision,
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: contractId,
      },
    );
    expect(linked.deliveryEvidenceState).toBe("EVIDENCED");
    expect(linked.freshnessState).toBe("FRESH");

    const subjectView = await world.references.describeSubject(
      customer.tenantId,
      "order",
      ORDER_ID as never,
    );
    // Payment (commerce state) and delivery (evidence state) are presented as
    // SEPARATE facts - never one opaque status (RL-LOCK-008/010).
    expect(subjectView.commercialState).toBe("placed");
    expect(subjectView.deliveryEvidenceState).toBe("EVIDENCED");
    expect(subjectView.evidence?.freshness.freshnessState).toBe("FRESH");
    expect(subjectView.evidence?.canonicalResourceId).toBe(contractId);
    expect(subjectView.evidence?.evidenceClass).toBe("AUTHENTICATED");

    // §11 "time to usable connectivity" (journey-level measurement): the
    // FIRST usable-connectivity instant is exactly this FRESH, EVIDENCED,
    // AUTHENTICATED link. Recorded through the REAL product-SLO recorder -
    // histogram sample + good event under the harness budget (300s).
    const usableAt = world.clock.now();
    const timeToUsableMs = msBetween(paidAt, usableAt);
    expect(timeToUsableMs).toBe(3 * STEP_MS);
    world.slo.recorder.recordTimeToUsableConnectivity({
      tenantId: customer.tenantId,
      durationMs: timeToUsableMs,
    });
    const timeToUsableSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === TIME_TO_USABLE_CONNECTIVITY_MS_METRIC);
    expect(timeToUsableSamples).toHaveLength(1);
    expect((timeToUsableSamples[0] as { value: number }).value).toBe(timeToUsableMs);
    const timeToUsableSlo = evaluateProductSlo(
      world.slo.recorder,
      "time-to-usable-connectivity",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(timeToUsableSlo.good).toBe(1);
    expect(timeToUsableSlo.bad).toBe(0);
    expect(timeToUsableSlo.state).toBe("within-budget");

    // §11 "connectivity cost per useful hour/GB where available": the pass
    // grants a 14-day term (336 useful hours) for 24.99 USD. The ADCOS usage
    // evidence reports ZERO bytes, so the per-GB unit is NOT available and
    // is honestly NOT recorded ("where available").
    const usage = await world.fake.getContractUsage(contractId);
    const usageBytes = ((usage as Record<string, unknown>)["usage"] as Record<string, unknown>)["bytes"];
    expect(usageBytes).toBe(0);
    world.slo.recorder.recordConnectivityCostPerUsefulUnit({
      tenantId: customer.tenantId,
      minorUnitsPerUsefulHour: 2499 / (14 * 24),
    });
    const costSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC);
    expect(costSamples).toHaveLength(1);
    expect((costSamples[0]?.labels as Record<string, unknown>)["unit"]).toBe("per_useful_hour");
    expect(
      costSamples.every(
        (sample) => (sample.labels as Record<string, unknown>)["unit"] !== "per_useful_gb",
      ),
    ).toBe(true);

    // --- 11. decision read model (RL-013) -----------------------------------
    const capabilitySnapshot = await world.experience.registry.latestCapabilitySnapshot(
      customer.tenantId,
      deviceId,
    );
    const contextSnapshot = await world.experience.registry.latestContextSnapshot(
      customer.tenantId,
      deviceId,
    );
    const decision = buildExperienceDecision({
      decisionId: parseExperienceDecisionId(world.ids.next()),
      intent: intentRecord.toRecord(),
      intentVersion: currentVersion,
      capabilitySnapshot: capabilitySnapshot ?? null,
      contextSnapshot: contextSnapshot ?? null,
      at: world.clock.now(),
    });
    expect(decision.derivedStatus).toBe("experience_supported");
    // Explainability: every decision input traces to real evidence records
    // with provenance, and the derived status never overwrote the intent's
    // authoritative status.
    expect(decision.subject.intentStatus).toBe("active");
    const capabilityInput = decision.inputs.find(
      (input) => input.kind === "device-capability-snapshot",
    );
    expect(capabilityInput?.sourceAuthority).toBe("roamlink");
    expect(capabilityInput?.freshness?.freshnessState).toBe("FRESH");
    expect(capabilityInput?.weight).toBeGreaterThan(0);

    // §11 "intent satisfaction rate" (product measurement point, RL-013):
    // the PURE derived-status mapping decides the outcome — a supported
    // decision is a SATISFIED intent — and the recorder turns it into the
    // SLO's good/bad event stream + counter sample.
    const satisfaction = intentSatisfactionOf(decision);
    expect(satisfaction).toEqual({ satisfied: true });
    world.slo.recorder.recordIntentSatisfaction({
      tenantId: customer.tenantId,
      satisfied: must(satisfaction, "intent satisfaction measurement").satisfied,
    });
    const satisfactionSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === INTENT_SATISFACTION_RATE_METRIC);
    expect(satisfactionSamples).toHaveLength(1);
    expect((satisfactionSamples[0]?.labels as Record<string, unknown>)["outcome"]).toBe("good");
    const satisfactionSlo = evaluateProductSlo(
      world.slo.recorder,
      "intent-satisfaction-rate",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(satisfactionSlo.good).toBe(1);
    expect(satisfactionSlo.observedGoodRatio).toBe(1);
    expect(satisfactionSlo.state).toBe("within-budget");

    // Structured-log evidence (RL-052 logging composition): the evaluation
    // is emitted through the world's CORRELATED logger under the journey's
    // correlation-id family, and the record carries the correlation id and
    // the SLO's own numbers (redaction-safe fields, RL-LOCK-016).
    const evaluationCorrelationId = world.correlation.next();
    world.slo.correlationCarrier.run(
      makeCorrelationContext({
        correlationId: evaluationCorrelationId,
        tenantId: customer.tenantId,
      }),
      () => logSloEvaluation(world.slo.logger, satisfactionSlo),
    );
    const logRecord = world.slo.logSink.records().at(-1);
    expect(logRecord?.correlationId).toBe(evaluationCorrelationId);
    expect((logRecord?.fields as Record<string, unknown>)["slo"]).toBe(
      "slo.intent-satisfaction-rate",
    );
    expect((logRecord?.fields as Record<string, unknown>)["slo_state"]).toBe(
      "within-budget",
    );

    // --- 12. notification delivered (RL-014) -------------------------------
    // Notifications are emitted ONLY from RoamLink's own durable state
    // transitions (RL-LOCK-009): the reference model's evidence_linked event
    // is the durable receipt.
    const history = await world.references.referenceHistory(
      customer.tenantId,
      REFERENCE_ID,
    );
    const linkEvent = must(
      history.find((event) => event.transition === "connectivity_reference.evidence_linked"),
      "evidence-linked event",
    );

    await world.notifications.emitFromTransition(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
      {
        notificationId: NOTIFICATION_ID,
        recipientUserId: customer.userId,
        topic: "connectivity",
        severity: "info",
        title: "Your connectivity is live",
        body: "Delivery evidence for your Traveler Pass order is now FRESH (contract active).",
        source: {
          origin: "roamlink_state_transition",
          aggregateType: "connectivity_reference",
          aggregateId: REFERENCE_ID,
          transition: "connectivity_reference.evidence_linked",
          eventId: linkEvent.eventId,
          occurredAt: linkEvent.occurredAt,
        },
        relatedRefs: [
          { kind: "order", id: ORDER_ID },
          { kind: "connectivity_reference", id: REFERENCE_ID },
        ],
      },
    );
    await world.notifications.recordChannelDelivery(
      world.envelope({ actorId: customer.actorId, tenantId: customer.tenantId }),
      { notificationId: NOTIFICATION_ID, channel: "in_app", outcome: "delivered" },
    );

    const delivered = await world.notifications.listNotificationsForRelatedRef(
      customer.tenantId,
      { kind: "order", id: ORDER_ID },
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.status).toBe("delivered");
    // The notification's source is the durable RoamLink transition with the
    // event id receipt - never a raw ADCOS payload.
    expect(delivered[0]?.source.transition).toBe("connectivity_reference.evidence_linked");
    expect(delivered[0]?.source.eventId).toBe(linkEvent.eventId);
    expect(delivered[0]?.source.origin).toBe("roamlink_state_transition");

    // --- 13. end-to-end correlation (one family) ---------------------------
    // Every RoamLink command in this journey carried a correlation id from
    // the same family; the commerce event chain retains them (audit).
    const orderEvents = await world.commerce.store.read.events.listForAggregate(
      customer.tenantId,
      "order",
      ORDER_ID,
    );
    expect(orderEvents.length).toBeGreaterThan(0);
    for (const event of orderEvents) {
      expect(event.correlationId).toMatch(/^corr\.dogfood\.onboarding\.\d+$/);
    }

    // The refundable amount proves the money-facts arithmetic is honest:
    // a succeeded 24.99 USD payment with zero refunds refunds exactly 24.99.
    const paymentRecord = must(
      await world.commerce.store.read.payments.findById(customer.tenantId, PAYMENT_ID as never),
      "succeeded payment",
    );
    expect(
      computeRefundableAmount(paymentRecord, []),
    ).toEqual({ amountMinorUnits: 2499, currency: "USD" });
  });

  it("retries never duplicate: replayed envelopes and replayed ADCOS commands replay the original outcome (RL-LOCK-014)", async () => {
    const world = makeDogfoodWorld("onboarding-idem");
    const customer = await registerCustomer(world, 0x21);
    await seedCatalog(world, customer);

    // The SAME §5 envelope delivered twice: one order placed, one payment.
    const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
    const createEnvelope = world.envelope({ ...actor, orderVersion: 1, key: "idem-order-dup" });
    const first = await world.commerce.orders.createOrder(createEnvelope, {
      orderId: ORDER_ID,
      ownerUserId: customer.userId,
    });
    const replay = await world.commerce.orders.createOrder(createEnvelope, {
      orderId: ORDER_ID,
      ownerUserId: customer.userId,
    });
    expect(replay).toEqual(first);
    expect(await world.commerce.store.read.orders.listByTenant(customer.tenantId)).toHaveLength(1);

    // Place the order (the replayable envelope proves idempotency too).
    const lineEnvelope = world.envelope({ ...actor, orderVersion: 1, key: "idem-line-dup" });
    await world.commerce.orders.addOrderLine(lineEnvelope, {
      orderId: ORDER_ID,
      lineId: world.ids.next(),
      variantId: VARIANT_ID,
      quantity: 1,
    });
    const placeEnvelope = world.envelope({ ...actor, orderVersion: 2, key: "idem-place-dup" });
    await world.commerce.orders.placeOrder(placeEnvelope, { orderId: ORDER_ID });
    await world.commerce.orders.placeOrder(placeEnvelope, { orderId: ORDER_ID });
    const placed = await world.commerce.store.read.orders.findById(
      customer.tenantId,
      ORDER_ID as never,
    );
    expect(placed?.status).toBe("placed");

    // The same payment envelope twice: one payment, one pending record.
    const payEnvelope = world.envelope({ ...actor, key: "idem-payment-dup" });
    await world.commerce.payments.recordPayment(payEnvelope, {
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.recordPayment(payEnvelope, {
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    expect(
      await world.commerce.store.read.payments.listForOrder(customer.tenantId, ORDER_ID as never),
    ).toHaveLength(1);

    // The same ADCOS intent command submitted three times: ONE intent.
    await world.adcos.intents.runCompatibilityCheck(undefined, world.clock.now());
    const input: IntentCommandInput = {
      sourceIntentId: INTENT_ID,
      sourceIntentVersionId: "00000000-0000-4000-8000-0000000000b2",
      sourceIntentVersionNumber: 1,
      actorId: customer.actorId,
      tenantId: customer.tenantId,
      requirements: [
        { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
      ],
      validity: {
        start: world.clock.now(),
        end: instantPlusMs(world.clock.now(), 14 * 24 * 60 * 60 * 1000),
      },
      termination: { actor: "customer", onExpiry: "release" },
    };
    const baseline = world.fake.intentCount();
    const submission = await world.adcos.intents.submit(input);
    await world.adcos.intents.submit(input);
    await world.adcos.intents.submit(input);
    expect(world.fake.intentCount()).toBe(baseline + 1);
    // The replay returns the ORIGINAL document (byte-identical identity).
    const again = await world.adcos.intents.submit(input);
    expect((again.document as Record<string, unknown>)["id"]).toBe(
      (submission.document as Record<string, unknown>)["id"],
    );

    // Admitting the same webhook delivery twice: ADMITTED then DUPLICATE;
    // the projection advances exactly once.
    const deliveries = world.fake.deliveries().slice(-1);
    const outcomes = await world.admitAll(deliveries);
    expect(outcomes).toEqual(["ADMITTED"]);
    const duplicate = await world.admitAll(deliveries);
    expect(duplicate).toEqual(["DUPLICATE"]);
    const processing = await world.boundary.inbox.processPending();
    expect(processing.considered).toBe(1);
    expect(processing.applied).toBe(1);
    const intentId = (deliveries[0]?.event.resource_id ?? "") as string;
    const projection = await world.boundary.projections.get("connectivity_intent", intentId);
    expect(projection?.projection_version).toBe(1);
  });
});
