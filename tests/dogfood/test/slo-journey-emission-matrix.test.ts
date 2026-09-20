/**
 * RL-116 — the §11 SLO × journey-state emission matrix, EXECUTED.
 *
 * The matrix (src/slo-matrix.ts) is executable truth: every row is driven
 * against the REAL dogfood world — the real domain planes, the real
 * reconciliation boundary with the REAL product-SLO recorder wired as its
 * sloObserver — and the emission deltas are asserted EXACTLY:
 *
 *   - presence: a row's product/harness measurement points emit precisely
 *     the named §11 metrics (with the expected label outcomes);
 *   - absence: gap rows emit NOTHING across all nine §11 metrics — the
 *     honest emptiness is pinned, so silently adding an emission point
 *     (or silently losing one) fails this suite.
 *
 * Duplicate-avoidance discipline: the domain-level SLO correctness that the
 * dogfood scenarios already pin (exact durations, budgets, burn-rate
 * evaluations, structured-log evidence) is NOT re-asserted here — this
 * suite is the SYSTEMATIC state × SLO cross-check between those points and
 * the reconciliation engine's product emission path.
 */
import { describe, expect, it } from "vitest";
import { parseExperienceDecisionId } from "@roamlink/contracts";
import { parseAdcosSignatureRef } from "@roamlink/adcos";
import {
  PRODUCT_SLO_IDS,
  parseProductSloId,
  type ProductSloId,
} from "@roamlink/observability";
import { buildExperienceDecision, intentSatisfactionOf } from "@roamlink/domain-experience";
import { compileExperienceIntent } from "@roamlink/intent-compiler";
import type { IntentCommandInput } from "@roamlink/integration";

import {
  makeDogfoodWorld,
  msBetween,
  must,
  registerCustomer,
  type DogfoodWorld,
} from "../src/world.js";
import {
  seedActiveConnectivity,
  makeJourneyWorld,
} from "../src/journey.js";
import {
  SLO_EMISSION_MATRIX,
  otherSlos,
  samplesOf,
  sloDelta,
  sloDeltaWhere,
  snapshotSloSamples,
  stageAccepted,
  stageDelivery,
  stageObserved,
  stagePathActive,
  stageRequested,
  stageReserved,
} from "../src/slo-matrix.js";

/** The world's snapshot-clock window for the journey device (world fixture). */
const SNAPSHOT_WINDOW_MS = 600_000;
/** Aging that makes BOTH the device snapshots AND the projections stale. */
const AGING_ADVANCE_MS = SNAPSHOT_WINDOW_MS + 5_000;
/** The walk's inter-stage hop (deterministic; no wall clock). */
const HOP_MS = 1_000;

/** Asserts the emission deltas of one matrix row: presence AND absence. */
function assertRowEmissions(
  world: DogfoodWorld,
  before: Map<string, number>,
  expected: readonly ProductSloId[],
): Map<string, number> {
  const after = snapshotSloSamples(world.slo.metrics);
  for (const slo of PRODUCT_SLO_IDS) {
    const delta = sloDelta(before, after, slo);
    if (expected.includes(slo)) {
      expect(delta).toBeGreaterThanOrEqual(1);
    } else {
      expect(delta).toBe(0);
    }
  }
  return after;
}

describe("RL-116: the §8 happy-path rows emit exactly what the matrix says", () => {
  it("walks observed -> requested -> accepted -> reserved -> path-active -> delivery with per-state deltas", async () => {
    const world = makeDogfoodWorld("slo-matrix-happy");

    // ROW observed — gap: no §11 emission point observes observation.
    let before = snapshotSloSamples(world.slo.metrics);
    const observed = await stageObserved(world);
    before = assertRowEmissions(world, before, []);

    // ROW requested — gap: no §11 emission point observes the request.
    world.clock.advanceBy(HOP_MS);
    const requested = await stageRequested(world, observed);
    before = assertRowEmissions(world, before, []);

    // ROW accepted — gap.
    world.clock.advanceBy(HOP_MS);
    const contractId = await stageAccepted(world, observed.customer, requested.adcosIntentId);
    before = assertRowEmissions(world, before, []);

    // ROW reserved — gap.
    world.clock.advanceBy(HOP_MS);
    await stageReserved(world, observed.customer, requested.adcosIntentId, contractId);
    before = assertRowEmissions(world, before, []);

    // ROW path-active — gap: the webhook->projection plane emits no §11 event.
    world.clock.advanceBy(HOP_MS);
    await stagePathActive(world);
    before = assertRowEmissions(world, before, []);

    // ROW delivery — HARNESS measurement point: time-to-usable-connectivity
    // is recorded by the walk (the src/journey.ts blueprint's own instant),
    // and NO product-owned §11 emission point fires for the evidence link.
    world.clock.advanceBy(HOP_MS);
    await stageDelivery(world, observed.customer, contractId, requested.paidAt);
    assertRowEmissions(world, before, ["time-to-usable-connectivity"]);
    const timeToUsable = samplesOf(world.slo.metrics, "time-to-usable-connectivity");
    expect(timeToUsable).toHaveLength(1);
    expect((timeToUsable[0]?.labels as Record<string, unknown>)["tenant_id"]).toBe(
      observed.customer.tenantId,
    );
  });
});

describe("RL-116: the decision + recovery rows are product-emitted through the real wiring", () => {
  it("maps the decision read model through the pure satisfaction rule, and the reconciliation job's durable actions through the sloObserver", async () => {
    const world = makeDogfoodWorld("slo-matrix-recovery");
    const observed = await stageObserved(world);
    const requested = await stageRequested(world, observed);
    const contractId = await stageAccepted(world, observed.customer, requested.adcosIntentId);
    await stageReserved(world, observed.customer, requested.adcosIntentId, contractId);
    await stagePathActive(world);
    world.clock.advanceBy(HOP_MS);
    await stageDelivery(world, observed.customer, contractId, requested.paidAt);
    const actor = { actorId: observed.customer.actorId, tenantId: observed.customer.tenantId };

    // Helper: build the decision read model over the device's CURRENT
    // snapshots (the product measurement point of intent satisfaction).
    const buildDecision = async () => {
      const capabilitySnapshot = await world.experience.registry.latestCapabilitySnapshot(
        observed.customer.tenantId,
        observed.deviceId,
      );
      const contextSnapshot = await world.experience.registry.latestContextSnapshot(
        observed.customer.tenantId,
        observed.deviceId,
      );
      return buildExperienceDecision({
        decisionId: parseExperienceDecisionId(world.ids.next()),
        intent: requested.intentRecord.toRecord(),
        intentVersion: requested.currentVersion,
        capabilitySnapshot: capabilitySnapshot ?? null,
        contextSnapshot: contextSnapshot ?? null,
        at: world.clock.now(),
      });
    };

    // ROW intent-satisfaction (supported): the PURE mapping decides, the
    // caller records at the product measurement point — one good event.
    let before: Map<string, number>;
    const supportedStart = snapshotSloSamples(world.slo.metrics);
    const supported = await buildDecision();
    expect(supported.derivedStatus).toBe("experience_supported");
    const satisfied = intentSatisfactionOf(supported);
    expect(satisfied).toEqual({ satisfied: true });
    world.slo.recorder.recordIntentSatisfaction({
      tenantId: observed.customer.tenantId,
      satisfied: must(satisfied, "satisfaction measurement").satisfied,
    });
    const supportedEnd = assertRowEmissions(world, supportedStart, ["intent-satisfaction-rate"]);
    expect(sloDeltaWhere(supportedStart, supportedEnd, "intent-satisfaction-rate", (labels) => labels["outcome"] === "good")).toBe(1);
    before = supportedEnd;

    // Age past BOTH the device snapshot windows and the projection TTLs:
    // the read model degrades honestly and the truth goes stale.
    world.clock.advanceBy(AGING_ADVANCE_MS);

    // ROW intent-satisfaction (degraded): the same product mapping now
    // yields the bad outcome — stale evidence weighs zero, never guessed.
    const degraded = await buildDecision();
    expect(degraded.derivedStatus).toBe("experience_degraded");
    const notSatisfied = intentSatisfactionOf(degraded);
    expect(notSatisfied).toEqual({ satisfied: false });
    world.slo.recorder.recordIntentSatisfaction({
      tenantId: observed.customer.tenantId,
      satisfied: must(notSatisfied, "degraded satisfaction measurement").satisfied,
    });
    const degradedEnd = assertRowEmissions(world, before, ["intent-satisfaction-rate"]);
    expect(sloDeltaWhere(before, degradedEnd, "intent-satisfaction-rate", (labels) => labels["outcome"] === "bad")).toBe(1);
    before = degradedEnd;

    // ROW recovered (automatic repair closes the stale/unknown window):
    // the reconciliation engine's own emission path. The job's durable
    // actions are the truth; the emitted §11 events MUST mirror them.
    // (The projection record's freshness_state is a write-time field; the
    // honest pre-repair signal is its EXPIRED freshness guarantee.)
    const preRepair = await world.boundary.projections.get("connectivity_contract", contractId);
    const preFreshUntil = must(preRepair, "pre-repair projection record").fresh_until;
    if (preFreshUntil === null) {
      throw new Error("expected a fresh_until on the seeded contract projection");
    }
    before = snapshotSloSamples(world.slo.metrics);
    const job = await world.boundary.reconciler.runJob({
      reason: "scheduled",
      correlationId: world.correlation.next(),
    });
    expect(job.status).toBe("COMPLETED");
    expect(msBetween(preFreshUntil, world.clock.now())).toBeGreaterThan(0);
    const repaired = job.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.outcome === "REPAIRED",
    );
    expect(repaired.length).toBeGreaterThanOrEqual(1);
    const after = snapshotSloSamples(world.slo.metrics);
    // every repaired canonical refresh = one good automatic-recovery event
    expect(sloDeltaWhere(before, after, "successful-automatic-recovery-rate", (labels) => labels["outcome"] === "good")).toBe(repaired.length);
    expect(sloDelta(before, after, "successful-automatic-recovery-rate")).toBe(repaired.length);
    // every stale-window-closing repair emits the CLOSED window duration,
    // stamped from the pre-repair record's own freshness fields
    const windowCarrying = repaired.filter(
      (action) =>
        (action.metrics as Record<string, unknown> | undefined)?.["staleForMs"] !== undefined,
    );
    expect(windowCarrying.length).toBeGreaterThanOrEqual(1);
    expect(sloDelta(before, after, "stale-unknown-state-duration")).toBe(windowCarrying.length);
    const emittedWindows = samplesOf(world.slo.metrics, "stale-unknown-state-duration").map(
      (sample) => sample.value,
    );
    for (const action of windowCarrying) {
      expect(emittedWindows).toContain(
        (action.metrics as Record<string, unknown>)["staleForMs"],
      );
    }
    // the contract's OWN closed window is the repair instant minus its
    // expired guarantee end (deterministic clock: the job ran at the
    // current instant) — stamped verbatim from the record, never guessed
    const contractRepair = job.actions.find(
      (action) =>
        action.action_type === "CANONICAL_REFRESH" &&
        action.resource_id === contractId &&
        action.outcome === "REPAIRED",
    );
    const contractStaleForMs = (contractRepair?.metrics as Record<string, unknown> | undefined)?.[
      "staleForMs"
    ];
    expect(contractStaleForMs).toBeDefined();
    const repairAt = world.clock.now();
    const expectedWindow = msBetween(preFreshUntil, repairAt);
    expect(contractStaleForMs).toBe(expectedWindow);
    // a scheduled trigger is NOT a manual intervention — zero manual delta
    expect(sloDelta(before, after, "manual-interventions-per-session-day")).toBe(0);
    // HARNESS measurement point (the matrix row names it): the outage window
    // that just closed is ALSO the minutes-without-usable-connectivity
    // measurement — recorded by the walk at the window close (scenario 2's
    // own point), in minutes on the deterministic clock.
    const minutes = expectedWindow / 60_000;
    world.slo.recorder.recordMinutesWithoutUsableConnectivity({
      tenantId: observed.customer.tenantId,
      minutes,
    });
    const afterMinutes = snapshotSloSamples(world.slo.metrics);
    expect(sloDelta(before, afterMinutes, "minutes-without-usable-connectivity")).toBe(1);

    // ROW manual intervention: a MANUAL repair loop is the product's own
    // manual-intervention emission point (trigger_reason "manual"), even
    // when every action finds the world already consistent.
    const beforeManual = snapshotSloSamples(world.slo.metrics);
    const manualJob = await world.boundary.reconciler.runJob({
      reason: "manual",
      correlationId: world.correlation.next(),
    });
    expect(manualJob.status).toBe("COMPLETED");
    const afterManual = snapshotSloSamples(world.slo.metrics);
    expect(sloDelta(beforeManual, afterManual, "manual-interventions-per-session-day")).toBe(1);
    expect(
      sloDelta(beforeManual, afterManual, "successful-automatic-recovery-rate"),
    ).toBe(0);
    expect(sloDelta(beforeManual, afterManual, "stale-unknown-state-duration")).toBe(0);

    // ROW failover (provider/access re-planning): the §11 failover outcome
    // is HARNESS-recorded at the granted failover reservation — the re-plan
    // itself has no product-owned §11 emission point.
    const beforeFailover = snapshotSloSamples(world.slo.metrics);
    await world.experience.intents.reviseIntent(world.envelope({ ...actor, intentVersion: 2 }), {
      intentId: must(requested.intentRecord.intentId, "intent id"),
      payload: {
        travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
        usageProfile: "travel_international",
        preferences: {
          reliability: "high",
          latency: "interactive",
          costSensitivity: "high",
          privacySensitivity: "high",
          preferredAccessClasses: ["home_cellular", "trusted_wifi"],
        },
        hardConstraints: { requireEncryptedTransport: true, forbidRoaming: false, forbidOpenWifi: true },
      },
      rationale: "Primary path degraded: prefer cellular failover, cap cost",
    });
    const intentRecord = await world.experience.intents.getIntent(
      observed.customer.tenantId,
      must(requested.intentRecord.intentId, "intent id"),
    );
    const versions = await world.experience.intents.listVersions(
      observed.customer.tenantId,
      must(requested.intentRecord.intentId, "intent id"),
    );
    const revisedVersion = must(
      versions.find((version) => version.intentVersionId === intentRecord.currentVersionId),
      "revised intent version",
    );
    const recompiled = compileExperienceIntent(
      intentRecord.toRecord(),
      revisedVersion,
      { at: world.clock.now(), commandId: world.ids.next(), actorId: observed.customer.actorId },
    );
    const submission = await world.adcos.intents.submit(
      recompiled.payload as unknown as IntentCommandInput,
    );
    const failoverIntentId = (submission.document as Record<string, unknown>)["id"] as string;
    const context = {
      actorId: observed.customer.actorId,
      tenantId: observed.customer.tenantId,
      correlationId: world.correlation.next(),
    };
    const failoverContract = await world.adcos.offers.selectOffers(
      failoverIntentId,
      { offers: [{ offer: "offer-ghana-failover-cellular" }], recorded_at: world.clock.now() },
      context,
    );
    const failoverContractId = (failoverContract.document as Record<string, unknown>)["id"] as string;
    await world.adcos.offers.activateContract(
      failoverIntentId,
      {
        activated_at: world.clock.now(),
        signature_refs: [parseAdcosSignatureRef("sig-matrix-failover-1")],
      },
      context,
    );
    const failoverLease = await world.adcos.offers.createReservation(
      failoverContractId,
      { granted_at: world.clock.now() },
      context,
    );
    expect((failoverLease.document as Record<string, unknown>)["status"]).toBe("granted");
    world.slo.recorder.recordProviderAccessFailover({
      tenantId: observed.customer.tenantId,
      succeeded: true,
    });
    const afterFailover = snapshotSloSamples(world.slo.metrics);
    expect(sloDeltaWhere(beforeFailover, afterFailover, "provider-access-failover-success", (labels) => labels["outcome"] === "good")).toBe(1);
    for (const slo of otherSlos("provider-access-failover-success")) {
      expect(sloDelta(beforeFailover, afterFailover, slo)).toBe(0);
    }

    // ROW delivered/usage accruing (cost where available): the usage
    // evidence reports ZERO bytes, so per-GB is honestly ABSENT; the
    // harness records the per-useful-hour cost (its measurement point).
    const usage = await world.fake.getContractUsage(contractId);
    const usageBytes = ((usage as Record<string, unknown>)["usage"] as Record<string, unknown>)["bytes"];
    expect(usageBytes).toBe(0);
    const beforeCost = snapshotSloSamples(world.slo.metrics);
    world.slo.recorder.recordConnectivityCostPerUsefulUnit({
      tenantId: observed.customer.tenantId,
      minorUnitsPerUsefulHour: 2499 / (14 * 24),
    });
    const afterCost = snapshotSloSamples(world.slo.metrics);
    expect(sloDelta(beforeCost, afterCost, "connectivity-cost-per-useful-hour-gb-where-available")).toBe(1);
    expect(
      sloDeltaWhere(beforeCost, afterCost, "connectivity-cost-per-useful-hour-gb-where-available", (labels) => labels["unit"] === "per_useful_gb"),
    ).toBe(0);
    expect(
      sloDeltaWhere(beforeCost, afterCost, "connectivity-cost-per-useful-hour-gb-where-available", (labels) => labels["unit"] === "per_useful_hour"),
    ).toBe(1);
  });
});

describe("RL-116: the §10 commerce-terminal rows", () => {
  it("completed / billable-final / failed / canceled emit exactly what the matrix says", async () => {
    const world = makeDogfoodWorld("slo-matrix-commerce");
    const customer = await registerCustomer(world, 0x72);
    const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
    const env = (orderVersion: number) => world.envelope({ ...actor, orderVersion });

    // Shared catalog for the four terminal-state drives.
    await world.commerce.catalog.createProduct(world.envelope(actor), {
      productId: "00000000-0000-4000-8000-0000000000e1",
      name: "Traveler Pass",
    });
    await world.commerce.catalog.activateProduct(world.envelope(actor), {
      productId: "00000000-0000-4000-8000-0000000000e1",
      expectedRevision: 1,
    });
    await world.commerce.catalog.createVariant(world.envelope(actor), {
      variantId: "00000000-0000-4000-8000-0000000000e2",
      productId: "00000000-0000-4000-8000-0000000000e1",
      name: "Ghana 14-Day",
      sku: "pass-matrix-commerce",
      billingModel: "one_time",
      termDays: 14,
      price: { amountMinorUnits: 2499, currency: "USD" },
    });

    const placeOrder = async (orderId: string): Promise<void> => {
      await world.commerce.orders.createOrder(env(1), { orderId, ownerUserId: customer.userId });
      await world.commerce.orders.addOrderLine(env(1), {
        orderId,
        lineId: world.ids.next(),
        variantId: "00000000-0000-4000-8000-0000000000e2",
        quantity: 1,
      });
      await world.commerce.orders.placeOrder(env(2), { orderId });
    };

    // ROW completed — gap: no §11 emission point observes order completion.
    let before = snapshotSloSamples(world.slo.metrics);
    const completedOrderId = world.ids.next();
    await placeOrder(completedOrderId);
    await world.commerce.orders.completeOrder(env(3), { orderId: completedOrderId });
    before = assertRowEmissions(world, before, []);

    // ROW billable-final — gap: invoice reconciliation emits no §11 event.
    before = snapshotSloSamples(world.slo.metrics);
    const billableOrderId = world.ids.next();
    const billablePaymentId = world.ids.next();
    const billableInvoiceId = world.ids.next();
    await placeOrder(billableOrderId);
    await world.commerce.payments.recordPayment(world.envelope(actor), {
      paymentId: billablePaymentId,
      orderId: billableOrderId,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(world.envelope(actor), {
      paymentId: billablePaymentId,
      expectedRevision: 1,
      transition: "succeed",
    });
    const invoice = await world.commerce.payments.issueInvoice(world.envelope(actor), {
      invoiceId: billableInvoiceId,
      invoiceNumber: "INV-2026-000771",
      orderId: billableOrderId,
    });
    await world.commerce.payments.reconcileInvoice(world.envelope(actor), {
      invoiceId: billableInvoiceId,
      expectedRevision: invoice.revision,
    });
    before = assertRowEmissions(world, before, []);

    // ROW failed — HARNESS measurement point: the support incident
    // attributable to the orchestration failure is recorded downstream of
    // the failed payment (scenario 4's measurement point); the failure
    // transition itself has no product-owned §11 emission point.
    before = snapshotSloSamples(world.slo.metrics);
    const failedOrderId = world.ids.next();
    const failedPaymentId = world.ids.next();
    await placeOrder(failedOrderId);
    await world.commerce.payments.recordPayment(world.envelope(actor), {
      paymentId: failedPaymentId,
      orderId: failedOrderId,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(world.envelope(actor), {
      paymentId: failedPaymentId,
      expectedRevision: 1,
      transition: "fail",
      failureReason: "declined_by_processor",
    });
    world.slo.recorder.recordSupportIncidentAttributable({ tenantId: customer.tenantId });
    before = assertRowEmissions(
      world,
      before,
      ["support-incidents-attributable-to-connectivity-orchestration"],
    );

    // ROW canceled — gap.
    before = snapshotSloSamples(world.slo.metrics);
    const canceledOrderId = world.ids.next();
    await placeOrder(canceledOrderId);
    await world.commerce.orders.cancelOrder(env(3), { orderId: canceledOrderId, reason: "customer changed plans" });
    assertRowEmissions(world, before, []);
  });
});

describe("RL-116: the unknown/stale window stays silent until it CLOSES", () => {
  it("emits NOTHING while the window is open (repair deferred) — honest absence, executable", async () => {
    const seeded = await seedActiveConnectivity(makeJourneyWorld("slo-matrix-deferred"));
    const { world, customer, contractId } = seeded;

    // Truth becomes unreachable AND the projection ages past its guarantee.
    world.fake.silentStateChange(contractId, "DEGRADED");
    world.fake.failNext({ kind: "transport", outcome: "not-sent" }, { count: 100 });
    world.clock.advanceBy(AGING_ADVANCE_MS);

    const before = snapshotSloSamples(world.slo.metrics);
    const job = await world.boundary.reconciler.runJob({
      reason: "scheduled",
      correlationId: world.correlation.next(),
    });
    expect(job.status).toBe("COMPLETED");
    // The canonical refresh deferred (bounded attempts) — no repair claimed.
    const target = job.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    expect(target?.outcome).toBe("DEFERRED");
    // THE ROW: no §11 SLO emitted anything — no fabricated recovery event,
    // no guessed duration, no manual intervention for a scheduled trigger.
    const after = snapshotSloSamples(world.slo.metrics);
    for (const slo of PRODUCT_SLO_IDS) {
      expect(sloDelta(before, after, slo)).toBe(0);
    }
    // The customer's journey vocabulary stays honest: the reference's
    // evidence is STALE (the last honest signal), never fabricated fresh.
    const view = await world.references.describeSubject(
      customer.tenantId,
      "order",
      seeded.orderId as never,
    );
    expect(view.evidence?.freshness.freshnessState).toBe("STALE");
  });
});

describe("RL-116: the matrix itself is complete, closed and honest", () => {
  it("covers the §8 journey vocabulary + the §10 failure states with no silent row", () => {
    // Every named SLO id is a member of the closed nine.
    for (const row of SLO_EMISSION_MATRIX) {
      for (const slo of row.productEmissions) parseProductSloId(slo);
      for (const slo of row.harnessMeasurements) parseProductSloId(slo);
    }
    // The §8 journey vocabulary (tech-lead handoff §8) is covered row for row.
    const journeyVocabulary = [
      "observed",
      "requested",
      "accepted",
      "reserved",
      "path-active",
      "delivery",
      "recovered",
    ] as const;
    for (const state of journeyVocabulary) {
      const covered = SLO_EMISSION_MATRIX.some((row) => row.state === state || row.state.startsWith(`${state} `));
      expect(covered, `matrix row missing for §8 state '${state}'`).toBe(true);
    }
    // The §10 failure semantics (spec/architecture.md §10) are covered too.
    const failureVocabulary = [
      "authorized",
      "delivery-started",
      "delivered/usage",
      "completed",
      "billable-final",
      "failed",
      "canceled",
      "unknown/stale",
    ] as const;
    for (const state of failureVocabulary) {
      const covered = SLO_EMISSION_MATRIX.some((row) => row.state.startsWith(state));
      expect(covered, `matrix row missing for §10 state '${state}'`).toBe(true);
    }
    // NO SILENT ROW: every row names an emission/measurement or carries an
    // explicit known-gap finding (never a quietly-passing assertion).
    for (const row of SLO_EMISSION_MATRIX) {
      const namesSomething =
        row.productEmissions.length > 0 ||
        row.harnessMeasurements.length > 0 ||
        row.knownGap !== null;
      expect(namesSomething, `matrix row '${row.state}' is silent`).toBe(true);
    }
    // The nine §11 SLOs all appear somewhere in the matrix (every SLO is
    // cross-checked against at least one state).
    const referenced = new Set(
      SLO_EMISSION_MATRIX.flatMap((row) => [...row.productEmissions, ...row.harnessMeasurements]),
    );
    for (const slo of PRODUCT_SLO_IDS) {
      expect(referenced.has(slo), `§11 SLO '${slo}' is not cross-checked by any matrix row`).toBe(true);
    }
  });
});
