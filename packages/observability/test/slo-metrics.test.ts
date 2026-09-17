/**
 * RL-052 §11 SLO instrumentation tests: the nine product SLOs of
 * spec/architecture.md §11 as named metric definitions + the typed recorder
 * emitting through the REAL metrics/SLO-event ports, composing with the
 * burn-rate machinery. Deterministic throughout (testkit clock).
 */
import { describe, expect, it } from "vitest";

import { DeterministicClock, fixtureUtcInstant } from "@roamlink/testkit";

import {
  MetricRegistry,
  createMetricsRecorder,
  type InMemoryMetrics,
  type MetricSample,
} from "../src/metrics/metrics.js";
import { SloEventRecorder } from "../src/slo/slo.js";
import {
  CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC,
  INTENT_SATISFACTION_RATE_METRIC,
  MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
  MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC,
  PRODUCT_SLO_IDS,
  PRODUCT_SLO_METRICS,
  PRODUCT_SLO_OBJECTIVE_NAMES,
  PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC,
  STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
  SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
  SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
  TIME_TO_USABLE_CONNECTIVITY_MS_METRIC,
  createProductSloRecorder,
  evaluateProductSlo,
  isProductSloId,
  makeProductSloObjective,
  objectiveNameOf,
  parseProductSloId,
  registerProductSloMetrics,
  type ProductSloRecorder,
} from "../src/slo/slo-metrics.js";

const T0 = fixtureUtcInstant();
const TENANT = "org:00000000-0000-4000-8000-000000000001";

/** Samples recorded under one metric name (any labels). */
function samplesOf(metrics: InMemoryMetrics, name: string): readonly MetricSample[] {
  return metrics.samples().filter((sample) => sample.name === name);
}

/** Builds a real recorder over the real ports with the deterministic clock. */
function makeRecorder(thresholds?: Parameters<typeof createProductSloRecorder>[1]): {
  recorder: ProductSloRecorder;
  metrics: InMemoryMetrics;
  events: SloEventRecorder;
  clock: DeterministicClock;
} {
  const registry = new MetricRegistry();
  registerProductSloMetrics(registry);
  const metrics = createMetricsRecorder(registry);
  const events = new SloEventRecorder();
  const clock = new DeterministicClock(T0);
  const recorder = createProductSloRecorder(
    { metrics, events, now: () => clock.now() },
    thresholds,
  );
  return { recorder, metrics, events, clock };
}

describe("§11 SLO vocabulary", () => {
  it("is exactly the nine frozen spec phrases as slugs", () => {
    expect([...PRODUCT_SLO_IDS]).toEqual([
      "time-to-usable-connectivity",
      "minutes-without-usable-connectivity",
      "manual-interventions-per-session-day",
      "successful-automatic-recovery-rate",
      "intent-satisfaction-rate",
      "connectivity-cost-per-useful-hour-gb-where-available",
      "stale-unknown-state-duration",
      "provider-access-failover-success",
      "support-incidents-attributable-to-connectivity-orchestration",
    ]);
  });

  it("parses members and rejects foreign ids fail-closed", () => {
    expect(isProductSloId("intent-satisfaction-rate")).toBe(true);
    expect(isProductSloId("intent-satisfaction")).toBe(false);
    expect(() => parseProductSloId("made-up-slo")).toThrow(/nine §11 product SLO ids/);
  });

  it("maps every id to a distinct health-label-compatible objective name", () => {
    const names = PRODUCT_SLO_IDS.map((id) => objectiveNameOf(id));
    expect(new Set(names).size).toBe(9);
    for (const name of names) {
      expect(name).toMatch(/^slo\.[a-z][a-z0-9.-]{0,62}$/);
    }
    expect(objectiveNameOf("support-incidents-attributable-to-connectivity-orchestration")).toBe(
      PRODUCT_SLO_OBJECTIVE_NAMES.supportIncidentsAttributableToConnectivityOrchestration,
    );
  });

  it("builds typed objectives pinned to the objective names", () => {
    const objective = makeProductSloObjective("provider-access-failover-success", {
      targetRatio: 0.99,
      windowMs: 3_600_000,
    });
    expect(objective.name).toBe("slo.provider-access-failover-success");
    expect(Object.isFrozen(objective)).toBe(true);
    expect(() =>
      makeProductSloObjective("time-to-usable-connectivity", {
        targetRatio: 0,
        windowMs: 60_000,
      }),
    ).toThrow(/targetRatio/);
  });
});

describe("§11 SLO metric definitions", () => {
  it("registers nine slug-named metrics idempotently", () => {
    const registry = new MetricRegistry();
    registerProductSloMetrics(registry);
    expect(registry.size).toBe(9);
    registerProductSloMetrics(registry); // idempotent re-registration
    expect(registry.size).toBe(9);
    expect(PRODUCT_SLO_METRICS).toHaveLength(9);
    for (const definition of PRODUCT_SLO_METRICS) {
      expect(definition.name).toMatch(/^roamlink_slo_[a-z0-9_]+$/);
      expect(definition.help.length).toBeGreaterThan(0);
    }
  });

  it("uses the closed, secret-free label vocabularies", () => {
    const labelNames = PRODUCT_SLO_METRICS.flatMap((definition) => [...definition.labelNames]);
    expect(labelNames).toContain("tenant_id");
    expect(labelNames).toContain("outcome");
    expect(labelNames).toContain("freshness_state");
    expect(labelNames).toContain("unit");
    expect(labelNames.every((label) => !/secret|token|password|credential/i.test(label))).toBe(
      true,
    );
  });
});

describe("§11 SLO recorder — measurements through the real ports", () => {
  it("records time to usable connectivity (histogram + threshold-classified event)", () => {
    const { recorder, metrics, events } = makeRecorder({
      timeToUsableConnectivityMs: 120_000,
    });
    recorder.recordTimeToUsableConnectivity({ tenantId: TENANT, durationMs: 90_000 });
    recorder.recordTimeToUsableConnectivity({ tenantId: TENANT, durationMs: 300_000 });

    const samples = samplesOf(metrics, TIME_TO_USABLE_CONNECTIVITY_MS_METRIC);
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.kind)).toEqual(["histogram", "histogram"]);
    expect(
      samples.every((sample) => (sample.labels as Record<string, unknown>)['tenant_id'] === TENANT),
    ).toBe(true);

    const evaluation = evaluateProductSlo(recorder, "time-to-usable-connectivity", {
      targetRatio: 0.5,
      windowMs: 3_600_000,
    });
    expect(evaluation.good).toBe(1);
    expect(evaluation.bad).toBe(1);
    expect(evaluation.state).toBe("exhausted");
    expect(events.events()).toHaveLength(2);
  });

  it("measures durations WITHOUT classification when no threshold is configured", () => {
    const { recorder, metrics, events } = makeRecorder();
    recorder.recordMinutesWithoutUsableConnectivity({ tenantId: TENANT, minutes: 12.5 });
    recorder.recordStaleUnknownStateDuration({
      tenantId: TENANT,
      durationMs: 45_000,
      freshnessState: "stale",
    });
    expect(samplesOf(metrics, MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC)).toHaveLength(1);
    expect(samplesOf(metrics, STALE_UNKNOWN_STATE_DURATION_MS_METRIC)).toHaveLength(1);
    // Honest: measured but not budgeted — no invented good/bad classification.
    expect(events.events()).toHaveLength(0);
  });

  it("counts manual interventions and support incidents (counters, threshold-classified)", () => {
    const { recorder, metrics } = makeRecorder({
      manualInterventionsPerSessionDay: 2,
      supportIncidentsPerDay: 1,
    });
    recorder.recordManualIntervention({ tenantId: TENANT });
    recorder.recordManualIntervention({ tenantId: TENANT, count: 2 });
    recorder.recordSupportIncidentAttributable({ tenantId: TENANT });

    const manual = samplesOf(metrics, MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC);
    expect(manual.map((sample) => (sample as { delta: number }).delta)).toEqual([1, 2]);
    const incidents = samplesOf(
      metrics,
      SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
    );
    expect(incidents.map((sample) => (sample as { delta: number }).delta)).toEqual([1]);

    const manualSlo = evaluateProductSlo(recorder, "manual-interventions-per-session-day", {
      targetRatio: 0.5,
      windowMs: 3_600_000,
    });
    expect(manualSlo.total).toBe(2); // 1 good (single) + 1 bad (count 2 > threshold)
    const incidentsSlo = evaluateProductSlo(
      recorder,
      "support-incidents-attributable-to-connectivity-orchestration",
      { targetRatio: 0.5, windowMs: 3_600_000 },
    );
    expect(incidentsSlo.total).toBe(1);
    expect(incidentsSlo.good).toBe(1); // count 1 <= threshold 1
  });

  it("records the three rate SLOs as good/bad event streams + outcome counters", () => {
    const { recorder, metrics } = makeRecorder();
    recorder.recordSuccessfulAutomaticRecovery({ tenantId: TENANT, succeeded: true });
    recorder.recordSuccessfulAutomaticRecovery({ tenantId: TENANT, succeeded: false });
    recorder.recordIntentSatisfaction({ tenantId: TENANT, satisfied: true });
    recorder.recordProviderAccessFailover({ tenantId: TENANT, succeeded: true });

    for (const [metric, good, bad] of [
      [SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC, 1, 1],
      [INTENT_SATISFACTION_RATE_METRIC, 1, 0],
      [PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC, 1, 0],
    ] as const) {
      const samples = samplesOf(metrics, metric);
      expect(samples).toHaveLength(good + bad);
      expect(
        samples.filter((sample) => (sample.labels as Record<string, unknown>)['outcome'] === "good"),
      ).toHaveLength(good);
      expect(
        samples.filter((sample) => (sample.labels as Record<string, unknown>)['outcome'] === "bad"),
      ).toHaveLength(bad);
    }

    const recovery = evaluateProductSlo(recorder, "successful-automatic-recovery-rate", {
      targetRatio: 0.5,
      windowMs: 3_600_000,
    });
    expect(recovery.observedGoodRatio).toBe(0.5);
    expect(recovery.state).toBe("exhausted");
    const failover = evaluateProductSlo(recorder, "provider-access-failover-success", {
      targetRatio: 0.999,
      windowMs: 3_600_000,
    });
    expect(failover.observedGoodRatio).toBe(1);
    expect(failover.state).toBe("within-budget");
  });

  it("records connectivity cost per useful hour/GB WHERE AVAILABLE (honest absence)", () => {
    const { recorder, metrics, events } = makeRecorder({
      connectivityCostPerUsefulHourMinorUnits: 10,
    });
    // Only the per-useful-hour unit is available here; per-GB stays absent.
    recorder.recordConnectivityCostPerUsefulUnit({
      tenantId: TENANT,
      minorUnitsPerUsefulHour: 7.44,
    });
    const samples = samplesOf(metrics, CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC);
    expect(samples).toHaveLength(1);
    expect((samples[0]?.labels as Record<string, unknown>)["unit"]).toBe("per_useful_hour");
    expect(
      samples.every((sample) => (sample.labels as Record<string, unknown>)['unit'] !== "per_useful_gb"),
    ).toBe(true);
    expect(evaluateProductSlo(recorder, "connectivity-cost-per-useful-hour-gb-where-available", {
      targetRatio: 0.9,
      windowMs: 3_600_000,
    }).good).toBe(1);
    expect(events.events()).toHaveLength(1);

    // Both units available: two histogram observations, one per unit.
    recorder.recordConnectivityCostPerUsefulUnit({
      tenantId: TENANT,
      minorUnitsPerUsefulHour: 9,
      minorUnitsPerUsefulGb: 250,
    });
    expect(samplesOf(metrics, CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC)).toHaveLength(3);
  });

  it("stamps every event at the explicit instant (deterministic clock default)", () => {
    const { recorder, events, clock } = makeRecorder();
    clock.advanceBy(5_000);
    recorder.recordIntentSatisfaction({ tenantId: TENANT, satisfied: true });
    recorder.recordIntentSatisfaction({
      tenantId: TENANT,
      satisfied: true,
      at: "2026-01-15T08:29:59.000Z",
    });
    const times = events.events().map((event) => event.at);
    expect(times[0]).toEqual(clock.now());
    expect(times[1]).toEqual("2026-01-15T08:29:59.000Z");
    const evaluation = evaluateProductSlo(recorder, "intent-satisfaction-rate", {
      targetRatio: 1,
      windowMs: 3_600_000,
      asOf: "2026-01-15T08:30:10.000Z",
    });
    expect(evaluation.total).toBe(2);
  });
});

describe("§11 SLO recorder — validation (fail-closed)", () => {
  it("rejects malformed measurements with typed errors", () => {
    const { recorder, metrics } = makeRecorder();
    expect(() =>
      recorder.recordTimeToUsableConnectivity({ tenantId: TENANT, durationMs: -1 }),
    ).toThrow(/durationMs/);
    expect(() =>
      recorder.recordMinutesWithoutUsableConnectivity({ tenantId: TENANT, minutes: Number.NaN }),
    ).toThrow(/minutes/);
    expect(() =>
      recorder.recordManualIntervention({ tenantId: TENANT, count: 0 }),
    ).toThrow(/count/);
    expect(() =>
      // @ts-expect-error deliberate contract violation (typed API proof)
      recorder.recordIntentSatisfaction({ tenantId: TENANT, satisfied: "yes" }),
    ).toThrow(/satisfied/);
    expect(() =>
      recorder.recordStaleUnknownStateDuration({
        tenantId: TENANT,
        durationMs: 1,
        // @ts-expect-error deliberate contract violation (typed API proof)
        freshnessState: "expired",
      }),
    ).toThrow(/freshnessState/);
    expect(() => recorder.recordSupportIncidentAttributable({ tenantId: "" })).toThrow(/tenantId/);
    // Nothing was recorded by any failed call (fail-closed, no partial state).
    expect(metrics.samples()).toHaveLength(0);
  });

  it("rejects invented/invalid budget thresholds", () => {
    expect(() =>
      makeRecorder({ timeToUsableConnectivityMs: 0 }),
    ).toThrow(/timeToUsableConnectivityMs/);
    expect(() =>
      makeRecorder({ minutesWithoutUsableConnectivity: -5 }),
    ).toThrow(/minutesWithoutUsableConnectivity/);
    expect(() => makeRecorder({ supportIncidentsPerDay: Number.POSITIVE_INFINITY })).toThrow(
      /supportIncidentsPerDay/,
    );
  });

  it("rejects malformed recorder deps", () => {
    const registry = new MetricRegistry();
    registerProductSloMetrics(registry);
    const metrics = createMetricsRecorder(registry);
    expect(() =>
      createProductSloRecorder({
        metrics,
        events: new SloEventRecorder(),
        // @ts-expect-error deliberate contract violation (typed API proof)
        now: "not-a-clock",
      }),
    ).toThrow(/now/);
  });

  it("fails closed through the metrics contract on unregistered names", () => {
    // A recorder over a registry WITHOUT registerProductSloMetrics: the
    // metrics port itself rejects the sample (METRIC_UNKNOWN) — the SLO
    // surface adds no second validation path, it inherits the contract's.
    const recorder = createProductSloRecorder({
      metrics: createMetricsRecorder(new MetricRegistry()),
      events: new SloEventRecorder(),
      now: () => T0,
    });
    expect(() =>
      recorder.recordProviderAccessFailover({ tenantId: TENANT, succeeded: true }),
    ).toThrow(/not registered/);
  });
});
