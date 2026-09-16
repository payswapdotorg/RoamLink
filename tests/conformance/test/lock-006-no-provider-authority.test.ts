/**
 * RL-LOCK-006 conformance suite: no provider authority.
 *
 * RoamLink may model customer-facing provider INFORMATION (an opaque
 * `providerReference` on a payment), but provider-native state is
 * external: provider APIs can never silently become RoamLink connectivity
 * truth.
 *
 * GREEN PROOFS:
 *  - no production source imports a provider SDK (structural scan of every
 *    package and app src tree);
 *  - the connectivity reference model's evidence vocabulary admits ONLY
 *    the `adcos` and `roamlink` source authorities - a provider-named
 *    authority cannot be parsed as delivery evidence.
 *
 * NEGATIVE PROOFS:
 *  - toggle RL-LOCK-006 plants a Stripe import in a core package; the scan
 *    goes red (plus an inline fixture proving the scanner's detection);
 *  - behaviorally, delivery evidence claiming a PROVIDER source authority
 *    must be rejected (red when admitted).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseDeliveryEvidence } from "@roamlink/commerce-connectivity";
import {
  findSdkImports,
  overlayFor,
  PROVIDER_SDK_PATTERNS,
  readSourceFiles,
  toggleHint,
  violationEnabled,
  type SourceFile,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-006";
const T0 = "2026-01-15T08:30:00.000Z";

/** Production sources only: package + app runtime code, never tests. */
function productionSources(): readonly SourceFile[] {
  return readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK)).filter((file) =>
    file.path.includes("/src/"),
  );
}

describe(`${LOCK}: no provider authority`, () => {
  it("green: no production source imports a provider SDK", () => {
    const findings = findSdkImports(productionSources(), PROVIDER_SDK_PATTERNS);
    expect(
      findings.map((finding) => `${finding.file} imports ${finding.imported} (${finding.sdk})`),
      `${toggleHint(LOCK)} - provider SDKs belong behind integration/adapter boundaries`,
    ).toEqual([]);
  });

  it("negative proof: a provider SDK import in a core package is detected (and turns the scan red when toggled)", () => {
    // Inline detection proof (runs every time): the scanner sees the pattern.
    const violating: SourceFile[] = [
      {
        path: "packages/domain-commerce/src/gateway.ts",
        content: 'import Stripe from "stripe";\nimport { twilio } from "twilio";\n',
      },
    ];
    const findings = findSdkImports(violating, PROVIDER_SDK_PATTERNS);
    expect(findings.map((finding) => finding.sdk).sort()).toEqual(["stripe", "twilio"]);

    // Toggle proof: with the fixture planted into the real-tree scan, the
    // production scan above must find it. This branch only runs toggled.
    if (violationEnabled(LOCK)) {
      const real = findSdkImports(productionSources(), PROVIDER_SDK_PATTERNS);
      expect(real.length).toBeGreaterThan(0);
    }
  });

  it("negative proof: delivery evidence cannot carry a provider authority claim (red when admitted)", () => {
    // The evidence vocabulary is closed and has NO provider-authority
    // member: any attempt to smuggle provider-native state into delivery
    // evidence is rejected at the parser.
    const base = {
      evidenceClass: "AUTHENTICATED",
      observedAt: T0,
      receivedAt: T0,
      freshUntil: "2026-01-15T08:31:00.000Z",
      freshnessState: "FRESH",
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-1",
      sourceVersion: 2,
      eventId: "evt-1",
      payloadDigest: "a".repeat(64),
      payload: { carrier: "acme" },
    };
    const withProviderAuthority = {
      ...base,
      sourceAuthority: "provider:acme",
      providerCarrierStatus: "active-on-carrier",
    };
    if (violationEnabled(LOCK)) {
      expect(() => parseDeliveryEvidence(withProviderAuthority)).not.toThrow();
    } else {
      expect(() => parseDeliveryEvidence(withProviderAuthority)).toThrow(
        /unknown field|vocabulary is closed/,
      );
    }
  });

  it("green: provider presence in commerce is presentation metadata only (opaque, bounded references)", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/domain-commerce/src"], []);
    const payment = files.find((file) => file.path.endsWith("payment.ts"));
    expect(payment).toBeDefined();
    // The provider reference is a short opaque string, and the payment's
    // closed vocabulary has no provider-LIFECYCLE state.
    expect(payment?.content).toMatch(/providerReference/);
    for (const forbidden of [/providerState/, /carrierStatus/, /providerLifecycle/]) {
      expect(forbidden.test(payment?.content ?? "")).toBe(false);
    }
  });
});
