import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository, scanSourceFile } from "../src/scan.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * RL-LOCK-002 / RL-LOCK-018: application modules may never import ADCOS
 * internal implementation modules. This test FAILS when a violation is
 * introduced anywhere under apps/, packages/ or services/ (outside
 * packages/adcos itself).
 */
describe("forbidden ADCOS internal imports (RL-LOCK-002/018)", () => {
  it("the repository contains no violations", () => {
    const violations = scanRepository(REPO_ROOT);
    expect(
      violations.map((v) => `${v.file} (${v.rule})`),
      `Forbidden ADCOS internal imports detected - only packages/adcos may touch ADCOS: ${violations
        .map((v) => `${v.file} via ${v.rule}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("the scanner actually detects violations (the test must be able to fail)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "roamlink-arch-"));
    try {
      const violating = join(fixtureRoot, "packages", "contracts", "evil.ts");
      mkdirSync(dirname(violating), { recursive: true });
      writeFileSync(violating, `import { internalThing } from "adcos/internal/lifecycle";\n`, "utf8");

      const violation = scanSourceFile(violating, "packages/contracts/evil.ts");
      expect(violation.length).toBeGreaterThan(0);
      expect(violation[0]?.rule).toBe("adc-os-path-import");

      // scope-style import
      writeFileSync(violating, `import { x } from "@adcos/core";\n`, "utf8");
      expect(scanSourceFile(violating, "packages/contracts/evil.ts").length).toBeGreaterThan(0);

      // require + dynamic import forms
      writeFileSync(violating, `const x = require("adc-os/session");\n`, "utf8");
      expect(scanSourceFile(violating, "packages/contracts/evil.ts").length).toBeGreaterThan(0);
      writeFileSync(violating, `const x = await import("@adcos/webhooks");\n`, "utf8");
      expect(scanSourceFile(violating, "packages/contracts/evil.ts").length).toBeGreaterThan(0);

      // clean file -> no violations
      writeFileSync(violating, `import { parseUserId } from "@roamlink/contracts";\n`, "utf8");
      expect(scanSourceFile(violating, "packages/contracts/evil.ts")).toEqual([]);

      // the packages/adcos boundary itself is exempt
      const boundary = join(fixtureRoot, "packages", "adcos", "client.ts");
      mkdirSync(dirname(boundary), { recursive: true });
      writeFileSync(boundary, `import { x } from "@adcos/core";\n`, "utf8");
      expect(scanSourceFile(boundary, "packages/adcos/client.ts")).toEqual([]);

      // scanRepository finds the fixture violation and reports the relative path
      writeFileSync(violating, `import { internalThing } from "adcos/internal/lifecycle";\n`, "utf8");
      const violations = scanRepository(fixtureRoot);
      expect(violations.length).toBe(1);
      expect(violations[0]?.file).toBe(join("packages", "contracts", "evil.ts"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("RoamLink contracts contain no false-positive triggers", () => {
    // AdcosIntentRef & co. are RoamLink-side reference TYPES; referring to
    // them must not look like importing ADCOS internals.
    const violations = scanRepository(REPO_ROOT);
    expect(violations).toEqual([]);
  });
});
