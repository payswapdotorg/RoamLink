import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADCOS_ENVIRONMENTS,
  ADCOS_ROUTES,
  AdcosEnvironmentMismatchError,
  assertAdcosEnvironmentMatches,
} from "../src/index.js";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PKG_DIR, "src");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * RL-LOCK-004/005 + RL-LOCK-018: the ADCOS v2 public surface has NO session
 * or NetworkPath resources. This conformance test fails the build if anyone
 * introduces `AdcosSession`/`AdcosPath` API resource types, session/path
 * routes, or session/path members on the client seam. (Contracts'
 * AdcosSessionRef/AdcosPathRef reference types are RoamLink-side projection
 * references, NOT ADCOS API resources - they live in @roamlink/contracts.)
 */
describe("no session/path resources in the ADCOS v2 public contract (RL-LOCK-004/005/018)", () => {
  it("no route path mentions sessions or paths", () => {
    for (const route of ADCOS_ROUTES) {
      expect(route.path.toLowerCase()).not.toMatch(/session|network-?path|\/paths?\b/);
    }
  });

  it("no source module declares AdcosSession/AdcosPath resource types", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const source = readFileSync(file, "utf8");
      // declarations only (mentions inside prohibition comments use plain
      // words; declaration sites always follow `interface AdcosSession` /
      // `type AdcosPath` / `Document = ...` shapes)
      if (/(?:interface|type)\s+Adcos(?:Session|Path|NetworkPath)\b/.test(source)) {
        offenders.push(file);
      }
      if (/Adcos(?:Session|Path|NetworkPath)Document\b/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the client seam has no session/path members", () => {
    const clientSource = readFileSync(join(SRC_DIR, "client.ts"), "utf8");
    const methodNames = [...clientSource.matchAll(/^\s{2}(?:readonly\s+)?(\w+)\s*[(:]/gm)].map(
      (match) => match[1] ?? "",
    );
    for (const name of methodNames) {
      expect(name.toLowerCase()).not.toMatch(/session|path/);
    }
    // sanity: the seam does expose the contract/lease surface
    expect(methodNames).toContain("listContracts");
    expect(methodNames).toContain("grantLease");
    expect(methodNames).toContain("getContractUsage");
  });

  it("environments fail closed on mismatch (environment-mismatch code)", () => {
    expect(() => assertAdcosEnvironmentMatches("sandbox", "sandbox")).not.toThrow();
    expect(() => assertAdcosEnvironmentMatches("production", "production")).not.toThrow();
    let caught: AdcosEnvironmentMismatchError | null = null;
    try {
      assertAdcosEnvironmentMatches("sandbox", "production");
    } catch (error) {
      caught = error as AdcosEnvironmentMismatchError;
    }
    expect(caught).toBeInstanceOf(AdcosEnvironmentMismatchError);
    expect(caught?.code).toBe("environment-mismatch");
    expect(ADCOS_ENVIRONMENTS).toEqual(["sandbox", "production"]);
  });
});
