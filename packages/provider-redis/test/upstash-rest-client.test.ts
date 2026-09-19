/**
 * Wire-behavior tests for the Upstash REST client (RL-096): envelope
 * handling, auth, failure mapping, secret hygiene. Complements the
 * port-parity battery (which proves behavioral equivalence).
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { RedisProviderError, UpstashRedisRestClient } from "../src/index.js";
import { createUpstashRestProtocol } from "./upstash-rest-protocol.js";

const START = "2026-01-15T10:00:00.000Z";
const TOKEN = "test-bearer-token-ascii-ONLY_01";
const BASE_URL = "https://example-redis.upstash.io";

function makeClient(overrides?: Partial<Parameters<typeof createUpstashRestProtocol>[0]>) {
  const clock = new DeterministicClock(START);
  const protocol = createUpstashRestProtocol({ clock, token: TOKEN, ...overrides });
  const client = new UpstashRedisRestClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchLike: protocol.fetchLike,
  });
  return { clock, protocol, client };
}

describe("UpstashRedisRestClient wire behavior (RL-096)", () => {
  it("sends the bearer token, JSON command array and reads the result envelope", async () => {
    const { client, protocol } = makeClient();
    await expect(client.setWithTtl("cache:wire", "abc", 10_000)).resolves.toEqual({ stored: true });
    const entry = protocol.requests[protocol.requests.length - 1];
    expect(entry?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(entry?.command).toEqual(["SET", "cache:wire", "abc", "PX", "10000"]);
    await expect(client.get("cache:wire")).resolves.toBe("abc");
  });

  it("maps NX misses to stored:false", async () => {
    const { client } = makeClient();
    await client.setWithTtl("coord:w", "h1", 10_000, { onlyIfAbsent: true });
    await expect(client.setWithTtl("coord:w", "h2", 10_000, { onlyIfAbsent: true })).resolves.toEqual({
      stored: false,
    });
  });

  it("maps a 401 to a typed, detail-suppressed provider error", async () => {
    const clock = new DeterministicClock(START);
    const protocol = createUpstashRestProtocol({ clock, token: "different-token" });
    const client = new UpstashRedisRestClient({ baseUrl: BASE_URL, token: TOKEN, fetchLike: protocol.fetchLike });
    const promise = client.get("cache:k");
    await expect(promise).rejects.toBeInstanceOf(RedisProviderError);
    await client.get("cache:k").catch((error: RedisProviderError) => {
      expect(error.phase).toBe("provider-error");
      expect(error.message).not.toContain("Unauthorized");
      expect(error.message).not.toContain(TOKEN);
    });
  });

  it("maps network-level failures to request-not-sent", async () => {
    const { client } = makeClient({ failNext: { count: 1 } });
    const error = await client.get("cache:k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisProviderError);
    expect((error as RedisProviderError).phase).toBe("request-not-sent");
  });

  it("maps non-JSON responses to response-unusable (fail closed)", async () => {
    const { client } = makeClient({ corruptNext: { count: 1 } });
    const error = await client.get("cache:k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisProviderError);
    expect((error as RedisProviderError).phase).toBe("response-unusable");
  });

  it("never includes the token in its stringifications (RL-LOCK-016)", async () => {
    const { client } = makeClient();
    expect(String(client)).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
  });

  it("rejects non-HTTPS base URLs and invalid tokens at construction", () => {
    const clock = new DeterministicClock(START);
    const protocol = createUpstashRestProtocol({ clock, token: TOKEN });
    expect(
      () => new UpstashRedisRestClient({ baseUrl: "http://example-redis.upstash.io", token: TOKEN, fetchLike: protocol.fetchLike }),
    ).toThrow(/https/i);
    expect(
      () => new UpstashRedisRestClient({ baseUrl: BASE_URL, token: "has space", fetchLike: protocol.fetchLike }),
    ).toThrow(/token/);
  });

  it("ping() reports false (never throws) when the accelerator is unreachable", async () => {
    const { client } = makeClient({ failNext: { count: 1 } });
    await expect(client.ping()).resolves.toBe(false);
  });
});
