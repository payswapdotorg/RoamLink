import { describe, expect, it } from "vitest";
import {
  NEON_POOL_BOUNDS,
  NEON_POOL_DEFAULTS,
  parseNeonConnectionString,
  redactNeonConnectionString,
  resolveNeonPoolOptions,
} from "../src/index.js";

describe("parseNeonConnectionString (RL-095)", () => {
  const VALID = "postgresql://owner:s3cret@ep-cool-name-a1b2c3d4-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  it("accepts a TLS-enforced Neon connection string and classifies the pooled endpoint", () => {
    const parsed = parseNeonConnectionString(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config).toEqual({
      host: "ep-cool-name-a1b2c3d4-pooler.eu-central-1.aws.neon.tech",
      port: 5432,
      database: "neondb",
      pooledEndpoint: true,
      sslMode: "require",
    });
  });

  it("classifies direct (non-pooler) endpoints", () => {
    const parsed = parseNeonConnectionString(
      "postgres://owner:s3cret@ep-cool-name-a1b2c3d4.eu-central-1.aws.neon.tech:5432/neondb?sslmode=verify-full",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.pooledEndpoint).toBe(false);
    expect(parsed.config.sslMode).toBe("verify-full");
    expect(parsed.config.port).toBe(5432);
  });

  it("keeps an explicit application_name but never a credential", () => {
    const parsed = parseNeonConnectionString(
      "postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=require&application_name=roamlink-host",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.applicationName).toBe("roamlink-host");
    const asJson = JSON.stringify(parsed.config);
    expect(asJson).not.toContain("s3cret");
  });

  it.each([
    ["empty string", ""],
    ["not a URL", "not-a-url"],
    ["whitespace", "postgresql://owner:s3cret@ep-x.neon.tech/neondb ?sslmode=require"],
    ["wrong scheme", "mysql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=require"],
    ["missing host", "postgresql://owner:s3cret@/neondb?sslmode=require"],
    ["missing user", "postgresql://:s3cret@ep-x.neon.tech/neondb?sslmode=require"],
    ["missing password", "postgresql://owner@ep-x.neon.tech/neondb?sslmode=require"],
    ["missing database", "postgresql://owner:s3cret@ep-x.neon.tech/?sslmode=require"],
    ["sslmode absent", "postgresql://owner:s3cret@ep-x.neon.tech/neondb"],
    ["sslmode=disable (plaintext)", "postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=disable"],
    ["sslmode=prefer (weak)", "postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=prefer"],
    ["password as query parameter", "postgresql://owner@ep-x.neon.tech/neondb?sslmode=require&password=s3cret"],
    ["over-long string", `postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=require&pad=${"x".repeat(2100)}`],
  ])("rejects: %s (value-free failure)", (_label, raw) => {
    const parsed = parseNeonConnectionString(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.name).toMatch(/ValidationError$/);
    // value-free: the password and the connection string never appear
    expect(parsed.error.message).not.toContain("s3cret");
    if (raw.length > 0) {
      expect(parsed.error.message).not.toContain(raw);
    }
  });

  it("never echoes the input string in the failure message", () => {
    const secret = "postgresql://owner:super-secret-password-42@ep-x.neon.tech/neondb";
    const parsed = parseNeonConnectionString(secret);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).not.toContain("super-secret-password-42");
    const serialized = JSON.stringify(parsed.error.details ?? []);
    expect(serialized).not.toContain("super-secret-password-42");
  });
});

describe("redactNeonConnectionString (RL-LOCK-016)", () => {
  it("masks the password and keeps the shape", () => {
    const redacted = redactNeonConnectionString(
      "postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=require",
    );
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toContain("ep-x.neon.tech");
    expect(redacted).toContain("sslmode=require");
  });

  it("masks query-level password-like parameters", () => {
    const redacted = redactNeonConnectionString(
      "postgresql://owner@ep-x.neon.tech/neondb?sslmode=require&sslpassword=k",
    );
    expect(redacted).not.toContain("sslpassword=k");
    expect(redacted).toContain("sslpassword=");
  });

  it("returns a marker for unparseable input without throwing", () => {
    expect(redactNeonConnectionString(":::")).toBe("[unparseable-connection-string]");
  });
});

describe("resolveNeonPoolOptions (RL-095 operational guidance)", () => {
  it("returns the documented conservative defaults", () => {
    expect(resolveNeonPoolOptions()).toEqual(NEON_POOL_DEFAULTS);
  });

  it("accepts bounded overrides", () => {
    expect(resolveNeonPoolOptions({ maxConnections: 10 }).maxConnections).toBe(10);
    expect(resolveNeonPoolOptions({ idleTimeoutMs: 60_000 }).idleTimeoutMs).toBe(60_000);
  });

  it("rejects out-of-bounds overrides with the documented bounds", () => {
    expect(() => resolveNeonPoolOptions({ maxConnections: 0 })).toThrow(/maxConnections/);
    expect(() => resolveNeonPoolOptions({ maxConnections: NEON_POOL_BOUNDS.maxConnections.max + 1 })).toThrow(
      /maxConnections/,
    );
    expect(() => resolveNeonPoolOptions({ connectTimeoutMs: 10 })).toThrow(/connectTimeoutMs/);
  });
});
