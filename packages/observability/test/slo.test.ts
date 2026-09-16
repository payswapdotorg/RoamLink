/**
 * RL-052 tests: SLO objectives, burn-rate/error-budget math, window
 * filtering, honest no-data, multi-window burn rates.
 */
import { describe, expect, it } from "vitest";

import {
  SloEventRecorder,
  makeServiceLevelObjective,
  multiWindowBurnRates,
} from "../src/slo/slo.js";
import { fixtureUtcInstant } from "@roamlink/testkit";

const T0 = fixtureUtcInstant();

describe("makeServiceLevelObjective", () => {
  it("validates and freezes the typed objective", () => {
    const slo = makeServiceLevelObjective({
      name: "connectivity.usable-time",
      targetRatio: 0.999,
      windowMs: 3_600_000,
    });
    expect(slo.atRiskBurnRate).toBe(0.5);
    expect(Object.isFrozen(slo)).toBe(true);
  });

  it("rejects invalid names, ratios, windows and thresholds", () => {
    expect(() => makeServiceLevelObjective({ name: "Bad Name", targetRatio: 0.9, windowMs: 1000 })).toThrow(
      /lowercase labels/,
    );
    expect(() => makeServiceLevelObjective({ name: "ok", targetRatio: 0, windowMs: 1000 })).toThrow(
      /targetRatio/,
    );
    expect(() => makeServiceLevelObjective({ name: "ok", targetRatio: 1.1, windowMs: 1000 })).toThrow(
      /targetRatio/,
    );
    expect(() => makeServiceLevelObjective({ name: "ok", targetRatio: 0.9, windowMs: 0 })).toThrow(
      /windowMs/,
    );
    expect(() =>
      makeServiceLevelObjective({ name: "ok", targetRatio: 0.9, windowMs: 1000, atRiskBurnRate: 1.5 }),
    ).toThrow(/atRiskBurnRate/);
  });
});

describe("burn-rate + error-budget math", () => {
  it("computes burn rate = (bad/total) / (1 - target)", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({
      name: "edge.sync",
      targetRatio: 0.9, // 10% error budget
      windowMs: 3_600_000,
    });
    // 3600 events, 36 bad -> 1% error ratio -> burn rate 0.1
    for (let i = 0; i < 3564; i += 1) recorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 36; i += 1) recorder.record("edge.sync", "bad", T0);
    const evaluation = recorder.evaluate(slo, T0);
    expect(evaluation.total).toBe(3600);
    expect(evaluation.bad).toBe(36);
    expect(evaluation.burnRate).toBeCloseTo(0.1, 10);
    expect(evaluation.budgetRemainingRatio).toBeCloseTo(0.9, 10);
    expect(evaluation.observedGoodRatio).toBeCloseTo(0.99, 10);
    expect(evaluation.state).toBe("within-budget");
  });

  it("marks the budget exhausted at burn rate >= 1 and overspent beyond", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({
      name: "edge.sync",
      targetRatio: 0.9,
      windowMs: 3_600_000,
    });
    for (let i = 0; i < 90; i += 1) recorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 10; i += 1) recorder.record("edge.sync", "bad", T0);
    expect(recorder.evaluate(slo, T0).state).toBe("exhausted"); // exactly 100%
    recorder.record("edge.sync", "bad", T0);
    const overspent = recorder.evaluate(slo, T0);
    // 11 bad of 101 total on a 10% budget
    expect(overspent.burnRate).toBeCloseTo((11 / 101) / (1 - 0.9), 8);
    expect(overspent.budgetRemainingRatio).toBeCloseTo(1 - (11 / 101) / (1 - 0.9), 8);
  });

  it("flags at-risk between the configured threshold and exhaustion", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({
      name: "edge.sync",
      targetRatio: 0.9,
      windowMs: 3_600_000,
      atRiskBurnRate: 0.5,
    });
    for (let i = 0; i < 95; i += 1) recorder.record("edge.sync", "good", T0);
    for (let i = 0; i < 5; i += 1) recorder.record("edge.sync", "bad", T0);
    const evaluation = recorder.evaluate(slo, T0);
    expect(evaluation.burnRate).toBeCloseTo(0.5, 10);
    expect(evaluation.state).toBe("at-risk");
  });

  it("reports no-data (never healthy) when the window has no events", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({ name: "edge.sync", targetRatio: 0.99, windowMs: 1_000 });
    const evaluation = recorder.evaluate(slo, T0);
    expect(evaluation.state).toBe("no-data");
    expect(evaluation.burnRate).toBeNull();
    expect(evaluation.observedGoodRatio).toBeNull();
  });

  it("filters events to the window (exclusive lower edge) and per-SLO", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({ name: "edge.sync", targetRatio: 0.5, windowMs: 1_000 });
    recorder.record("edge.sync", "bad", fixtureUtcInstant(0));
    recorder.record("edge.sync", "good", fixtureUtcInstant(500));
    recorder.record("other.slo", "bad", fixtureUtcInstant(600)); // different SLO
    const inWindow = recorder.evaluate(slo, fixtureUtcInstant(1_000));
    expect(inWindow.total).toBe(1); // event at t=0 slid out; only t=500 counts
    expect(inWindow.good).toBe(1);
    const beforeSlide = recorder.evaluate(slo, fixtureUtcInstant(999));
    expect(beforeSlide.total).toBe(2);
  });

  it("validates recorded event names/outcomes", () => {
    const recorder = new SloEventRecorder();
    expect(() => recorder.record("bad name", "good", T0)).toThrow(/naming convention/);
    expect(() => recorder.record("ok", "meh" as "good", T0)).toThrow(/good.*bad|closed vocabulary/);
  });
});

describe("multiWindowBurnRates", () => {
  it("evaluates the same events over labeled windows (fast/slow pairing)", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({
      name: "edge.sync",
      targetRatio: 0.99,
      windowMs: 3_600_000,
    });
    // old hour: 900 good + 1 bad; recent 5 minutes: 99 good + 1 bad
    for (let i = 0; i < 900; i += 1) recorder.record("edge.sync", "good", fixtureUtcInstant(45_000));
    recorder.record("edge.sync", "bad", fixtureUtcInstant(50_000));
    for (let i = 0; i < 99; i += 1) recorder.record("edge.sync", "good", fixtureUtcInstant(250_000));
    recorder.record("edge.sync", "bad", fixtureUtcInstant(260_000));
    const rates = multiWindowBurnRates(
      recorder,
      slo,
      [
        { label: "fast-5m", windowMs: 300_000 },
        { label: "slow-1h", windowMs: 3_600_000 },
      ],
      fixtureUtcInstant(400_000),
    );
    const fast = rates.find((r) => r.label === "fast-5m");
    const slow = rates.find((r) => r.label === "slow-1h");
    // fast window (100_000, 400_000]: the 99 good + 1 bad recent events only
    expect(fast?.total).toBe(100);
    expect(fast?.bad).toBe(1);
    expect(fast?.burnRate).toBeCloseTo((1 / 100) / 0.01, 8); // = 1.0 (fast burn)
    // slow window (40_000, 4_000_000]: everything except nothing - 1001 total, 2 bad
    expect(slow?.total).toBe(1001);
    expect(slow?.bad).toBe(2);
    expect(slow?.burnRate).toBeCloseTo((2 / 1001) / 0.01, 8); // ~ 0.2 (slow burn)
  });

  it("returns null burn rates for empty windows and validates labels", () => {
    const recorder = new SloEventRecorder();
    const slo = makeServiceLevelObjective({ name: "edge.sync", targetRatio: 0.9, windowMs: 1_000 });
    const rates = multiWindowBurnRates(
      recorder,
      slo,
      [
        { label: "empty", windowMs: 60_000 },
      ],
      T0,
    );
    expect(rates[0]?.burnRate).toBeNull();
    expect(() =>
      multiWindowBurnRates(recorder, slo, [{ label: "", windowMs: 1 }], T0),
    ).toThrow(/label/);
  });
});
