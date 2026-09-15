import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import {
  createInMemoryAppliedVersionsLedger,
  createMigrationRunner,
  isMigrationVersion,
  parseMigrationVersion,
  type Migration,
} from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";
const FIXED_CLOCK = (): UtcInstant => parseUtcInstant(T0);

let clockTick = 0;
const tickingClock = (): UtcInstant =>
  parseUtcInstant(`2026-10-01T00:00:0${(clockTick += 1)}.000Z`);

function migration(
  version: string,
  description: string,
  log: string[],
  options?: { upThrows?: boolean },
): Migration {
  const v = parseMigrationVersion(version);
  return {
    version: v,
    description,
    up: () => {
      if (options?.upThrows) throw new Error("simulated migration failure");
      log.push(`up:${version}`);
    },
    down: () => {
      log.push(`down:${version}`);
    },
  };
}

describe("migration version (RL-003)", () => {
  it("accepts zero-padded 4-digit versions and rejects everything else", () => {
    expect(parseMigrationVersion("0001")).toBe("0001");
    expect(isMigrationVersion("9999")).toBe(true);
    for (const bad of ["1", "00001", "abc", "", 12, null, "12a4"]) {
      expect(isMigrationVersion(bad)).toBe(false);
      expect(() => parseMigrationVersion(bad)).toThrow(ValidationError);
    }
  });
});

describe("migration runner (RL-003)", () => {
  it("applies pending migrations in ASCENDING version order regardless of list order", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [
        migration("0003", "third", log),
        migration("0001", "first", log),
        migration("0002", "second", log),
      ],
      ledger,
      now: FIXED_CLOCK,
    });

    const applied = await runner.migrateUp();
    expect(log).toEqual(["up:0001", "up:0002", "up:0003"]);
    expect(applied.map((entry) => entry.version)).toEqual(["0001", "0002", "0003"]);
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual(["0001", "0002", "0003"]);
    expect(ledger.snapshot().map((entry) => entry.appliedAt)).toEqual([T0, T0, T0]);
  });

  it("re-running migrateUp is idempotent: nothing is applied twice", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [
        migration("0001", "first", log),
        migration("0002", "second", log),
        migration("0003", "third", log),
      ],
      ledger,
      now: FIXED_CLOCK,
    });

    await runner.migrateUp();
    const second = await runner.migrateUp();
    expect(second).toEqual([]);
    expect(log).toEqual(["up:0001", "up:0002", "up:0003"]);
    expect(ledger.snapshot()).toHaveLength(3);
  });

  it("migrateUp(target) stops after the target version", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [
        migration("0001", "first", log),
        migration("0002", "second", log),
        migration("0003", "third", log),
      ],
      ledger,
      now: FIXED_CLOCK,
    });

    const applied = await runner.migrateUp(parseMigrationVersion("0002"));
    expect(applied.map((entry) => entry.version)).toEqual(["0001", "0002"]);
    expect(log).toEqual(["up:0001", "up:0002"]);
    // then the remainder can be applied later
    const rest = await runner.migrateUp(parseMigrationVersion("0003"));
    expect(rest.map((entry) => entry.version)).toEqual(["0003"]);
  });

  it("migrateDown rolls back in DESCENDING order and keeps the target applied", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [
        migration("0001", "first", log),
        migration("0002", "second", log),
        migration("0003", "third", log),
      ],
      ledger,
      now: FIXED_CLOCK,
    });
    await runner.migrateUp();

    const rolledBack = await runner.migrateDown(parseMigrationVersion("0001"));
    expect(rolledBack).toEqual(["0003", "0002"]);
    expect(log).toEqual(["up:0001", "up:0002", "up:0003", "down:0003", "down:0002"]);
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual(["0001"]);

    // re-up after a partial rollback
    await runner.migrateUp();
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual(["0001", "0002", "0003"]);
  });

  it("migrateDown() with no target rolls back everything; re-up works", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [migration("0001", "first", log), migration("0002", "second", log)],
      ledger,
      now: FIXED_CLOCK,
    });
    await runner.migrateUp();

    const rolledBack = await runner.migrateDown();
    expect(rolledBack).toEqual(["0002", "0001"]);
    expect(log).toEqual(["up:0001", "up:0002", "down:0002", "down:0001"]);
    expect(ledger.snapshot()).toEqual([]);

    const reup = await runner.migrateUp();
    expect(reup.map((entry) => entry.version)).toEqual(["0001", "0002"]);
  });

  it("rejects duplicate migration versions", () => {
    const log: string[] = [];
    expect(() =>
      createMigrationRunner({
        migrations: [migration("0001", "first", log), migration("0001", "again", log)],
        ledger: createInMemoryAppliedVersionsLedger(),
        now: FIXED_CLOCK,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects unknown targets (up and down)", async () => {
    const log: string[] = [];
    const runner = createMigrationRunner({
      migrations: [migration("0001", "first", log)],
      ledger: createInMemoryAppliedVersionsLedger(),
      now: FIXED_CLOCK,
    });
    await expect(runner.migrateUp(parseMigrationVersion("0009"))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(runner.migrateDown(parseMigrationVersion("0009"))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("fails closed when the ledger references a version missing from the migration list", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    // simulate state corruption: ledger knows a version the runner does not
    await ledger.recordApplied(parseMigrationVersion("0009"), parseUtcInstant("2020-01-01T00:00:00.000Z"));
    const runner = createMigrationRunner({
      migrations: [migration("0001", "first", log)],
      ledger,
      now: FIXED_CLOCK,
    });
    await expect(runner.migrateUp()).rejects.toBeInstanceOf(ValidationError);
  });

  it("a failing migration leaves earlier ones applied and itself unrecorded", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [
        migration("0001", "first", log),
        migration("0002", "boom", log, { upThrows: true }),
        migration("0003", "third", log),
      ],
      ledger,
      now: FIXED_CLOCK,
    });
    await expect(runner.migrateUp()).rejects.toThrow("simulated migration failure");
    expect(ledger.snapshot().map((entry) => entry.version)).toEqual(["0001"]);
    expect(log).toEqual(["up:0001"]);
  });

  it("appliedAt stamps come from the injected clock (deterministic)", async () => {
    const log: string[] = [];
    const ledger = createInMemoryAppliedVersionsLedger();
    const runner = createMigrationRunner({
      migrations: [migration("0001", "first", log), migration("0002", "second", log)],
      ledger,
      now: tickingClock,
    });
    await runner.migrateUp();
    expect(ledger.snapshot().map((entry) => entry.appliedAt)).toEqual([
      "2026-10-01T00:00:01.000Z",
      "2026-10-01T00:00:02.000Z",
    ]);
  });

  it("validates migration shape (version, description, up/down) and tolerates an empty list", () => {
    const ledger = createInMemoryAppliedVersionsLedger();
    const bad = {
      version: "1",
      description: "x",
      up: (): void => undefined,
      down: (): void => undefined,
    } as unknown as Migration;
    expect(() =>
      createMigrationRunner({ migrations: [bad], ledger, now: FIXED_CLOCK }),
    ).toThrow(ValidationError);
    const noDown = {
      version: parseMigrationVersion("0001"),
      description: "x",
      up: (): void => undefined,
    } as unknown as Migration;
    expect(() =>
      createMigrationRunner({ migrations: [noDown], ledger, now: FIXED_CLOCK }),
    ).toThrow(ValidationError);
    expect(() =>
      createMigrationRunner({ migrations: [], ledger, now: FIXED_CLOCK }),
    ).not.toThrow();
  });
});
