/**
 * RL-080/RL-081 deep contract checks — the import-level counterparts of the
 * gate's file-based API-consistency and SLO-instrumentation criteria.
 *
 * These tests import the REAL exported contracts (no fixtures, no fakes of
 * the measured surface) and prove:
 *
 *  1. every spec/api.md resource is covered by the actual route tables
 *     (app-kit + enterprise);
 *  2. the four-stage mutation acknowledgement vocabulary is exactly the
 *     spec's command semantics (accepted/executed/delivered/billable-final);
 *  3. every mutation carries the spec's command envelope (request id,
 *     correlation id, idempotency key, actor/tenant, optimistic version) —
 *     proven by EXECUTING the real request-planning functions;
 *  4. the customer webhook surface is exported on the enterprise route table;
 *  5. EVERY §11 SLO (parsed live from spec/architecture.md) is instrumented
 *     through the @roamlink/observability primitives: a typed objective is
 *     constructed for each, good/bad events are recorded on the deterministic
 *     testkit clock, windows/burn rates evaluate, and each composes with the
 *     health registry, the metrics contract and the correlated logger.
 *
 * This file is also the instrumentation evidence the MVP gate's SLO
 * criterion scans for (the `slo.<slug>` names below) — with the honest
 * caveat, recorded in the gate artifacts, that this is the GATE'S OWN suite;
 * the dogfood/load harnesses must reference the SLOs for the criterion to
 * pass (see docs/reports/mvp-release-gate.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  API_ROUTE_TEMPLATES,
  MUTATION_HEADERS,
  MUTATION_OUTCOME_STAGES,
  mutationRequestHeaders,
  planMutationRequest,
  type ActorContext,
} from "@roamlink/app-kit";
import { ENTERPRISE_API_ROUTE_TEMPLATES } from "@roamlink/enterprise";
import {
  HealthRegistry,
  MetricRegistry,
  SloEventRecorder,
  createCorrelatedLogger,
  createInMemoryLogSink,
  createManualCorrelationCarrier,
  createMetricsRecorder,
  makeCorrelationContext,
  makeServiceLevelObjective,
  multiWindowBurnRates,
  registerSloMetrics,
  emitSloEvaluationMetrics,
  runHealthChecks,
  sloHealthCheck,
  sloHealthState,
  logSloEvaluation,
} from "@roamlink/observability";
import { DeterministicClock } from "@roamlink/testkit";
import type { UtcInstant } from "@roamlink/contracts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SPEC_API = readFileSync(join(REPO_ROOT, "spec", "api.md"), "utf8");
const SPEC_ARCHITECTURE = readFileSync(join(REPO_ROOT, "spec", "architecture.md"), "utf8");

/** spec/api.md's backticked /v1 resources (deduped, sorted). */
const SPEC_RESOURCES = [
  ...new Set(SPEC_API.match(/`\/v1\/[a-z-]+`/g) ?? []),
].map((token) => token.slice(1, -1)).sort();

/** spec/architecture.md §11's SLO phrases (lowercased, punctuation stripped). */
const SPEC_SLOS = (() => {
  const section = SPEC_ARCHITECTURE.match(/^## 11\. SLOs\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  expect(section).not.toBeNull();
  return (section?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/[.;,]+$/, "").trim().toLowerCase());
})();

/** The §11-derived SLO names instrumented through the observability primitives. */
const SLO_NAMES = SPEC_SLOS.map(
  (phrase) => `slo.${phrase.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
);

describe("RL-080 API consistency — spec/api.md vs the real exported contracts", () => {
  it("spec/api.md lists the expected representative resources", () => {
    expect(SPEC_RESOURCES.length).toBeGreaterThanOrEqual(10);
    expect(SPEC_RESOURCES).toContain("/v1/users");
    expect(SPEC_RESOURCES).toContain("/v1/connectivity");
    expect(SPEC_RESOURCES).toContain("/v1/notifications");
  });

  it("every spec-listed resource is covered by a real route template (app-kit + enterprise)", () => {
    const templates = [
      ...Object.values(API_ROUTE_TEMPLATES),
      ...Object.values(ENTERPRISE_API_ROUTE_TEMPLATES),
    ];
    const missing = SPEC_RESOURCES.filter(
      (resource) => !templates.some((template) => template.startsWith(resource)),
    );
    expect(missing, `spec-listed resources missing from the route tables: ${missing.join(", ")}`).toEqual([]);
  });

  it("the mutation-outcome stage vocabulary is exactly the spec's four stages", () => {
    expect([...MUTATION_OUTCOME_STAGES]).toEqual([
      "accepted",
      "executed",
      "delivered",
      "billable-final",
    ]);
  });

  it("every mutation carries the full command envelope (executed through the real planning functions)", () => {
    const actor: ActorContext = {
      actorId: "usr:00000000-0000-4000-8000-000000000001",
      tenantId: "usr:00000000-0000-4000-8000-000000000001",
    };
    let next = 0;
    const ids = { next: () => `req-${(next += 1)}` };
    const plan = planMutationRequest(actor, ids, {
      idempotencyKey: "idem.deep.contract.1",
      correlationId: "corr.deep.contract.1",
      expectedVersion: 3,
    });
    const headers = mutationRequestHeaders(actor, plan);
    expect(headers[MUTATION_HEADERS.requestId]).toBe("req-1");
    expect(headers[MUTATION_HEADERS.correlationId]).toBe("corr.deep.contract.1");
    expect(headers[MUTATION_HEADERS.idempotencyKey]).toBe("idem.deep.contract.1");
    expect(headers[MUTATION_HEADERS.actorId]).toBe(actor.actorId);
    expect(headers[MUTATION_HEADERS.tenantId]).toBe(actor.tenantId);
    expect(headers[MUTATION_HEADERS.expectedVersion]).toBe("3");

    const minimal = mutationRequestHeaders(actor, planMutationRequest(actor, ids));
    expect(minimal[MUTATION_HEADERS.actorId]).toBe(actor.actorId);
    expect(MUTATION_HEADERS.expectedVersion in minimal).toBe(false);
  });

  it("the customer webhook surface is exported on the enterprise route table", () => {
    const routes = Object.values(ENTERPRISE_API_ROUTE_TEMPLATES);
    expect(routes.some((route) => route.startsWith("/v1/enterprise/webhook-endpoints"))).toBe(true);
  });
});

describe("RL-080/RL-081 SLO instrumentation — every §11 SLO through the observability primitives", () => {
  it("spec/architecture.md §11 parses to the nine product SLOs", () => {
    expect(SPEC_SLOS).toEqual([
      "time to usable connectivity",
      "minutes without usable connectivity",
      "manual interventions per session/day",
      "successful automatic recovery rate",
      "intent satisfaction rate",
      "connectivity cost per useful hour/gb where available",
      "stale/unknown-state duration",
      "provider/access failover success",
      "support incidents attributable to connectivity orchestration",
    ]);
    expect(SLO_NAMES).toHaveLength(9);
  });

  it("each §11 SLO becomes a typed objective and evaluates honestly on the deterministic clock", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const t0 = clock.now();
    const tPlus = (ms: number): UtcInstant => {
      clock.advanceBy(ms);
      return clock.now();
    };
    for (const name of SLO_NAMES) {
      const objective = makeServiceLevelObjective({
        name,
        targetRatio: 0.9,
        windowMs: 60_000,
      });
      expect(objective.name).toBe(name);

      const recorder = new SloEventRecorder();
      // No data in the window: no-data, never silently healthy.
      const noData = recorder.evaluate(objective, t0);
      expect(noData.state).toBe("no-data");
      expect(sloHealthState(noData.state)).toBe("degraded");

      // 9 good + 1 bad at target 0.9 = exactly exhausted budget.
      for (let index = 0; index < 9; index += 1) recorder.record(name, "good", tPlus(1_000));
      recorder.record(name, "bad", tPlus(1_000));
      const exhausted = recorder.evaluate(objective, tPlus(1_000));
      expect(exhausted.total).toBe(10);
      expect(exhausted.state).toBe("exhausted");
      expect(exhausted.burnRate).toBeCloseTo(1, 9);

      // Outside the window, events stop counting.
      const aged = recorder.evaluate(objective, tPlus(120_000));
      expect(aged.total).toBe(0);
      expect(aged.state).toBe("no-data");
    }
  });

  it("each §11 SLO composes with health, metrics and the correlated logger", async () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const objective = makeServiceLevelObjective({
      name: SLO_NAMES[0] ?? "slo.time-to-usable-connectivity",
      targetRatio: 0.95,
      windowMs: 300_000,
    });
    const recorder = new SloEventRecorder();
    const now = clock.now();
    recorder.record(objective.name, "good", now);
    recorder.record(objective.name, "bad", now);
    const evaluation = recorder.evaluate(objective, now);

    // Health composition: a burning SLO is degraded, registered and runnable.
    const registry = new HealthRegistry();
    registry.register(
      sloHealthCheck(objective.name, () => recorder.evaluate(objective, clock.now()), {
        now: () => clock.now(),
      }),
    );
    const report = await runHealthChecks(registry, { now: () => clock.now() });
    expect(report.state).toBe("degraded");
    expect(report.checks[0]?.name).toBe(objective.name);

    // Metrics composition: the SLO exports through the metrics contract.
    const metricRegistry = new MetricRegistry();
    registerSloMetrics(metricRegistry);
    const metrics = createMetricsRecorder(metricRegistry);
    emitSloEvaluationMetrics(metrics, evaluation);
    expect(metrics.samples().some((sample) => sample.name === "roamlink_slo_events_total")).toBe(true);
    expect(metrics.samples().some((sample) => sample.name === "roamlink_slo_burn_rate")).toBe(true);

    // Multi-window burn rates: labeled windows; the fast window ages out
    // (null burn rate — no-data, never a zero) while the slow one still sees
    // the events.
    const windowsAtNow = multiWindowBurnRates(
      recorder,
      objective,
      [
        { label: "fast-5m", windowMs: 300_000 },
        { label: "slow-6h", windowMs: 21_600_000 },
      ],
      now,
    );
    expect(windowsAtNow.map((window) => window.label)).toEqual(["fast-5m", "slow-6h"]);
    expect(windowsAtNow.every((window) => window.total === 2)).toBe(true);
    expect(windowsAtNow.every((window) => window.burnRate !== null)).toBe(true);
    clock.advanceBy(10 * 60_000);
    const agedWindows = multiWindowBurnRates(
      recorder,
      objective,
      [
        { label: "fast-5m", windowMs: 300_000 },
        { label: "slow-6h", windowMs: 21_600_000 },
      ],
      clock.now(),
    );
    expect(agedWindows[0]?.burnRate).toBeNull();
    expect(agedWindows[0]?.total).toBe(0);
    expect(agedWindows[1]?.total).toBe(2);

    // Correlated logging: the record carries the correlation id and the
    // SLO's own numbers (redaction-safe fields, RL-LOCK-016).
    const inMemorySink = createInMemoryLogSink();
    const carrier = createManualCorrelationCarrier();
    const logger = createCorrelatedLogger({
      sink: inMemorySink.sink,
      carrier,
      now: () => clock.now(),
    });
    const correlation = makeCorrelationContext({
      correlationId: "corr.deep.slo.1",
      tenantId: "org:00000000-0000-4000-8000-000000000001",
    });
    carrier.run(correlation, () => {
      logSloEvaluation(logger, evaluation);
    });
    const record = inMemorySink.records()[0];
    expect(record?.correlationId).toBe("corr.deep.slo.1");
    expect(record?.fields?.["slo"]).toBe(objective.name);
    expect(record?.fields?.["slo_state"]).toBe("exhausted");
  });
});
