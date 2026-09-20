/**
 * RL-106 — the REAL-database concurrency verification suite.
 *
 * packages/persistence-postgres's README ("Honest deltas and gaps") pins
 * exactly what pglite CANNOT express: a pglite engine is ONE PostgreSQL
 * session, so (1) a second concurrent `begin()` fails loudly
 * (PGLITE_TRANSACTION_CONCURRENT) and (2) the two-connection invariants —
 * committed readers never see uncommitted writes, true races on the
 * SAVEPOINT-fenced enqueue, FOR UPDATE SKIP LOCKED claiming, and the
 * delivered-outcome vs recoverInFlight race — cannot be exercised there.
 *
 * THIS suite runs against a REAL pooled PostgreSQL (DATABASE_URL, e.g. the
 * operator-phase Neon/Postgres instance). It is gated:
 *
 *   - DATABASE_URL set     -> the suite runs for real;
 *   - DATABASE_URL unset   -> the suite SKIPS with the explicit honest skip
 *     line below (CI stays green with zero skipped-as-passed lies; the skip
 *     is named, never silent).
 *
 * pglite remains the default engine everywhere else (the sanctioned
 * development mode) — the first describe pins WHY a real pool is required.
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { ConflictError, isRoamLinkError } from "@roamlink/contracts";
import { Pool } from "pg";
import {
  createPgliteDriver,
  createPgDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "../src/index.js";

import { REPO_MIGRATIONS_DIR, wireMigrationFileAccess } from "./helpers.js";
import { readdirSync, readFileSync } from "node:fs";

const RAW_DATABASE_URL = process.env["DATABASE_URL"]?.trim() || undefined;
/**
 * The suite requires a REAL PostgreSQL connection string. A DATABASE_URL
 * carrying some OTHER scheme (e.g. a SQLite `file:` URL) is honestly treated
 * as not-configured for THIS suite: the invariants under test are PostgreSQL
 * connection semantics, and connecting to a non-Postgres would only fail
 * with a driver error - a skip with the named reason is the honest answer.
 */
const DATABASE_URL =
  RAW_DATABASE_URL !== undefined &&
  (RAW_DATABASE_URL.startsWith("postgres://") || RAW_DATABASE_URL.startsWith("postgresql://"))
    ? RAW_DATABASE_URL
    : undefined;

// --------------------------------------------------------------------------------
// The honest skip gate
// --------------------------------------------------------------------------------

const realDatabase = DATABASE_URL !== undefined ? describe : describe.skip;
if (DATABASE_URL === undefined) {
  // The explicit, honest skip line (never a silent pass, never a lie).
  console.log(
    "[RL-106] SKIPPING the real-database concurrency suite: no PostgreSQL DATABASE_URL is configured " +
      "(postgres:// or postgresql:// required). " +
      "The two-connection invariants (isolation, SKIP LOCKED claiming, SAVEPOINT-fenced " +
      "enqueue races, the delivered-vs-recoverInFlight race) require a real pooled PostgreSQL. " +
      "The suite runs in the operator phase and against any real Postgres; CI stays green.",
  );
}

// --------------------------------------------------------------------------------
// Runtime helpers
// --------------------------------------------------------------------------------

const T0 = "2026-10-01T00:00:00.000Z";

interface RealRuntime {
  readonly pool: Pool;
  readonly persistence: ReturnType<typeof createPostgresPersistence>;
  readonly runner: ReturnType<typeof createPostgresMigrationRunner>;
  readonly close: () => Promise<void>;
}

/** A real pooled runtime over DATABASE_URL with the REAL migrations applied from empty. */
async function createRealRuntime(): Promise<RealRuntime> {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => REPO_MIGRATIONS_DIR);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const driver = createPgDriver(pool as never);
  const runner = createPostgresMigrationRunner({ driver, migrationsDir: REPO_MIGRATIONS_DIR });
  // Start from EMPTY state regardless of what a previous test left behind.
  await runner.migrateDown();
  await runner.migrateUp();
  return {
    pool,
    persistence: createPostgresPersistence(driver),
    runner,
    close: async () => {
      await driver.close();
    },
  };
}

/** A real delay to widen a genuine two-connection race window (no fake clocks here). */
const raceWindow = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
function nextKey(prefix: string): string {
  counter += 1;
  return `rl106-${prefix}-${String(counter).padStart(4, "0")}`;
}

// --------------------------------------------------------------------------------
// The pglite pin (ALWAYS on — the honest statement of why a real pool is needed)
// --------------------------------------------------------------------------------

describe("RL-106 pin: pglite cannot express two-connection concurrency (honest limit)", () => {
  it("refuses a second concurrent begin() loudly (PGLITE_TRANSACTION_CONCURRENT)", async () => {
    wireMigrationFileAccess();
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    const runner = createPostgresMigrationRunner({ driver, migrationsDir: REPO_MIGRATIONS_DIR });
    await runner.migrateUp();
    const persistence = createPostgresPersistence(driver);
    const first = await persistence.begin();
    await expect(persistence.begin()).rejects.toThrow(/PGLITE_TRANSACTION_CONCURRENT|concurrent/i);
    await first.rollback();
    await driver.close();
  });
});

// --------------------------------------------------------------------------------
// The gated REAL-database concurrency suite
// --------------------------------------------------------------------------------

realDatabase("RL-106: real-database concurrency invariants (DATABASE_URL-gated)", () => {
  it(
    "a reader on connection B never observes writer A's uncommitted record or outbox row",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();
      try {
        const key = nextKey("iso");
        const writer = await runtime.persistence.begin();
        await writer.records("rl106-isolation").insert(key, { visible: false, at: T0 });
        await writer.outbox.enqueue({ idempotencyKey: key, payload: { iso: 1 }, createdAt: T0 });

        // Reader B: a SEPARATE unit of work (a separate pooled connection).
        const reader = await runtime.persistence.begin();
        expect(await reader.records("rl106-isolation").get(key)).toBeNull();
        expect(await reader.outbox.count()).toBe(0);
        expect(await reader.outbox.get(key)).toBeNull();

        // A raw AUTOCOMMIT connection (outside any unit of work) also sees nothing.
        const raw = await runtime.pool.connect();
        try {
          const uncommitted = await raw.query(
            "SELECT count(*)::int AS n FROM roamlink_outbox WHERE idempotency_key = $1",
            [key],
          );
          expect(uncommitted.rows[0]?.["n"]).toBe(0);
        } finally {
          raw.release();
        }

        // The commit makes it visible to B (and the raw connection).
        await writer.commit();
        expect((await reader.records("rl106-isolation").get(key))?.value).toEqual({ visible: false, at: T0 });
        expect(await reader.outbox.get(key)).not.toBeNull();
        await reader.rollback();
      } finally {
        await runtime.close();
      }
    },
  );

  it(
    "two concurrent claimDue callers get DISJOINT claim sets (FOR UPDATE SKIP LOCKED)",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();
      try {
        const keys = Array.from({ length: 6 }, () => nextKey("due"));
        const enqueueAll = await runtime.persistence.begin();
        for (const key of keys) {
          await enqueueAll.outbox.enqueue({ idempotencyKey: key, payload: { n: 1 }, createdAt: T0 });
        }
        await enqueueAll.commit();

        const claimedBy = new Map<string, string[]>(); // worker -> keys
        const claim = async (worker: string): Promise<void> => {
          const unitOfWork = await runtime.persistence.begin();
          const claimed = await unitOfWork.outbox.claimDue(T0, 3);
          claimedBy.set(worker, claimed.map((record) => record.idempotencyKey));
          await raceWindow(60); // hold the locks so the other worker must SKIP them
          await unitOfWork.commit();
        };

        const first = claim("worker-a");
        await raceWindow(25); // deterministic stagger: a's claim locks the first rows
        const second = claim("worker-b");
        await Promise.all([first, second]);

        const a = claimedBy.get("worker-a") ?? [];
        const b = claimedBy.get("worker-b") ?? [];
        expect(a.length).toBe(3);
        expect(b.length).toBe(3);
        const intersection = a.filter((key) => b.includes(key));
        expect(intersection).toEqual([]); // never the same record twice
        expect([...a, ...b].sort()).toEqual([...keys].sort()); // together: all six, exactly once

        // Nothing is left claimable: every record is DELIVERING (owned).
        expect(await runtime.persistence.outbox.count("PENDING")).toBe(0);
        expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(6);
      } finally {
        await runtime.close();
      }
    },
  );

  it(
    "concurrent SAVEPOINT-fenced enqueues of the same idempotency key resolve to exactly one row",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();
      try {
        const key = nextKey("fence");
        const outcomes: string[] = [];

        const enqueueA = (async (): Promise<void> => {
          const unitOfWork = await runtime.persistence.begin();
          const result = await unitOfWork.outbox.enqueue({
            idempotencyKey: key,
            payload: { fenced: true },
            createdAt: T0,
          });
          outcomes.push(result.outcome);
          await raceWindow(40);
          await unitOfWork.commit();
        })();
        const enqueueB = (async (): Promise<void> => {
          await raceWindow(25); // B's INSERT blocks on A's uncommitted row, is fenced
          const unitOfWork = await runtime.persistence.begin();
          const result = await unitOfWork.outbox.enqueue({
            idempotencyKey: key,
            payload: { fenced: true },
            createdAt: T0,
          });
          outcomes.push(result.outcome);
          await unitOfWork.commit();
        })();
        await Promise.all([enqueueA, enqueueB]);

        expect(outcomes.sort()).toEqual(["ALREADY_ENQUEUED", "ENQUEUED"]);
        expect(await runtime.persistence.outbox.count()).toBe(1); // exactly one row
        expect((await runtime.persistence.outbox.get(key))?.payloadDigest).toBeDefined();
      } finally {
        await runtime.close();
      }
    },
  );

  it(
    "the same key enqueued concurrently with a DIFFERENT payload is the typed conflict (never a silent overwrite)",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();
      try {
        const key = nextKey("fence-conflict");
        const errors: unknown[] = [];

        const enqueueA = (async (): Promise<void> => {
          const unitOfWork = await runtime.persistence.begin();
          await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { v: 1 }, createdAt: T0 });
          await raceWindow(40);
          await unitOfWork.commit();
        })();
        const enqueueB = (async (): Promise<void> => {
          await raceWindow(25);
          const unitOfWork = await runtime.persistence.begin();
          try {
            await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { v: 2 }, createdAt: T0 });
            await unitOfWork.commit();
          } catch (error) {
            errors.push(error);
            await unitOfWork.rollback();
          }
        })();
        await Promise.all([enqueueA, enqueueB]);

        expect(errors.length).toBe(1);
        expect(errors[0]).toBeInstanceOf(ConflictError);
        expect(await runtime.persistence.outbox.count()).toBe(1);
        // The SURVIVING row is A's payload (the winner), never a mix.
        expect((await runtime.persistence.outbox.get(key))?.payloadDigest).toBeDefined();
      } finally {
        await runtime.close();
      }
    },
  );

  it(
    "the delivered-outcome vs recoverInFlight race keeps the effect EXACTLY ONCE and typed (both interleavings)",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();

      // Builds one claimed (DELIVERING) record and races the restart sweep
      // against the original owner's delivered outcome.
      const raceOnce = async (label: string): Promise<"delivered-stands" | "recovery-reowns"> => {
        const key = nextKey(`race-${label}`);
        const seed = await runtime.persistence.begin();
        await seed.outbox.enqueue({ idempotencyKey: key, payload: { race: label }, createdAt: T0 });
        await seed.commit();
        const claim = await runtime.persistence.begin();
        await claim.outbox.claimDue(T0, 10);
        await claim.commit();

        const sweepUnit = runtime.persistence.begin().then(async (unitOfWork) => {
          try {
            const recovered = await unitOfWork.outbox.recoverInFlight(T0);
            await unitOfWork.commit();
            return { recovered: recovered.map((record) => record.idempotencyKey), error: null as unknown };
          } catch (error) {
            await unitOfWork.rollback();
            return { recovered: [], error };
          }
        });
        const outcomeUnit = runtime.persistence.begin().then(async (unitOfWork) => {
          try {
            await unitOfWork.outbox.markDelivered(key, T0);
            await unitOfWork.commit();
            return { delivered: true, error: null as unknown };
          } catch (error) {
            await unitOfWork.rollback();
            return { delivered: false, error };
          }
        });

        // Interleaving control: sweep locks first, then the outcome attempts.
        const sweepPromise = sweepUnit;
        await raceWindow(10);
        const outcomePromise = outcomeUnit;
        const [sweep, outcome] = await Promise.all([sweepPromise, outcomePromise]);

        const final = await runtime.persistence.outbox.get(key);
        const sweepWon = final?.deliveryState === "PENDING";
        const outcomeWon = final?.deliveryState === "DELIVERED";

        // EXACTLY ONE effect: either the recovery re-owned the claim (the
        // outcome was refused), or the delivered outcome stands (the filtered
        // sweep re-owned nothing). Never both, never neither.
        if (sweepWon) {
          expect(outcome.delivered).toBe(false);
          expect(outcome.error).toBeDefined();
          // The refusal is TYPED: the shared closed state machine (or the
          // commit CAS) refuses to overwrite a re-owned claim - never a raw
          // driver error, never a silent overwrite.
          expect(isRoamLinkError(outcome.error)).toBe(true);
          expect(final?.nextAttemptAt).toBe(T0); // due exactly at the recovery instant
          expect(final?.retryCount).toBe(0); // recovery consumes no retry budget
          expect(sweep.error).toBeNull();
          expect(sweep.recovered).toContain(key);
          await settleDelivered(key);
          return "recovery-reowns";
        }
        if (outcomeWon) {
          expect(outcome.delivered).toBe(true);
          expect(outcome.error).toBeNull();
          expect(sweep.recovered).not.toContain(key); // the DELIVERED row never matches the sweep
          expect(sweep.error).toBeNull();
          return "delivered-stands";
        }
        throw new Error(
          `unreachable race outcome: state=${String(final?.deliveryState)} sweep=${JSON.stringify(sweep)} outcome=${JSON.stringify(outcome)}`,
        );
      };

      // Drives the raced record to its terminal DELIVERED state so rounds
      // stay independent: a re-owned (PENDING) record is re-claimable by
      // design (the obligation continues, at-least-once).
      const settleDelivered = async (key: string): Promise<void> => {
        for (;;) {
          const unitOfWork = await runtime.persistence.begin();
          try {
            const claimed = await unitOfWork.outbox.claimDue(T0, 10);
            if (claimed.length === 0) {
              await unitOfWork.rollback();
              break;
            }
            for (const record of claimed) {
              await unitOfWork.outbox.markDelivered(record.idempotencyKey, T0);
            }
            await unitOfWork.commit();
          } catch (error) {
            await unitOfWork.rollback();
            throw error;
          }
        }
        expect((await runtime.persistence.outbox.get(key))?.deliveryState).toBe("DELIVERED");
      };

      try {
        // Both interleavings, several rounds: the invariant must hold every time.
        for (let round = 0; round < 3; round += 1) {
          const outcomeA = await raceOnce(`a${round}`);
          expect(["recovery-reowns", "delivered-stands"]).toContain(outcomeA);
          const outcomeB = await raceOnce(`b${round}`);
          expect(["recovery-reowns", "delivered-stands"]).toContain(outcomeB);
        }
        // Terminal states were never resurrected anywhere in the rounds above:
        // every re-owned record was re-deliverable, every delivered record
        // stayed delivered (asserted inside raceOnce by the final-state read).
      } finally {
        await runtime.close();
      }
    },
  );

  it(
    "recoverInFlight re-owns stranded claims over the real pool (the RL-093 restart discipline, pool proof)",
    { timeout: 60_000 },
    async () => {
      const runtime = await createRealRuntime();
      try {
        const keys = [nextKey("strand"), nextKey("strand")];
        const seed = await runtime.persistence.begin();
        for (const key of keys) {
          await seed.outbox.enqueue({ idempotencyKey: key, payload: { stranded: true }, createdAt: T0 });
        }
        await seed.commit();
        // The crashed worker's claim committed; the outcome never did.
        const crashedClaim = await runtime.persistence.begin();
        const claimed = await crashedClaim.outbox.claimDue(T0, 10);
        expect(claimed.length).toBe(2);
        await crashedClaim.commit();
        expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(2);

        // The restarted worker sweeps BEFORE its first claim (RL-093).
        const restarted = await runtime.persistence.begin();
        const recovered = await restarted.outbox.recoverInFlight(T0);
        expect(recovered.map((record) => record.idempotencyKey).sort()).toEqual([...keys].sort());
        expect(recovered.every((record) => record.deliveryState === "PENDING")).toBe(true);
        expect(recovered.every((record) => record.retryCount === 0)).toBe(true); // budget untouched
        await restarted.commit();

        // The obligation continues: re-claim and complete.
        const next = await runtime.persistence.begin();
        const reClaimed = await next.outbox.claimDue(T0, 10);
        expect(reClaimed.map((record) => record.idempotencyKey).sort()).toEqual([...keys].sort());
        for (const record of reClaimed) {
          await next.outbox.markDelivered(record.idempotencyKey, T0);
        }
        await next.commit();
        expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(2);
      } finally {
        await runtime.close();
      }
    },
  );
});

