/**
 * Boundary enforcement (RL-035, spec/adcos-integration.md §8 + RL-LOCK-002/
 * RL-LOCK-018): ONLY the reconciler/integration boundary writes
 * ADCOS-derived projections.
 *
 * This is a FAILING-CAPABLE architecture test (RL-LOCK-018): it scans the
 * real workspace sources and fails the build when a package outside the
 * boundary imports the projection package at all, or when anything outside
 * {projections, reconciliation} touches the WRITER surface. It also proves
 * the boundary factory never leaks a write capability.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHarness, createIntentOnFake, mustGetProjection } from "./helpers.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

function packageDirectories(): string[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name));
}

function sourceFilesUnder(dir: string, sub: "src" | "test"): string[] {
  const root = join(dir, sub);
  const files: string[] = [];
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["'](@roamlink\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

describe("only the reconciler/integration boundary writes ADCOS-derived projections (spec §8)", () => {
  it("no package outside the boundary imports @roamlink/projections at all", () => {
    const boundaryPackages = new Set(["projections", "reconciliation"]);
    const offenders: string[] = [];
    for (const packageDir of packageDirectories()) {
      const name = relative(join(REPO_ROOT, "packages"), packageDir);
      if (boundaryPackages.has(name)) continue;
      for (const file of sourceFilesUnder(packageDir, "src")) {
        for (const imported of importsOf(file)) {
          if (imported === "@roamlink/projections") {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
          }
        }
      }
    }
    expect(offenders, `forbidden projection imports: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the projection WRITER surface is imported only by its home and the reconciler", () => {
    const writerSurface = new Set([
      "ProjectionWriter",
      "ProjectionStore",
      "InMemoryProjectionStore",
      "AdcosProjectionEngine",
      "createBoundaryProjectionWriter",
    ]);
    const allowed = new Set(["projections", "reconciliation"]);
    const offenders: string[] = [];
    for (const packageDir of packageDirectories()) {
      const name = relative(join(REPO_ROOT, "packages"), packageDir);
      if (allowed.has(name)) continue;
      for (const file of [...sourceFilesUnder(packageDir, "src"), ...sourceFilesUnder(packageDir, "test")]) {
        const source = readFileSync(file, "utf8");
        for (const symbol of writerSurface) {
          const pattern = new RegExp(`\\b${symbol}\\b`);
          if (source.includes("@roamlink/projections") && pattern.test(source)) {
            offenders.push(`${relative(REPO_ROOT, file)} references ${symbol}`);
          }
        }
      }
    }
    expect(offenders, `forbidden writer-surface references: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the reconciliation package exports no raw writer surface of its own", () => {
    for (const file of sourceFilesUnder(join(REPO_ROOT, "packages", "reconciliation"), "src")) {
      const source = readFileSync(file, "utf8");
      expect(
        /export\s+(class|const|function)\s+InMemory\w*Store/.test(source),
        `${relative(REPO_ROOT, file)} must not export a projection store implementation`,
      ).toBe(false);
    }
  });
});

describe("the boundary factory never leaks a write capability", () => {
  it("the exposed projection surface has get/list/count ONLY (no apply)", () => {
    const harness = makeHarness();
    const exposed = harness.boundary.projections as unknown as Record<string, unknown>;
    expect(Object.keys(exposed).sort()).toEqual(["count", "get", "list"]);
    expect(exposed["apply"]).toBeUndefined();
    expect((harness.boundary as unknown as Record<string, unknown>)["projectionStore"]).toBeUndefined();
  });

  it("webhook-driven projection flows through the boundary-owned engine", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-boundary-projector");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const record = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(record.source_authority).toBe("adcos");
    expect(record.event_id).toBe("evt-1");
  });

  it("the reconciler NEVER mutates ADCOS (RL-LOCK-001: reads only)", async () => {
    const harness = makeHarness();
    await createIntentOnFake(harness, "idem-boundary-read-only");
    await harness.admit(harness.fake.deliveries());
    const before = {
      intents: harness.fake.intentCount(),
      contracts: harness.fake.contractCount(),
      leases: harness.fake.leaseCount(),
    };
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(harness.fake.intentCount()).toBe(before.intents);
    expect(harness.fake.contractCount()).toBe(before.contracts);
    expect(harness.fake.leaseCount()).toBe(before.leases);
  });
});
