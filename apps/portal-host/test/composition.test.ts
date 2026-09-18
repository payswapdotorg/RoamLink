/**
 * The hosted composition root (RL-089): fail-closed boot, REAL readiness,
 * the env-parsed webhook key registry and the production scrypt KDF binding.
 */
import { describe, expect, it } from "vitest";

import {
  CompositionError,
  createPortalHostComposition,
  parseWebhookSigningKeys,
  ScryptPasswordHasher,
} from "../src/index.js";
import {
  createPostgresMigrationRunner,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePasswordHash, InsecureTestPasswordHasher, parsePasswordSecret } from "@roamlink/auth";

const PASSWORD = parsePasswordSecret("correct-horse-battery");
const OTHER_PASSWORD = parsePasswordSecret("wrong-password-123");

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

describe("the portal-host composition (fail-closed boot)", () => {
  it("refuses to boot without DATABASE_URL (never an in-memory fallback)", async () => {
    await expect(
      createPortalHostComposition({ mode: "production", databaseUrl: undefined }),
    ).rejects.toThrow(/DATABASE_URL is not configured/);
  });

  it("refuses to boot on an unsupported connection string", async () => {
    await expect(
      createPortalHostComposition({ mode: "production", databaseUrl: "mysql://nope" }),
    ).rejects.toThrow(/not a supported PostgreSQL connection string/);
  });

  it("refuses the embedded pglite engine in production mode", async () => {
    await expect(
      createPortalHostComposition({ mode: "production", databaseUrl: "pglite://" }),
    ).rejects.toThrow(/REFUSED in production mode/);
  });

  it("boots the embedded engine in development mode and reports an UNMIGRATED database as NOT ready", async () => {
    const composition = await createPortalHostComposition({
      mode: "development",
      databaseUrl: "pglite://",
    });
    try {
      const before = await composition.readyCheck();
      expect(before.ready).toBe(false);
      const migrations = before.checks.find((c) => c.name === "migrations");
      expect(migrations?.state).toBe("down");
    } finally {
      await composition.dispose();
    }
  });

  it("reports ready ONLY after the real infra/migrations are applied to its own driver", async () => {
    // The runner must be wired to the REAL infra/migrations (RL-092).
    setMigrationFileAccess({
      listDir: (dir) => readdirSync(dir),
      readTextFile: (path) => readFileSync(path, "utf8"),
    });
    setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
    const composition = await createPortalHostComposition({
      mode: "development",
      databaseUrl: "pglite://",
    });
    try {
      // The REAL migration set (infra/migrations) applied through the REAL
      // runner - the same artifact the deployment applies (RL-092).
      const runner = createPostgresMigrationRunner({ driver: composition.driver });
      const applied = await runner.migrateUp();
      expect(applied.length).toBeGreaterThanOrEqual(4);
      const report = await composition.readyCheck();
      expect(report.ready).toBe(true);
      const migrations = report.checks.find((c) => c.name === "migrations");
      expect(migrations?.state).toBe("healthy");
      expect(migrations?.detail).toMatch(/migration\(s\) applied/);
    } finally {
      await composition.dispose();
    }
  });
});

describe("parseWebhookSigningKeys (fail-closed key configuration)", () => {
  it("parses comma-separated keyId:secret pairs", () => {
    expect(parseWebhookSigningKeys("k1:s1, k2:s2")).toEqual({ k1: "s1", k2: "s2" });
  });

  it("treats absent/empty configuration as NO keys", () => {
    expect(parseWebhookSigningKeys(undefined)).toEqual({});
    expect(parseWebhookSigningKeys("   ")).toEqual({});
  });

  it("refuses malformed entries (nothing half-configured)", () => {
    expect(() => parseWebhookSigningKeys("k1")).toThrow(CompositionError);
    expect(() => parseWebhookSigningKeys("k1:,k2:s2")).toThrow(CompositionError);
    expect(() => parseWebhookSigningKeys(":s1")).toThrow(CompositionError);
  });
});

describe("the production scrypt KDF binding (RL-089 composition)", () => {
  const hasher = new ScryptPasswordHasher();

  it("round-trips a password through hash -> verify", async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(hash.algorithm).toBe("scrypt");
    expect(hash.digest.length).toBeLessThanOrEqual(512);
    expect(hash.digest).not.toContain("correct-horse-battery");
    expect(await hasher.verify(PASSWORD, hash)).toBe(true);
    expect(await hasher.verify(OTHER_PASSWORD, hash)).toBe(false);
  });

  it("salts per hash (two hashes of the same password differ)", async () => {
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);
    expect(first.digest).not.toBe(second.digest);
    expect(await hasher.verify(PASSWORD, second)).toBe(true);
  });

  it("rejects credentials of any other algorithm (the test double can never pass)", async () => {
    const testHasher = new InsecureTestPasswordHasher();
    const testHash = parsePasswordHash(await testHasher.hash(PASSWORD));
    expect(testHash.algorithm).toBe("insecure-test-sha256");
    expect(await hasher.verify(PASSWORD, testHash)).toBe(false);
  });

  it("rejects structurally broken scrypt digests (fail closed)", async () => {
    await hasher.hash(PASSWORD);
    expect(
      await hasher.verify(PASSWORD, {
        algorithm: "scrypt",
        digest: "scrypt$16384$8$1$nothex$nothexatall0000000000000000000000000000000000000000000000",
      }),
    ).toBe(false);
    expect(await hasher.verify(PASSWORD, { algorithm: "scrypt", digest: "garbage" })).toBe(false);
  });
});

describe("the migration path resolver pins infra/migrations (RL-092)", () => {
  it("sees the real migration files in the repository", () => {
    const files = readdirSync(join(REPO_ROOT, "infra", "migrations")).filter((f) =>
      f.endsWith(".up.sql"),
    );
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain("0001-roamlink-schema-ledger.up.sql");
    for (const file of files) {
      expect(readFileSync(join(REPO_ROOT, "infra", "migrations", file), "utf8").length).toBeGreaterThan(0);
    }
  });
});
