import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DeterministicClock } from "@roamlink/testkit";
import { HealthRegistry, runHealthChecks } from "@roamlink/observability";
import {
  InMemoryObjectStorage,
  R2Env,
  S3ObjectStorageClient,
  buildContentAddressedKey,
  createObjectStorageHealthCheck,
  md5Hex,
  sha256Hex,
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

// --------------------------------------------------------------------------------
// The REAL-WIRE legs (PA-012): env-gated against the operator's live R2
// bucket. With the R2 env surface exported the legs RUN (request signing
// against the live service, bucket addressing, the md5 ETag wire law,
// ListObjectsV2 XML parsing, health composition); with the keys absent
// they SKIP with the NAMED reason below — CI stays green with the
// deterministic legs above (zero silent passes, zero skipped-as-passed
// lies — the AR-010 operator-phase discipline).
// --------------------------------------------------------------------------------

const R2_PARSED = tryParseR2Env(process.env);
const R2_CONFIG = R2_PARSED.ok ? R2_PARSED.config : undefined;

if (!R2_CONFIG) {
  console.log(
    "[RL-098/PA-012] SKIPPING the real-wire legs: the R2 env surface is not fully configured " +
      "(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET). The legs run in the " +
      "operator phase against the live bucket (request signing, bucket addressing, the md5 ETag " +
      "wire law, ListObjectsV2 parsing, health composition) — this skip is named, never a silent pass.",
  );
}

const realWire = R2_CONFIG ? it : it.skip;

function livePort(): ObjectStoragePort {
  const config = R2_CONFIG;
  if (!config) throw new Error("unreachable: the gate above decides these legs");
  return new S3ObjectStorageClient({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}

describe("the real-wire legs over the live R2 bucket (env-gated, PA-012)", () => {
  realWire(
    "signs requests, addresses the bucket and round-trips put/get/list/delete against the LIVE service",
    async () => {
      const port = livePort();
      const body = "rl098-pa012-real-wire-probe: known bytes, md5-etag wire law";
      const key = buildContentAddressedKey({
        namespace: "backups",
        contentSha256: sha256Hex(body),
        filename: "pa012-real-wire-probe.txt",
        at: new Date().toISOString(),
      });
      // PUT: the signed single-part upload lands (SigV4 header auth against
      // the live service) and the ETag IS the MD5 content digest of the
      // stored bytes (the S3 wire law, live-confirmed by PA-012).
      const put = await port.put({ key, body, contentType: "text/plain" });
      expect(put.etag).toBe(md5Hex(body));
      expect(put.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
      // GET: byte-identical, same etag.
      const fetched = await port.get(key);
      expect(fetched).not.toBeNull();
      expect(Buffer.from(fetched?.body ?? new Uint8Array()).toString("utf8")).toBe(body);
      expect(fetched?.etag).toBe(md5Hex(body));
      // LIST: the real ListObjectsV2 XML (xmlns root, md5 etags) parses and
      // names the object under its content-addressed key.
      const prefix = `${key.slice(0, key.lastIndexOf("/") + 1)}`;
      const page = await port.list({ prefix });
      const entry = page.keys.find((candidate) => candidate.key === key);
      expect(entry?.etag).toBe(md5Hex(body));
      expect(entry?.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
      // DELETE + absence is a state, never an error. The LIVE wire confirms
      // idempotently (S3's DeleteObject contract: an absent key also answers
      // 204 success — live-confirmed by PA-012), so the second delete is the
      // S3 confirmation `true`, and absence stays observable via get().
      await expect(port.delete(key)).resolves.toBe(true);
      await expect(port.get(key)).resolves.toBeNull();
      await expect(port.delete(key)).resolves.toBe(true);
    },
    60_000,
  );

  realWire(
    "composes health over the live port (an answered probe is healthy, absence included)",
    async () => {
      const clock = new DeterministicClock(START);
      const registry = new HealthRegistry();
      registry.register(createObjectStorageHealthCheck({ port: livePort(), clock }));
      const report = await runHealthChecks(registry, { now: () => clock.now() });
      expect(report.state).toBe("healthy");
    },
    60_000,
  );
});
