/**
 * RL-112 — the rollback decision rule's suite entry: the EXECUTABLE
 * post-rollback check is part of the standard verification run.
 *
 * The rule (infra/deployment/rollback/check.mjs, documented in the runbook
 * §9) decides deployment-level rollback acceptance: health + readiness
 * SERVABILITY + the §6b synthetic smoke. A rollback NEVER auto-runs
 * migrateDown — the deliberate down-migration is the runbook §9.2
 * exception, operator-commanded, paired with a restore-from-backup,
 * because the round-trip battery
 * (packages/persistence-postgres/test/rollback-roundtrip.test.ts) proves
 * the baseline down migrations DROP the data tables.
 *
 * This entry runs the checker's SELFTEST (deterministic, loopback-only
 * stub deployments): the honest ready state is accepted, a surfaced
 * degraded state is accepted, a truthful not-ready answer is REJECTED (not
 * restored service), a lying ready is REJECTED (the no-lie law), and an
 * unreachable host fails without crashing.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

describe("RL-112 the executable post-rollback decision rule", () => {
  it("the rollback check's selftest proves the runner end to end (exit 0)", () => {
    const run = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "infra", "deployment", "rollback", "selftest.mjs")],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(
      run.status,
      `the selftest must exit 0\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    ).toBe(0);
    expect(run.stdout).toMatch(/all \d+ checks passed/);
  });

  it("the runner is wired at the root (pnpm rollback:check / rollback:check:selftest)", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["rollback:check"]).toBe("node infra/deployment/rollback/check.mjs");
    expect(pkg.scripts["rollback:check:selftest"]).toBe(
      "node infra/deployment/rollback/selftest.mjs",
    );
  });
});
