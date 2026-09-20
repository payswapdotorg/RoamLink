/**
 * RL-109 — the SLO dashboard read model: pure presentation over the FROZEN
 * recorder primitives. Deterministic throughout (testkit clock).
 *
 * Pinned laws:
 *  - the snapshot covers ALL NINE §11 product SLO ids, in the closed order;
 *  - BUDGETED ids render the REAL evaluation (state, events, burn rate,
 *    budget remaining) + the multi-window burn rates + the health mapping —
 *    zero invented numbers;
 *  - MEASURED-ONLY ids (no objective configured) never carry a fabricated
 *    state: budgeted=false, evaluation=null, healthState=null, and the
 *    honest not-budgeted detail;
 *  - the overall roll-up is the pure health aggregation over the budgeted
 *    rows; an UNCONFIGURED deployment (no objectives at all) is honestly
 *    degraded — never silently healthy;
 *  - no-data budgeted rows are degraded (never healthy — fail-safe default,
 *    the slo-health law);
 *  - the input fails closed: no events seam, no clock -> TypeError.
 */
import { describe, expect, it } from "vitest";

import { DeterministicClock } from "@roamlink/testkit";

import { MetricRegistry, createMetricsRecorder } from "../src/metrics/metrics.js";
import { SloEventRecorder } from "../src/slo/slo.js";
import {
  PRODUCT_SLO_IDS,
  PRODUCT_SLO_OBJECTIVE_NAMES,
  createProductSloRecorder,
  makeProductSloObjective,
  registerProductSloMetrics,
  type ProductSloRecorder,
} from "../src/slo/slo-metrics.js";
import {
  buildProductSloDashboard,
  SLO_DASHBOARD_WINDOWS,
  type SloDashboardRow,
} from "../src/slo/slo-dashboard.js";

const T0 = "2026-11-01T12:00:00.000Z";
const DAY_MS = 86_400_000;

function makeRecorder(clock: DeterministicClock): ProductSloRecorder {
  const registry = new MetricRegistry();
  registerProductSloMetrics(registry);
  return createProductSloRecorder(
    { metrics: createMetricsRecorder(registry), events: new SloEventRecorder(), now: () => clock.now() },
    // Two of the rate/duration SLOs are BUDGETED with explicit targets; the
    // rest of the suite's objectives are configured at the dashboard layer.
    { staleUnknownStateDurationMs: 60_000 },
  );
}

function budgetedObjectives(): Record<string, ReturnType<typeof makeProductSloObjective>> {
  // The deployment's operator configuration: two §11 SLOs carry targets.
  const intent = makeProductSloObjective("intent-satisfaction-rate", {
    targetRatio: 0.99,
    windowMs: DAY_MS,
  });
  const failover = makeProductSloObjective("provider-access-failover-success", {
    targetRatio: 0.9,
    windowMs: DAY_MS,
    atRiskBurnRate: 0.5,
  });
  return {
    "intent-satisfaction-rate": intent,
    "provider-access-failover-success": failover,
  } as never;
}

function rowOf(rows: readonly SloDashboardRow[], id: string): SloDashboardRow {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`expected a dashboard row for ${id}`);
  return row;
}

describe("RL-109 the §11 SLO dashboard read model", () => {
  it("covers all nine §11 ids; unconfigured ids are honestly measured-only (never fabricated)", () => {
    const clock = new DeterministicClock(T0);
    const recorder = makeRecorder(clock);
    const snapshot = buildProductSloDashboard({
      events: recorder.events,
      asOf: clock.now(),
      objectives: {} as never,
    });
    expect(snapshot.rows.map((row) => row.id)).toEqual([...PRODUCT_SLO_IDS]);
    expect(snapshot.budgetedCount).toBe(0);
    expect(snapshot.overall).toBe("degraded"); // unconfigured is NEVER silently healthy
    for (const row of snapshot.rows) {
      expect(row.budgeted).toBe(false);
      expect(row.evaluation).toBeNull();
      expect(row.healthState).toBeNull();
      expect(row.windows).toEqual([]);
      expect(row.detail).toMatch(/not budgeted/);
    }
    expect(snapshot.asOf).toBe(T0);
  });

  it("budgeted rows render the REAL evaluation: state, events, burn rate, budget, windows, health", () => {
    const clock = new DeterministicClock(T0);
    const recorder = makeRecorder(clock);
    // REAL events through the public recorder: intent satisfaction 98/100
    // (burn 2x the 1% budget => exhausted), failover 1 bad of 100
    // (burn (1/100)/0.1 = 0.1 => within-budget).
    for (let index = 0; index < 100; index += 1) {
      recorder.recordIntentSatisfaction({
        tenantId: "org:ops-1",
        satisfied: index >= 2 ? true : false,
        at: clock.now(),
      });
    }
    for (let index = 0; index < 100; index += 1) {
      recorder.recordProviderAccessFailover({
        tenantId: "org:ops-1",
        succeeded: true,
        at: clock.now(),
      });
    }
    const snapshot = buildProductSloDashboard({
      events: recorder.events,
      asOf: clock.now(),
      objectives: budgetedObjectives() as never,
    });

    expect(snapshot.budgetedCount).toBe(2);
    expect(snapshot.overall).toBe("degraded"); // one exhausted row dominates

    const intent = rowOf(snapshot.rows, "intent-satisfaction-rate");
    expect(intent.budgeted).toBe(true);
    expect(intent.objectiveName).toBe(PRODUCT_SLO_OBJECTIVE_NAMES.intentSatisfactionRate);
    expect(intent.evaluation?.total).toBe(100);
    expect(intent.evaluation?.good).toBe(98);
    expect(intent.evaluation?.bad).toBe(2);
    expect(intent.evaluation?.burnRate).toBeCloseTo(2, 9);
    expect(intent.evaluation?.state).toBe("exhausted");
    expect(intent.healthState).toBe("degraded");
    expect(intent.windows.map((window) => window.label)).toEqual(SLO_DASHBOARD_WINDOWS.map((w) => w.label));
    expect(intent.windows.every((window) => window.burnRate !== null)).toBe(true); // same events inside every window

    const failover = rowOf(snapshot.rows, "provider-access-failover-success");
    expect(failover.evaluation?.state).toBe("within-budget");
    expect(failover.healthState).toBe("healthy");
    expect(failover.evaluation?.budgetRemainingRatio).toBeCloseTo(1, 9); // zero bad events -> full budget

    // The measured-only ids stay honest even when other rows are budgeted.
    const stale = rowOf(snapshot.rows, "stale-unknown-state-duration");
    expect(stale.budgeted).toBe(false);
    expect(stale.evaluation).toBeNull();
    expect(stale.healthState).toBeNull();
  });

  it("an empty window for a budgeted SLO is no-data -> degraded (never silently healthy)", () => {
    const clock = new DeterministicClock(T0);
    const recorder = makeRecorder(clock);
    recorder.recordIntentSatisfaction({ tenantId: "org:ops-1", satisfied: true, at: T0 });
    // Advance FAR beyond the objective window: the event ages out.
    clock.advanceBy(DAY_MS * 2);
    const snapshot = buildProductSloDashboard({
      events: recorder.events,
      asOf: clock.now(),
      objectives: budgetedObjectives() as never,
    });
    const intent = rowOf(snapshot.rows, "intent-satisfaction-rate");
    expect(intent.evaluation?.state).toBe("no-data");
    expect(intent.evaluation?.burnRate).toBeNull();
    expect(intent.healthState).toBe("degraded");
    expect(snapshot.overall).toBe("degraded");
  });

  it("multi-window burn rates split honestly: recent bad events burn the fast window, not the slow one", () => {
    const clock = new DeterministicClock(T0);
    const recorder = makeRecorder(clock);
    // 90 minutes of healthy history (outside the 5m/30m windows at T+2h).
    for (let index = 0; index < 90; index += 1) {
      recorder.recordIntentSatisfaction({ tenantId: "org:ops-1", satisfied: true, at: T0 });
      clock.advanceBy(60_000);
    }
    // A fresh burst of bad events inside the last five minutes.
    clock.advanceBy(30 * 60_000);
    for (let index = 0; index < 4; index += 1) {
      recorder.recordIntentSatisfaction({ tenantId: "org:ops-1", satisfied: false, at: clock.now() });
      clock.advanceBy(60_000);
    }
    const snapshot = buildProductSloDashboard({
      events: recorder.events,
      asOf: clock.now(),
      objectives: budgetedObjectives() as never,
    });
    const intent = rowOf(snapshot.rows, "intent-satisfaction-rate");
    const fast = intent.windows.find((window) => window.label === "5m");
    const slow = intent.windows.find((window) => window.label === "6h");
    expect(fast?.total).toBe(4);
    expect(fast?.bad).toBe(4);
    expect(slow?.total).toBe(94);
    expect(slow?.bad).toBe(4);
    expect(fast?.burnRate).toBeCloseTo(100, 6); // (4/4 bad)/(1% budget) = 100x budget consumption
  });

  it("fails closed on a missing events seam or a missing clock (never ambient time)", () => {
    const clock = new DeterministicClock(T0);
    const recorder = makeRecorder(clock);
    expect(() =>
      buildProductSloDashboard({
        events: undefined as never,
        asOf: clock.now(),
        objectives: {} as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildProductSloDashboard({
        events: recorder.events,
        objectives: {} as never,
      }),
    ).toThrow(TypeError);
  });
});
