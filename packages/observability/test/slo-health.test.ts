/**
 * RL-052 tests: SLO composition with the existing health registry, metrics
 * contract and correlated logger (health states, metric emission,
 * correlation-aware log fields).
 */
import { describe, expect, it } from "vitest";

import {
  HealthRegistry,
  MetricRegistry,
  SloEventRecorder,
  createCorrelatedLogger,
  createInMemoryLogSink,
  createMetricsRecorder,
  createManualCorrelationCarrier,
  emitSloEvaluationMetrics,
  logSloEvaluation,
  makeServiceLevelObjective,
  registerSloMetrics,
  sloHealthCheck,
  sloHealthState,
  sloLogFields,
  runHealthChecks,
} from "../src/index.js";
import { makeCorrelationContext } from "../src/index.js";
import { fixtureCorrelationId, fixtureTenantId, fixtureUtcInstant } from "@roamlink/testkit";

const T0 = fixtureUtcInstant();

function slo() {
  return makeServiceLevelObjective({
    name: "edge.sync",
    targetRatio: 0.9,
    windowMs: 3_600_000,
  });
}

describe("sloHealthState mapping", () => {
  it("maps the closed SLO states onto the health vocabulary", () => {
    expect(sloHealthState("within-budget")).toBe("healthy");
    expect(sloHealthState("at-risk")).toBe("degraded");
    expect(sloHealthState("exhausted")).toBe("degraded");
    expect(sloHealthState("no-data")).toBe("degraded");
  });
});

describe("sloHealthCheck composes with HealthRegistry", () => {
  async function registryWith(
    evaluation: () => ReturnType<SloEventRecorder["evaluate"]>,
  ): Promise<{ registry: HealthRegistry; report: Awaited<ReturnType<typeof runHealthChecks>> }> {
    const registry = new HealthRegistry();
    registry.register(sloHealthCheck("edge.sync", evaluation, { now: () => T0 }));
    const report = await runHealthChecks(registry, { now: () => T0 });
    return { registry, report };
  }

  it("aggregates healthy when the SLO is within budget", async () => {
    const recorder = new SloEventRecorder();
    for (let i = 0; i < 100; i += 1) recorder.record("edge.sync", "good", T0);
    const { report } = await registryWith(() => recorder.evaluate(slo(), T0));
    expect(report.state).toBe("healthy");
    expect(report.checks[0]?.state).toBe("healthy");
    expect(report.checks[0]?.detail).toContain("burn rate");
  });

  it("degrades (never down) when the budget is exhausted or there is no data", async () => {
    const recorder = new SloEventRecorder();
    for (let i = 0; i < 90; i += 1) recorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 10; i += 1) recorder.record("edge.sync", "bad", T0);
    const { report } = await registryWith(() => recorder.evaluate(slo(), T0));
    expect(report.state).toBe("degraded");

    const empty = new SloEventRecorder();
    const { report: noData } = await registryWith(() => empty.evaluate(slo(), T0));
    expect(noData.state).toBe("degraded");
    expect(noData.checks[0]?.detail).toContain("no events");
  });

  it("rejects evaluations whose SLO name does not match the check", async () => {
    const recorder = new SloEventRecorder();
    const other = makeServiceLevelObjective({ name: "other.slo", targetRatio: 0.9, windowMs: 1_000 });
    const registry = new HealthRegistry();
    registry.register(sloHealthCheck("edge.sync", () => recorder.evaluate(other, T0)));
    const report = await runHealthChecks(registry, { now: () => T0 });
    expect(report.state).toBe("down"); // fail-closed on the mismatch
    expect(report.checks[0]?.detail).toContain("different SLO name");
  });
});

describe("SLO metrics export", () => {
  it("registers the closed metric set idempotently and emits evaluations", () => {
    const registry = new MetricRegistry();
    registerSloMetrics(registry);
    registerSloMetrics(registry); // idempotent
    expect(registry.size).toBe(3);
    const recorder = createMetricsRecorder(registry);

    const eventRecorder = new SloEventRecorder();
    for (let i = 0; i < 95; i += 1) eventRecorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 5; i += 1) eventRecorder.record("edge.sync", "bad", T0);
    emitSloEvaluationMetrics(recorder, eventRecorder.evaluate(slo(), T0));

    const samples = recorder.samples();
    expect(samples.filter((s) => s.name === "roamlink_slo_events_total")).toHaveLength(2);
    expect(
      samples.find(
        (s) => s.name === "roamlink_slo_events_total" && (s.labels as Record<string, unknown>)["outcome"] === "bad",
      ),
    ).toMatchObject({ delta: 5 });
    expect(samples.find((s) => s.name === "roamlink_slo_burn_rate")).toMatchObject({
      labels: { slo: "edge.sync" },
    });
    expect(samples.find((s) => s.name === "roamlink_slo_budget_remaining")).toBeDefined();
  });

  it("emits no counters for a no-data evaluation", () => {
    const registry = new MetricRegistry();
    registerSloMetrics(registry);
    const recorder = createMetricsRecorder(registry);
    emitSloEvaluationMetrics(recorder, new SloEventRecorder().evaluate(slo(), T0));
    expect(recorder.samples().filter((s) => s.name === "roamlink_slo_events_total")).toHaveLength(0);
  });
});

describe("correlation-aware SLO log fields", () => {
  it("attaches safe, value-free fields to correlated logger records", () => {
    const sink = createInMemoryLogSink();
    const carrier = createManualCorrelationCarrier();
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier,
      minLevel: "debug",
      now: () => T0,
    });

    const eventRecorder = new SloEventRecorder();
    for (let i = 0; i < 99; i += 1) eventRecorder.record("edge.sync", "good", T0);
    eventRecorder.record("edge.sync", "bad", T0);
    const evaluation = eventRecorder.evaluate(slo(), T0);

    carrier.run(
      makeCorrelationContext({
        correlationId: fixtureCorrelationId(7),
        tenantId: fixtureTenantId({ seed: 2 }),
      }),
      () => logSloEvaluation(logger, evaluation),
    );

    expect(sink.records()).toHaveLength(1);
    const record = sink.records()[0];
    if (record === undefined) throw new Error("expected a log record");
    expect(record.level).toBe("info"); // burn rate 0.1 on a 10% budget: within-budget
    expect(record.correlationId).toBe(fixtureCorrelationId(7));
    expect(record.tenantId).toBe(fixtureTenantId({ seed: 2 }));
    expect(record.fields["slo"]).toBe("edge.sync");
    expect(record.fields["slo_state"]).toBe("within-budget");
    expect(record.fields["slo_bad"]).toBe(1);
    // the fields are exactly the closed SLO field set - no payloads, no secrets
    expect(Object.keys(record.fields).sort()).toEqual([
      "slo",
      "slo_bad",
      "slo_budget_remaining",
      "slo_burn_rate",
      "slo_good",
      "slo_state",
      "slo_total",
    ]);
  });

  it("sloLogFields returns the closed field set for any evaluation", () => {
    const evaluation = new SloEventRecorder().evaluate(slo(), T0);
    const fields = sloLogFields(evaluation);
    expect(fields["slo_state"]).toBe("no-data");
    expect(fields["slo_burn_rate"]).toBeNull();
    expect(JSON.stringify(fields)).not.toContain("undefined");
  });

  it("logs exhausted and no-data at error level", () => {
    const sink = createInMemoryLogSink();
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier: createManualCorrelationCarrier(),
      now: () => T0,
    });
    const eventRecorder = new SloEventRecorder();
    for (let i = 0; i < 90; i += 1) eventRecorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 10; i += 1) eventRecorder.record("edge.sync", "bad", T0);
    logSloEvaluation(logger, eventRecorder.evaluate(slo(), T0));
    logSloEvaluation(logger, new SloEventRecorder().evaluate(slo(), T0));
    expect(sink.records().map((r) => r.level)).toEqual(["error", "error"]);
  });
});
