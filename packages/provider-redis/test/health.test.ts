import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { InMemoryEphemeralCoordination, createRedisHealthCheck } from "../src/index.js";
import type { EphemeralCoordinationPort } from "../src/index.js";
import { runHealthChecks, HealthRegistry } from "@roamlink/observability";

const START = "2026-01-15T10:00:00.000Z";

describe("createRedisHealthCheck (RL-096)", () => {
  it("reports healthy when PING succeeds (deterministic checkedAt)", async () => {
    const clock = new DeterministicClock(START);
    const port = new InMemoryEphemeralCoordination({ clock });
    const check = createRedisHealthCheck({ port, clock });
    const result = await check.run();
    expect(result).toMatchObject({ name: "redis", state: "healthy", checkedAt: START });
  });

  it("reports down with a suppressed detail when PING fails", async () => {
    const clock = new DeterministicClock(START);
    const failing: EphemeralCoordinationPort = {
      get: async () => null,
      setWithTtl: async () => ({ stored: false }),
      delete: async () => false,
      incrementWithTtl: async () => ({ count: 1, firstIncrement: true }),
      timeToLiveMs: async () => null,
      ping: async () => false,
    };
    const check = createRedisHealthCheck({ port: failing, clock });
    const result = await check.run();
    expect(result.state).toBe("down");
    expect(result.detail).toBeDefined();
    expect(result.detail).not.toMatch(/error|exception/i);
  });

  it("reports down when the probe throws (suppressed)", async () => {
    const clock = new DeterministicClock(START);
    const throwing: EphemeralCoordinationPort = {
      get: async () => null,
      setWithTtl: async () => ({ stored: false }),
      delete: async () => false,
      incrementWithTtl: async () => ({ count: 1, firstIncrement: true }),
      timeToLiveMs: async () => null,
      ping: async () => {
        throw new Error("connection refused (may embed endpoint details)");
      },
    };
    const check = createRedisHealthCheck({ port: throwing, clock });
    const result = await check.run();
    expect(result.state).toBe("down");
    expect(result.detail).not.toContain("connection refused");
  });

  it("composes with the HealthRegistry (degraded accelerator -> down contribution)", async () => {
    const clock = new DeterministicClock(START);
    const port = new InMemoryEphemeralCoordination({ clock });
    const registry = new HealthRegistry();
    registry.register(createRedisHealthCheck({ port, clock }));
    const report = await runHealthChecks(registry, { now: () => clock.now() });
    expect(report.state).toBe("healthy");
  });

  it("rejects invalid names", () => {
    const clock = new DeterministicClock(START);
    const port = new InMemoryEphemeralCoordination({ clock });
    expect(() => createRedisHealthCheck({ port, clock, name: "REDIS" })).toThrow(/lowercase/);
  });
});
