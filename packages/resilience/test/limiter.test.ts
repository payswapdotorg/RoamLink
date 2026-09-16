/**
 * RL-053 tests: token bucket + sliding window limiters - deterministic
 * admission math under explicit instants (testkit clock discipline).
 */
import { describe, expect, it } from "vitest";

import { SlidingWindowLimiter, TokenBucketLimiter } from "../src/index.js";
import { fixtureUtcInstant } from "@roamlink/testkit";

const T0 = fixtureUtcInstant();

describe("TokenBucketLimiter", () => {
  it("starts full and drains by capacity", () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillTokensPerMs: 0.001 });
    expect(limiter.tryTake("tenant-a", 3, T0)).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.tryTake("tenant-a", 1, T0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("refills continuously with elapsed time (1000ms at 0.001/ms = 1 token)", () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillTokensPerMs: 0.001 });
    expect(limiter.tryTake("k", 2, T0)).toMatchObject({ allowed: true });
    expect(limiter.tryTake("k", 1, T0)).toMatchObject({ allowed: false });
    expect(limiter.tryTake("k", 1, fixtureUtcInstant(1_000))).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("caps refill at capacity (no banking beyond the burst)", () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillTokensPerMs: 1 });
    expect(limiter.tryTake("k", 2, T0)).toMatchObject({ allowed: true });
    expect(limiter.tryTake("k", 2, fixtureUtcInstant(60_000))).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    // 1ms elapsed at 1 token/ms refills exactly 1 token: 2 are still needed
    expect(limiter.tryTake("k", 2, fixtureUtcInstant(60_001))).toMatchObject({
      allowed: false,
      remaining: 1,
    });
  });

  it("computes exact retryAfterMs from the refill deficit", () => {
    const limiter = new TokenBucketLimiter({ capacity: 10, refillTokensPerMs: 0.01 });
    expect(limiter.tryTake("k", 10, T0)).toMatchObject({ allowed: true });
    const denied = limiter.tryTake("k", 5, T0);
    expect(denied).toMatchObject({ allowed: false });
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBe(500); // 5 tokens / 0.01 per ms
    }
  });

  it("isolates state per key and validates keys/costs/config", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillTokensPerMs: 0.0001 });
    expect(limiter.tryTake("tenant-a", 1, T0)).toMatchObject({ allowed: true });
    expect(limiter.tryTake("tenant-b", 1, T0)).toMatchObject({ allowed: true });
    expect(limiter.trackedKeys).toBe(2);
    expect(() => limiter.tryTake("bad key!", 1, T0)).toThrow(/safe label/);
    expect(() => limiter.tryTake("k", 0, T0)).toThrow(/tokens/);
    expect(() => limiter.tryTake("k", 2, T0)).toThrow(/capacity/);
    expect(() => new TokenBucketLimiter({ capacity: 0, refillTokensPerMs: 1 })).toThrow(/capacity/);
    expect(() => new TokenBucketLimiter({ capacity: 1, refillTokensPerMs: 0 })).toThrow(
      /refillTokensPerMs/,
    );
    expect(limiter.snapshot("tenant-a")).toMatchObject({ tokens: 0 });
    expect(limiter.snapshot("never-seen")).toBeUndefined();
  });
});

describe("SlidingWindowLimiter", () => {
  it("admits while the in-window cost stays within maxCost", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 60_000, maxCost: 3 });
    expect(limiter.tryTake("k", 1, T0)).toEqual({ allowed: true, remaining: 2 });
    expect(limiter.tryTake("k", 2, T0)).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.tryTake("k", 1, T0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("slides: costs older than the window stop counting", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1_000, maxCost: 1 });
    expect(limiter.tryTake("k", 1, T0)).toMatchObject({ allowed: true });
    expect(limiter.tryTake("k", 1, fixtureUtcInstant(999))).toMatchObject({ allowed: false });
    // the window is (at - windowMs, at] with an EXCLUSIVE lower edge: at
    // t=1000 the T0 event is exactly windowMs old and has slid out
    expect(limiter.tryTake("k", 1, fixtureUtcInstant(1_000))).toMatchObject({ allowed: true });
  });

  it("rejects with the earliest slide-out retry hint", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 10_000, maxCost: 1 });
    expect(limiter.tryTake("k", 1, T0)).toMatchObject({ allowed: true });
    const denied = limiter.tryTake("k", 1, fixtureUtcInstant(4_000));
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBe(6_000); // oldest event leaves at T0+10s
    }
  });

  it("validates config, cost and keys; snapshots are read-only", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1_000, maxCost: 2 });
    expect(() => new SlidingWindowLimiter({ windowMs: 0, maxCost: 1 })).toThrow(/windowMs/);
    expect(() => limiter.tryTake("k", 0, T0)).toThrow(/cost/);
    expect(() => limiter.tryTake("k", 3, T0)).toThrow(/cost/);
    expect(() => limiter.tryTake("bad key", 1, T0)).toThrow(/safe label/);
    limiter.tryTake("k", 1, T0);
    expect(limiter.snapshot("k")).toEqual({ activeCost: 1, eventCount: 1 });
    expect(limiter.snapshot("other")).toBeUndefined();
  });
});
