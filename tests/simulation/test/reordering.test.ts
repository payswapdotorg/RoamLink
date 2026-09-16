/**
 * RL-071 scenario: REORDERING - webhook events delivered out of order vs
 * projection application.
 *
 * ADCOS emits versioned events (v1, v2, ...). The transport delivers them
 * REVERSED. The architectural invariants:
 *  - no state REGRESSION: an event whose version is lower than the applied
 *    one is skipped (never un-applies newer truth);
 *  - CONVERGENCE: the final projection equals the in-order outcome;
 *  - no fabricated truth: the surviving projection is exactly the highest
 *    delivered version's event.
 */
import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import { T0, makeSimulation, type Simulation } from "../src/harness.js";

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

/** Creates one intent + accepted-offer contract + activation (3 events). */
async function emitVersionedEvents(simulation: Simulation): Promise<{
  readonly intentId: string;
  readonly contractId: string;
}> {
  const intentDocument = (await simulation.fake.createIntent(INTENT_REQUEST, {
    idempotencyKey: "idem-reorder-intent" as never,
  })) as Record<string, unknown>;
  const intentId = intentDocument["id"] as string;

  const contractDocument = (await simulation.fake.acceptOffers(
    intentId,
    { offers: [], recorded_at: parseUtcInstant(T0) },
    { idempotencyKey: "idem-reorder-offers" as never },
  )) as Record<string, unknown>;
  const contractId = contractDocument["id"] as string;

  await simulation.fake.activateContract(
    intentId,
    { activated_at: parseUtcInstant(T0), signature_refs: [] },
    { idempotencyKey: "idem-reorder-activate" as never },
  );
  return { intentId, contractId };
}

describe("RL-071 reordering: out-of-order webhook events vs projection application", () => {
  it("reversed delivery converges to the highest version; late older events never regress state", async () => {
    const simulation = makeSimulation();
    const { intentId, contractId } = await emitVersionedEvents(simulation);

    const emitted = simulation.fake.emittedEvents();
    expect(emitted.length).toBe(3);

    // The transport delivers everything REVERSED.
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "reverse", dropCount: 0, delayCount: 0 };
    const deliveries = simulation.fake.deliveries();
    expect(deliveries.length).toBe(3);

    // Admit + project in the (reversed) delivery order.
    await simulation.admitAndProject(deliveries);

    // The contract projection converged to the HIGHEST delivered version.
    const contract = await simulation.boundary.projections.get(
      "connectivity_contract",
      contractId,
    );
    expect(contract).not.toBeNull();
    expect(contract?.source_version).toBe(2); // activation bumped it to v2
    expect(contract?.freshness_state).toBe("FRESH");
    expect(contract?.evidence_class).toBe("AUTHENTICATED");

    // The intent projection holds its single event.
    const intent = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(intent?.source_version).toBe(1);

    // A LATE re-delivery of the OLDER contract event (v1) is skipped: no
    // regression, no duplicate write, no error.
    const olderEvent = emitted.find(
      (event) => event.event.resource_id === contractId && event.event.resource_version === 1,
    );
    expect(olderEvent).toBeDefined();
    const before = await simulation.boundary.projections.get("connectivity_contract", contractId);
    await simulation.admitAndProject();
    const after = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(after?.source_version).toBe(2);
    expect(after?.projection_version).toBe(before?.projection_version);
    expect(after?.event_id).toBe(before?.event_id);
  });

  it("reversed and in-order delivery produce the SAME final projections (convergence)", async () => {
    // World A: in-order delivery.
    const inOrder = makeSimulation();
    const worldA = await emitVersionedEvents(inOrder);
    inOrder.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await inOrder.admitAndProject();

    // World B: reversed delivery.
    const reversed = makeSimulation();
    const worldB = await emitVersionedEvents(reversed);
    reversed.fake.webhookDelivery = { duplicateFactor: 1, reorder: "reverse", dropCount: 0, delayCount: 0 };
    await reversed.admitAndProject();

    // Convergence: identical surviving truth. The write COUNTER may differ
    // (the reversed world skipped the outdated event instead of applying
    // it), but the surviving STATE - version, freshness, evidence, payload -
    // is exactly the same (modulo per-world resource ids in the payload).
    const a = await inOrder.boundary.projections.get("connectivity_contract", worldA.contractId);
    const b = await reversed.boundary.projections.get("connectivity_contract", worldB.contractId);
    expect(a?.source_version).toBe(b?.source_version);
    expect(a?.freshness_state).toBe(b?.freshness_state);
    expect(a?.evidence_class).toBe(b?.evidence_class);
    expect((a?.payload as Record<string, unknown>)["resource_version"]).toBe(
      (b?.payload as Record<string, unknown>)["resource_version"],
    );
    expect((a?.payload as Record<string, unknown>)["event_type"]).toBe(
      (b?.payload as Record<string, unknown>)["event_type"],
    );
  });

  it("out-of-order admission order cannot fabricate a newer truth than the source emitted", async () => {
    const simulation = makeSimulation();
    const { contractId } = await emitVersionedEvents(simulation);
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "reverse", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();

    // The canonical read is the authority: the projection's event id is one
    // of the events the source ACTUALLY emitted for this resource - never
    // an invented combination.
    const emitted = simulation.fake
      .emittedEvents()
      .filter((event) => event.event.resource_id === contractId)
      .map((event) => event.event.event_id);
    const projection = await simulation.boundary.projections.get(
      "connectivity_contract",
      contractId,
    );
    expect(emitted).toContain(projection?.event_id);
  });
});
