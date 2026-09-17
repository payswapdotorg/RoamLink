/**
 * RL-075 suite 5: HEALTH/READINESS COMPOSITION (RL-052; spec/security.md
 * "Fail-safe defaults": "Unknown or unverifiable connectivity state must
 * not be represented as healthy"; spec/architecture.md §11 SLOs:
 * "stale/unknown-state duration" is measured, never hidden).
 *
 * The observability health composition must report component states
 * HONESTLY: degraded is not ready, unknown is not healthy.
 *
 * Verification catalog:
 *   H-1 aggregation rules: any down -> down; else any degraded ->
 *        degraded; else healthy; an EMPTY registry is healthy (no declared
 *        dependency failed) - the closed composition, proven both ways;
 *   H-2 a check that THROWS or returns garbage is DOWN with a suppressed
 *        detail (third-party error text may carry secrets - RL-LOCK-016);
 *        a check answering under a DIFFERENT name than its registration
 *        is DOWN;
 *   H-3 SLO composition: no-data is DEGRADED (never silently healthy);
 *        an exhausted error budget is degraded (a reliability signal, not
 *        a liveness failure); sloHealthCheck fails closed on a throwing
 *        evaluation;
 *   H-4 the composed data-plane health: checks built from the REAL state
 *        (inbox backlog, projection freshness, outbox backlog, audit-chain
 *        verification) report degradation honestly when the state degrades
 *        - and recover when it heals.
 */
import { describe, expect, it } from "vitest";
import {
  HealthRegistry,
  runHealthChecks,
  aggregateHealthStates,
} from "@roamlink/observability";
import {
  SloEventRecorder,
  makeServiceLevelObjective,
  sloHealthCheck,
  sloHealthState,
} from "@roamlink/observability";
import { InMemoryAuditLog, verifyAuditChain } from "@roamlink/audit";
import type { AuditEventPlain } from "@roamlink/audit";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  T0,
  makeDeploymentWorld,
} from "../src/harness.js";

describe("RL-075 suite 5: health/readiness composition", () => {
  it("H-1 aggregation: down dominates; degraded is not ready; empty is healthy", async () => {
    // Pure aggregation over the closed vocabulary.
    expect(aggregateHealthStates(["healthy", "healthy"])).toBe("healthy");
    expect(aggregateHealthStates(["healthy", "degraded"])).toBe("degraded");
    expect(aggregateHealthStates(["degraded", "degraded"])).toBe("degraded");
    expect(aggregateHealthStates(["healthy", "down"])).toBe("down");
    expect(aggregateHealthStates(["degraded", "down"])).toBe("down");

    // The registry composition agrees (empty = healthy: no declared
    // dependency failed).
    const empty = new HealthRegistry();
    const emptyReport = await runHealthChecks(empty, { now: () => parseUtcInstant(T0) });
    expect(emptyReport.state).toBe("healthy");

    // degraded != ready: one degraded dependency makes the whole report
    // degraded even with everything else healthy.
    const mixed = new HealthRegistry();
    mixed.register({ name: "database", run: () => ({ name: "database", state: "healthy", checkedAt: T0 }) });
    mixed.register({ name: "adcos-api", run: () => ({ name: "adcos-api", state: "degraded", checkedAt: T0 }) });
    const mixedReport = await runHealthChecks(mixed, { now: () => parseUtcInstant(T0) });
    expect(mixedReport.state).toBe("degraded");

    // any down -> down.
    const down = new HealthRegistry();
    down.register({ name: "database", run: () => ({ name: "database", state: "healthy", checkedAt: T0 }) });
    down.register({ name: "storage", run: () => ({ name: "storage", state: "down", checkedAt: T0 }) });
    const downReport = await runHealthChecks(down, { now: () => parseUtcInstant(T0) });
    expect(downReport.state).toBe("down");
  });

  it("H-2 throwing checks, garbage results and name mismatches are DOWN (fail-closed, suppressed details)", async () => {
    const registry = new HealthRegistry();
    registry.register({
      name: "throwing-dependency",
      run: () => {
        throw new Error("third-party failure detail that may contain a credential");
      },
    });
    registry.register({
      name: "garbage-result",
      run: () => ({ name: "garbage-result", state: "flying", checkedAt: T0 }),
    });
    registry.register({
      name: "renamed-check",
      run: () => ({ name: "some-other-name", state: "healthy", checkedAt: T0 }),
    });
    const report = await runHealthChecks(registry, { now: () => parseUtcInstant(T0) });
    expect(report.state).toBe("down");
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    expect(byName.get("throwing-dependency")?.state).toBe("down");
    expect(byName.get("throwing-dependency")?.detail).toContain("suppressed");
    expect(byName.get("garbage-result")?.state).toBe("down");
    expect(byName.get("renamed-check")?.state).toBe("down");
    // The suppressed detail never carries the third-party error text.
    expect(JSON.stringify(report.checks)).not.toContain("third-party failure detail");
  });

  it("H-3 SLO composition: no-data and exhausted budgets are DEGRADED, never healthy", () => {
    const slo = makeServiceLevelObjective({
      name: "connectivity.usable-time",
      targetRatio: 0.99,
      windowMs: 3_600_000,
    });

    // NO DATA: an empty window is never silently healthy.
    const recorder = new SloEventRecorder();
    const noData = recorder.evaluate(slo, T0);
    expect(noData.state).toBe("no-data");
    expect(sloHealthState(noData.state)).toBe("degraded");

    // A well-behaved window: within budget -> healthy (99.8% observed vs
    // a 99% target: only 20% of the error budget consumed).
    for (let index = 0; index < 998; index += 1) {
      recorder.record("connectivity.usable-time", "good", T0);
    }
    recorder.record("connectivity.usable-time", "bad", T0);
    recorder.record("connectivity.usable-time", "bad", T0);
    const within = recorder.evaluate(slo, T0);
    expect(within.state).toBe("within-budget");
    expect(sloHealthState(within.state)).toBe("healthy");

    // An EXHAUSTED error budget: degraded (a reliability signal, not a
    // liveness failure - down stays reserved for broken dependencies).
    const burning = new SloEventRecorder();
    for (let index = 0; index < 50; index += 1) {
      burning.record("connectivity.usable-time", "good", T0);
    }
    for (let index = 0; index < 50; index += 1) {
      burning.record("connectivity.usable-time", "bad", T0);
    }
    const exhausted = burning.evaluate(slo, T0);
    expect(exhausted.state).toBe("exhausted");
    expect(sloHealthState(exhausted.state)).toBe("degraded");

    // sloHealthCheck composes into the registry: a throwing evaluation
    // fails CLOSED as down with suppressed details.
    const throwingCheck = sloHealthCheck("connectivity.usable-time", () => {
      throw new Error("evaluation exploded");
    }, { now: () => parseUtcInstant(T0) });
    const registry = new HealthRegistry();
    registry.register(throwingCheck);
    void registry;
    const registry2 = new HealthRegistry();
    registry2.register(throwingCheck);
    return runHealthChecks(registry2, { now: () => parseUtcInstant(T0) }).then((report) => {
      expect(report.state).toBe("down");
      expect(report.checks[0]?.detail).toContain("suppressed");
    });
  });

  it("H-4 the composed data-plane health reports real degradation honestly and recovers", async () => {
    const world = makeDeploymentWorld();

    // Drive one projected event, then compose the data-plane checks over
    // the REAL public state.
    await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "health" } },
        ],
        validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
        termination: { actor: "customer", onExpiry: "release" },
        recorded_at: world.clock.now(),
      },
      { idempotencyKey: "idem.health.intent.1" as never },
    );
    await world.admitAndProject();
    // The audit-chain view the health check verifies (the serialized plain
    // form - the same view the admin console and the restore path verify).
    const audit = new InMemoryAuditLog();
    await audit.append({
      category: "auth",
      action: "session.create",
      outcome: "allowed",
      actorId: "usr:00000000-0000-4000-8000-0000000000h2",
      correlationId: "corr.health.audit.0",
      occurredAt: world.clock.now(),
    });
    const auditChain: AuditEventPlain[] = (await audit.events()).map((event) => event.toPlain());

    const composeHealth = (chain: readonly AuditEventPlain[] = auditChain) => {
      const registry = new HealthRegistry();
      registry.register({
        name: "inbox.backlog",
        run: async () => {
          // The HONEST backlog: extended records whose processing status is
          // not yet PROJECTED (admission is durable forever - the state
          // lives on the extended record).
          const records = await world.persistence
            .records("adcos-webhook-inbox")
            .list();
          const pending = records.filter(
            (record) =>
              (record.value as { processing?: { status?: string } }).processing?.status !==
              "PROJECTED",
          ).length;
          return {
            name: "inbox.backlog",
            state: pending === 0 ? "healthy" : "degraded",
            detail: `${pending} admitted events await projection`,
            checkedAt: world.clock.now(),
          };
        },
      });
      registry.register({
        name: "outbox.backlog",
        run: async () => {
          const pending = await world.persistence.outbox.count("PENDING");
          return {
            name: "outbox.backlog",
            state: pending === 0 ? "healthy" : "degraded",
            detail: `${pending} deliveries pending`,
            checkedAt: world.clock.now(),
          };
        },
      });
      registry.register({
        name: "projections.freshness",
        run: async () => {
          const all = await world.plane.boundary.projections.list();
          const stale = all.filter(
            (record) => record.freshness_state === "STALE" || record.freshness_state === "UNKNOWN",
          ).length;
          return {
            name: "projections.freshness",
            state: stale === 0 ? "healthy" : "degraded",
            detail:
              stale === 0
                ? "all projections FRESH"
                : `${stale} of ${all.length} projections STALE/UNKNOWN`,
            checkedAt: world.clock.now(),
          };
        },
      });
      registry.register({
        name: "audit.chain",
        run: async () => {
          const verification = verifyAuditChain(chain);
          return {
            name: "audit.chain",
            state: verification.ok ? "healthy" : "down",
            detail: verification.ok ? "digest chain verified" : "digest chain broken",
            checkedAt: world.clock.now(),
          };
        },
      });
      return registry;
    };

    // Healthy start: no backlog, FRESH projections, intact chain.
    const healthyReport = await runHealthChecks(composeHealth(), { now: () => parseUtcInstant(world.clock.now()) });
    expect(healthyReport.state).toBe("healthy");
    const healthyByName = new Map(healthyReport.checks.map((check) => [check.name, check]));
    expect(healthyByName.get("projections.freshness")?.state).toBe("healthy");

    // Degrade: admit events WITHOUT projecting (an inbox backlog), stop
    // the outbox drain with a pending record, and age the projections past
    // their freshness guarantee.
    await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "health-2" } },
        ],
        validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: world.clock.now(),
      },
      { idempotencyKey: "idem.health.intent.2" as never },
    );
    await world.admitAll(world.fake.deliveries().slice(1)); // admitted, never projected
    const unitOfWork = await world.persistence.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "idem.health.outbox.1",
      payload: { effect: "health-probe" },
      createdAt: world.clock.now(),
    });
    await unitOfWork.commit();
    world.clock.advanceBy(120_000); // past the 60s freshness guarantee

    // A TAMPERED audit chain is DOWN (the strongest degradation signal):
    // the attacker rewrites a recorded authorization outcome.
    const tamperedChain = JSON.parse(JSON.stringify(auditChain)) as AuditEventPlain[];
    (tamperedChain[0] as { outcome: string }).outcome = "denied";
    const tamperReport = await runHealthChecks(composeHealth(tamperedChain), {
      now: () => parseUtcInstant(world.clock.now()),
    });
    expect(tamperReport.state).toBe("down");
    const tamperByName = new Map(tamperReport.checks.map((check) => [check.name, check]));
    expect(tamperByName.get("audit.chain")?.state).toBe("down");

    const degradedReport = await runHealthChecks(composeHealth(), { now: () => parseUtcInstant(world.clock.now()) });
    expect(degradedReport.state).toBe("degraded"); // degraded != ready
    const degradedByName = new Map(degradedReport.checks.map((check) => [check.name, check]));
    expect(degradedByName.get("inbox.backlog")?.state).toBe("degraded");
    expect(degradedByName.get("outbox.backlog")?.state).toBe("degraded");

    // RECOVERY: drain the inbox, deliver the outbox, refresh the
    // projections through the reconciler - the composed health heals.
    await world.plane.boundary.inbox.processPending();
    const claimUnit = await world.persistence.begin();
    const claimed = await claimUnit.outbox.claimDue(world.clock.now(), 10);
    await claimUnit.commit();
    const outcomeUnit = await world.persistence.begin();
    for (const record of claimed) {
      await outcomeUnit.outbox.markDelivered(record.idempotencyKey, world.clock.now());
    }
    await outcomeUnit.commit();
    await world.plane.boundary.reconciler.runJob({ reason: "scheduled" });
    const recoveredReport = await runHealthChecks(composeHealth(), { now: () => parseUtcInstant(world.clock.now()) });
    expect(recoveredReport.state).toBe("healthy");
    const recoveredByName = new Map(recoveredReport.checks.map((check) => [check.name, check]));
    expect(recoveredByName.get("inbox.backlog")?.state).toBe("healthy");
    expect(recoveredByName.get("outbox.backlog")?.state).toBe("healthy");
    expect(recoveredByName.get("projections.freshness")?.state).toBe("healthy");
  });
});
