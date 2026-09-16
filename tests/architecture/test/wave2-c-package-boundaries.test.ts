import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-2 Worker C packages (RL-050/051/053 new, RL-040/052 extended) must
 * keep the three-worker-safe dependency direction (RL-LOCK-019,
 * spec/repository-layout.md "Dependency direction"):
 *
 *  - `secrets`, `audit` and `resilience` depend ONLY on @roamlink/contracts;
 *  - `edge` and `observability` (already contracts-only in Wave 1) stay
 *    contracts-only after the RL-041/042/052 extensions - in particular the
 *    RL-042 sync engine must NOT import @roamlink/secrets (key material
 *    crosses through the duck-typed key-provider seam, not a package edge).
 */
const CONTRACTS_ONLY_PACKAGES = [
  "packages/secrets",
  "packages/audit",
  "packages/resilience",
  "packages/edge",
  "packages/observability",
] as const;

function readManifest(packageDir: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(REPO_ROOT, packageDir, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
}

function sourceFiles(packageDir: string): string[] {
  const srcDir = join(REPO_ROOT, packageDir, "src");
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.ts$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(srcDir);
  return files;
}

describe("Wave-2 Worker C packages keep the contracts-only dependency direction (RL-LOCK-019)", () => {
  for (const packageDir of CONTRACTS_ONLY_PACKAGES) {
    it(`${packageDir} declares only @roamlink/contracts as a RoamLink dependency`, () => {
      const manifest = readManifest(packageDir);
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = manifest[field];
        if (deps === undefined) continue;
        const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
        expect(
          roamlinkDeps,
          `${packageDir} ${field} must only reference @roamlink/contracts`,
        ).toEqual(["@roamlink/contracts"]);
      }
    });

    it(`${packageDir} source imports only @roamlink/contracts (never other RoamLink packages)`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(packageDir)) {
        const source = readFileSync(file, "utf8");
        const matches = [...source.matchAll(/from\s+["'](@roamlink\/[^"']+)["']/g)];
        for (const match of matches) {
          if (match[1] !== "@roamlink/contracts") {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${match[1]}`);
          }
        }
      }
      expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("the edge sync engine keeps the RL-050 seam duck-typed (no secrets import anywhere in edge)", () => {
    const edgeSyncDir = join(REPO_ROOT, "packages", "edge", "src", "sync");
    expect(existsSync(edgeSyncDir)).toBe(true);
    for (const file of sourceFiles("packages/edge/src/sync")) {
      const source = readFileSync(file, "utf8");
      expect(
        source.includes("@roamlink/secrets"),
        `${relative(REPO_ROOT, file)} must not import the secrets package (key material crosses the duck-typed key-provider seam)`,
      ).toBe(false);
    }
  });
});
