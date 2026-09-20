/**
 * RL-107/RL-108 — the worker host composition: the honest degraded state
 * when no delivery channel is configured, the full composition when the
 * seams are bound, the readiness vocabulary, and the ADCOS probe
 * composition laws (not-configured is honest; configured is fail-closed).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import { TEST_SIGNING_KEY_ID, TEST_SIGNING_SECRET } from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

import {
  createWorkerHost,
  ManualWorkerTimer,
  type OutboxDeliveryPort,
  type WorkerHostEnv,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0 = "2026-10-01T00:00:00.000Z" as UtcInstant;
void parseUtcInstant;

async function migratedPersistence() {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const driver = createPgliteDriver(db);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  return { db, driver, persistence: createPostgresPersistence(driver) };
}

function baseEnv(overrides: Partial<WorkerHostEnv> = {}): WorkerHostEnv {
  return {
    mode: "development",
    databaseUrl: "pglite://",
    ...overrides,
  };
}

describe("RL-107 the worker host composition", () => {
  it("with no delivery channel composed: no outbox drain, honest degraded readiness, records stay PENDING", async () => {
    const { db, persistence, driver } = await migratedPersistence();
    try {
      const host = await createWorkerHost(baseEnv(), { now: () => T0, persistence, driver });
      expect(host.outbox).toBeNull();
      const report = await host.readyCheck();
      expect(report.status).toBe("degraded:outbox-delivery");
      expect(report.ready).toBe(true); // servable, the degradation surfaced honestly
      const outboxCheck = report.checks.find((check) => check.name === "outbox-delivery");
      expect(outboxCheck?.state).toBe("degraded");
      expect(outboxCheck?.detail).toContain("records stay PENDING");
      await host.stop();
    } finally {
      await db.close();
    }
  });

  it("composes the full host when the delivery seam + ADCOS client are bound: drains the queue", async () => {
    const { db, persistence, driver } = await migratedPersistence();
    try {
      const delivered: string[] = [];
      const delivery: OutboxDeliveryPort = {
        async deliver(record) {
          delivered.push(record.idempotencyKey);
          return { outcome: "DELIVERED" };
        },
      };
      const fake = new FakeAdcos();
      const clock = new DeterministicClock(T0);
      const host = await createWorkerHost(
        baseEnv({
          webhookSigningKeys: { [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET },
        }),
        { delivery, adcOsClient: fake, now: () => clock.now(), timer: new ManualWorkerTimer(), persistence, driver },
      );
      expect(host.outbox).not.toBeNull();
      expect(host.inbox).not.toBeNull(); // the reconciliation boundary's inbox
      expect(host.reconciliation).not.toBeNull(); // the scheduler drive

      // Seed an obligation; start() must sweep then drain it.
      const seed = await persistence.begin();
      await seed.outbox.enqueue({ idempotencyKey: "host-1", payload: { a: 1 }, createdAt: T0 });
      await seed.commit();
      host.start();
      await host.whenSettled();
      await host.outbox?.tickOnce(); // drive the first bounded tick (manual timer)
      expect(delivered).toContain("host-1");
      expect(host.outbox?.snapshot().recoveredOnStart).toBe(0); // nothing stranded to sweep
      expect((await persistence.outbox.get("host-1"))?.deliveryState).toBe("DELIVERED");
      const report = await host.readyCheck();
      expect(report.ready).toBe(true);
      expect(report.status).not.toContain("not-ready");
      await host.stop();
    } finally {
      await db.close();
    }
  });

  it("a host whose database is unreachable is honestly NOT ready (never ready-with-secrets-suppressed)", async () => {
    // A composition over a CLOSED driver: the required database probe answers down.
    const { db, persistence, driver } = await migratedPersistence();
    const host = await createWorkerHost(baseEnv(), {
      delivery: { async deliver() { return { outcome: "DELIVERED" as const }; } },
      now: () => T0,
      persistence,
      driver,
    });
    try {
      // Sanity: ready while the engine is open.
      expect((await host.readyCheck()).ready).toBe(true);
    } finally {
      await db.close(); // "unreachable" now
    }
    const report = await host.readyCheck();
    expect(report.ready).toBe(false);
    expect(report.status).toBe("not-ready:database,migrations"); // both REQUIRED probes honestly down
    void persistence;
  });
});

describe("RL-108 the probe composition in the worker host", () => {
  it("an absent ADCOS env reports not-configured honestly and composes nothing", async () => {
    const { db, persistence, driver } = await migratedPersistence();
    try {
      const host = await createWorkerHost(baseEnv({ adcOsEnv: {} }), { now: () => T0, persistence, driver });
      expect(host.probeResult?.status).toBe("not-configured");
      expect(host.compatibility).toBeNull();
      expect(host.reconciliation).toBeNull();
      const report = await host.readyCheck();
      expect(report.checks.find((check) => check.name === "adcos-compatibility")).toBeUndefined();
      await host.stop();
    } finally {
      await db.close();
    }
  });

  it("a configured probe runs the suite against the client and applies the fail-closed state", async () => {
    const { db, persistence, driver } = await migratedPersistence();
    try {
      const fake = new FakeAdcos(); // seeds the probe resources by default -> compatible
      const host = await createWorkerHost(
        baseEnv({
          adcOsEnv: {
            ADCOS_API_BASE_URL: "https://adcos.example.test",
            ADCOS_CLIENT_ID: "roamlink-worker",
            ADCOS_CLIENT_SECRET: "env-only-never-committed",
            ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
            ADCOS_API_VERSION: "2.0",
          },
          webhookSigningKeys: { [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET },
        }),
        { adcOsClient: fake, now: () => T0, persistence, driver },
      );
      expect(host.probeResult).not.toBeNull();
      expect(host.probeResult?.status).toBe("compatible");
      expect(host.compatibility).not.toBeNull();
      host.compatibility?.assertMutationsAllowed(); // the gate OPENS on compatible
      const report = await host.readyCheck();
      const adcosCheck = report.checks.find((check) => check.name === "adcos-compatibility");
      expect(adcosCheck?.state).toBe("healthy");
      await host.stop();
    } finally {
      await db.close();
    }
  });

  it("an incompatible endpoint degrades readiness and refuses mutations (fail-closed)", async () => {
    const { db, persistence, driver } = await migratedPersistence();
    try {
      // A client whose endpoint violates the pinned contract (the §9
      // application self-description route is disabled): the suite fails closed.
      const fake = new FakeAdcos({ seedProbe: true, now: () => T0 });
      fake.disableRoute("application_self");
      const host = await createWorkerHost(
        baseEnv({
          adcOsEnv: {
            ADCOS_API_BASE_URL: "https://adcos.example.test",
            ADCOS_CLIENT_ID: "roamlink-worker",
            ADCOS_CLIENT_SECRET: "env-only-never-committed",
            ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
          },
        }),
        { adcOsClient: fake, now: () => T0, persistence, driver },
      );
      expect(host.probeResult?.status).toBe("incompatible");
      let refused = false;
      try {
        host.compatibility?.assertMutationsAllowed();
      } catch {
        refused = true;
      }
      expect(refused).toBe(true); // mutations gated (the existing §9 semantics)
      const report = await host.readyCheck();
      const adcosCheck = report.checks.find((check) => check.name === "adcos-compatibility");
      expect(adcosCheck?.state).toBe("degraded");
      expect(adcosCheck?.detail).toContain("fail closed");
      await host.stop();
    } finally {
      await db.close();
    }
  });
});
