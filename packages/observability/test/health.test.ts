import { describe, expect, it } from "vitest";
import { ConflictError } from "@roamlink/contracts";
import { fixtureUtcInstant } from "@roamlink/testkit";
import {
  HealthRegistry,
  aggregateHealthStates,
  isHealthState,
  parseHealthState,
  runHealthChecks,
  type HealthCheck,
  type HealthCheckOutput,
} from "../src/index.js";

function result(
  name: string,
  state: "healthy" | "degraded" | "down",
  checkedAt = fixtureUtcInstant(),
): HealthCheckOutput {
  return { name, state, checkedAt };
}

describe("closed health-state vocabulary", () => {
  it("is exactly healthy / degraded / down", () => {
    for (const state of ["healthy", "degraded", "down"] as const) {
      expect(isHealthState(state)).toBe(true);
      expect(parseHealthState(state)).toBe(state);
    }
    for (const bad of ["up", "unknown", "", 1, null]) {
      expect(isHealthState(bad)).toBe(false);
      expect(() => parseHealthState(bad)).toThrowError(/health-state vocabulary/);
    }
  });
});

describe("aggregateHealthStates", () => {
  it("any down -> down", () => {
    expect(aggregateHealthStates(["healthy", "degraded", "down"])).toBe("down");
    expect(aggregateHealthStates(["down"])).toBe("down");
    expect(aggregateHealthStates(["down", "down"])).toBe("down");
  });

  it("degraded without down -> degraded", () => {
    expect(aggregateHealthStates(["healthy", "degraded"])).toBe("degraded");
    expect(aggregateHealthStates(["degraded"])).toBe("degraded");
  });

  it("all healthy -> healthy; empty -> healthy (no declared dependency failed)", () => {
    expect(aggregateHealthStates(["healthy", "healthy"])).toBe("healthy");
    expect(aggregateHealthStates([])).toBe("healthy");
  });
});

describe("HealthRegistry", () => {
  it("registers checks with validated dependency names and rejects duplicates", () => {
    const registry = new HealthRegistry();
    const check: HealthCheck = { name: "database", run: () => result("database", "healthy") };
    registry.register(check);
    expect(registry.size).toBe(1);
    expect(registry.has("database")).toBe(true);

    expect(() => registry.register(check)).toThrowError(ConflictError);
    expect(() =>
      registry.register({ name: "Bad Name", run: () => result("x", "healthy") }),
    ).toThrowError(/dependency labels/);
    expect(() =>
      registry.register({ name: "adcos-api", run: "not a function" as unknown as () => never }),
    ).toThrowError(/run function/);
  });

  it("accepts dotted and dashed dependency names", () => {
    const registry = new HealthRegistry();
    registry.register({ name: "adcos-api", run: () => result("adcos-api", "healthy") });
    registry.register({ name: "outbox.worker", run: () => result("outbox.worker", "healthy") });
    expect(registry.size).toBe(2);
  });
});

describe("runHealthChecks", () => {
  it("aggregates registered results with a deterministic clock", async () => {
    const registry = new HealthRegistry();
    registry.register({ name: "database", run: () => result("database", "healthy") });
    registry.register({
      name: "adcos-api",
      run: async () => result("adcos-api", "degraded", fixtureUtcInstant(5)),
    });
    const report = await runHealthChecks(registry, { now: () => fixtureUtcInstant(10_000) });
    expect(report.state).toBe("degraded");
    expect(report.checks).toHaveLength(2);
    expect(report.evaluatedAt).toBe(fixtureUtcInstant(10_000));
    expect(Object.isFrozen(report)).toBe(true);
    const adcos = report.checks.find((c) => c.name === "adcos-api");
    expect(adcos?.state).toBe("degraded");
    expect(adcos?.checkedAt).toBe(fixtureUtcInstant(5));
  });

  it("a throwing check becomes down with a SUPPRESSED detail (RL-LOCK-016)", async () => {
    const registry = new HealthRegistry();
    registry.register({
      name: "payments",
      run: () => {
        throw new Error("connection string with password=hunter2 leaked");
      },
    });
    const report = await runHealthChecks(registry, { now: () => fixtureUtcInstant() });
    expect(report.state).toBe("down");
    const payments = report.checks[0];
    expect(payments?.state).toBe("down");
    expect(payments?.detail).toContain("suppressed");
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("an invalid check result is treated as down, not crashed", async () => {
    const registry = new HealthRegistry();
    registry.register({
      name: "cache",
      run: () => ({ name: "cache", state: "exploded", checkedAt: fixtureUtcInstant() }),
    });
    registry.register({
      name: "queue",
      run: () => ({ name: "queue", state: "healthy", checkedAt: "not-an-instant" }),
    });
    const report = await runHealthChecks(registry, { now: () => fixtureUtcInstant() });
    expect(report.state).toBe("down");
    expect(report.checks.every((c) => c.state === "down")).toBe(true);
  });

  it("a result under a different name than its registration is treated as down", async () => {
    const registry = new HealthRegistry();
    registry.register({
      name: "identity",
      run: () => result("somebody-else", "healthy"),
    });
    const report = await runHealthChecks(registry, { now: () => fixtureUtcInstant() });
    const identity = report.checks[0];
    expect(identity?.name).toBe("identity");
    expect(identity?.state).toBe("down");
    expect(identity?.detail).toContain("different name");
  });

  it("an empty registry is healthy", async () => {
    const report = await runHealthChecks(new HealthRegistry(), {
      now: () => fixtureUtcInstant(),
    });
    expect(report.state).toBe("healthy");
    expect(report.checks).toEqual([]);
  });
});
