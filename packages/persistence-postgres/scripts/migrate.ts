#!/usr/bin/env node
/**
 * The migration CLI (RL-092): forward + rollback + manifest over the real
 * PostgreSQL driver, reading infra/migrations. Run through tsx (a
 * devDependency of this package):
 *
 *   pnpm --filter @roamlink/persistence-postgres db:migrate            # apply all pending
 *   pnpm --filter @roamlink/persistence-postgres db:rollback           # roll everything back
 *   pnpm --filter @roamlink/persistence-postgres db:rollback -- 0002   # roll back to (keeping) 0002
 *   pnpm --filter @roamlink/persistence-postgres db:manifest           # print the manifest JSON
 *
 * The connection string comes from DATABASE_URL (env-driven configuration;
 * this script contains zero secrets).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { createPgDriver, runMigrationCommand, setMigrationFileAccess, setMigrationPathResolver } from "../src/index.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = join(packageDir, "..", "..");
const migrationsDir = join(repoRoot, "infra", "migrations");

setMigrationFileAccess({
  listDir: (dir) => readdirSync(dir),
  readTextFile: (path) => readFileSync(path, "utf8"),
});
setMigrationPathResolver(() => migrationsDir);

async function main(): Promise<void> {
  const [command, targetArgument] = process.argv.slice(2);
  if (command !== "up" && command !== "down" && command !== "manifest") {
    fail("usage: migrate.ts <up|down|manifest> [target-version]");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    fail("DATABASE_URL is not set; the migration CLI refuses to guess a connection target");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const driver = createPgDriver(pool);
  try {
    const result = await runMigrationCommand(driver, command, {
      ...(targetArgument !== undefined ? { target: parseTarget(targetArgument) } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await driver.close();
  }
}

function parseTarget(value: string): `${number}` {
  if (!/^\d{4}$/.test(value) || value === "0000") {
    fail(`invalid migration target '${value}': expected a 4-digit version 0001..9999`);
  }
  return value as `${number}`;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
