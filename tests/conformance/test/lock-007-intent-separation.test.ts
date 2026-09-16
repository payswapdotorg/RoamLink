/**
 * RL-LOCK-007 conformance suite: ExperienceIntent is not
 * ConnectivityIntent.
 *
 * The RoamLink `ExperienceIntent` is a customer/domain abstraction
 * (PREFERENCES ONLY); the ADCOS `ConnectivityIntent` remains canonical for
 * connectivity execution. Mapping between them is explicit, versioned and
 * traceable (RL-012's compiler).
 *
 * GREEN PROOFS:
 *  - the experience-domain access classes are a closed PREFERENCES-only
 *    vocabulary (no constraint/execution semantics);
 *  - the intent payload vocabulary is closed: travel window + usage profile
 *    + preference profile + boolean hard constraints, and NOTHING else
 *    ("no money, no network facts");
 *  - domain-experience never imports the ADCOS/integration packages;
 *  - the compiler preserves source-intent traceability (id + version id +
 *    version number in payload AND envelope).
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - an access class asserting connectivity EXECUTION semantics is
 *    rejected by the closed vocabulary parser;
 *  - an intent payload carrying connectivity-execution fields (path
 *    selection, network constraints) is rejected by its closed vocabulary.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ACCESS_CLASS_NAMES,
  ExperienceIntent,
  ExperienceIntentVersion,
  parseAccessClassName,
} from "@roamlink/domain-experience";
import { fixtureUserId } from "@roamlink/testkit";
import { overlayFor, readSourceFiles, toggleHint, violationEnabled } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-007";
const T0 = "2026-01-15T08:30:00.000Z";
const TENANT = "usr:00000000-0000-4000-8000-000000000003";

const INTENT_BASE = {
  intentId: "00000000-0000-4000-8000-0000000000b1",
  ownerUserId: fixtureUserId(3) as unknown as string,
  status: "draft",
  currentVersionId: "00000000-0000-4000-8000-0000000000b2",
  currentVersionNumber: 1,
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

/** A valid PREFERENCES-only intent payload. */
const PREFERENCES_PAYLOAD = {
  travelWindow: { start: T0, end: "2026-01-16T08:30:00.000Z" },
  usageProfile: "travel_international",
  preferences: {
    reliability: "standard",
    latency: "interactive",
    costSensitivity: "medium",
    privacySensitivity: "high",
    preferredAccessClasses: ["trusted_wifi", "home_cellular"],
  },
  hardConstraints: {
    requireEncryptedTransport: true,
    forbidRoaming: false,
    forbidOpenWifi: true,
  },
} as const;

const VERSION_BASE = {
  tenantId: TENANT,
  intentVersionId: "00000000-0000-4000-8000-0000000000b2",
  intentId: "00000000-0000-4000-8000-0000000000b1",
  versionNumber: 1,
  payload: PREFERENCES_PAYLOAD,
  createdAt: T0,
} as const;

describe(`${LOCK}: ExperienceIntent is not ConnectivityIntent`, () => {
  it("green: the access-class vocabulary is preferences-only and closed", () => {
    expect(ACCESS_CLASS_NAMES).toEqual([
      "trusted_wifi",
      "open_wifi",
      "home_cellular",
      "roaming_cellular",
      "wired",
      "satellite",
      "hotspot",
    ]);
    for (const name of ACCESS_CLASS_NAMES) {
      expect(parseAccessClassName(name)).toBe(name);
    }
  });

  it("negative proof: an access class with connectivity-execution semantics is rejected (red when admitted)", () => {
    for (const invented of ["mandatory_cellular", "constrained_wired", "required_path"]) {
      if (violationEnabled(LOCK)) {
        expect(() => parseAccessClassName(invented)).not.toThrow();
      } else {
        expect(() => parseAccessClassName(invented)).toThrow(/ACCESS_CLASS_INVALID|preferences only/);
      }
    }
  });

  it("green: an ExperienceIntent and its PREFERENCES-only version construct cleanly", () => {
    const intent = new ExperienceIntent({ ...INTENT_BASE });
    const version = new ExperienceIntentVersion({ ...VERSION_BASE });
    expect(intent.intentId).toBe(INTENT_BASE.intentId);
    expect(version.versionNumber).toBe(1);
    expect(version.payload.hardConstraints.requireEncryptedTransport).toBe(true);
  });

  it("negative proof: an intent payload carrying connectivity-execution fields is rejected (red when admitted)", () => {
    const violating = {
      ...VERSION_BASE,
      payload: {
        ...PREFERENCES_PAYLOAD,
        // ADCOS-execution semantics smuggled into the experience payload:
        pathSelection: { preferredPath: "fiber-ring-7", routingWeight: 0.9 },
        connectivityConstraints: [{ dimension: "path", classification: "hard" }],
      },
    };
    if (violationEnabled(LOCK)) {
      expect(() => new ExperienceIntentVersion(violating)).not.toThrow();
    } else {
      expect(() => new ExperienceIntentVersion(violating)).toThrow(
        /must be a valid intent payload/,
      );
    }
  });

  it("green: the experience domain and compiler never import the ADCOS boundary packages", () => {
    const files = readSourceFiles(
      REPO_ROOT,
      ["packages/domain-experience", "packages/intent-compiler"],
      overlayFor(LOCK),
    );
    const offenders = files
      .filter((file) => file.path.includes("/src/"))
      .filter(
        (file) =>
          /from\s+["']@roamlink\/adcos["']/.test(file.content) ||
          /from\s+["']@roamlink\/integration["']/.test(file.content),
      )
      .map((file) => file.path);
    expect(
      offenders,
      `${toggleHint(LOCK)} - the experience domain must not depend on ADCOS execution semantics`,
    ).toEqual([]);
  });

  it("green: the intent compiler preserves source-intent traceability in payload AND envelope", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/intent-compiler/src"], []);
    const command = files.find((file) => file.path.endsWith("command.ts"));
    expect(command).toBeDefined();
    const content = command?.content ?? "";
    expect(content).toMatch(/sourceIntentId/);
    expect(content).toMatch(/sourceIntentVersionId/);
    expect(content).toMatch(/sourceIntentVersionNumber/);
    // The compiled payload must not carry experience-domain preference
    // vocabulary verbatim into the ADCOS command (mapping is explicit).
    expect(content).not.toMatch(/ACCESS_CLASS_NAMES/);
  });
});
