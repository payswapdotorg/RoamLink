import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");

/**
 * spec/repository-layout.md: `contracts` is the lowest-level package. It must
 * not depend on any other RoamLink workspace package (no @roamlink/*
 * dependencies, no @roamlink/* imports in source) so the dependency graph
 * stays acyclic and three-worker-safe (RL-LOCK-019).
 */
describe("packages/contracts is the lowest-level package", () => {
  it("declares no @roamlink/* dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(CONTRACTS_DIR, "package.json"), "utf8"),
    ) as Record<string, Record<string, unknown> | undefined>;

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(
        roamlinkDeps,
        `packages/contracts ${field} must not reference other RoamLink packages`,
      ).toEqual([]);
    }
  });

  it("source contains no @roamlink/* imports", () => {
    const offenders: string[] = [];
    const srcDir = join(CONTRACTS_DIR, "src");
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.ts$/.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          if (/(?:from|import\()\s+["']@roamlink\//.test(source)) {
            offenders.push(relative(REPO_ROOT, path));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders, `contracts must not import other RoamLink packages: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the workspace test packages do not bypass the contracts boundary", () => {
    // tests/architecture is allowed to depend on @roamlink/contracts only.
    const manifestPath = join(REPO_ROOT, "tests", "architecture", "package.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(deps.filter((name) => name.startsWith("@roamlink/"))).toEqual(["@roamlink/contracts"]);
  });
});
