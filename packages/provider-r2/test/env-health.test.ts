import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DeterministicClock } from "@roamlink/testkit";
import { HealthRegistry, runHealthChecks } from "@roamlink/observability";
import {
  InMemoryObjectStorage,
  R2Env,
  createObjectStorageHealthCheck,
  tryParseR2Env,
  type ObjectStoragePort,
} from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";

function failingPort(): ObjectStoragePort {
  return {
    put: async () => {
      throw new Error("not used");
    },
    get: async () => {
      throw new Error("ECONNREFUSED https://account.r2.cloudflarestorage.com (suppressed)");
    },
    delete: async () => false,
    list: async () => ({ keys: [], truncated: false }),
    presign: async () => new URL("https://fake-r2.local/x"),
  };
}

describe("tryParseR2Env (RL-098)", () => {
  it("parses valid credentials, deriving the endpoint from the account id", () => {
    const result = tryParseR2Env({
      R2_ACCOUNT_ID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "s3cret-key",
      R2_BUCKET: "roamlink-artifacts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.endpoint).toBe("https://a1b2c3d4e5f60718293a4b5c6d7e8f90.r2.cloudflarestorage.com");
    expect(result.config.bucket).toBe("roamlink-artifacts");
    expect(String(result.config)).not.toContain("s3cret-key");
    expect(inspect(result.config)).not.toContain("s3cret-key");
    expect(JSON.stringify(result.config)).not.toContain("s3cret-key");
    expect(result.config).toBeInstanceOf(R2Env);
  });

  it("honors an explicit R2_ENDPOINT override", () => {
    const result = tryParseR2Env({
      R2_ACCOUNT_ID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "s3cret-key",
      R2_BUCKET: "roamlink-artifacts",
      R2_ENDPOINT: "https://custom.example.org",
    });
    expect(result.ok).toBe(true);
    if (result.ok) return;
    void 0;
  });

  it("rejects a malformed account id, http endpoints and bad bucket names (keys only)", () => {
    for (const source of [
      { R2_ACCOUNT_ID: "not-hex", R2_ACCESS_KEY_ID: "A", R2_SECRET_ACCESS_KEY: "S", R2_BUCKET: "bucket-ok" },
      {
        R2_ACCOUNT_ID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        R2_ACCESS_KEY_ID: "A",
        R2_SECRET_ACCESS_KEY: "S",
        R2_BUCKET: "roamlink-artifacts",
        R2_ENDPOINT: "http://insecure.example.org",
      },
      {
        R2_ACCOUNT_ID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        R2_ACCESS_KEY_ID: "A",
        R2_SECRET_ACCESS_KEY: "S",
        R2_BUCKET: "Bad_Bucket",
      },
    ]) {
      const result = tryParseR2Env(source);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain("values are never included");
      expect(result.error.message).not.toContain("s3cret-key");
    }
  });

  it("fails naming required keys when absent", () => {
    const result = tryParseR2Env({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("R2_SECRET_ACCESS_KEY");
    expect(result.error.message).toContain("R2_BUCKET");
  });
});

describe("createObjectStorageHealthCheck (RL-098)", () => {
  it("reports healthy when the probe GET answers (absent object is healthy)", async () => {
    const clock = new DeterministicClock(START);
    const port = new InMemoryObjectStorage();
    const check = createObjectStorageHealthCheck({ port, clock });
    const result = await check.run();
    expect(result).toMatchObject({ name: "object-storage", state: "healthy", checkedAt: START });
  });

  it("reports down with a suppressed detail when the probe throws", async () => {
    const clock = new DeterministicClock(START);
    const check = createObjectStorageHealthCheck({
      port: failingPort(),
      clock,
    });
    const result = await check.run();
    expect(result.state).toBe("down");
    expect(result.detail).not.toContain("ECONNREFUSED");
    expect(result.detail).not.toContain("r2.cloudflarestorage.com");
  });

  it("composes with the observability HealthRegistry", async () => {
    const clock = new DeterministicClock(START);
    const registry = new HealthRegistry();
    registry.register(createObjectStorageHealthCheck({ port: new InMemoryObjectStorage(), clock }));
    const report = await runHealthChecks(registry, { now: () => clock.now() });
    expect(report.state).toBe("healthy");
  });

  it("rejects invalid names", () => {
    const port = new InMemoryObjectStorage();
    expect(() => createObjectStorageHealthCheck({ port, name: "OBJECT" })).toThrow(/lowercase/);
  });
});
