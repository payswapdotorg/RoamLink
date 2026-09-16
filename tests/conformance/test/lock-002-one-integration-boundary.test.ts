/**
 * RL-LOCK-002 conformance suite: ONE integration boundary.
 *
 * Application modules access ADCOS only through the RoamLink integration
 * boundary and its public contract types. The boundary is structural:
 * exactly the packages that own/compose ADCOS access may import
 * `@roamlink/adcos`; everything else (domain, edge, commerce, apps,
 * platform packages) must go through `@roamlink/integration`'s public
 * surface or not touch ADCOS at all.
 *
 * GREEN PROOF: the current tree's source imports + manifests stay inside
 * the allowed importer set.
 *
 * NEGATIVE PROOF: an application module importing `@roamlink/adcos`
 * directly is a violation - toggling RL-LOCK-002 plants exactly such a
 * file (packages/edge/src/adcos-direct.ts), and the scan goes red. The
 * inline fixture proves the scanner detects the pattern in every run.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  findImportsOf,
  overlayFor,
  readSourceFiles,
  readWorkspaceManifests,
  toggleHint,
  type SourceFile,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-002";

/**
 * The packages allowed to import @roamlink/adcos: the boundary contract
 * package itself plus the integration-boundary composition set
 * (integration adapters, the webhook inbox, the projection engine, the
 * reconciler, and the compatibility suite that verifies the boundary).
 */
const ALLOWED_ADCOS_IMPORTERS = new Set([
  "packages/adcos",
  "packages/integration",
  "packages/webhook-inbox",
  "packages/projections",
  "packages/reconciliation",
  "packages/compat",
]);

/** The package dir that owns a repo-relative file path. */
function owningPackage(path: string): string | null {
  const match = /^((?:packages|apps)\/[^/]+)/.exec(path);
  return match === null ? null : (match[1] as string);
}

/** Every src import of @roamlink/adcos outside the allowed importer set. */
function boundaryViolations(files: readonly SourceFile[]): { readonly file: string; readonly imported: string }[] {
  return findImportsOf(files, "@roamlink/adcos")
    .map((finding) => ({
      ...finding,
      pkg: owningPackage(finding.file),
    }))
    .filter(
      (finding) =>
        finding.file.includes("/src/") &&
        finding.pkg !== null &&
        !ALLOWED_ADCOS_IMPORTERS.has(finding.pkg),
    );
}

describe(`${LOCK}: one integration boundary`, () => {
  it("green: only the boundary composition set imports @roamlink/adcos in runtime sources", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK));
    const violations = boundaryViolations(files);
    expect(
      violations.map((violation) => `${violation.file} imports ${violation.imported}`),
      `${toggleHint(LOCK)} - an application module reached past the integration boundary`,
    ).toEqual([]);
  });

  it("green: only the boundary composition set declares @roamlink/adcos as a runtime dependency", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const violations = manifests
      .filter(
        (manifest) =>
          manifest.dependencies.includes("@roamlink/adcos") &&
          !ALLOWED_ADCOS_IMPORTERS.has(manifest.dir),
      )
      .map((manifest) => manifest.dir);
    expect(
      violations,
      `${toggleHint(LOCK)} - a package outside the boundary depends on the ADCOS contract package`,
    ).toEqual([]);
  });

  it("negative proof: the scanner detects a direct ADCOS import from an application module", () => {
    const violating: SourceFile[] = [
      {
        path: "packages/edge/src/adcos-direct.ts",
        content: 'import type { AdcosClient } from "@roamlink/adcos";\n',
      },
      {
        path: "apps/web/src/direct.ts",
        content: 'const x = require("@roamlink/adcos");\n',
      },
    ];
    const violations = boundaryViolations(violating);
    expect(violations.length).toBe(2);
    expect(violations.map((violation) => violation.file)).toEqual([
      "packages/edge/src/adcos-direct.ts",
      "apps/web/src/direct.ts",
    ]);
  });

  it("negative proof: a boundary-bypassing import turns the real-tree scan red (toggle)", () => {
    // With the fixture toggled ON, the violating file is part of the scan
    // set and MUST be found (this assertion fires only in toggled runs).
    if (!overlayFor(LOCK).some((file) => file.path === "packages/edge/src/adcos-direct.ts")) {
      return; // toggle off: covered by the tests above
    }
    const files = readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK));
    const violations = boundaryViolations(files);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.file).toBe("packages/edge/src/adcos-direct.ts");
  });
});
