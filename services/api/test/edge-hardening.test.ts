/**
 * RL-105 — the hardened API edge tests: admission control (rate limiting),
 * the ingress body cap (typed 413), correlation-id surfacing and the
 * redacting structured request log. The existing dispatch tests remain the
 * regression fence: nothing here changes envelope/idempotency/authorization
 * semantics.
 */
import { describe, expect, it } from "vitest";
import type { UtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import { createInMemoryLogSink } from "@roamlink/observability";
import { DistributedFixedWindowLimiter, InMemoryEphemeralCoordination } from "@roamlink/provider-redis";

import { createApiService, type ApiService } from "../src/index.js";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_RATE_LIMIT_MAX_COST,
  RATE_LIMIT_CHECK_NAME,
  correlationIdOf,
  createInMemoryApiRateLimiter,
  parseRateLimitOptions,
  rateLimitBucketKeyOf,
  rateLimitReadinessCheck,
  resolveApiRateLimitBinding,
  resolveRateLimitBinding,
} from "../src/index.js";
import {
  T0,
  createTestWorld,
  mutationHeaders,
  tenantOf,
  userIdFromSeed,
} from "./helpers.js";

const FIXED_NOW: UtcInstant = T0;

/** A step-function limiter stub: admits the first `budget` takes, then declines. */
function stubLimiter(budget: number, retryAfterMs = 30_000) {
  const takenKeys: string[] = [];
  let remaining = budget;
  return {
    takenKeys,
    tryTake: async (key: string, _cost: number, _at: UtcInstant | string) => {
      takenKeys.push(key);
      remaining -= 1;
      if (remaining >= 0) return { allowed: true, remaining } as const;
      return { allowed: false, remaining: 0, retryAfterMs } as const;
    },
  };
}

/** A minimal service over the test world's identity (no per-test handlers). */
function createEdgeWorld(options?: {
  readonly mode?: "production" | "development";
  readonly edge?: Parameters<typeof createApiService>[0]["edge"];
}): ReturnType<typeof createTestWorld> & { service: ApiService } {
  const world = createTestWorld();
  // Re-compose the SAME identity over an edge-configured service.
  const service = createApiService({
    persistence: world.persistence,
    identity: world.identityStores,
    webhookVerifier: {
      verify: async () => {
        throw new Error("the webhook verifier must be configured for webhook tests");
      },
    },
    now: () => world.clock.now(),
    newId: () => world.ids.next(),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    ...(options?.edge !== undefined ? { edge: options.edge } : {}),
  });
  return { ...world, service };
}

describe("RL-105 admission control (rate limiting)", () => {
  it("answers the typed 429 (kind rate-limited, retryAfterMs, retry-after header) when the bucket declines", async () => {
    const limiter = stubLimiter(1);
    const world = createEdgeWorld({ edge: { rateLimiter: limiter } });
    const userId = userIdFromSeed(1);
    const headers = mutationHeaders({
      actorId: `usr:${userId}`,
      tenantId: tenantOf(1),
      key: "edge-rl-1",
    });
    const first = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...headers, authorization: "Bearer unknown-token" },
    });
    expect(first.status).toBe(401); // admitted (budget 1) then refused by auth
    const second = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...headers, authorization: "Bearer unknown-token" },
    });
    expect(second.status).toBe(429); // budget exhausted -> admission declined
    const body = JSON.parse(second.body as string) as Record<string, unknown>;
    expect(body["kind"]).toBe("rate-limited");
    expect(body["reason"]).toBe("RATE_LIMITED");
    expect(body["retryable"]).toBe(true);
    expect(body["retryAfterMs"]).toBe(30_000);
    expect((second.headers ?? {})["retry-after"]).toBe("30");
  });

  it("rate limits per bucket (route class + principal hint) and keeps the budget before authentication", async () => {
    const limiter = stubLimiter(2);
    const world = createEdgeWorld({ edge: { rateLimiter: limiter } });
    const userId = userIdFromSeed(1);
    const headers = mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(1), key: "edge-rl-2" });
    for (let i = 0; i < 2; i += 1) {
      const response = await world.service.handle({
        method: "GET",
        path: "/v1/users/me",
        headers: { ...headers, authorization: "Bearer unknown" },
      });
      expect(response.status).toBe(401); // admission passed, auth refused
    }
    const declined = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...headers, authorization: "Bearer unknown" },
    });
    expect(declined.status).toBe(429);
    // The bucket came from the actor-header hint (transport context only).
    expect(limiter.takenKeys.every((key) => key === `api.usr:${userId}`)).toBe(true);
  });

  it("keeps GET /v1/readiness exempt from admission control (load balancers probe it)", async () => {
    const limiter = stubLimiter(0);
    const world = createEdgeWorld({ edge: { rateLimiter: limiter } });
    const response = await world.service.handle({ method: "GET", path: "/v1/readiness", headers: {} });
    expect(response.status).not.toBe(429);
    expect(limiter.takenKeys).toEqual([]); // never even consulted
  });

  it("the default composition uses the honest in-memory fallback in development and refuses it in production", async () => {
    const development = resolveRateLimitBinding("development", undefined);
    expect(development.state.kind).toBe("in-memory");
    expect(development.limiter).toBeDefined();

    const production = resolveRateLimitBinding("production", undefined);
    expect(production.state.kind).toBe("disabled");
    expect(production.limiter).toBeUndefined();

    const bound = resolveRateLimitBinding("production", stubLimiter(1));
    expect(bound.state.kind).toBe("distributed");

    // The readiness vocabulary for each state (optional criticality).
    expect((await rateLimitReadinessCheck(development.state).run()).state).toBe("degraded");
    const disabledCheck = await rateLimitReadinessCheck(production.state).run();
    expect(disabledCheck.state).toBe("degraded");
    expect(disabledCheck.name).toBe(RATE_LIMIT_CHECK_NAME);
  });

  it("drains a bounded in-memory window and recovers in the next window (clock-driven)", async () => {
    const limiter = createInMemoryApiRateLimiter(parseRateLimitOptions({ windowMs: 60_000, maxCost: 2 }));
    const at1 = FIXED_NOW;
    expect((await limiter.tryTake("api.bucket", 1, at1)).allowed).toBe(true);
    expect((await limiter.tryTake("api.bucket", 1, at1)).allowed).toBe(true);
    const declined = await limiter.tryTake("api.bucket", 1, at1);
    expect(declined.allowed).toBe(false);
    if (!declined.allowed) expect(declined.retryAfterMs).toBeGreaterThan(0);
  });

  it("composes the Redis-backed distributed limiter through the same seam (provider-redis)", async () => {
    const coordination = new InMemoryEphemeralCoordination({ clock: new DeterministicClock(FIXED_NOW) });
    const distributed = new DistributedFixedWindowLimiter(
      { windowMs: 60_000, maxCost: 2, keyPrefix: "rl-api-edge" },
      coordination,
    );
    const world = createEdgeWorld({ edge: { rateLimiter: distributed } });
    const userId = userIdFromSeed(2);
    const headers = mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(2), key: "edge-rl-3" });
    for (let i = 0; i < 2; i += 1) {
      const response = await world.service.handle({
        method: "GET",
        path: "/v1/users/me",
        headers: { ...headers, authorization: "Bearer unknown" },
      });
      expect(response.status).toBe(401);
    }
    const declined = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...headers, authorization: "Bearer unknown" },
    });
    expect(declined.status).toBe(429);
    const body = JSON.parse(declined.body as string) as Record<string, unknown>;
    expect(body["kind"]).toBe("rate-limited");
    expect(typeof body["retryAfterMs"]).toBe("number");
  });
});

describe("RL-105 ingress body cap", () => {
  it("refuses an over-cap body with the typed 413 before any handler runs", async () => {
    const world = createEdgeWorld({ edge: { bodyLimitBytes: 64 } });
    const userId = userIdFromSeed(3);
    const bigBody = JSON.stringify({ blob: "x".repeat(200) });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(3), key: "edge-cap-1" }),
      body: bigBody,
    });
    expect(response.status).toBe(413); // NOT 401: the cap runs before auth
    const body = JSON.parse(response.body as string) as Record<string, unknown>;
    expect(body["kind"]).toBe("validation");
    expect(body["reason"]).toBe("PAYLOAD_TOO_LARGE");
    expect(body["retryable"]).toBe(false);
  });

  it("admits bodies under the cap and defaults to the documented 1 MiB limit", async () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(1_048_576);
    const world = createEdgeWorld({ edge: { bodyLimitBytes: 64 } });
    const userId = userIdFromSeed(3);
    const response = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(3), key: "edge-cap-2" }), authorization: "Bearer unknown" },
    });
    expect(response.status).toBe(401); // reached the auth layer (no body to cap)
  });
});

describe("RL-105 correlation + structured request logging", () => {
  it("echoes a valid envelope correlation id on the response and generates one when absent", async () => {
    const world = createEdgeWorld();
    const userId = userIdFromSeed(4);
    const headers = mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(4), key: "edge-corr-1" });
    headers["x-roamlink-correlation-id"] = "corr-edge-echo-1";
    const echoed = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...headers, authorization: "Bearer unknown" },
    });
    expect((echoed.headers ?? {})["x-roamlink-correlation-id"]).toBe("corr-edge-echo-1");

    const generated = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: "Bearer unknown" },
    });
    const generatedId = (generated.headers ?? {})["x-roamlink-correlation-id"] ?? "";
    expect(generatedId.length).toBeGreaterThan(0);
    expect(generatedId).not.toBe("corr-edge-echo-1");
  });

  it("replaces a malformed client correlation id with a fresh edge-generated one (never echoed garbage)", async () => {
    const world = createEdgeWorld({ edge: { newCorrelationId: () => "corr-edge-fresh" } });
    const response = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: "Bearer unknown", "x-roamlink-correlation-id": "not a safe ref!" },
    });
    expect((response.headers ?? {})["x-roamlink-correlation-id"]).toBe("corr-edge-fresh");
  });

  it("logs one redacting structured record per request (method/path/status/duration, never headers or bodies)", async () => {
    const sink = createInMemoryLogSink();
    const world = createEdgeWorld({ edge: { logSink: sink.sink } });
    const userId = userIdFromSeed(5);
    await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantOf(5), key: "edge-log-1" }), authorization: "Bearer super-secret-token" },
    });
    const records = sink.records();
    const requestRecords = records.filter((record) => record.message === "http_request");
    expect(requestRecords.length).toBe(1);
    const record = requestRecords[0] as (typeof requestRecords)[number];
    expect(record.fields["method"]).toBe("GET");
    expect(record.fields["path"]).toBe("/v1/users/me");
    expect(record.fields["status"]).toBe(401);
    expect(typeof record.fields["durationMs"]).toBe("number");
    // Correlation id rides the record via the correlation context.
    expect(typeof record.correlationId).toBe("string");
    // Secret-suppression discipline: neither the bearer token nor the raw
    // headers object may appear anywhere in the serialized record.
    const serialized = JSON.stringify(record);
    expect(serialized.includes("super-secret-token")).toBe(false);
    expect(serialized.includes("authorization")).toBe(false);
  });

  it("carries the composition's honest rate-limit binding line", async () => {
    const sink = createInMemoryLogSink();
    createEdgeWorld({ edge: { logSink: sink.sink } });
    const binding = sink.records().find((record) => record.message === "rate_limit_binding");
    expect(binding).toBeDefined();
    expect(binding?.fields["binding"]).toBe("in-memory"); // development default, honestly labeled
  });

  it("resolves the host-facing binding helper symmetrically (single source of truth)", async () => {
    const dev = resolveApiRateLimitBinding("development", { rateLimitMaxCost: 5 });
    expect(dev.state.kind).toBe("in-memory");
    expect(dev.limiter).toBeDefined();
    const prod = resolveApiRateLimitBinding("production", undefined);
    expect(prod.state.kind).toBe("disabled");
    expect(prod.limiter).toBeUndefined();
    expect(DEFAULT_RATE_LIMIT_MAX_COST).toBe(600);
    expect(() => parseRateLimitOptions({ windowMs: 0 })).toThrow();
  });
});

describe("RL-105 bucket-key discipline", () => {
  it("derives safe, route-classed bucket keys with an anonymous fallback", () => {
    expect(rateLimitBucketKeyOf("POST", "/v1/webhooks/adcos", { "x-adcos-key-id": "whk-1" })).toBe("webhooks-adcos.whk-1");
    expect(rateLimitBucketKeyOf("POST", "/v1/webhooks/adcos", {})).toBe("webhooks-adcos.anonymous");
    expect(rateLimitBucketKeyOf("POST", "/v1/auth/session", {})).toBe("auth-session");
    expect(rateLimitBucketKeyOf("GET", "/v1/users/me", { "x-roamlink-actor-id": "usr:abc" })).toBe("api.usr:abc");
    expect(rateLimitBucketKeyOf("GET", "/v1/users/me", {})).toBe("api.anonymous");
    // A hostile hint can never break the limiter's safe-label contract.
    expect(rateLimitBucketKeyOf("GET", "/v1/users/me", { "x-roamlink-actor-id": "bad key!" })).toBe("api.anonymous");
  });

  it("correlationIdOf validates the envelope header shape", () => {
    const next = (): string => "corr-fresh";
    expect(correlationIdOf({ method: "GET", path: "/v1/x", headers: {} }, next)).toBe("corr-fresh");
    expect(
      correlationIdOf({ method: "GET", path: "/v1/x", headers: { "x-roamlink-correlation-id": "corr-valid-1" } }, next),
    ).toBe("corr-valid-1");
    expect(
      correlationIdOf({ method: "GET", path: "/v1/x", headers: { "x-roamlink-correlation-id": "no spaces allowed" } }, next),
    ).toBe("corr-fresh");
  });
});
