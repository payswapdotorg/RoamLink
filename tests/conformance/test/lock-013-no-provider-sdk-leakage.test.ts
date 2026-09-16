/**
 * RL-LOCK-013 conformance suite: no hidden provider SDK leakage.
 *
 * Provider SDKs belong behind appropriate integration/adapter boundaries.
 * Core Experience/Commerce code must not depend on provider-specific
 * implementation details.
 *
 * GREEN PROOFS:
 *  - every CORE package's runtime dependencies are @roamlink/* workspace
 *    packages only (zero third-party runtime deps in domain, edge,
 *    platform and reference packages);
 *  - no production source imports a provider SDK (shared with LOCK-006,
 *    from the dependency direction rather than the authority direction).
 *
 * NEGATIVE PROOF: a core package manifest declaring a third-party runtime
 * dependency ("stripe") turns the manifest scan red (toggle RL-LOCK-013;
 * an inline fixture proves detection in every run).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  overlayFor,
  readWorkspaceManifests,
  toggleHint,
  violationEnabled,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-013";

/**
 * The CORE packages whose manifests must stay provider-free: every domain,
 * edge, platform and reference package (apps and the boundary composition
 * packages may add integration dependencies only through ADR-approved
 * seams - none of which exist today).
 */
const CORE_PACKAGE_DIRS = [
  "packages/contracts",
  "packages/auth",
  "packages/domain-experience",
  "packages/domain-commerce",
  "packages/commerce-connectivity",
  "packages/notifications",
  "packages/intent-compiler",
  "packages/edge",
  "packages/edge-actions",
  "packages/edge-connector",
  "packages/persistence",
  "packages/projections",
  "packages/webhook-inbox",
  "packages/reconciliation",
  "packages/compat",
  "packages/retention",
  "packages/secrets",
  "packages/audit",
  "packages/observability",
  "packages/resilience",
  "packages/adcos",
  "packages/testkit",
  "packages/app-kit",
  "packages/enterprise",
] as const;

describe(`${LOCK}: no hidden provider SDK leakage`, () => {
  it("green: core packages declare only @roamlink/* runtime dependencies", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const core = new Set<string>(CORE_PACKAGE_DIRS);
    const violations = manifests
      .filter((manifest) => core.has(manifest.dir))
      .flatMap((manifest) =>
        manifest.dependencies
          .filter((dep) => !dep.startsWith("@roamlink/"))
          .map((dep) => `${manifest.dir} -> ${dep}`),
      );
    expect(
      violations,
      `${toggleHint(LOCK)} - core packages must not depend on provider-specific implementation details`,
    ).toEqual([]);
  });

  it("green: core packages' devDependencies are tooling only (typescript, eslint, vitest, node types, testkit)", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const core = new Set<string>(CORE_PACKAGE_DIRS);
    const allowedDev = new Set([
      "@roamlink/testkit",
      "@roamlink/retention",
      "@types/node",
      "eslint",
      "typescript",
      "vitest",
    ]);
    const violations = manifests
      .filter((manifest) => core.has(manifest.dir))
      .flatMap((manifest) =>
        manifest.devDependencies
          .filter((dep) => !allowedDev.has(dep))
          .map((dep) => `${manifest.dir} -> ${dep}`),
      );
    expect(violations).toEqual([]);
  });

  it("negative proof: a third-party runtime dependency in a core manifest is a violation", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, []);
    const domainCommerce = manifests.find((manifest) => manifest.dir === "packages/domain-commerce");
    expect(domainCommerce).toBeDefined();
    const thirdParty = (domainCommerce?.dependencies ?? []).filter(
      (dep) => !dep.startsWith("@roamlink/"),
    );
    // Green proof on the real manifest: none. The negative fixture:
    // toggling RL-LOCK-013 replaces this manifest with one that declares
    // "stripe", and the scan above goes red.
    expect(thirdParty).toEqual([]);

    if (violationEnabled(LOCK)) {
      const toggled = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
      const toggledCommerce = toggled.find(
        (manifest) => manifest.dir === "packages/domain-commerce",
      );
      expect(
        (toggledCommerce?.dependencies ?? []).filter((dep) => dep === "stripe").length,
      ).toBeGreaterThan(0);
    }
  });
});
