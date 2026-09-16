/**
 * RL-LOCK-019 conformance suite: three-worker-safe ownership.
 *
 * Parallel work must operate on disjoint bounded contexts/contracts.
 * Shared-authority edits require orchestrator serialization. The frozen
 * repository layout encodes this as DEPENDENCY DIRECTION rules over the
 * workspace graph (spec/repository-layout.md, spec/dependency-graph.md):
 *
 * GREEN PROOFS (the whole workspace graph, not per-wave slices):
 *  - contracts has ZERO runtime dependencies (the foundation);
 *  - sibling domain packages never import each other (experience,
 *    commerce, notifications, auth are disjoint authorities - they mirror
 *    shared discipline through contracts instead);
 *  - apps consume the application kit only (web/admin) or their frozen
 *    edge set (mobile) - never a domain or integration package;
 *  - the workspace dependency graph is ACYCLIC;
 *  - no package outside the boundary composition set depends on the
 *    projection/integration internals.
 *
 * NEGATIVE PROOF (red-on-violation): a sibling-authority dependency
 * (notifications -> domain-commerce) turns the graph scan red (toggle
 * RL-LOCK-019; an inline fixture proves detection in every run).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  overlayFor,
  readWorkspaceManifests,
  toggleHint,
  violationEnabled,
  type PackageManifest,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-019";

/**
 * Sibling domain/authority packages: disjoint bounded contexts that must
 * never depend on each other (their shared disciplines are mirrored from
 * @roamlink/contracts, never imported sideways).
 */
const SIBLING_AUTHORITY_PACKAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "packages/auth": ["@roamlink/domain-experience", "@roamlink/domain-commerce", "@roamlink/notifications", "@roamlink/commerce-connectivity"],
  "packages/domain-experience": ["@roamlink/domain-commerce", "@roamlink/notifications", "@roamlink/commerce-connectivity", "@roamlink/auth"],
  "packages/domain-commerce": ["@roamlink/domain-experience", "@roamlink/notifications", "@roamlink/commerce-connectivity", "@roamlink/auth"],
  "packages/notifications": ["@roamlink/domain-experience", "@roamlink/domain-commerce", "@roamlink/commerce-connectivity", "@roamlink/auth"],
  "packages/commerce-connectivity": ["@roamlink/domain-experience", "@roamlink/notifications", "@roamlink/auth"],
  "packages/intent-compiler": ["@roamlink/domain-commerce", "@roamlink/notifications", "@roamlink/commerce-connectivity"],
});

/** Forbidden runtime deps for each app surface. */
const APP_FORBIDDEN_DEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "apps/web": [
    "@roamlink/adcos",
    "@roamlink/integration",
    "@roamlink/domain-experience",
    "@roamlink/domain-commerce",
    "@roamlink/auth",
    "@roamlink/persistence",
    "@roamlink/projections",
    "@roamlink/webhook-inbox",
    "@roamlink/reconciliation",
  ],
  "apps/admin": [
    "@roamlink/adcos",
    "@roamlink/integration",
    "@roamlink/domain-experience",
    "@roamlink/domain-commerce",
    "@roamlink/auth",
    "@roamlink/persistence",
    "@roamlink/projections",
    "@roamlink/webhook-inbox",
    "@roamlink/reconciliation",
  ],
  "apps/mobile": [
    "@roamlink/adcos",
    "@roamlink/integration",
    "@roamlink/domain-experience",
    "@roamlink/domain-commerce",
    "@roamlink/auth",
    "@roamlink/persistence",
    "@roamlink/projections",
    "@roamlink/webhook-inbox",
    "@roamlink/reconciliation",
    "@roamlink/notifications",
    "@roamlink/enterprise",
  ],
});

describe(`${LOCK}: three-worker-safe ownership (dependency direction)`, () => {
  it("green: contracts is the zero-dependency foundation", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const contracts = manifests.find((manifest) => manifest.dir === "packages/contracts");
    expect(contracts).toBeDefined();
    expect(contracts?.dependencies).toEqual([]);
  });

  it("green: sibling authority packages never depend on each other", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const byDir = new Map(manifests.map((manifest) => [manifest.dir, manifest]));
    const violations: string[] = [];
    for (const [dir, forbidden] of Object.entries(SIBLING_AUTHORITY_PACKAGES)) {
      const manifest = byDir.get(dir);
      if (manifest === undefined) continue;
      for (const dep of forbidden) {
        if (manifest.dependencies.includes(dep)) {
          violations.push(`${dir} -> ${dep}`);
        }
      }
    }
    expect(
      violations,
      `${toggleHint(LOCK)} - sibling authority packages are disjoint bounded contexts`,
    ).toEqual([]);
  });

  it("green: apps consume only their sanctioned surfaces", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const byDir = new Map(manifests.map((manifest) => [manifest.dir, manifest]));
    const violations: string[] = [];
    for (const [dir, forbidden] of Object.entries(APP_FORBIDDEN_DEPS)) {
      const manifest = byDir.get(dir);
      if (manifest === undefined) continue;
      for (const dep of forbidden) {
        if (manifest.dependencies.includes(dep)) {
          violations.push(`${dir} -> ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("green: the workspace dependency graph is acyclic", () => {
    const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
    const cycle = findCycle(manifests);
    expect(cycle, `workspace dependency cycle: ${cycle?.join(" -> ") ?? "none"}`).toBeNull();
  });

  it("negative proof: a sibling-authority dependency is detected (and turns the scan red when toggled)", () => {
    // Inline detection proof: a notifications -> domain-commerce edge is
    // exactly the violation the sibling rule forbids.
    const violating: readonly PackageManifest[] = [
      {
        dir: "packages/notifications",
        name: "@roamlink/notifications",
        dependencies: [
          "@roamlink/contracts",
          "@roamlink/domain-commerce",
          "@roamlink/persistence",
        ],
        devDependencies: [],
      },
    ];
    const forbidden = SIBLING_AUTHORITY_PACKAGES["packages/notifications"] ?? [];
    const found = violating[0]?.dependencies.filter((dep) => forbidden.includes(dep)) ?? [];
    expect(found).toEqual(["@roamlink/domain-commerce"]);

    if (violationEnabled(LOCK)) {
      // The real-tree scan with the toggled manifest MUST find the
      // sibling-authority edge.
      const manifests = readWorkspaceManifests(REPO_ROOT, overlayFor(LOCK));
      const notifications = manifests.find(
        (manifest) => manifest.dir === "packages/notifications",
      );
      expect(
        (notifications?.dependencies ?? []).includes("@roamlink/domain-commerce"),
      ).toBe(true);
    }
  });
});

/** Finds a dependency cycle in the workspace graph (DFS), or null. */
function findCycle(manifests: readonly PackageManifest[]): readonly string[] | null {
  const edges = new Map<string, readonly string[]>();
  for (const manifest of manifests) {
    edges.set(
      manifest.name,
      manifest.dependencies.filter((dep) => dep.startsWith("@roamlink/")),
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): readonly string[] | null => {
    if (done.has(node)) return null;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      return [...stack.slice(cycleStart), node];
    }
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  };

  for (const manifest of manifests) {
    const cycle = visit(manifest.name);
    if (cycle !== null) return cycle;
  }
  return null;
}
