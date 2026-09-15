import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import {
  ADCOS_API_VERSION_DEFAULT,
  ENV_KEYS,
  parseEnv,
  tryParseEnv,
} from "../src/env/env-schema.js";
import { ValidationError } from "../src/errors/errors.js";

const DEV_ENV: Record<string, string> = {
  NODE_ENV: "development",
  ROAMLINK_API_BASE_URL: "http://localhost:3000",
  ROAMLINK_PUBLIC_API_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://localhost:5432/roamlink",
  REDIS_URL: "redis://localhost:6379",
  ADCOS_API_BASE_URL: "https://adcos.example.com",
  ADCOS_API_VERSION: "2.0",
  ADCOS_CLIENT_ID: "roamlink-sandbox",
  ADCOS_CLIENT_SECRET: "dev-only-not-a-real-secret",
  ADCOS_WEBHOOK_SECRET: "dev-only-webhook-secret",
};

describe("env schema (fail-closed, matches .env.example exactly)", () => {
  it("recognizes exactly the .env.example key set", () => {
    expect([...ENV_KEYS]).toEqual([
      "NODE_ENV",
      "ROAMLINK_API_BASE_URL",
      "ROAMLINK_PUBLIC_API_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "ADCOS_API_BASE_URL",
      "ADCOS_API_VERSION",
      "ADCOS_CLIENT_ID",
      "ADCOS_CLIENT_SECRET",
      "ADCOS_WEBHOOK_SECRET",
    ]);
  });

  it("parses a complete development environment", () => {
    const env = parseEnv(DEV_ENV);
    expect(env.nodeEnv).toBe("development");
    expect(env.roamlinkApiBaseUrl).toBe("http://localhost:3000");
    expect(env.adcosApiVersion).toBe("2.0");
    expect(env.adcosClientSecret).toBe("dev-only-not-a-real-secret");
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("requires nothing beyond NODE_ENV outside production", () => {
    const env = parseEnv({ NODE_ENV: "test" });
    expect(env.nodeEnv).toBe("test");
    expect(env.databaseUrl).toBe("");
    expect(env.adcosApiVersion).toBe(ADCOS_API_VERSION_DEFAULT);
  });

  it("NODE_ENV is always required", () => {
    const result = tryParseEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain("NODE_ENV");
    }
    expect(() => parseEnv({ NODE_ENV: "staging" })).toThrowError(/NODE_ENV/);
  });

  it("production missing keys fail loudly, naming the KEY ONLY (RL-LOCK-016)", () => {
    let error: ValidationError | undefined;
    try {
      parseEnv({ NODE_ENV: "production" });
    } catch (thrown) {
      error = thrown as ValidationError;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const message = error?.message ?? "";
    for (const key of [
      "ROAMLINK_API_BASE_URL",
      "ROAMLINK_PUBLIC_API_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "ADCOS_API_BASE_URL",
      "ADCOS_CLIENT_ID",
      "ADCOS_CLIENT_SECRET",
      "ADCOS_WEBHOOK_SECRET",
    ]) {
      expect(message, key).toContain(key);
    }
    // key names only - the error must not invent values
    expect(error?.details.every((detail) => detail.path !== undefined)).toBe(true);
  });

  it("a set-but-empty required key counts as missing in production", () => {
    const source: Record<string, string> = { ...DEV_ENV, NODE_ENV: "production", DATABASE_URL: "" };
    delete source["ADCOS_WEBHOOK_SECRET"];
    expect(() => parseEnv(source)).toThrowError(/DATABASE_URL/);
    expect(() => parseEnv(source)).toThrowError(/ADCOS_WEBHOOK_SECRET/);
  });

  it("secret VALUES never appear in thrown messages, String() or JSON (RL-LOCK-016)", () => {
    const clientSecret = "super-secret-CLIENT-VALUE";
    const webhookSecret = "super-secret-WEBHOOK-VALUE";
    let thrown: ValidationError | undefined;
    try {
      parseEnv({
        NODE_ENV: "production",
        ADCOS_CLIENT_SECRET: clientSecret,
        ADCOS_WEBHOOK_SECRET: webhookSecret,
        ADCOS_API_BASE_URL: "not a url at all", // force a validation error alongside secrets
      });
    } catch (error) {
      thrown = error as ValidationError;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown?.message).not.toContain(clientSecret);
    expect(thrown?.message).not.toContain(webhookSecret);
    expect(String(thrown)).not.toContain(clientSecret);
    expect(JSON.stringify(thrown)).not.toContain(clientSecret);
    expect(inspect(thrown)).not.toContain(clientSecret);
  });

  it("validates value formats, naming the key and expectation but never the value", () => {
    expect(() => parseEnv({ NODE_ENV: "development", ROAMLINK_API_BASE_URL: "not-a-url" })).toThrowError(
      /ROAMLINK_API_BASE_URL/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", ROAMLINK_PUBLIC_API_URL: "ftp://x" })).toThrowError(
      /ROAMLINK_PUBLIC_API_URL/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", DATABASE_URL: "has spaces inside" })).toThrowError(
      /DATABASE_URL/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", ADCOS_API_BASE_URL: " http://x" })).toThrowError(
      /ADCOS_API_BASE_URL/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", ADCOS_CLIENT_SECRET: "has spaces" })).toThrowError(
      /ADCOS_CLIENT_SECRET/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", REDIS_URL: "bad\nvalue" })).toThrowError(/REDIS_URL/);
    // connection strings without whitespace/controls are accepted as-is
    expect(() =>
      parseEnv({ NODE_ENV: "development", REDIS_URL: "redis://:password@host:6379/0" }),
    ).not.toThrow();
  });

  it("ADCOS_API_VERSION defaults to the pinned 2.0 and rejects other lines", () => {
    expect(parseEnv({ NODE_ENV: "development" }).adcosApiVersion).toBe("2.0");
    expect(parseEnv({ ...DEV_ENV, ADCOS_API_VERSION: "2.0" }).adcosApiVersion).toBe("2.0");
    expect(() => parseEnv({ NODE_ENV: "development", ADCOS_API_VERSION: "1.1" })).toThrowError(
      /ADCOS_API_VERSION/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", ADCOS_API_VERSION: "2" })).toThrowError(
      /ADCOS_API_VERSION/,
    );
  });

  it("rejects unknown ROAMLINK_/ADCOS_ keys as typos while ignoring unrelated keys", () => {
    expect(() => parseEnv({ NODE_ENV: "development", ROAMLINK_API_BASE_URLL: "http://x" })).toThrowError(
      /ROAMLINK_API_BASE_URLL/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", adcos_client_id: "x" })).toThrowError(
      /adcos_client_id/,
    );
    expect(() => parseEnv({ NODE_ENV: "development", PATH: "/usr/bin", HOME: "/root" })).not.toThrow();
  });

  it("secrets are redacted from toString, util.inspect and JSON.stringify", () => {
    const env = parseEnv(DEV_ENV);
    expect(String(env)).toContain("[REDACTED]");
    expect(String(env)).not.toContain("dev-only-not-a-real-secret");
    expect(inspect(env)).not.toContain("dev-only-not-a-real-secret");
    expect(inspect(env, { depth: 5, showHidden: true })).not.toContain("dev-only-not-a-real-secret");
    expect(JSON.stringify(env)).not.toContain("dev-only-not-a-real-secret");
    expect(JSON.stringify(env)).not.toContain("dev-only-webhook-secret");
    expect(JSON.parse(JSON.stringify(env))).not.toHaveProperty("adcosClientSecret");
    // legitimate access still works through the getters
    expect(env.adcosClientSecret).toBe("dev-only-not-a-real-secret");
    expect(env.adcosWebhookSecret).toBe("dev-only-webhook-secret");
    // structured redacted view
    expect(env.redactedView()["ADCOS_CLIENT_SECRET"]).toBe("[REDACTED]");
    expect(env.redactedView()["NODE_ENV"]).toBe("development");
  });

  it("tryParseEnv returns a discriminated result", () => {
    const ok = tryParseEnv(DEV_ENV);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.env.nodeEnv).toBe("development");
    }
    const bad = tryParseEnv({ NODE_ENV: "production" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.reason).toBe("ENV_INVALID");
    }
  });

  it("full production environment parses", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      ROAMLINK_API_BASE_URL: "https://api.roamlink.example",
      ROAMLINK_PUBLIC_API_URL: "https://api.roamlink.example",
      DATABASE_URL: "postgres://prod-db/roamlink",
      REDIS_URL: "rediss://prod-redis:6380",
      ADCOS_API_BASE_URL: "https://adcos.example.com",
      ADCOS_API_VERSION: "2.0",
      ADCOS_CLIENT_ID: "roamlink-prod",
      ADCOS_CLIENT_SECRET: "prod-secret-value-1",
      ADCOS_WEBHOOK_SECRET: "prod-webhook-secret-1",
    });
    expect(env.nodeEnv).toBe("production");
    expect(env.adcosApiVersion).toBe("2.0");
  });
});
