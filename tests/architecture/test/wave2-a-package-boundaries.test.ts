import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-2 Worker A packages (RL-012/013/020/021) must keep the
 * three-worker-safe dependency direction (RL-LOCK-019,
 * spec/repository-layout.md "Dependency direction"):
 *
 *  - `intent-compiler` depends ONLY on @roamlink/contracts +
 *    @roamlink/domain-experience (it compiles experience intents; the
 *    ADCOS-side mapping belongs to the integration boundary, RL-031);
 *  - `domain-commerce` depends ONLY on @roamlink/contracts +
 *    @roamlink/persistence (commerce has no experience-domain edge and
 *    never touches the integration boundary);
 *  - neither package imports @roamlink/adcos or any ADCOS internal
 *    (RL-LOCK-002/007): no ADCOS type is modeled outside the boundary.
 */
const PACKAGE_ALLOWED_DEPS = {
  "packages/intent-compiler": [
    "@roamlink/contracts",
    "@roamlink/domain-experience",
  ],
  "packages/domain-commerce": [
    "@roamlink/contracts",
    "@roamlink/persistence",
  ],
} as const;

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

describe("Wave-2 Worker A packages keep the dependency direction (RL-LOCK-019)", () => {
  for (const [packageDir, allowed] of Object.entries(PACKAGE_ALLOWED_DEPS)) {
    it(`${packageDir} declares exactly its allowed RoamLink dependencies`, () => {
      const manifest = readManifest(packageDir);
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = manifest[field];
        if (deps === undefined) continue;
        const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
        expect(
          roamlinkDeps.sort(),
          `${packageDir} ${field} must reference only ${allowed.join(" + ")}`,
        ).toEqual([...allowed].sort());
      }
    });

    it(`${packageDir} source imports only its allowed RoamLink packages`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(packageDir)) {
        const source = readFileSync(file, "utf8");
        const matches = [...source.matchAll(/from\s+["'](@roamlink\/[^"']+)["']/g)];
        for (const match of matches) {
          const imported = match[1] ?? "unknown";
          if (!(allowed as readonly string[]).includes(imported)) {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
          }
        }
      }
      expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("the RL-013 decision read model is additive to domain-experience (no authority migration)", () => {
    const decisionDir = join(REPO_ROOT, "packages", "domain-experience", "src", "decision");
    expect(existsSync(decisionDir)).toBe(true);
    for (const file of sourceFiles("packages/domain-experience/src/decision")) {
      const source = readFileSync(file, "utf8");
      expect(
        source.includes("@roamlink/adcos"),
        `${relative(REPO_ROOT, file)} must not import the ADCOS contract package (decisions reference connectivity, never model it)`,
      ).toBe(false);
    }
  });

  it("the intent-compiler output carries source-intent traceability fields", () => {
    const commandFile = join(REPO_ROOT, "packages", "intent-compiler", "src", "command.ts");
    expect(existsSync(commandFile)).toBe(true);
    const source = readFileSync(commandFile, "utf8");
    for (const field of [
      "sourceIntentId",
      "sourceIntentVersionId",
      "sourceIntentVersionNumber",
    ]) {
      expect(source.includes(field), `command.ts must define the ${field} traceability field`).toBe(
        true,
      );
    }
  });

  it("commerce records carry no connectivity/delivery vocabulary (RL-LOCK-008)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("packages/domain-commerce/src")) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "AdcosIntentRef",
        "AdcosContractRef",
        "AdcosLeaseRef",
        "AdcosSessionRef",
        "AdcosPathRef",
        "reservationState",
        "sessionState",
      ]) {
        if (source.includes(forbidden)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${forbidden}`);
        }
      }
    }
    expect(
      offenders,
      `commerce must not model connectivity/delivery state: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
