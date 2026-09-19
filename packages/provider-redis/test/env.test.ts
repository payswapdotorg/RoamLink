import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { tryParseUpstashRedisEnv, UpstashRedisRestEnv } from "../src/index.js";

const TOKEN = "AXX1-example-token-ascii_01";

describe("tryParseUpstashRedisEnv (RL-096)", () => {
  it("parses a valid pair into a redacting config object", () => {
    const result = tryParseUpstashRedisEnv({
      UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: TOKEN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.baseUrl).toBe("https://example-redis.upstash.io");
    expect(result.config.token).toBe(TOKEN);
    // secret hygiene
    expect(String(result.config)).not.toContain(TOKEN);
    expect(inspect(result.config)).not.toContain(TOKEN);
    expect(JSON.stringify(result.config)).not.toContain(TOKEN);
    expect(result.config).toBeInstanceOf(UpstashRedisRestEnv);
  });

  it("rejects http:// (credentials on the wire)", () => {
    const result = tryParseUpstashRedisEnv({
      UPSTASH_REDIS_REST_URL: "http://example-redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: TOKEN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("UPSTASH_REDIS_REST_URL");
  });

  it("fails naming KEYS only when missing", () => {
    for (const source of [{}, { UPSTASH_REDIS_REST_URL: "" }, { UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }]) {
      const result = tryParseUpstashRedisEnv(source);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain("values are never included");
      expect(result.error.message).not.toContain(TOKEN);
    }
  });
});
