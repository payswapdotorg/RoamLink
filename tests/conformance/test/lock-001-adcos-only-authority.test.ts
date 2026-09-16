/**
 * RL-LOCK-001 conformance suite: ADCOS is the connectivity authority.
 *
 * GREEN PROOFS (current tree):
 *  - no file outside the ADCOS boundary package defines an ADCOS-lifecycle-
 *    shaped state machine (transition map or state-array vocabulary);
 *  - the domain/authority packages do not import the ADCOS contract or
 *    integration packages at all (they cannot express connectivity
 *    authority without them);
 *  - the projection engine's canonical-resource vocabulary is closed and
 *    contains no RoamLink-invented connectivity kinds.
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - planting a competing lifecycle definition in a domain package makes
 *    the structural scan fail (toggle RL-LOCK-001; also proven inline
 *    against an in-memory overlay);
 *  - a RoamLink-invented canonical resource kind ("connectivity_session")
 *    is REJECTED by the projection record parser - if the tree ever
 *    admitted a second authority's vocabulary, this assertion fails.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ADCOS_PROJECTION_RESOURCE_TYPES,
  parseAdcosProjectionResourceType,
} from "@roamlink/projections";
import { ADCOS_ROUTES } from "@roamlink/adcos";
import {
  overlayFor,
  violationEnabled,
  toggleHint,
  type SourceFile,
  findCompetingLifecycleDefinitions,
  readSourceFiles,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-001";

/** Domain/authority packages that must never touch the boundary. */
const AUTHORITY_PACKAGES = [
  "packages/domain-experience",
  "packages/domain-commerce",
  "packages/commerce-connectivity",
  "packages/notifications",
  "packages/auth",
  "packages/intent-compiler",
  "packages/edge",
  "packages/edge-actions",
] as const;

describe(`${LOCK}: ADCOS is the connectivity authority`, () => {
  it("green: no package outside the ADCOS boundary defines ADCOS-lifecycle semantics", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK));
    const findings = findCompetingLifecycleDefinitions(files);
    expect(
      findings.map((finding) => `${finding.file} (${finding.kind})`),
      `${toggleHint(LOCK)} - a competing connectivity lifecycle state machine exists outside packages/adcos`,
    ).toEqual([]);
  });

  it("negative proof: a planted competing lifecycle definition turns the scan red", () => {
    // The same scanner, handed ONLY the violating overlay, must find it.
    // (When the toggle is on, the test above already fails; this test makes
    // the scanner's teeth independently visible in every run.)
    const violating: SourceFile[] = [
      {
        path: "packages/domain-commerce/src/competitor.ts",
        content: [
          "const T: Record<string, string[]> = {",
          '  INTENT: ["OFFER_SELECTED", "EXPIRED", "FAILED"],',
          '  OFFER_SELECTED: ["CONTRACT_ACTIVE", "TERMINATED"],',
          '  CONTRACT_ACTIVE: ["EXECUTION_ACTIVE", "DEGRADED"],',
          "};",
        ].join("\n"),
      },
    ];
    const findings = findCompetingLifecycleDefinitions(violating);
    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe("transition-map");

    const arrayViolation: SourceFile[] = [
      {
        path: "packages/notifications/src/competitor.ts",
        content: 'export const STATES = ["INTENT", "OFFER_SELECTED", "DELIVERY"];',
      },
    ];
    expect(findCompetingLifecycleDefinitions(arrayViolation).length).toBe(1);
  });

  it("green: authority packages import neither the ADCOS contract nor the integration boundary", () => {
    const files = readSourceFiles(
      REPO_ROOT,
      AUTHORITY_PACKAGES.slice(),
      overlayFor(LOCK),
    );
    for (const file of files) {
      if (!file.path.includes("/src/")) continue;
      for (const specifier of [/from\s+["']@roamlink\/adcos["']/, /from\s+["']@roamlink\/integration["']/]) {
        expect(
          specifier.test(file.content),
          `${file.path} reaches the ADCOS/integration packages directly (a domain package cannot become a connectivity authority)`,
        ).toBe(false);
      }
    }
  });

  it("green: the canonical resource vocabulary contains no session/path/connectivity-execution kinds", () => {
    for (const invented of [
      "connectivity_session",
      "network_path",
      "adcos_session",
      "roamlink_path",
      "routing_decision",
    ]) {
      expect(ADCOS_PROJECTION_RESOURCE_TYPES).not.toContain(invented);
    }
  });

  it("negative proof: a RoamLink-invented canonical resource kind is rejected (red when admitted)", () => {
    for (const invented of ["connectivity_session", "network_path", "routing_table"]) {
      if (violationEnabled(LOCK)) {
        // The violating fixture asserts the second authority EXISTS. A
        // conforming tree rejects the invented kind, so this fails.
        expect(() => parseAdcosProjectionResourceType(invented)).not.toThrow();
      } else {
        expect(() => parseAdcosProjectionResourceType(invented)).toThrow(/closed v2 canonical resource types/);
      }
    }
  });

  it("green: the pinned v2 route table exposes no session or path mutation routes", () => {
    for (const route of ADCOS_ROUTES) {
      expect(route.path, `route ${route.operation}`).not.toMatch(/session|path|route|topology/i);
      expect(route.operation, `route ${route.operation}`).not.toMatch(/session|path|route|topology/i);
    }
  });
});
