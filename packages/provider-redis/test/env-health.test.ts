/**
 * Env-gated real-wire legs for the Upstash Redis REST accelerator
 * (RL-096 / PA-013).
 *
 * With the Upstash env surface exported (UPSTASH_REDIS_REST_URL +
 * UPSTASH_REDIS_REST_TOKEN) the legs RUN against the operator's live
 * accelerator: the pinned REST envelope end to end (PING, SET/GET,
 * SET NX, PTTL countdown, real expiry, DEL, the pinned EVAL increment),
 * the fixed-window limiter's real TTL behavior (window rollover,
 * boundary counting), and health composition over the live port. With
 * the keys absent they SKIP with the NAMED reason below — CI stays green
 * with the deterministic legs (zero silent passes, zero
 * skipped-as-passed lies — the AR-010 operator-phase discipline).
 *
 * Bounded by construction: every key the legs touch is run-scoped and
 * carries a mandatory TTL (the bounded-accelerator law — no durable
 * state is ever left behind).
 */
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DeterministicClock } from "@roamlink/testkit";
import { HealthRegistry, runHealthChecks } from "@roamlink/observability";
import {
  createRedisHealthCheck,
  DistributedFixedWindowLimiter,
  tryParseUpstashRedisEnv,
  UpstashRedisRestClient,
} from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REDIS_PARSED = tryParseUpstashRedisEnv(process.env);
const REDIS_CONFIG = REDIS_PARSED.ok ? REDIS_PARSED.config : undefined;

if (!REDIS_CONFIG) {
  console.log(
    "[RL-096/PA-013] SKIPPING the real-wire legs: the Upstash Redis env surface is not fully configured " +
      "(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN). The legs run in the operator phase against the live " +
      "accelerator (the pinned REST envelope end to end, the fixed-window limiter's real TTL behavior (window " +
      "rollover, boundary counting), health composition) — this skip is named, never a silent pass.",
  );
}

const realWire = REDIS_CONFIG ? it : it.skip;
const RUN_ID = Date.now().toString(36);

function livePort(): UpstashRedisRestClient {
  const config = REDIS_CONFIG;
  if (!config) throw new Error("unreachable: the gate above decides these legs");
  return new UpstashRedisRestClient({ baseUrl: config.baseUrl, token: config.token });
}

describe("the real-wire legs over the live Upstash Redis accelerator (env-gated, PA-013)", () => {
  realWire(
    "speaks the pinned REST envelope end to end (PING, SET/GET, SET NX, PTTL countdown, expiry, DEL, EVAL increment)",
    async () => {
      const port = livePort();
      const run = `rl096:pa013:${RUN_ID}`;
      // PING over the live envelope (bearer auth + JSON command array).
      await expect(port.ping()).resolves.toBe(true);
      // Bounded write + byte-exact read-back.
      await expect(port.setWithTtl(`${run}:obj`, "v1", 5_000)).resolves.toEqual({ stored: true });
      await expect(port.get(`${run}:obj`)).resolves.toBe("v1");
      // Real SET NX semantics: the second holder loses.
      await expect(port.setWithTtl(`${run}:lock`, "holder-1", 5_000, { onlyIfAbsent: true })).resolves.toEqual({
        stored: true,
      });
      await expect(port.setWithTtl(`${run}:lock`, "holder-2", 5_000, { onlyIfAbsent: true })).resolves.toEqual({
        stored: false,
      });
      await expect(port.get(`${run}:lock`)).resolves.toBe("holder-1");
      // Real PTTL: present, bounded by the written TTL, counting down.
      const ttl1 = await port.timeToLiveMs(`${run}:obj`);
      expect(ttl1).not.toBeNull();
      expect(ttl1 as number).toBeGreaterThan(0);
      expect(ttl1 as number).toBeLessThanOrEqual(5_000);
      await sleep(200);
      const ttl2 = await port.timeToLiveMs(`${run}:obj`);
      expect(ttl2).not.toBeNull();
      expect(ttl2 as number).toBeLessThan(ttl1 as number);
      // Real expiry at the TTL boundary: absence is a state, never an error.
      await expect(port.setWithTtl(`${run}:expire`, "gone", 1_000)).resolves.toEqual({ stored: true });
      await sleep(1_400);
      await expect(port.get(`${run}:expire`)).resolves.toBeNull();
      await expect(port.timeToLiveMs(`${run}:expire`)).resolves.toBeNull();
      // Delete + idempotent absence.
      await expect(port.delete(`${run}:obj`)).resolves.toBe(true);
      await expect(port.delete(`${run}:obj`)).resolves.toBe(false);
      // The pinned EVAL increment over the live wire: the counter counts,
      // and the FIRST increment guarantees the TTL (bounded state).
      await expect(port.incrementWithTtl(`${run}:window`, 5_000)).resolves.toEqual({
        count: 1,
        firstIncrement: true,
      });
      await expect(port.incrementWithTtl(`${run}:window`, 5_000, 2)).resolves.toEqual({
        count: 3,
        firstIncrement: false,
      });
      const counterTtl = await port.timeToLiveMs(`${run}:window`);
      expect(counterTtl).not.toBeNull();
      expect(counterTtl as number).toBeGreaterThan(0);
      expect(counterTtl as number).toBeLessThanOrEqual(5_000);
    },
    30_000,
  );

  realWire(
    "the fixed-window limiter rolls over at the epoch-aligned boundary with real TTLs (boundary counting)",
    async () => {
      const port = livePort();
      const keyPrefix = `ratelimit:pa013:${RUN_ID}`;
      const limiter = new DistributedFixedWindowLimiter({ windowMs: 1_000, maxCost: 3, keyPrefix }, port);
      const subject = "rollover-1";
      const windowKey = (bucket: number) => `${keyPrefix}:${subject}:${bucket}`;
      // Enter a FRESH window with ample margin so the fill + the denial
      // land in one epoch-aligned bucket.
      const intoWindow = Date.now() % 1_000;
      if (intoWindow > 250) await sleep(1_000 - intoWindow + 60);
      const fillAt = Date.now();
      const bucket = Math.floor(fillAt / 1_000);
      // Fill the window in ONE call (cost = maxCost): allowed, remaining 0.
      const fill = await limiter.tryTake(subject, 3, new Date(fillAt).toISOString());
      expect(fill).toMatchObject({ allowed: true, remaining: 0 });
      // Boundary counting: the bucket key carries a real TTL bounded by
      // the window length (the fixed-window law — state self-destructs).
      const ttl = await port.timeToLiveMs(windowKey(bucket));
      expect(ttl).not.toBeNull();
      expect(ttl as number).toBeGreaterThan(0);
      expect(ttl as number).toBeLessThanOrEqual(1_000);
      // A further take in the same window is denied with the
      // epoch-aligned retry hint.
      const denied = await limiter.tryTake(subject, 1, new Date().toISOString());
      if (denied.allowed) throw new Error("the same-window take must be denied");
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000);
      // Rollover: past the boundary the NEXT bucket opens fresh (its own
      // key, its own TTL) — the window state never leaks across buckets.
      await sleep(denied.retryAfterMs + 300);
      const rolled = await limiter.tryTake(subject, 1, new Date().toISOString());
      expect(rolled).toMatchObject({ allowed: true, remaining: 2 });
      const rolledBucket = Math.floor(Date.now() / 1_000);
      const rolledTtl = await port.timeToLiveMs(windowKey(rolledBucket));
      expect(rolledTtl).not.toBeNull();
      expect(rolledTtl as number).toBeGreaterThan(0);
      expect(rolledTtl as number).toBeLessThanOrEqual(1_000);
    },
    30_000,
  );

  realWire(
    "composes health over the live accelerator (an answered PING is healthy)",
    async () => {
      const clock = new DeterministicClock(START);
      const registry = new HealthRegistry();
      registry.register(createRedisHealthCheck({ port: livePort(), clock }));
      const report = await runHealthChecks(registry, { now: () => clock.now() });
      expect(report.state).toBe("healthy");
    },
    30_000,
  );

  realWire("keeps the live credential redacted from every stringification (RL-LOCK-016)", () => {
    const config = REDIS_CONFIG;
    if (!config) throw new Error("unreachable: the gate above decides these legs");
    const port = livePort();
    // Boolean-first so a failure prints true/false, never the value.
    const leaked =
      String(port).includes(config.token) ||
      JSON.stringify(port).includes(config.token) ||
      String(config).includes(config.token) ||
      inspect(config).includes(config.token);
    expect(leaked).toBe(false);
  });
});
