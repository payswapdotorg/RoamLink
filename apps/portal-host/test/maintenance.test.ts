/**
 * RL-107 — the /api/maintenance/daily trigger: fail-closed authentication,
 * the bounded inline sweep kick (idempotent), and the event-driven QStash
 * kick with deterministic per-day job ids (cron retries never duplicate).
 */
import { describe, expect, it } from "vitest";
import { parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import { InMemoryJobDeliveryQueue } from "@roamlink/provider-qstash";
import { PGlite } from "@electric-sql/pglite";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isAuthorizedCronRequest, runDailyMaintenance } from "../src/maintenance.js";
import { handleMaintenanceDaily } from "../src/handlers.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0 = parseUtcInstant("2026-10-01T00:00:00.000Z");
void (null as unknown as UtcInstant);

async function migratedPersistence() {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const db = new PGlite();
  const driver = createPgliteDriver(db);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  return { db, persistence: createPostgresPersistence(driver) };
}

/** Seeds one stranded DELIVERING claim (the crash window the sweep re-owns). */
async function seedStrandedClaim(persistence: Awaited<ReturnType<typeof migratedPersistence>>["persistence"]) {
  const seed = await persistence.begin();
  await seed.outbox.enqueue({ idempotencyKey: "mt-sweep-1", payload: { a: 1 }, createdAt: T0 });
  await seed.commit();
  const claim = await persistence.begin();
  await claim.outbox.claimDue(T0, 10);
  await claim.commit();
  expect(await persistence.outbox.count("DELIVERING")).toBe(1);
}

describe("RL-107 maintenance trigger authentication (fail-closed)", () => {
  const request = (authorization?: string): { readonly headers: { get(name: string): string | null } } => ({
    headers: {
      get: (name: string) => (name === "authorization" && authorization !== undefined ? authorization : null),
    },
  });

  it("refuses EVERY request when CRON_SECRET is not configured", () => {
    expect(isAuthorizedCronRequest(request("Bearer anything"), undefined)).toBe(false);
    expect(isAuthorizedCronRequest(request(), "")).toBe(false);
  });

  it("accepts only the exact Bearer match (constant-time)", () => {
    expect(isAuthorizedCronRequest(request("Bearer secret-value-1"), "secret-value-1")).toBe(true);
    expect(isAuthorizedCronRequest(request("Bearer secret-value-2"), "secret-value-1")).toBe(false);
    expect(isAuthorizedCronRequest(request("bearer secret-value-1"), "secret-value-1")).toBe(true); // scheme is case-insensitive
    expect(isAuthorizedCronRequest(request(), "secret-value-1")).toBe(false);
    expect(isAuthorizedCronRequest(request("secret-value-1"), "secret-value-1")).toBe(false); // not a Bearer
  });
});

describe("RL-107 the inline maintenance kick", () => {
  it("sweeps stranded claims and reports the honest inbox skip; repeating converges (idempotent)", async () => {
    const { db, persistence } = await migratedPersistence();
    try {
      await seedStrandedClaim(persistence);
      const clock = new DeterministicClock(T0);
      const result = await runDailyMaintenance({
        persistence,
        now: () => clock.now(),
      });
      if (result.mode !== "inline") throw new Error("expected the inline mode");
      expect(result.outbox.recovered).toBe(1);
      expect(result.inbox).toEqual({
        drained: false,
        reason: "no webhook inbox with a composed projector is bound in this process",
      });
      expect(await persistence.outbox.count("DELIVERING")).toBe(0); // re-owned to PENDING
      expect(await persistence.outbox.count("PENDING")).toBe(1);

      // Idempotent: a second kick on the same instant sweeps nothing further.
      const second = await runDailyMaintenance({ persistence, now: () => clock.now() });
      if (second.mode !== "inline") throw new Error("expected the inline mode");
      expect(second.outbox.recovered).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("drains one bounded inbox batch when an inbox source is bound", async () => {
    const { db, persistence } = await migratedPersistence();
    try {
      const clock = new DeterministicClock(T0);
      let calls = 0;
      const result = await runDailyMaintenance({
        persistence,
        inbox: {
          processPending: async (limit?: number) => {
            calls += 1;
            expect(limit).toBe(50);
            return {
              considered: 0,
              alreadyProjected: 0,
              applied: 0,
              skipped: 0,
              failed: 0,
              conflicts: 0,
            };
          },
        },
        now: () => clock.now(),
      });
      if (result.mode === "inline" && result.inbox.drained) {
        expect(result.inbox.report.applied).toBe(0);
      } else {
        throw new Error("the bound inbox must have drained");
      }
      expect(calls).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("RL-107 the event-driven QStash kick", () => {
  it("enqueues two durable jobs with DETERMINISTIC per-day ids; a same-day retry is a duplicate", async () => {
    const { db, persistence } = await migratedPersistence();
    try {
      const clock = new DeterministicClock(T0);
      const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "qstash-signing-key-never-in-prod" });
      const first = await runDailyMaintenance({
        persistence,
        asyncDelivery: queue,
        asyncDestination: "https://host.example.test/api/maintenance/receiver",
        now: () => clock.now(),
      });
      expect(first.mode).toBe("enqueued");
      if (first.mode === "enqueued") {
        expect(first.jobs.map((job) => job.jobId).sort()).toEqual([
          "maintenance-daily-20261001-inbox",
          "maintenance-daily-20261001-outbox",
        ]);
        expect(first.jobs.every((job) => job.accepted && !job.duplicate)).toBe(true);
      }

      // A cron retry on the SAME day is the same (jobId, payload) -> duplicate receipt.
      const retry = await runDailyMaintenance({
        persistence,
        asyncDelivery: queue,
        asyncDestination: "https://host.example.test/api/maintenance/receiver",
        now: () => clock.now(),
      });
      if (retry.mode === "enqueued") {
        expect(retry.jobs.every((job) => job.accepted && job.duplicate)).toBe(true);
      } else {
        throw new Error("expected the enqueued mode");
      }
    } finally {
      await db.close();
    }
  });
});

describe("RL-107 the /api/maintenance/daily handler", () => {
  it("answers 503 CRON_SECRET_NOT_CONFIGURED (fail-closed) when the secret is unset", async () => {
    const { db, persistence } = await migratedPersistence();
    try {
      const response = await handleMaintenanceDaily(
        new Request("https://host.example.test/api/maintenance/daily"),
        {
          ok: true,
          composition: {
            maintenance: {
              cronSecret: undefined,
              run: async () => runDailyMaintenance({ persistence, now: () => T0 }),
            },
          },
        } as never,
      );
      expect(response.status).toBe(503);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body["reason"]).toBe("CRON_SECRET_NOT_CONFIGURED");
    } finally {
      await db.close();
    }
  });

  it("answers 401 for a wrong bearer and 200 with the bearer + the inline result", async () => {
    const { db, persistence } = await migratedPersistence();
    try {
      const composition = {
        maintenance: {
          cronSecret: "cron-secret-1",
          run: async () => runDailyMaintenance({ persistence, now: () => T0 }),
        },
      };
      const unauthorized = await handleMaintenanceDaily(
        new Request("https://host.example.test/api/maintenance/daily"),
        { ok: true, composition } as never,
      );
      expect(unauthorized.status).toBe(401);

      await seedStrandedClaim(persistence);
      const authorized = await handleMaintenanceDaily(
        new Request("https://host.example.test/api/maintenance/daily", {
          headers: { authorization: "Bearer cron-secret-1" },
        }),
        { ok: true, composition } as never,
      );
      expect(authorized.status).toBe(200);
      const body = JSON.parse(await authorized.text()) as { mode: "inline" | "enqueued"; outbox?: { recovered: number } };
      expect(body.mode).toBe("inline");
      expect(body.outbox?.recovered).toBe(1);
    } finally {
      await db.close();
    }
  });
});
