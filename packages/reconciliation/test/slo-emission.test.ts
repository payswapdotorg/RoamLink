/**
 * §11 SLO emission from reconciliation outcomes (additive RL-052 wiring):
 * the completed job's durable actions become successful-automatic-recovery,
 * stale/unknown-state-duration and manual-intervention measurements through
 * the structural observer port — with the SAME behavior when no observer is
 * wired (the port is optional and side-effect-free by construction).
 *
 * The observer here is an in-memory recording adapter implementing the same
 * method shapes the `@roamlink/observability` product-SLO recorder exports;
 * the dogfood/load suites wire the REAL recorder through this same port.
 */
import { describe, expect, it } from "vitest";
import { epochMsOf, parseUtcInstant } from "@roamlink/contracts";

import { makeHarness, createIntentOnFake } from "./helpers.js";
import {
  closedStaleWindowMs,
  degradedForMsAt,
  emitReconciliationSloEvents,
  type ReconciliationSloObserver,
} from "../src/slo-emission.js";
import type { ReconciliationJobRecord } from "../src/job-record.js";

const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";

/** An in-memory recording observer (mirrors the observability recorder shapes). */
class RecordingObserver implements ReconciliationSloObserver {
  readonly recoveries: { succeeded: boolean; tenantId: string; at: string }[] = [];
  readonly staleDurations: {
    durationMs: number;
    freshnessState: "stale" | "unknown";
    tenantId: string;
  }[] = [];
  readonly manualInterventions: { tenantId: string; at?: string }[] = [];

  recordSuccessfulAutomaticRecovery(input: {
    succeeded: boolean;
    tenantId: string;
    at?: string;
  }): void {
    this.recoveries.push({
      succeeded: input.succeeded,
      tenantId: input.tenantId,
      at: input.at ?? "",
    });
  }

  recordStaleUnknownStateDuration(input: {
    durationMs: number;
    freshnessState: "stale" | "unknown";
    tenantId: string;
  }): void {
    this.staleDurations.push({
      durationMs: input.durationMs,
      freshnessState: input.freshnessState,
      tenantId: input.tenantId,
    });
  }

  recordManualIntervention(input: { tenantId: string; at?: string }): void {
    this.manualInterventions.push({
      tenantId: input.tenantId,
      ...(input.at !== undefined ? { at: input.at } : {}),
    });
  }
}

function refreshActionsOf(job: ReconciliationJobRecord) {
  return job.actions.filter((action) => action.action_type === "CANONICAL_REFRESH");
}

describe("emitReconciliationSloEvents — the durable-action mapping", () => {
  it("maps a freshness-renewal REPAIR to a good recovery AND the closed stale window", async () => {
    const observer = new RecordingObserver();
    const harness = makeHarness({
      policy: { discoveryEnabled: false },
      sloObserver: observer,
    });
    await createIntentOnFake(harness, "idem-slo-repaired");
    await harness.admit(harness.fake.deliveries());
    // Job 1 projects the event (FRESH guarantee, 60s TTL).
    const first = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(refreshActionsOf(first).every((action) => action.outcome === "ALREADY_CONSISTENT")).toBe(
      true,
    );
    expect(observer.recoveries).toHaveLength(0);

    // 61s later the guarantee expired by exactly 1s: the sweep degrades to
    // STALE and the scan's canonical read RENEWS the guarantee (REPAIRED).
    harness.clock.advanceBy(61_000);
    const second = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const renewed = refreshActionsOf(second).find((action) => action.outcome === "REPAIRED");
    expect(renewed).toBeDefined();
    expect(renewed?.detail).toContain("FRESHNESS_RENEWED");

    // The closed stale window (1s) is stamped into the DURABLE action metrics
    // and emitted verbatim — measured from the record's own fresh_until.
    expect(renewed?.metrics).toMatchObject({ staleForMs: 1_000, staleState: "STALE" });
    expect(observer.recoveries).toEqual([
      { succeeded: true, tenantId: PLATFORM_TENANT, at: renewed?.attempted_at ?? "" },
    ]);
    expect(observer.staleDurations).toEqual([
      { durationMs: 1_000, freshnessState: "stale", tenantId: PLATFORM_TENANT },
    ]);
    expect(observer.manualInterventions).toHaveLength(0);
  });

  it("maps DEGRADED_STALE to a failed recovery AND the degradation age (usually 0 — honest)", async () => {
    const observer = new RecordingObserver();
    const harness = makeHarness({
      policy: { maxCanonicalReadAttempts: 2, refreshMarginMs: 120_000, discoveryEnabled: false },
      sloObserver: observer,
    });
    await createIntentOnFake(harness, "idem-slo-degraded");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    // Renewal-margin expiry + deterministic canonical failure: the loop
    // degrades to STALE while the guarantee is STILL VALID (age 0 — the
    // loop never pretends the truth had been unguaranteed longer than it was).
    harness.fake.disableRoute("intent_get");
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const degraded = refreshActionsOf(job).find((action) => action.outcome === "DEGRADED_STALE");
    expect(degraded).toBeDefined();
    expect(degraded?.metrics).toMatchObject({ degradedForMs: 0 });

    expect(observer.recoveries).toEqual([
      { succeeded: false, tenantId: PLATFORM_TENANT, at: degraded?.attempted_at ?? "" },
    ]);
    expect(observer.staleDurations).toEqual([
      { durationMs: 0, freshnessState: "stale", tenantId: PLATFORM_TENANT },
    ]);
  });

  it("maps a manually-triggered job to one manual intervention", async () => {
    const observer = new RecordingObserver();
    const harness = makeHarness({ policy: { discoveryEnabled: false }, sloObserver: observer });
    await createIntentOnFake(harness, "idem-slo-manual");

    const job = await harness.boundary.reconciler.runJob({ reason: "manual" });
    expect(job.trigger_reason).toBe("manual");
    expect(observer.manualInterventions).toEqual([
      { tenantId: PLATFORM_TENANT, at: job.completed_at ?? undefined },
    ]);

    // A SCHEDULED job of the same shape emits no manual intervention.
    observer.manualInterventions.length = 0;
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(observer.manualInterventions).toHaveLength(0);
  });

  it("emits nothing for non-attempt outcomes (ALREADY_CONSISTENT / DEFERRED / CANONICAL_ABSENT)", async () => {
    const observer = new RecordingObserver();
    const harness = makeHarness({ policy: { discoveryEnabled: false }, sloObserver: observer });
    await createIntentOnFake(harness, "idem-slo-consistent");

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(refreshActionsOf(job).every((action) => action.outcome === "ALREADY_CONSISTENT")).toBe(
      true,
    );
    expect(observer.recoveries).toHaveLength(0);
    expect(observer.staleDurations).toHaveLength(0);
  });

  it("double-emits nothing on idempotent job replays (the recorded outcome stands)", async () => {
    const observer = new RecordingObserver();
    const harness = makeHarness({
      policy: { discoveryEnabled: false },
      sloObserver: observer,
    });
    await createIntentOnFake(harness, "idem-slo-replay");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    harness.clock.advanceBy(61_000);

    const first = await harness.boundary.reconciler.runJob({
      reason: "scheduled",
      jobId: "00000000-0000-4000-8000-0000000000f1",
      correlationId: "corr-slo-replay",
    });
    const replay = await harness.boundary.reconciler.runJob({
      reason: "scheduled",
      jobId: "00000000-0000-4000-8000-0000000000f1",
      correlationId: "corr-slo-replay",
    });
    expect(replay.job_id).toBe(first.job_id);
    // Exactly one good recovery + one closed-window duration for the single
    // REPAIRED action - the replay returned the recorded outcome and
    // re-emitted NOTHING.
    const repaired = refreshActionsOf(first).filter((action) => action.outcome === "REPAIRED");
    expect(repaired).toHaveLength(1);
    expect(observer.recoveries).toEqual([
      { succeeded: true, tenantId: PLATFORM_TENANT, at: repaired[0]?.attempted_at ?? "" },
    ]);
    expect(observer.staleDurations).toHaveLength(1);
  });

  it("is identical engine behavior WITHOUT an observer (optional port)", async () => {
    const withObserver = makeHarness({ policy: { discoveryEnabled: false } });
    const withoutObserver = makeHarness({ policy: { discoveryEnabled: false } });
    const outcomes: string[][] = [];
    for (const harness of [withObserver, withoutObserver]) {
      await createIntentOnFake(harness, "idem-slo-no-observer");
      await harness.admit(harness.fake.deliveries());
      await harness.boundary.reconciler.runJob({ reason: "scheduled" });
      harness.clock.advanceBy(61_000);
      const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
      expect(job.status).toBe("COMPLETED");
      outcomes.push(refreshActionsOf(job).map((action) => action.outcome));
      const renewed = refreshActionsOf(job).find((action) => action.outcome === "REPAIRED");
      expect(renewed?.metrics).toMatchObject({ staleForMs: 1_000, staleState: "STALE" });
    }
    // The durable repair outcomes (and their stamped metrics) are IDENTICAL
    // with and without the observer wired.
    expect(outcomes[0]).toEqual(outcomes[1]);
  });
});

describe("degradedForMsAt / closedStaleWindowMs — the freshness math", () => {
  const at = parseUtcInstant("2026-01-15T09:00:00.000Z");

  it("measures the age past the expired guarantee (STALE decay)", () => {
    expect(
      degradedForMsAt(
        {
          freshness_state: "FRESH",
          fresh_until: parseUtcInstant("2026-01-15T08:59:30.000Z"),
          observed_at: parseUtcInstant("2026-01-15T08:00:00.000Z"),
        },
        at,
        epochMsOf,
      ),
    ).toBe(30_000);
  });

  it("falls back to observed_at when the guarantee is absent and never goes negative", () => {
    expect(
      degradedForMsAt(
        { freshness_state: "UNKNOWN", fresh_until: null, observed_at: parseUtcInstant("2026-01-15T08:30:00.000Z") },
        at,
        epochMsOf,
      ),
    ).toBe(1_800_000);
    expect(
      degradedForMsAt(
        {
          freshness_state: "FRESH",
          fresh_until: parseUtcInstant("2026-01-15T10:00:00.000Z"),
          observed_at: null,
        },
        at,
        epochMsOf,
      ),
    ).toBe(0);
    expect(
      degradedForMsAt({ freshness_state: "UNKNOWN", fresh_until: null, observed_at: null }, at, epochMsOf),
    ).toBe(0);
  });

  it("computes the closed stale/unknown window only for pre-repair STALE/UNKNOWN records", () => {
    expect(
      closedStaleWindowMs(
        {
          freshness_state: "STALE",
          fresh_until: parseUtcInstant("2026-01-15T08:59:00.000Z"),
          observed_at: parseUtcInstant("2026-01-15T08:00:00.000Z"),
        },
        at,
        epochMsOf,
      ),
    ).toEqual({ durationMs: 60_000, staleState: "stale" });
    expect(
      closedStaleWindowMs(
        {
          freshness_state: "UNKNOWN",
          fresh_until: null,
          observed_at: parseUtcInstant("2026-01-15T08:30:00.000Z"),
        },
        at,
        epochMsOf,
      ),
    ).toEqual({ durationMs: 1_800_000, staleState: "unknown" });
    // A FRESH record (renewal) closes no stale window; no record, no window.
    expect(
      closedStaleWindowMs(
        {
          freshness_state: "FRESH",
          fresh_until: parseUtcInstant("2026-01-15T08:59:00.000Z"),
          observed_at: parseUtcInstant("2026-01-15T08:00:00.000Z"),
        },
        at,
        epochMsOf,
      ),
    ).toBeNull();
    expect(closedStaleWindowMs(null, at, epochMsOf)).toBeNull();
    // Never negative.
    expect(
      closedStaleWindowMs(
        {
          freshness_state: "STALE",
          fresh_until: parseUtcInstant("2026-01-15T10:00:00.000Z"),
          observed_at: null,
        },
        at,
        epochMsOf,
      ),
    ).toEqual({ durationMs: 0, staleState: "stale" });
  });
});

describe("emitReconciliationSloEvents — validation", () => {
  it("requires an observer", () => {
    const job = {
      trigger_reason: "scheduled",
      tenant_id: PLATFORM_TENANT,
      completed_at: null,
      actions: [],
    } as unknown as ReconciliationJobRecord;
    expect(() =>
      emitReconciliationSloEvents(null as unknown as ReconciliationSloObserver, job),
    ).toThrow(/ReconciliationSloObserver/);
  });
});
