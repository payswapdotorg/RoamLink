import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { HealthRegistry, runHealthChecks } from "@roamlink/observability";
import { createNeonHealthCheck, type PostgresProbePort } from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";

function healthyProbe(): PostgresProbePort {
  return { probe: async () => undefined };
}

function failingProbe(): PostgresProbePort {
  return {
    probe: async () => {
      throw new Error("password authentication failed for user \"owner\" connection string: postgresql://owner:pw@ep-x.neon.tech/neondb");
    },
  };
}

describe("createNeonHealthCheck (RL-095, deployment.md §7)", () => {
  it("reports healthy with a value-free detail when the probe completes", async () => {
    const clock = new DeterministicClock(START);
    const check = createNeonHealthCheck({ probe: healthyProbe(), clock });
    const result = await check.run();
    expect(result.name).toBe("database");
    expect(result.state).toBe("healthy");
    expect(result.checkedAt).toBe(START);
    expect(result.detail).not.toContain("postgresql://");
  });

  it("reports down with a SUPPRESSED detail when the probe fails (RL-LOCK-016)", async () => {
    const clock = new DeterministicClock(START);
    const check = createNeonHealthCheck({ probe: failingProbe(), clock });
    const result = await check.run();
    expect(result.state).toBe("down");
    expect(result.detail).toBeDefined();
    // driver error text (which embeds the connection string) must be suppressed
    expect(result.detail).not.toContain("postgresql://");
    expect(result.detail).not.toContain("ep-x.neon.tech");
    expect(result.detail).not.toContain("password");
  });

  it("keeps checkedAt deterministic under the testkit clock", async () => {
    const clock = new DeterministicClock(START);
    const check = createNeonHealthCheck({ probe: healthyProbe(), clock });
    await check.run();
    clock.advanceBy(250);
    const second = await check.run();
    expect(second.checkedAt).toBe("2026-01-15T10:00:00.250Z");
  });

  it("composes with the observability HealthRegistry: down dominates", async () => {
    const clock = new DeterministicClock(START);
    const registry = new HealthRegistry();
    registry.register(createNeonHealthCheck({ probe: failingProbe(), clock }));
    const report = await runHealthChecks(registry, { now: () => clock.now() });
    expect(report.state).toBe("down");
    const database = report.checks.find((c) => c.name === "database");
    expect(database?.state).toBe("down");
  });

  it("rejects invalid registry names and non-probe ports", () => {
    expect(() => createNeonHealthCheck({ name: "DATABASE", probe: healthyProbe() })).toThrow(/lowercase/);
    expect(() => createNeonHealthCheck({ name: "", probe: healthyProbe() })).toThrow(/lowercase/);
    expect(() =>
      createNeonHealthCheck({ probe: {} as unknown as PostgresProbePort }),
    ).toThrow(/PostgresProbePort/);
  });
});
