/**
 * PA-025 — the command-ledger executed-stage writer: the CAS-guarded write
 * over the REAL persistence (pglite + the real infra/migrations), including
 * the additive resource fact the live command-execution path records (the
 * durable record of WHAT execution created — the fact the PA-019 read
 * projections project from) and the unchanged idempotent-replay law.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
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

import { createCommandLedger } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0: UtcInstant = parseUtcInstant("2026-10-01T00:00:00.000Z");
const T1: UtcInstant = parseUtcInstant("2026-10-01T00:01:00.000Z");

async function createRuntime() {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const db = new (await import("@electric-sql/pglite")).PGlite();
  const driver = createPgliteDriver(db);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  const persistence = createPostgresPersistence(driver);
  return { driver, persistence };
}

const storedCommand = (commandId: string): Record<string, unknown> => ({
  commandId,
  requestId: `req-${commandId}`,
  correlationId: `corr-${commandId}`,
  idempotencyKey: `wk-${commandId}`,
  kind: "device.enroll",
  route: "/v1/devices",
  tenantId: "usr:00000000-0000-4000-8000-00000000000a",
  actorId: "usr:00000000-0000-4000-8000-00000000000a",
  expectedVersion: null,
  payloadDigest: "digest",
  payload: { name: "Acahat Phone", platform: "ios" },
  acceptedAt: T0,
  executedAt: null,
  deliveredAt: null,
  billableFinalAt: null,
  resource: null,
});

/** Reads the stored command's current value straight from the ledger. */
async function readCommand(persistence: Awaited<ReturnType<typeof createRuntime>>["persistence"], commandId: string) {
  const record = await persistence.records("api-commands").get(commandId);
  return record === null ? null : (record.value as Record<string, unknown>);
}

describe("PA-025 the command-ledger executed-stage writer", () => {
  it("CAS-writes executedAt together with the executor's resource (ONE version-guarded write)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.records("api-commands").insert("cmd-ledger-1", storedCommand("cmd-ledger-1") as never);
      await seed.commit();

      const ledger = createCommandLedger({ persistence: runtime.persistence });
      await ledger.markExecuted("cmd-ledger-1", T1, { type: "device", id: "1a000000-0000-4000-8000-000000000001", version: 1 });

      const after = await readCommand(runtime.persistence, "cmd-ledger-1");
      expect(after?.["executedAt"]).toBe(T1);
      expect(after?.["resource"]).toEqual({
        type: "device",
        id: "1a000000-0000-4000-8000-000000000001",
        version: 1,
      });
      // The accepted facts are untouched — stages never collapse or lie.
      expect(after?.["acceptedAt"]).toBe(T0);
      expect(after?.["deliveredAt"]).toBeNull();
      expect(after?.["billableFinalAt"]).toBeNull();
    } finally {
      await runtime.driver.close();
    }
  });

  it("keeps the pre-PA-025 behavior when no resource is passed (executedAt only)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.records("api-commands").insert("cmd-ledger-2", storedCommand("cmd-ledger-2") as never);
      await seed.commit();

      const ledger = createCommandLedger({ persistence: runtime.persistence });
      await ledger.markExecuted("cmd-ledger-2", T1);

      const after = await readCommand(runtime.persistence, "cmd-ledger-2");
      expect(after?.["executedAt"]).toBe(T1);
      expect(after?.["resource"]).toBeNull();
    } finally {
      await runtime.driver.close();
    }
  });

  it("is an idempotent replay no-op: an already-executed command is NEVER rewritten (first execution's facts stand)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.records("api-commands").insert("cmd-ledger-3", storedCommand("cmd-ledger-3") as never);
      await seed.commit();

      const ledger = createCommandLedger({ persistence: runtime.persistence });
      await ledger.markExecuted("cmd-ledger-3", T1, { type: "device", id: "1a000000-0000-4000-8000-000000000003", version: 1 });
      // The redelivered/replayed obligation carries a LATER instant and a
      // DIFFERENT resource: the first execution's facts must stand.
      await ledger.markExecuted("cmd-ledger-3", parseUtcInstant("2026-10-01T09:00:00.000Z"), {
        type: "device",
        id: "1a000000-0000-4000-8000-000000000009",
      });

      const after = await readCommand(runtime.persistence, "cmd-ledger-3");
      expect(after?.["executedAt"]).toBe(T1);
      expect(after?.["resource"]).toEqual({
        type: "device",
        id: "1a000000-0000-4000-8000-000000000003",
        version: 1,
      });
    } finally {
      await runtime.driver.close();
    }
  });

  it("fails closed on a command the obligation names that is not in the ledger", async () => {
    const runtime = await createRuntime();
    try {
      const ledger = createCommandLedger({ persistence: runtime.persistence });
      await expect(ledger.markExecuted("cmd-missing", T1)).rejects.toThrow(ConflictError);
    } finally {
      await runtime.driver.close();
    }
  });

  it("concurrent executions of the same command advance it EXACTLY ONCE (the CAS guard: never a double write, never a blend)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.records("api-commands").insert("cmd-ledger-4", storedCommand("cmd-ledger-4") as never);
      await seed.commit();

      const ledger = createCommandLedger({ persistence: runtime.persistence });
      // Two workers race the same obligation (the at-least-once redelivery
      // reality). Whichever interleaving the database serializes, the FINAL
      // state carries exactly ONE executedAt and ONE resource: the winner's
      // write; the loser either reads post-commit (the idempotent no-op) or
      // loses the version-guarded CAS (the typed conflict) — both honest,
      // neither ever overwrites the first execution's facts.
      const resourceA = { type: "device", id: "1a000000-0000-4000-8000-000000000004" };
      const resourceB = { type: "device", id: "1a000000-0000-4000-8000-000000000009" };
      await Promise.allSettled([
        ledger.markExecuted("cmd-ledger-4", T1, resourceA),
        ledger.markExecuted("cmd-ledger-4", T1, resourceB),
      ]);

      const after = await readCommand(runtime.persistence, "cmd-ledger-4");
      expect(after?.["executedAt"]).toBe(T1); // advanced exactly once
      const resource = after?.["resource"] as { readonly id?: string } | null;
      expect(resource).not.toBeNull();
      expect([resourceA.id, resourceB.id]).toContain(resource?.id); // exactly one winner
      expect(after?.["acceptedAt"]).toBe(T0); // the accepted facts untouched
    } finally {
      await runtime.driver.close();
    }
  });
});
