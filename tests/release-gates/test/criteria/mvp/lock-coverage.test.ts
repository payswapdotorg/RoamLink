/**
 * RL-080 MVP criterion 2 — the lock-coverage conformance suite.
 *
 * One suite per architecture lock already exists in tests/conformance
 * (RL-LOCK-001..017, 019) and tests/architecture (RL-LOCK-018). This file
 * adds the missing piece and validates the whole map:
 *
 *  - every lock RL-LOCK-001..020 has a mechanically verified coverage
 *    pointer (file exists, references the lock id, owning package declares
 *    a test script);
 *  - RL-LOCK-020 (architecture changes require ADR) gets an EXECUTABLE
 *    conformance check here — before RL-080 it had NO mechanical coverage
 *    anywhere (tests/conformance/README.md documented it as "governance,
 *    not mechanically testable before an ADR exists"). This suite checks
 *    the ADR-process artifacts the lock requires: the ADR directory, at
 *    least one accepted ADR with Status/Decision sections, and the frozen
 *    architecture sanity script gating the required spec files.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCK_COVERAGE } from "../../../../../scripts/release/lib/criteria-mvp.mjs";
import { discoverWorkspacePackages } from "../../../../../scripts/release/lib/gate-util.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

const ALL_LOCKS = Array.from({ length: 20 }, (_, index) =>
  `RL-LOCK-${String(index + 1).padStart(3, "0")}`,
);

describe("RL-080 lock coverage — every architecture lock has a conformance suite", () => {
  it("the coverage map names exactly RL-LOCK-001..RL-LOCK-020", () => {
    expect(Object.keys(LOCK_COVERAGE).sort()).toEqual(ALL_LOCKS);
  });

  it("every mapped coverage suite exists on the tree and references its lock id", () => {
    for (const [lockId, coverage] of Object.entries(LOCK_COVERAGE)) {
      for (const suitePath of coverage.suites) {
        const absolute = join(REPO_ROOT, suitePath);
        expect(existsSync(absolute), `${suitePath} (covering ${lockId}) must exist`).toBe(true);
        const text = readFileSync(absolute, "utf8");
        expect(
          text.includes(lockId),
          `${suitePath} must reference ${lockId} (a suite that cannot name its lock is not a proof)`,
        ).toBe(true);
      }
    }
  });

  it("every mapped owning package declares a test script (the coverage runs in the stack)", () => {
    const packagesByName = new Map(
      discoverWorkspacePackages(REPO_ROOT).map((pkg) => [pkg.name, pkg]),
    );
    for (const coverage of Object.values(LOCK_COVERAGE)) {
      const pkg = packagesByName.get(coverage.package);
      expect(pkg, `owning package ${coverage.package} must be a workspace package`).toBeDefined();
      expect(pkg?.hasTest, `${coverage.package} must declare a test script`).toBe(true);
    }
  });
});

describe("RL-LOCK-020 — architecture changes require ADR (process-artifact conformance)", () => {
  it("the ADR directory exists and contains at least one accepted ADR", () => {
    const adrDir = join(REPO_ROOT, "spec", "adr");
    expect(existsSync(adrDir)).toBe(true);
    const adrs = readdirSync(adrDir).filter((name) => name.endsWith(".md"));
    expect(adrs.length).toBeGreaterThanOrEqual(1);
    for (const name of adrs) {
      const text = readFileSync(join(adrDir, name), "utf8");
      expect(text.includes("**Status:**"), `${name} must record a Status`).toBe(true);
      expect(text.includes("## Decision"), `${name} must record a Decision`).toBe(true);
    }
  });

  it("the frozen architecture sanity script exists and gates the required spec files", () => {
    const scriptPath = join(REPO_ROOT, "scripts", "check-architecture.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf8");
    const required = [...script.matchAll(/"(spec\/[^"]+|README\.md|AGENTS\.md)"/g)].flatMap(
      (match) => (match[1] !== undefined ? [match[1]] : []),
    );
    expect(required.length).toBeGreaterThanOrEqual(10);
    for (const file of required) {
      expect(existsSync(join(REPO_ROOT, file)), `required architecture file ${file}`).toBe(true);
    }
    expect(script.includes("process.exit(1)")).toBe(true);
  });
});
