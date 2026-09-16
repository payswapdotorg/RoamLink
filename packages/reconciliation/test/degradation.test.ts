/**
 * STALE/UNKNOWN degradation when canonical truth is unreachable (RL-035,
 * spec §7: "When canonical truth cannot be obtained, the state becomes STALE
 * or UNKNOWN; the system does not guess" - RL-LOCK-010).
 */
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseRevision } from "@roamlink/contracts";
import {
  makeHarness,
  mustGetProjection,
  createIntentOnFake,
  fixedGate,
  countingAdcosClient,
} from "./helpers.js";
import type { ReconciliationJobRecord } from "../src/job-record.js";

function refreshActionOf(job: ReconciliationJobRecord, resourceId: string) {
  const found = job.actions.find(
    (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === resourceId,
  );
  if (found === undefined) {
    throw new Error(`test expected a CANONICAL_REFRESH action for ${resourceId}`);
  }
  return found;
}

describe("degradation: never guess when truth is unreachable", () => {
  it("a never-observed resource stays ABSENT (absence is the unknown state) - DEFERRED", async () => {
    const harness = makeHarness({
      policy: { maxCanonicalReadAttempts: 2 },
      discovery: {
        discover: async () => ({
          resources: [{ resource_type: "connectivity_intent" as const, resource_id: "intent-ghost" }],
          routeFailures: [],
        }),
      },
    });
    harness.fake.failNext({ kind: "adcos-error", code: "store-failed" }, { count: 5 });

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job.status).toBe("COMPLETED");
    const action = refreshActionOf(job, "intent-ghost");
    expect(action.outcome).toBe("DEFERRED");
    expect(action.detail).toContain("NEVER_OBSERVED");
    expect(action.attempts).toBe(2);
    // No record was invented: the absence IS the unknown state.
    expect(await harness.boundary.projections.get("connectivity_intent", "intent-ghost")).toBeNull();
  });

  it("an already-degraded record is not re-degraded (no version churn) - DEFERRED", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-degrade-churn");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    harness.clock.advanceBy(61_000); // TTL expiry -> sweep will degrade
    harness.fake.failNext({ kind: "adcos-error", code: "rate-limited" }, { count: 3 });

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("DEFERRED");
    expect(action.detail).toContain("PRIOR_STATE_ALREADY_STALE");
    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("STALE"); // degraded once (by the sweep)
    // The sweep's STALE transition is the ONLY write: no markStale churn.
    expect(record.projection_version).toBe(2);
  });

  it("a FRESH record whose renewal fails deterministically degrades to STALE, payload retained", async () => {
    const harness = makeHarness({
      policy: { maxCanonicalReadAttempts: 2, refreshMarginMs: 120_000, discoveryEnabled: false },
    });
    const intentId = await createIntentOnFake(harness, "idem-degrade-deterministic");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    harness.fake.disableRoute("intent_get"); // route-unknown: deterministic
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("DEGRADED_STALE");
    expect(action.detail).toContain("route-unknown");
    expect(action.attempts).toBe(1); // deterministic failures do not retry

    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("STALE");
    expect(record.evidence_class).toBe("STALE");
    expect((record.payload as Record<string, unknown>)["event_id"]).toBe("evt-1"); // prior truth retained
  });

  it("a partially applied record that cannot be repaired degrades to UNKNOWN", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-degrade-unknown");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    const source = await mustGetProjection(harness, "connectivity_intent", intentId);
    await harness.store.apply(
      {
        ...source,
        payload_digest: canonicalJsonDigest({ torn: true }),
        projection_version: parseRevision(source.projection_version + 1),
      },
      source.projection_version,
    );

    harness.fake.failNext({ kind: "adcos-error", code: "store-failed" }, { count: 5 });
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("DEGRADED_UNKNOWN");
    expect(action.detail).toContain("PARTIAL_APPLICATION_UNREPAIRABLE");

    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("UNKNOWN");
    expect(record.evidence_class).toBe("UNKNOWN");
    expect(record.fresh_until).toBeNull(); // no freshness guarantee is claimed
    // The (corrupt) payload is retained for diagnostics - never destroyed.
    expect(record.payload).toBeDefined();
  });

  it("the authority reporting the resource GONE is canonical absence, not degradation", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-degrade-absent");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    harness.fake.forgetResource("connectivity_intent", intentId);
    harness.clock.advanceBy(61_000); // force a refresh attempt

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("CANONICAL_ABSENT");
    expect(action.detail).toContain("AUTHORITY_REPORTS_RESOURCE_UNKNOWN");

    // The prior payload is retained as historical evidence; the sweep's STALE
    // transition is the only mutation (nothing is guessed, nothing destroyed).
    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("STALE");
    expect((record.payload as Record<string, unknown>)["event_id"]).toBe("evt-1");
    expect(record.projection_version).toBe(2); // event apply + sweep only
  });
});

describe("degradation: the compatibility gate closes canonical fetches (fail-closed)", () => {
  it("an INCOMPATIBLE gate defers fetches entirely - zero canonical reads, local sweep still runs", async () => {
    const base = makeHarness();
    const { client, reads } = countingAdcosClient(base.fake);
    const harness = makeHarness({
      client,
      compatibility: fixedGate("incompatible"),
      policy: { discoveryEnabled: false },
    });
    const intentId = await createIntentOnFake(harness, "idem-gate-closed");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    harness.clock.advanceBy(61_000);
    reads.count = 0;
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("DEFERRED");
    expect(action.detail).toContain("COMPATIBILITY_GATE_INCOMPATIBLE");
    expect(reads.count).toBe(0); // no canonical I/O through a closed gate

    // Local degradation (the sweep) still happens honestly.
    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("STALE");
  });

  it("an UNVERIFIED (unknown) gate equally defers fetches", async () => {
    const harness = makeHarness({
      compatibility: fixedGate("unknown"),
      policy: { discoveryEnabled: false },
    });
    const intentId = await createIntentOnFake(harness, "idem-gate-unknown");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    harness.clock.advanceBy(61_000);

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("DEFERRED");
    expect(action.detail).toContain("COMPATIBILITY_GATE_UNKNOWN");
  });
});

describe("degradation: discovery failures are visible but never block the tracked scan", () => {
  it("failing discovery routes record DEFERRED DISCOVERY actions; tracked resources still reconcile", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-discovery-fail");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" }); // tracked now

    harness.fake.disableRoute("intent_list"); // discovery route gone
    harness.clock.advanceBy(61_000);
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    const discoveryFailures = job.actions.filter(
      (action) => action.action_type === "DISCOVERY" && action.outcome === "DEFERRED",
    );
    expect(discoveryFailures.length).toBe(1);
    expect(discoveryFailures[0]?.detail).toContain("intent_list");

    // The tracked resource still refreshed through its (working) read route.
    const action = refreshActionOf(job, intentId);
    expect(action.outcome).toBe("REPAIRED");
    expect(action.detail).toContain("FRESHNESS_RENEWED");
  });

  it("a totally failing discovery records one DEFERRED action and the scan proceeds on tracked records", async () => {
    const harness = makeHarness({
      discovery: {
        discover: async () => {
          throw new Error("total discovery failure");
        },
      },
    });
    const intentId = await createIntentOnFake(harness, "idem-discovery-total");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    harness.clock.advanceBy(61_000);

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const discoveryFailures = job.actions.filter(
      (action) => action.action_type === "DISCOVERY" && action.outcome === "DEFERRED",
    );
    expect(discoveryFailures.length).toBe(1);
    expect(discoveryFailures[0]?.detail).toContain("DISCOVERY_FAILED");
    expect(refreshActionOf(job, intentId).outcome).toBe("REPAIRED");
  });
});
