/**
 * RL-071 scenario: DELAY - freshness decay to STALE, then delayed truth.
 *
 * Events arrive late; freshness guarantees expire meanwhile. The
 * architectural invariants:
 *  - FRESH degrades to STALE monotonically as the clock passes fresh_until
 *    (never stays silently FRESH);
 *  - a DELAYED event that carries NEWER truth still applies (lateness does
 *    not discard new information) and re-establishes freshness;
 *  - the commerce read model re-evaluates evidence freshness AT THE QUERY
 *    INSTANT: FRESH at link time becomes STALE later, UNKNOWN is presented,
 *    never hidden.
 */
import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  ORDER_ID,
  REFERENCE_ID,
  T0,
  USER_TENANT,
  makeSimulation,
  seedPlacedOrder,
  type Simulation,
} from "../src/harness.js";

const INTENT_REQUEST = Object.freeze({
  requirements: Object.freeze([
    Object.freeze({ dimension: "usage", classification: "soft", statement: Object.freeze({ profile: "sim" }) }),
  ]),
  validity: Object.freeze({
    start: parseUtcInstant(T0),
    end: parseUtcInstant("2026-01-16T08:30:00.000Z"),
  }),
  termination: Object.freeze({ actor: "roamlink", on_expiry: "release" }),
  recorded_at: parseUtcInstant(T0),
});

describe("RL-071 delay: freshness decay -> STALE; delayed truth still converges", () => {
  it("FRESH decays to STALE as the guarantee expires; the payload is retained", async () => {
    const simulation = makeSimulation();
    const { contractId } = await seedIntentAndContract(simulation);
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();

    let projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("FRESH");
    const freshUntil = projection?.fresh_until ?? null;
    expect(freshUntil).not.toBeNull();

    // BEFORE the guarantee expires: still FRESH (the sweep is a no-op).
    simulation.clock.advanceTo("2026-01-15T08:30:30.000Z");
    await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("FRESH");

    // AFTER the guarantee expires, the scheduled job runs: the freshness
    // sweep FIRST transitions the record to STALE (the decay is measured in
    // the sweep action), and the canonical scan then repairs it from the
    // authority - re-establishing a fresh observation at the current clock.
    simulation.clock.advanceTo("2026-01-15T08:31:30.000Z");
    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const sweep = job.actions.find((action) => action.action_type === "FRESHNESS_SWEEP");
    expect(sweep?.detail).toMatch(/TRANSITIONED_TO_STALE\(\d+\)/);
    expect(Number(/TRANSITIONED_TO_STALE\((\d+)\)/.exec(sweep?.detail ?? "")?.[1] ?? 0)).toBeGreaterThan(0);

    const repair = job.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    expect(repair?.outcome).toBe("REPAIRED");
    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("FRESH");
    expect(projection?.received_at).toBe(simulation.clock.now());
  });

  it("when the canonical source is unreachable, the decayed state is PRESENTED (STALE retained, never guessed away)", async () => {
    // An incompatible-gate world: the §9 gate observed schema drift, so the
    // reconciler refuses canonical fetches entirely (fail-closed).
    const simulation = makeSimulation({
      compatibility: { status: () => "incompatible" },
    });
    const { contractId } = await seedIntentAndContract(simulation);
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();

    simulation.clock.advanceBy(120_000);
    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const sweep = job.actions.find((action) => action.action_type === "FRESHNESS_SWEEP");
    expect(sweep?.detail).toMatch(/TRANSITIONED_TO_STALE\(\d+\)/);

    const projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("STALE");
    expect(projection?.evidence_class).toBe("STALE");
    expect(projection?.payload).toBeDefined(); // known prior state retained
    const deferred = job.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.outcome === "DEFERRED",
    );
    expect(deferred.length).toBeGreaterThan(0);
  });

  it("a DELAYED delivery withholding then releasing: late events still apply and re-establish freshness", async () => {
    // A mutable gate: INCOMPATIBLE while the partition persists (so the
    // decayed STALE state is what remains visible), flipped back to
    // compatible for the recovery job.
    let gateStatus: "unknown" | "compatible" | "incompatible" = "incompatible";
    const simulation = makeSimulation({
      compatibility: { status: () => gateStatus },
    });
    // The transport is configured to WITHHOLD the first two emitted events
    // (delay applies at emission time - set BEFORE the mutations).
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 2 };

    const { intentId, contractId } = await seedIntentAndContract(simulation);

    // Activate the contract on the source (a THIRD event, v2 of contract).
    await simulation.fake.activateContract(
      intentId,
      { activated_at: parseUtcInstant(T0), signature_refs: [] },
      { idempotencyKey: "idem-delay-activate" as never },
    );

    expect(simulation.fake.deliveries().length).toBe(1); // only the activation is visible

    // The visible event is admitted + projected: the contract reaches v2.
    await simulation.admitAndProject();
    let projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.source_version).toBe(2);
    expect(projection?.freshness_state).toBe("FRESH");

    // Freshness decays while the delayed events are still withheld; the
    // incompatible gate keeps this world's canonical fetches deferred, so
    // the STALE state is what the sweep left (honest degradation).
    simulation.clock.advanceBy(120_000);
    await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("STALE");

    // The delayed events are RELEASED (late delivery).
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    simulation.fake.flushDelayedDeliveries();
    await simulation.admitAndProject();

    // The older contract event (v1) is skipped as OUTDATED (no regression);
    // the intent event (its resource's only event) applies late; the
    // contract stays at v2 - the highest delivered truth.
    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.source_version).toBe(2);

    const intent = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(intent).not.toBeNull();
    expect(intent?.source_version).toBe(1);

    // A final job with the gate compatible again repairs the contract from
    // the canonical read: late truth converges back to FRESH.
    gateStatus = "compatible";
    await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("FRESH");
  });

  it("the commerce read model re-evaluates evidence freshness at the QUERY instant", async () => {
    const simulation = makeSimulation();
    await seedPlacedOrder(simulation);
    const { intentId } = await seedIntentAndContract(simulation);
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();

    // Link delivery evidence for the placed order at T0 (evidence is FRESH).
    const linked = await simulation.references.createReference(
      simulation.envelope(),
      { referenceId: REFERENCE_ID, subjectType: "order", subjectId: ORDER_ID },
    );
    expect(linked.deliveryEvidenceState).toBe("UNEVIDENCED");
    await simulation.references.linkDeliveryEvidence(simulation.envelope(), {
      referenceId: REFERENCE_ID,
      expectedRevision: linked.revision,
      canonicalResourceType: "connectivity_intent",
      canonicalResourceId: intentId,
    });

    // The committed read model, queried INSIDE the guarantee: FRESH.
    const recordAtFresh = await simulation.referenceStore.read.references.findById(
      USER_TENANT,
      REFERENCE_ID,
    );
    expect(recordAtFresh?.deliveryEvidenceState).toBe("EVIDENCED");
    expect(recordAtFresh?.evidence?.freshnessState).toBe("FRESH");

    // ...queried LATER (clock past fresh_until): the evidence freshness is
    // re-evaluated at the query instant - the read model presents STALE.
    simulation.clock.advanceBy(120_000);
    const { describeSubjectConnectivity } = await import("@roamlink/commerce-connectivity");
    const viewLate = describeSubjectConnectivity(
      { subjectType: "order", subjectId: ORDER_ID, commercialState: "placed" },
      await simulation.referenceStore.read.references.findById(USER_TENANT, REFERENCE_ID),
      simulation.clock.now(),
    );
    expect(viewLate.deliveryEvidenceState).toBe("EVIDENCED");
    expect(viewLate.evidence?.freshness.freshnessState).toBe("STALE");
    expect(viewLate.evidence?.freshness.recordedFreshnessState).toBe("FRESH"); // audit retained

    // A NEWER observation returns the view to FRESH: the reconciler first
    // repairs the projection from the canonical read (a fresh received_at
    // and a new freshness guarantee), THEN the relink snapshots it.
    await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    await simulation.references.linkDeliveryEvidence(simulation.envelope(), {
      referenceId: REFERENCE_ID,
      expectedRevision: recordAtFresh?.revision ?? 2,
      canonicalResourceType: "connectivity_intent",
      canonicalResourceId: intentId,
    });
    const viewRelinked = describeSubjectConnectivity(
      { subjectType: "order", subjectId: ORDER_ID, commercialState: "placed" },
      await simulation.referenceStore.read.references.findById(USER_TENANT, REFERENCE_ID),
      simulation.clock.now(),
    );
    expect(viewRelinked.evidence?.freshness.freshnessState).toBe("FRESH");
  });
});

/** Creates one intent + accepted-offer contract on the fake (2 events). */
async function seedIntentAndContract(simulation: Simulation): Promise<{
  readonly intentId: string;
  readonly contractId: string;
}> {
  const intentDocument = (await simulation.fake.createIntent(INTENT_REQUEST, {
    idempotencyKey: "idem-delay-intent" as never,
  })) as Record<string, unknown>;
  const intentId = intentDocument["id"] as string;
  const contractDocument = (await simulation.fake.acceptOffers(
    intentId,
    { offers: [], recorded_at: parseUtcInstant(T0) },
    { idempotencyKey: "idem-delay-offers" as never },
  )) as Record<string, unknown>;
  return { intentId, contractId: contractDocument["id"] as string };
}
