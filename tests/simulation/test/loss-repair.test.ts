/**
 * RL-071 scenario: LOSS - dropped events and silent canonical changes,
 * repaired by the reconciler.
 *
 * ADCOS changes canonical state WITHOUT emitting an event (or the event is
 * dropped by the transport). The architectural invariants:
 *  - the projection does not silently diverge forever: the reconciler's
 *    canonical scan compares freshness against the canonical resource and
 *    REPAIRS the projection from the authoritative read;
 *  - the repair is HONEST: the repaired payload is the canonical document
 *    (its digest matches), freshness is re-established, provenance is
 *    AUTHENTICATED - never a guess;
 *  - a NEVER-delivered resource is discovered and projected (missed
 *    webhooks), not invented.
 */
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseUtcInstant } from "@roamlink/contracts";
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

describe("RL-071 loss: dropped events -> reconciler repair (no fabricated truth)", () => {
  it("a SILENT canonical change (no event) is repaired from the canonical read after freshness decays", async () => {
    const simulation = makeSimulation();
    const { intentId, contractId } = await seedIntentAndContract(simulation);

    // The event for the accepted-offer contract was delivered + projected.
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();
    let projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.source_version).toBe(1);
    expect(projection?.freshness_state).toBe("FRESH");

    // ADCOS now changes canonical state SILENTLY (no event at all).
    await simulation.fake.silentStateChange(contractId, "CONTRACT_ACTIVE");

    // Nothing new is deliverable; the inbox has nothing to admit.
    expect(simulation.fake.deliveries().length).toBe(2); // the two original events

    // Inside the freshness guarantee the reconciler sees CONSISTENT (the
    // projection is still fresh): no repair is fabricated.
    const earlyJob = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const earlyRefresh = earlyJob.actions.filter((action) => action.action_type === "CANONICAL_REFRESH");
    expect(earlyRefresh.every((action) => action.outcome === "ALREADY_CONSISTENT")).toBe(true);

    // Time passes: the freshness guarantee EXPIRES (default 60s TTL).
    simulation.clock.advanceBy(120_000);

    // The reconciler now finds the projection NEEDS_REFRESH and repairs it
    // from the CANONICAL READ (the authority's current truth).
    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const repair = job.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    expect(repair?.outcome).toBe("REPAIRED");

    projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection).not.toBeNull();
    // The honest repair: canonical document payload, digest matches, fresh.
    const canonical = await simulation.fake.getContract(contractId as never);
    expect(projection?.payload).toEqual(canonical);
    expect(projection?.payload_digest).toBe(canonicalJsonDigest(canonical));
    expect(projection?.source_version).toBe(2); // the silent change bumped it
    expect(projection?.freshness_state).toBe("FRESH");
    expect(projection?.evidence_class).toBe("AUTHENTICATED");
    expect(projection?.received_at).toBe(simulation.clock.now());

    // The intent projection was also swept: FRESH inside its guarantee.
    const intent = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(intent?.freshness_state).toBe("FRESH");
  });

  it("a DROPPED event leaves no permanent gap: discovery + canonical scan project the resource", async () => {
    const simulation = makeSimulation();
    const { intentId, contractId } = await seedIntentAndContract(simulation);

    // The transport DROPS the first event entirely (the intent event is
    // lost; only the contract event arrives).
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 1, delayCount: 0 };
    const deliveries = simulation.fake.deliveries();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.event.resource_id).toBe(contractId);

    await simulation.admitAndProject(deliveries);

    // The intent projection does NOT exist yet: absence, not a guess.
    expect(await simulation.boundary.projections.get("connectivity_intent", intentId)).toBeNull();

    // The reconciler's discovery walks the canonical list routes, finds the
    // never-observed intent, and repairs it from the canonical read.
    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const intentRepair = job.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === intentId,
    );
    expect(intentRepair?.outcome).toBe("REPAIRED");

    const intent = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(intent).not.toBeNull();
    const canonicalIntent = await simulation.fake.getIntent(intentId as never);
    expect(intent?.payload).toEqual(canonicalIntent);
    expect(intent?.freshness_state).toBe("FRESH");
  });

  it("a transient canonical-read failure defers honestly (STALE/UNKNOWN, never a guess)", async () => {
    const simulation = makeSimulation();
    const { contractId } = await seedIntentAndContract(simulation);
    simulation.fake.webhookDelivery = { duplicateFactor: 1, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.admitAndProject();

    // Freshness expires; then EVERY canonical read attempt fails transiently.
    simulation.clock.advanceBy(120_000);
    simulation.fake.failNext({ kind: "transport", outcome: "not-sent" }, { count: 10 });

    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const contractAction = job.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    // The repair is DEFERRED (truth unreachable), not fabricated.
    expect(contractAction?.outcome).toBe("DEFERRED");

    // The projection degraded to STALE - the known prior state, retained.
    const projection = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("STALE");
    expect(projection?.payload).toBeDefined(); // prior state retained

    // When the transport recovers, the NEXT job repairs from the authority.
    const repaired = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    const repair = repaired.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    expect(repair?.outcome).toBe("REPAIRED");
    const after = await simulation.boundary.projections.get("connectivity_contract", contractId);
    expect(after?.freshness_state).toBe("FRESH");
  });
});

/** Creates one intent + accepted-offer contract on the fake (2 events). */
async function seedIntentAndContract(simulation: Simulation): Promise<{
  readonly intentId: string;
  readonly contractId: string;
}> {
  const intentDocument = (await simulation.fake.createIntent(INTENT_REQUEST, {
    idempotencyKey: "idem-loss-intent" as never,
  })) as Record<string, unknown>;
  const intentId = intentDocument["id"] as string;

  const contractDocument = (await simulation.fake.acceptOffers(
    intentId,
    { offers: [], recorded_at: parseUtcInstant(T0) },
    { idempotencyKey: "idem-loss-offers" as never },
  )) as Record<string, unknown>;
  return { intentId, contractId: contractDocument["id"] as string };
}
