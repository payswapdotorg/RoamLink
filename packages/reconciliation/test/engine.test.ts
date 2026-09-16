/**
 * Engine lifecycle + classification units (RL-035).
 *
 * Proves the job orchestration shape (phases, deterministic ordering,
 * summaries), the closed scan classification, the closed failure
 * classification, and that a FRESH record inside its guarantee triggers NO
 * canonical I/O at all.
 */
import { describe, expect, it } from "vitest";
import { AdcosApiError } from "@roamlink/adcos";
import { AdcosTransportError } from "@roamlink/integration";
import { RateLimitedError, UnavailableError } from "@roamlink/contracts";
import { AdcosProjectionEngine, InMemoryProjectionStore } from "@roamlink/projections";
import { DeterministicClock } from "@roamlink/testkit";
import {
  classifyScanTarget,
  isCanonicalResourceAbsent,
  isTransientCanonicalFailure,
  unreachableCauseOf,
  DEFAULT_RECONCILER_ACTOR_ID,
} from "../src/index.js";
import { parseReconciliationPolicy } from "../src/policy.js";
import { makeHarness, createIntentOnFake, countingAdcosClient, mustGetProjection } from "./helpers.js";

describe("the closed failure classification (never invents kinds)", () => {
  it("classifies transient vs deterministic ADCOS errors by the pinned retryable flags", () => {
    expect(isTransientCanonicalFailure(new AdcosApiError("rate-limited", "x"))).toBe(true);
    expect(isTransientCanonicalFailure(new AdcosApiError("store-failed", "x"))).toBe(true);
    expect(isTransientCanonicalFailure(new AdcosApiError("invalid-input", "x"))).toBe(false);
    expect(isTransientCanonicalFailure(new AdcosApiError("route-unknown", "x"))).toBe(false);
    expect(isTransientCanonicalFailure(new AdcosApiError("version-unsupported", "x"))).toBe(false);
    expect(isTransientCanonicalFailure(new AdcosApiError("resource-unknown", "x"))).toBe(false);
  });

  it("classifies transport failures as retryable for reads (not-sent and unknown)", () => {
    expect(isTransientCanonicalFailure(new AdcosTransportError("not-sent", "x"))).toBe(true);
    expect(isTransientCanonicalFailure(new AdcosTransportError("unknown", "x"))).toBe(true);
  });

  it("honors the retryable flag of RoamLink errors", () => {
    expect(isTransientCanonicalFailure(new RateLimitedError("x"))).toBe(true);
    expect(isTransientCanonicalFailure(new UnavailableError("x"))).toBe(true);
    expect(isTransientCanonicalFailure(new Error("plain"))).toBe(false);
  });

  it("recognizes authoritative absence deterministically", () => {
    expect(isCanonicalResourceAbsent(new AdcosApiError("resource-unknown", "x"))).toBe(true);
    expect(isCanonicalResourceAbsent(new AdcosApiError("store-failed", "x"))).toBe(false);
    expect(isCanonicalResourceAbsent(new AdcosTransportError("unknown", "x"))).toBe(false);
  });

  it("maps failures onto the closed unreachable-cause vocabulary", () => {
    expect(unreachableCauseOf(new AdcosTransportError("not-sent", "x"))).toBe("TRANSPORT_UNAVAILABLE");
    expect(unreachableCauseOf(new AdcosTransportError("unknown", "x"))).toBe("TIMEOUT_OUTCOME_UNKNOWN");
    expect(unreachableCauseOf(new AdcosApiError("rate-limited", "x"))).toBe("PROBE_FAILED");
    expect(unreachableCauseOf(new Error("plain"))).toBe("PROBE_FAILED");
  });
});

describe("the scan classification (closed)", () => {
  const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
  const store = new InMemoryProjectionStore();
  const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
  const policy = parseReconciliationPolicy({
    maxCanonicalReadAttempts: 3,
    inboxBatchLimit: 50,
    refreshMarginMs: 10_000,
    discoveryEnabled: false,
  });
  const now = clock.now();

  it("a never-observed resource needs a refresh", async () => {
    expect(classifyScanTarget(null, now, policy)).toBe("NEEDS_REFRESH");
  });

  it("a FRESH record inside its guarantee (and margin) is CONSISTENT", async () => {
    await engine.projectCanonicalRead({
      resourceType: "connectivity_intent",
      resourceId: "intent-fresh",
      payload: { state: "INTENT" },
      observedAt: now,
    });
    const record = await store.get("connectivity_intent", "intent-fresh");
    expect(classifyScanTarget(record, now, policy)).toBe("CONSISTENT");
  });

  it("a FRESH record inside the refresh margin needs a proactive refresh", async () => {
    await engine.projectCanonicalRead({
      resourceType: "connectivity_intent",
      resourceId: "intent-margin",
      payload: { state: "INTENT" },
      observedAt: now,
    });
    const record = await store.get("connectivity_intent", "intent-margin");
    // 55s remain (60s TTL - 5s margin advance) - inside the 10s margin.
    clock.advanceBy(55_000);
    expect(classifyScanTarget(record, clock.now(), policy)).toBe("NEEDS_REFRESH");
  });

  it("STALE and UNKNOWN records need a refresh", async () => {
    const base = await store.get("connectivity_intent", "intent-fresh");
    if (base === null) throw new Error("test expected the seeded projection");
    const staleRecord: typeof base = { ...base, freshness_state: "STALE" };
    expect(classifyScanTarget(staleRecord, now, policy)).toBe("NEEDS_REFRESH");
    const unknownRecord: typeof base = { ...staleRecord, freshness_state: "UNKNOWN" };
    expect(classifyScanTarget(unknownRecord, now, policy)).toBe("NEEDS_REFRESH");
  });

  it("a payload/digest mismatch (torn write) is PARTIALLY_APPLIED and dominates freshness", async () => {
    const record = await store.get("connectivity_intent", "intent-fresh");
    if (record === null) throw new Error("test expected the seeded projection");
    const torn: typeof record = { ...record, payload_digest: "0".repeat(64) as never };
    expect(classifyScanTarget(torn, now, policy)).toBe("PARTIALLY_APPLIED");
  });
});

describe("the job orchestration shape", () => {
  it("runs the three phases in order and records a deterministic summary", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-engine-shape");
    await harness.admit(harness.fake.deliveries());

    const job = await harness.boundary.reconciler.runJob({ reason: "startup" });
    expect(job.status).toBe("COMPLETED");
    expect(job.trigger_reason).toBe("startup");
    expect(job.actor_id).toBe(DEFAULT_RECONCILER_ACTOR_ID);

    const types = job.actions.map((action) => action.action_type);
    expect(types.indexOf("FRESHNESS_SWEEP")).toBeLessThan(types.indexOf("INBOX_DRAIN"));
    const refreshes = job.actions.filter((action) => action.action_type === "CANONICAL_REFRESH");
    expect(types.indexOf("INBOX_DRAIN")).toBeLessThan(
      job.actions.findIndex((action) => action.action_type === "CANONICAL_REFRESH"),
    );
    expect(job.summary?.scanned).toBe(1);
    expect(job.summary?.repaired).toBe(1); // the inbox drain applied the event
    expect(job.summary?.alreadyConsistent).toBe(2); // the no-op sweep + the FRESH-scan verification
    expect(refreshes[0]?.resource_id).toBe(intentId);
    void refreshes;
  });

  it("scans targets in deterministic (type, id) order", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const clock = harness.clock;
    const engine = new AdcosProjectionEngine({
      writer: harness.store,
      reader: harness.store,
      clock,
    });
    // Seed tracked projections out of order.
    for (const [type, id] of [
      ["connectivity_lease", "lease-9"],
      ["connectivity_intent", "intent-2"],
      ["connectivity_contract", "contract-1"],
      ["connectivity_intent", "intent-1"],
    ] as const) {
      await engine.projectCanonicalRead({
        resourceType: type,
        resourceId: id,
        payload: { seeded: true },
        observedAt: clock.now(),
      });
    }
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const scanned = job.actions
      .filter((action) => action.action_type === "CANONICAL_REFRESH")
      .map((action) => `${action.resource_type}/${action.resource_id}`);
    expect(scanned).toEqual([
      "connectivity_contract/contract-1",
      "connectivity_intent/intent-1",
      "connectivity_intent/intent-2",
      "connectivity_lease/lease-9",
    ]);
  });

  it("a FRESH record inside its guarantee triggers ZERO canonical reads", async () => {
    const base = makeHarness({ policy: { discoveryEnabled: false } });
    const { client, reads } = countingAdcosClient(base.fake);
    const harness = makeHarness({ client, policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-engine-noio");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" }); // projects + fetches once

    reads.count = 0;
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(reads.count).toBe(0); // the guarantee is still valid: no I/O
    const action = job.actions.find(
      (candidate) => candidate.action_type === "CANONICAL_REFRESH" && candidate.resource_id === intentId,
    );
    expect(action?.outcome).toBe("ALREADY_CONSISTENT");
    expect(action?.detail).toContain("FRESHNESS_GUARANTEE_VALID");
    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.freshness_state).toBe("FRESH");
  });

  it("validates the policy (closed, bounded knobs)", () => {
    expect(() =>
      parseReconciliationPolicy({
        maxCanonicalReadAttempts: 0,
        inboxBatchLimit: 10,
        refreshMarginMs: 0,
        discoveryEnabled: true,
      }),
    ).toThrow();
    expect(() =>
      parseReconciliationPolicy({
        maxCanonicalReadAttempts: 99,
        inboxBatchLimit: 10,
        refreshMarginMs: 0,
        discoveryEnabled: true,
      }),
    ).toThrow();
    expect(() =>
      parseReconciliationPolicy({
        maxCanonicalReadAttempts: 3,
        inboxBatchLimit: 0,
        refreshMarginMs: 0,
        discoveryEnabled: true,
      }),
    ).toThrow();
    expect(() =>
      parseReconciliationPolicy({
        maxCanonicalReadAttempts: 3,
        inboxBatchLimit: 10,
        refreshMarginMs: -1,
        discoveryEnabled: true,
      }),
    ).toThrow();
  });
});
