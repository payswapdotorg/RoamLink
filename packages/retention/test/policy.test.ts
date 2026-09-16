/**
 * RL-054 policy tests: retention windows, the STRUCTURALLY enforced stricter
 * controls for location/network-identifiers, and the closed vocabularies
 * (RL-LOCK-018 - a lax policy must FAIL construction, not silently apply).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_POLICY,
  parseRetentionPolicy,
  retentionRuleFor,
} from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;

function policyWith(overrides: Record<string, unknown>): unknown {
  const rules: Record<string, unknown> = {};
  for (const [category, rule] of Object.entries(DEFAULT_RETENTION_POLICY.rules)) {
    rules[category] = {
      ...(rule as unknown as Record<string, unknown>),
      ...(overrides[category] ?? {}),
    };
  }
  return { contractVersion: "0.1", rules };
}

describe("the default retention policy", () => {
  it("carries one rule per closed-vocabulary category", () => {
    expect(Object.keys(DEFAULT_RETENTION_POLICY.rules).sort()).toEqual([
      "diagnostics",
      "location",
      "network-identifiers",
      "telemetry",
      "usage",
    ]);
  });

  it("gives location and network identifiers the strictest, consent-gated windows", () => {
    const location = retentionRuleFor(DEFAULT_RETENTION_POLICY, "location");
    const network = retentionRuleFor(DEFAULT_RETENTION_POLICY, "network-identifiers");
    expect(location.retentionWindowMs).toBe(DAY);
    expect(network.retentionWindowMs).toBe(7 * DAY);
    expect(location.requiresExplicitConsent).toBe(true);
    expect(network.requiresExplicitConsent).toBe(true);
    for (const category of ["diagnostics", "usage", "telemetry"] as const) {
      const rule = retentionRuleFor(DEFAULT_RETENTION_POLICY, category);
      expect(location.retentionWindowMs).toBeLessThan(rule.retentionWindowMs);
      expect(network.retentionWindowMs).toBeLessThan(rule.retentionWindowMs);
      expect(rule.requiresExplicitConsent).toBe(false);
    }
  });

  it("tombstones the stricter categories and hard-deletes the coarse ones", () => {
    expect(retentionRuleFor(DEFAULT_RETENTION_POLICY, "location").erasureSemantics).toBe("tombstone");
    expect(retentionRuleFor(DEFAULT_RETENTION_POLICY, "network-identifiers").erasureSemantics).toBe(
      "tombstone",
    );
    expect(retentionRuleFor(DEFAULT_RETENTION_POLICY, "diagnostics").erasureSemantics).toBe(
      "hard-delete",
    );
    expect(retentionRuleFor(DEFAULT_RETENTION_POLICY, "usage").erasureSemantics).toBe("hard-delete");
  });
});

describe("parseRetentionPolicy (fail-closed, stricter controls enforced)", () => {
  it("round-trips the default policy", () => {
    const parsed = parseRetentionPolicy(policyWith({}));
    expect(parsed).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it("REJECTS a location window not strictly shorter than the coarse categories", () => {
    expect(() =>
      parseRetentionPolicy(policyWith({ location: { retentionWindowMs: 180 * DAY } })),
    ).toThrowError(/strictly shorter/);
    expect(() =>
      parseRetentionPolicy(policyWith({ location: { retentionWindowMs: 90 * DAY } })),
    ).toThrowError(/strictly shorter/);
  });

  it("REJECTS a network-identifiers window as long as diagnostics", () => {
    expect(() =>
      parseRetentionPolicy(policyWith({ "network-identifiers": { retentionWindowMs: 90 * DAY } })),
    ).toThrowError(/strictly shorter than the diagnostics window/);
  });

  it("REJECTS stricter categories without the explicit-consent requirement", () => {
    expect(() =>
      parseRetentionPolicy(policyWith({ location: { requiresExplicitConsent: false } })),
    ).toThrowError(/REQUIRE explicit consent/);
    expect(() =>
      parseRetentionPolicy(policyWith({ "network-identifiers": { requiresExplicitConsent: false } })),
    ).toThrowError(/REQUIRE explicit consent/);
  });

  it("rejects missing rules, extra categories, bad windows and empty purposes", () => {
    const missing = policyWith({}) as Record<string, unknown>;
    const rules = missing["rules"] as Record<string, unknown>;
    delete rules["telemetry"];
    expect(() => parseRetentionPolicy(missing)).toThrowError(/missing required rule/);

    const extra = policyWith({}) as Record<string, unknown>;
    (extra["rules"] as Record<string, unknown>)["carrier-metadata"] = {
      category: "carrier-metadata",
      retentionWindowMs: DAY,
      erasureSemantics: "hard-delete",
      allowedPurposes: ["diagnostics"],
      maxPayloadBytes: 512,
      requiresExplicitConsent: false,
    };
    expect(() => parseRetentionPolicy(extra)).toThrowError(/closed category vocabulary is exact/);

    expect(() =>
      parseRetentionPolicy(policyWith({ usage: { retentionWindowMs: 0 } })),
    ).toThrowError(/retentionWindowMs/);
    expect(() =>
      parseRetentionPolicy(policyWith({ usage: { allowedPurposes: [] } })),
    ).toThrowError(/non-empty purpose list/);
    expect(() =>
      parseRetentionPolicy(policyWith({ usage: { allowedPurposes: ["marketing"] } })),
    ).toThrowError(/out-of-vocabulary purpose/);
    expect(() =>
      parseRetentionPolicy({ contractVersion: "9.9", rules: (policyWith({}) as Record<string, unknown>)["rules"] }),
    ).toThrowError(/contractVersion/);
  });
});
