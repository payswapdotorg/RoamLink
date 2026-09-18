/**
 * Distributed fixed-window limiter tests (RL-096): decision parity with
 * the resilience shape, epoch-aligned windows, bounded TTL state,
 * deterministic under the testkit clock.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { DistributedFixedWindowLimiter, InMemoryEphemeralCoordination } from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";

function makeLimiter(windowMs = 60_000, maxCost = 3) {
  const clock = new DeterministicClock(START);
  const port = new InMemoryEphemeralCoordination({ clock });
  const limiter = new DistributedFixedWindowLimiter(
    { windowMs, maxCost, keyPrefix: "ratelimit:demo" },
    port,
  );
  return { clock, port, limiter };
}

describe("DistributedFixedWindowLimiter (RL-096)", () => {
  it("admits up to maxCost then rejects with an epoch-aligned retry hint", async () => {
    const { limiter, clock } = makeLimiter(60_000, 3);
    const t0 = START;
    await expect(limiter.tryTake("org-1", 1, t0)).resolves.toEqual({ allowed: true, remaining: 2 });
    await expect(limiter.tryTake("org-1", 1, t0)).resolves.toEqual({ allowed: true, remaining: 1 });
    await expect(limiter.tryTake("org-1", 1, t0)).resolves.toEqual({ allowed: true, remaining: 0 });
    const decision = await limiter.tryTake("org-1", 1, t0);
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
    clock.advanceBy(59_999);
    await expect(limiter.tryTake("org-1", 1, "2026-01-15T10:00:59.999Z")).resolves.toMatchObject({
      allowed: false,
    });
    clock.advanceBy(1);
    await expect(limiter.tryTake("org-1", 1, "2026-01-15T10:01:00.000Z")).resolves.toEqual({
      allowed: true,
      remaining: 2,
    });
  });

  it("keys state per subject (per-tenant isolation)", async () => {
    const { limiter } = makeLimiter(60_000, 1);
    await expect(limiter.tryTake("org-1", 1, START)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.tryTake("org-1", 1, START)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.tryTake("org-2", 1, START)).resolves.toMatchObject({ allowed: true });
  });

  it("keys state per window bucket, not per call time", async () => {
    const { limiter, clock } = makeLimiter(60_000, 10);
    await limiter.tryTake("org-1", 4, START);
    clock.advanceBy(30_000);
    await expect(limiter.tryTake("org-1", 6, "2026-01-15T10:00:30.000Z")).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("keeps window state bounded (TTL present on the counter key)", async () => {
    const { limiter, port } = makeLimiter(60_000, 10);
    await limiter.tryTake("org-1", 1, START);
    const bucket = Math.floor(Date.parse(START) / 60_000);
    await expect(port.timeToLiveMs(`ratelimit:demo:org-1:${bucket}`)).resolves.toBeGreaterThan(0);
  });

  it("rejects invalid configuration and inputs", async () => {
    const clock = new DeterministicClock(START);
    const port = new InMemoryEphemeralCoordination({ clock });
    expect(() =>
      new DistributedFixedWindowLimiter({ windowMs: 500, maxCost: 3, keyPrefix: "p" }, port),
    ).toThrow(/windowMs/);
    expect(() =>
      new DistributedFixedWindowLimiter({ windowMs: 60_000, maxCost: 0, keyPrefix: "p" }, port),
    ).toThrow(/maxCost/);
    expect(() =>
      new DistributedFixedWindowLimiter({ windowMs: 60_000, maxCost: 3, keyPrefix: "bad prefix!" }, port),
    ).toThrow(/keyPrefix/);
    const limiter = new DistributedFixedWindowLimiter({ windowMs: 60_000, maxCost: 3, keyPrefix: "p" }, port);
    await expect(limiter.tryTake("org-1", 0, START)).rejects.toThrow();
    await expect(limiter.tryTake("bad key!", 1, START)).rejects.toThrow();
    await expect(limiter.tryTake("org-1", 1, "not-a-time")).rejects.toThrow();
  });
});
