import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-3 Worker C packages (RL-043 edge-actions, RL-044 edge-connector,
 * RL-054 retention) must keep the three-worker-safe dependency direction
 * (RL-LOCK-019, spec/repository-layout.md "Dependency direction") and the
 * platform-isolation rules:
 *
 *  - `edge-actions` may depend on contracts, edge (the capability gate,
 *    action contracts, offline outbox), domain-experience (the closed
 *    DeviceCapabilitySnapshot vocabulary) and testkit;
 *  - `edge-connector` may depend on contracts, edge (device refs) and
 *    testkit;
 *  - `retention` may depend on contracts, persistence (the RL-003
 *    primitives) and testkit;
 *  - NONE of them may import ADCOS internals (RL-LOCK-002) - in addition to
 *    the repo-wide forbidden-imports test;
 *  - Experience/Commerce CORE packages must never import the platform
 *    adapter packages (RL-LOCK-013: no platform/provider leakage into
 *    Experience/Commerce core - the seam direction is one-way).
 */
const ALLOWED_EDGE_ACTIONS_DEPS = [
  "@roamlink/contracts",
  "@roamlink/edge",
  "@roamlink/domain-experience",
  "@roamlink/testkit",
] as const;

const ALLOWED_EDGE_CONNECTOR_DEPS = [
  "@roamlink/contracts",
  "@roamlink/edge",
  "@roamlink/testkit",
] as const;

const ALLOWED_RETENTION_DEPS = [
  "@roamlink/contracts",
  "@roamlink/persistence",
  "@roamlink/testkit",
] as const;

/** Experience/Commerce core packages (RL-LOCK-013 protected consumers). */
const CORE_PACKAGES = [
  "packages/domain-experience",
  "packages/domain-commerce",
] as const;

/** The Wave-3 Worker C platform packages (RL-043/044/054). */
const WORKER_C_PACKAGES = [
  "packages/edge-actions",
  "packages/edge-connector",
  "packages/retention",
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

describe("Wave-3 Worker C packages keep the dependency direction (RL-LOCK-019)", () => {
  it.each([
    ["packages/edge-actions", ALLOWED_EDGE_ACTIONS_DEPS],
    ["packages/edge-connector", ALLOWED_EDGE_CONNECTOR_DEPS],
    ["packages/retention", ALLOWED_RETENTION_DEPS],
  ] as const)("%s declares only allowed RoamLink dependencies", (packageDir, allowed) => {
    const manifest = readManifest(packageDir);
    // Runtime dependencies must stay within the allowed set; testkit is a
    // TEST-ONLY tool and may only appear as a devDependency.
    const runtimeAllowed = (allowed as readonly string[]).filter((name) => name !== "@roamlink/testkit");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      for (const dep of roamlinkDeps) {
        expect(
          runtimeAllowed,
          `${packageDir} ${field} declares the non-test dependency '${dep}'`,
        ).toContain(dep);
      }
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDevDeps, `${packageDir} may only dev-depend on @roamlink/testkit`).toEqual([
        "@roamlink/testkit",
      ]);
    }
  });

  it.each(WORKER_C_PACKAGES)("%s src imports only the declared boundary packages", (packageDir) => {
    const allowed =
      packageDir === "packages/edge-actions"
        ? ALLOWED_EDGE_ACTIONS_DEPS
        : packageDir === "packages/edge-connector"
          ? ALLOWED_EDGE_CONNECTOR_DEPS
          : ALLOWED_RETENTION_DEPS;
    const offenders: string[] = [];
    for (const file of sourceFiles(packageDir, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(allowed as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no Wave-3 Worker C package imports ADCOS internals (RL-LOCK-002)", () => {
    const offenders: string[] = [];
    for (const packageDir of WORKER_C_PACKAGES) {
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

  it("Experience/Commerce core never imports the platform adapter packages (RL-LOCK-013)", () => {
    const offenders: string[] = [];
    for (const corePackage of CORE_PACKAGES) {
      for (const file of sourceFiles(corePackage, "src")) {
        for (const imported of roamlinkImportsOf(file)) {
          if ((WORKER_C_PACKAGES.map((pkg) => `@roamlink/${pkg.split("/")[1]}`) as string[]).includes(imported)) {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
          }
        }
      }
    }
    expect(
      offenders,
      `platform leakage into Experience/Commerce core: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the adapter packages stay behind the stable edge contract (RL-LOCK-013 seam)", () => {
    // The platform packages may import the edge CONTRACTS package, but the
    // edge package must never depend on any platform adapter (one-way seam).
    const edgeManifest = readManifest("packages/edge");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = edgeManifest[field];
      if (deps === undefined) continue;
      const platformDeps = Object.keys(deps).filter((name) =>
        (
          WORKER_C_PACKAGES.map((pkg) => `@roamlink/${pkg.split("/")[1]}`) as string[]
        ).includes(name),
      );
      expect(platformDeps, "the edge contract package must not depend on platform adapters")
        .toEqual([]);
    }
  });
});
