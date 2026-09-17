/**
 * RL-075 suite 1: PERSISTENCE MIGRATION / RECOVERY (spec/definition-of-done.md
 * "Migration/rollback behavior documented when state changes"; infra/
 * migrations/README.md runner contract).
 *
 * Deterministic simulations over the versioned migration runner contract
 * (the same port a PostgreSQL driver implements for the infra/migrations
 * SQL files) - no real infrastructure.
 *
 * Recovery catalog:
 *   M-1 a migration sequence applies cleanly from EMPTY state in ascending
 *       version order, recorded in the applied-versions ledger;
 *   M-2 from EVERY prior state: applying up to k, then continuing, converges
 *       to exactly the same ledger as a single pass;
 *   M-3 re-running migrateUp is idempotent (zero new applications);
 *   M-4 rollback safety: migrateDown applies `down` in DESCENDING order,
 *       the target stays applied, and a subsequent forward run re-applies
 *       cleanly (forward-compatible writes);
 *   M-5 crash-during-migration recovery is IDEMPOTENT: a migration that
 *       crashed mid-`up` (side effect visible, ledger NOT updated) is
 *       re-executed by the re-run and converges - a second crash-free run
 *       applies nothing new;
 *   M-6 state corruption fails closed: a ledger entry referencing an
 *       unknown version, or a duplicate entry, is MIGRATION_LEDGER_CORRUPT
 *       (never guessed through).
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryAppliedVersionsLedger,
  createMigrationRunner,
  type Migration,
} from "@roamlink/persistence";
import { ValidationError, parseUtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import type { MigrationVersion } from "@roamlink/persistence";

const T0 = "2026-04-01T06:00:00.000Z";

/** Builds a deterministic 5-migration "schema" with observable effects. */
function migrationSet(
  state: Map<string, string>,
  options: { readonly crashDuring?: string } = {},
): Migration[] {
  const describe = (version: string): Migration => ({
    version: version as MigrationVersion,
    description: `migration ${version}`,
    up: () => {
      state.set(version, `applied-${version}`);
      if (options.crashDuring === version) {
        // The crash happens AFTER the schema effect but BEFORE the runner
        // records the version in its ledger (the classic torn window).
        throw new Error(`simulated crash during migration ${version}`);
      }
    },
    down: () => {
      state.delete(version);
    },
  });
  return ["0001", "0002", "0003", "0004", "0005"].map((version) =>
    describe(version as MigrationVersion),
  );
}

function runnerOf(state: Map<string, string>, ledger = createInMemoryAppliedVersionsLedger()) {
  return {
    runner: createMigrationRunner({
      migrations: migrationSet(state),
      ledger,
      now: () => new DeterministicClock(T0).now(),
    }),
    ledger,
  };
}

describe("RL-075 suite 1: persistence migration and recovery", () => {
  it("M-1 the sequence applies cleanly from empty state in ascending order", async () => {
    const state = new Map<string, string>();
    const { runner, ledger } = runnerOf(state);
    const applied = await runner.migrateUp();
    expect(applied.map((entry) => entry.version)).toEqual(["0001", "0002", "0003", "0004", "0005"]);
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
    ]);
    // Every schema effect is present (deterministic order).
    expect([...state.keys()]).toEqual(["0001", "0002", "0003", "0004", "0005"]);
  });

  it("M-2 from EVERY prior state k, continuing converges to the same ledger", async () => {
    const reference = new Map<string, string>();
    const { ledger: referenceLedger } = runnerOf(reference);
    await createMigrationRunner({
      migrations: migrationSet(reference),
      ledger: referenceLedger,
      now: () => new DeterministicClock(T0).now(),
    }).migrateUp();
    const referenceVersions = referenceLedger
      .snapshot()
      .map((entry) => `${entry.version}@${entry.appliedAt}`);

    for (let k = 1; k <= 4; k += 1) {
      const state = new Map<string, string>();
      const { runner, ledger } = runnerOf(state);
      const target = `000${k}` as MigrationVersion;
      await runner.migrateUp(target);
      expect(ledger.snapshot().map((entry) => entry.version)).toEqual(
        ["0001", "0002", "0003", "0004", "0005"].slice(0, k),
      );
      // The deployment upgrade continues from the prior state.
      const continued = await runner.migrateUp();
      expect(continued.map((entry) => entry.version)).toEqual(
        ["0001", "0002", "0003", "0004", "0005"].slice(k),
      );
      // CONVERGENCE: identical ledger content (versions + appliedAt stamps).
      expect(ledger.snapshot().map((entry) => `${entry.version}@${entry.appliedAt}`)).toEqual(
        referenceVersions,
      );
    }
  });

  it("M-3 re-running migrateUp is idempotent (zero new applications)", async () => {
    const state = new Map<string, string>();
    const { runner } = runnerOf(state);
    await runner.migrateUp();
    const again = await runner.migrateUp();
    expect(again).toEqual([]);
    // And a partial-target re-run applies nothing already applied.
    const partial = await runner.migrateUp("0003" as MigrationVersion);
    expect(partial).toEqual([]);
  });

  it("M-4 rollback is descending, target-relative, and forward-compatible", async () => {
    const state = new Map<string, string>();
    const { runner, ledger } = runnerOf(state);
    await runner.migrateUp();

    // Roll back to 0003: 0005 and 0004 come down (in that order), 0003 stays.
    const rolledBack = await runner.migrateDown("0003" as MigrationVersion);
    expect(rolledBack).toEqual(["0005", "0004"]);
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual(["0001", "0002", "0003"]);
    expect(state.has("0004")).toBe(false);
    expect(state.has("0005")).toBe(false);
    expect(state.has("0003")).toBe(true);

    // An unknown rollback target fails closed (typed, not guessed through).
    await expect(runner.migrateDown("0009" as MigrationVersion)).rejects.toMatchObject({
      reason: "MIGRATION_TARGET_UNKNOWN",
    });

    // Full rollback: everything down, empty ledger.
    const all = await runner.migrateDown();
    expect(all).toEqual(["0003", "0002", "0001"]);
    expect(ledger.snapshot()).toEqual([]);

    // FORWARD-COMPATIBLE: re-applying after the rollback is clean (the
    // schema effects are re-created, the ledger re-records everything).
    const reapplied = await runner.migrateUp();
    expect(reapplied.map((entry) => entry.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
    ]);
    expect([...state.keys()]).toEqual(["0001", "0002", "0003", "0004", "0005"]);
  });

  it("M-5 crash-during-migration: the re-run converges (idempotent recovery)", async () => {
    // The migration at 0003 crashes AFTER its schema effect but BEFORE the
    // ledger records it (the torn window a power loss produces).
    const state = new Map<string, string>();
    const crashLedger = createInMemoryAppliedVersionsLedger();
    const crashRunner = createMigrationRunner({
      migrations: migrationSet(state, { crashDuring: "0003" }),
      ledger: crashLedger,
      now: () => new DeterministicClock(T0).now(),
    });

    await expect(crashRunner.migrateUp()).rejects.toThrowError(/simulated crash during migration 0003/);
    // The torn state: 0001..0002 are recorded; 0003's EFFECT is visible but
    // NOT in the ledger (the crash happened in the window).
    expect(crashLedger.snapshot().map((entry) => entry.version)).toEqual(["0001", "0002"]);
    expect(state.has("0003")).toBe(true);

    // RECOVERY: the re-run re-executes 0003 (deterministic migrations are
    // safe to re-run; the ledger catches up) and continues to the end.
    const recoveredRunner = createMigrationRunner({
      migrations: migrationSet(state),
      ledger: crashLedger,
      now: () => new DeterministicClock(T0).now(),
    });
    const recovered = await recoveredRunner.migrateUp();
    expect(recovered.map((entry) => entry.version)).toEqual(["0003", "0004", "0005"]);
    expect(crashLedger.snapshot().map((entry) => entry.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
    ]);
    // CONVERGENCE: a third, crash-free run applies nothing (fixed point).
    const fixedPoint = await recoveredRunner.migrateUp();
    expect(fixedPoint).toEqual([]);
    expect([...state.keys()]).toEqual(["0001", "0002", "0003", "0004", "0005"]);
  });

  it("M-6 ledger corruption fails closed (unknown or duplicate versions)", async () => {
    const state = new Map<string, string>();
    const { runner } = runnerOf(state);
    await runner.migrateUp();

    // A ledger entry referencing a version NOT in the migration list is
    // state corruption - fail closed, never guess through.
    const corruptUnknown = createInMemoryAppliedVersionsLedger();
    await corruptUnknown.recordApplied("9999" as MigrationVersion, parseUtcInstant("2026-04-01T06:00:00.000Z"));
    const corruptRunner = createMigrationRunner({
      migrations: migrationSet(new Map()),
      ledger: corruptUnknown,
      now: () => new DeterministicClock(T0).now(),
    });
    await expect(corruptRunner.migrateUp()).rejects.toMatchObject({
      reason: "MIGRATION_LEDGER_CORRUPT",
    });
    await expect(corruptRunner.migrateDown()).rejects.toMatchObject({
      reason: "MIGRATION_LEDGER_CORRUPT",
    });

    // A duplicate ledger entry is corruption too.
    const corruptDuplicate = createInMemoryAppliedVersionsLedger();
    await corruptDuplicate.recordApplied("0001" as MigrationVersion, parseUtcInstant("2026-04-01T06:00:00.000Z"));
    await expect(
      corruptDuplicate.recordApplied("0001" as MigrationVersion, parseUtcInstant("2026-04-01T06:01:00.000Z")),
    ).rejects.toMatchObject({ reason: "MIGRATION_LEDGER_CORRUPT" });

    // And an invalid migration list itself is rejected up front.
    expect(() =>
      createMigrationRunner({
        migrations: [
          { version: "0001" as MigrationVersion, description: "x", up: () => undefined, down: () => undefined },
        ],
        ledger: createInMemoryAppliedVersionsLedger(),
      }),
    ).not.toThrow();
    expect(() =>
      createMigrationRunner({
        migrations: [
          { version: "0001" as MigrationVersion, description: "a", up: () => undefined, down: () => undefined },
          { version: "0001" as MigrationVersion, description: "duplicate", up: () => undefined, down: () => undefined },
        ],
        ledger: createInMemoryAppliedVersionsLedger(),
      }),
    ).toThrowError(ValidationError);
  });
});
