import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-3 Worker B packages (RL-035 reconciliation, RL-036 compat) must keep
 * the three-worker-safe dependency direction (RL-LOCK-019,
 * spec/repository-layout.md "Dependency direction") and the one-integration-
 * boundary rule for ADCOS-derived projections (spec/adcos-integration.md §8,
 * RL-LOCK-002):
 *
 *  - `reconciliation` may depend on contracts, adcos (public types only),
 *    persistence, integration, projections, webhook-inbox and testkit - it
 *    IS the reconciler/integration boundary that writes ADCOS-derived
 *    projections;
 *  - `compat` may depend on contracts, adcos, integration, webhook-inbox and
 *    testkit - it consumes the boundary's public surface only and never
 *    touches the projection writer;
 *  - neither package may import ADCOS internals (RL-LOCK-002, in addition to
 *    the repo-wide forbidden-imports test).
 */
const ALLOWED_RECONCILIATION_DEPS = [
  "@roamlink/contracts",
  "@roamlink/adcos",
  "@roamlink/persistence",
  "@roamlink/integration",
  "@roamlink/projections",
  "@roamlink/webhook-inbox",
  "@roamlink/testkit",
] as const;

const ALLOWED_COMPAT_DEPS = [
  "@roamlink/contracts",
  "@roamlink/adcos",
  "@roamlink/integration",
  "@roamlink/webhook-inbox",
  "@roamlink/testkit",
] as const;

function readManifest(packageDir: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(REPO_ROOT, packageDir, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
}

function sourceFiles(packageDir: string, sub: "src" | "test"): string[] {
  const root = join(REPO_ROOT, packageDir, sub);
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function roamlinkImportsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["'](@roamlink\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

describe("Wave-3 Worker B packages keep the dependency direction (RL-LOCK-019)", () => {
  it("packages/reconciliation declares exactly the boundary dependency set", () => {
    const manifest = readManifest("packages/reconciliation");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDeps.sort(), `${field} must match the allowed boundary set`).toEqual(
        [...ALLOWED_RECONCILIATION_DEPS].sort(),
      );
    }
  });

  it("packages/reconciliation src imports only the declared boundary packages", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("packages/reconciliation", "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(ALLOWED_RECONCILIATION_DEPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
  });

  it("packages/compat declares exactly the boundary-consumer dependency set", () => {
    const manifest = readManifest("packages/compat");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDeps.sort(), `${field} must match the allowed compat set`).toEqual(
        [...ALLOWED_COMPAT_DEPS].sort(),
      );
    }
  });

  it("packages/compat src imports only the declared packages and NEVER the projection writer (§8)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("packages/compat", "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(ALLOWED_COMPAT_DEPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
      // §8: the compat suite consumes the boundary; it must not even import
      // the projections package (read or write).
      if (roamlinkImportsOf(file).includes("@roamlink/projections")) {
        offenders.push(`${relative(REPO_ROOT, file)} -> @roamlink/projections (compat must not write projections)`);
      }
    }
    expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no Wave-3 Worker B package imports ADCOS internals (RL-LOCK-002)", () => {
    const offenders: string[] = [];
    for (const packageDir of ["packages/reconciliation", "packages/compat"]) {
      for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
        const source = readFileSync(file, "utf8");
        const adcOsInternal = new RegExp("from\\s+[\"'].*adc-?os/(src|internal|lib)", "i");
        const adcosInternal = new RegExp("from\\s+[\"'].*adcos/(src|internal|lib)", "i");
        if (adcOsInternal.test(source) || adcosInternal.test(source)) {
          offenders.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders, `ADCOS-internal imports: ${offenders.join(", ")}`).toEqual([]);
  });
});
