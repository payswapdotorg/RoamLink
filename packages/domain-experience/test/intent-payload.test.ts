/**
 * RL-011 intent payload + preference profile tests: travel-window bounds,
 * closed vocabularies, access classes as PREFERENCES ONLY, and the
 * structural no-money guarantee.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, canonicalizeJson } from "@roamlink/contracts";

import {
  ACCESS_CLASS_NAMES,
  parseAccessClassName,
  parseExperienceIntentPayload,
  parsePreferenceProfile,
} from "../src/index.js";

function payloadFixture(overrides?: Record<string, unknown>) {
  return {
    travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
    usageProfile: "travel_international",
    preferences: {
      reliability: "high",
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
    ...overrides,
  };
}

describe("preference profile (RL-011 sub-model)", () => {
  it("parses and freezes a valid profile", () => {
    const profile = parsePreferenceProfile(payloadFixture().preferences);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.preferredAccessClasses)).toBe(true);
    expect(profile.reliability).toBe("high");
  });

  it("rejects closed-vocabulary violations and duplicate ranked preferences", () => {
    expect(() =>
      parsePreferenceProfile({ ...payloadFixture().preferences, reliability: "extreme" }),
    ).toThrowError(ValidationError);
    expect(() =>
      parsePreferenceProfile({ ...payloadFixture().preferences, costSensitivity: "cheap" }),
    ).toThrowError(/sensitivity, never an amount/i);
    expect(() =>
      parsePreferenceProfile({
        ...payloadFixture().preferences,
        preferredAccessClasses: ["trusted_wifi", "trusted_wifi"],
      }),
    ).toThrowError(/duplicate/);
    expect(() =>
      parsePreferenceProfile({ ...payloadFixture().preferences, extra: 1 }),
    ).toThrowError(/unknown field/);
  });
});

describe("access classes are PREFERENCES ONLY (RL-LOCK-007)", () => {
  it("the vocabulary is closed and rejects outsiders without echoing", () => {
    expect([...ACCESS_CLASS_NAMES]).toHaveLength(7);
    expect(parseAccessClassName("trusted_wifi")).toBe("trusted_wifi");
    expect(() => parseAccessClassName("adcos_premium_class")).toThrowError(
      /preferences only/i,
    );
    try {
      parseAccessClassName("secret-class");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-class");
    }
  });
});

describe("travel window validation", () => {
  it("accepts a bounded window and rejects start >= end", () => {
    expect(() => parseExperienceIntentPayload(payloadFixture())).not.toThrow();
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({
          travelWindow: { start: "2026-02-14T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
        }),
      ),
    ).toThrowError(/strictly before end/);
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({
          travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
        }),
      ),
    ).toThrowError(/strictly before end/);
  });

  it("rejects windows longer than 366 days and naive timestamps", () => {
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({
          travelWindow: {
            start: "2026-01-01T00:00:00.000Z",
            end: "2027-06-01T00:00:00.000Z",
          },
        }),
      ),
    ).toThrowError(/366 days/);
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({ travelWindow: { start: "2026-02-01T00:00:00", end: "2026-02-14T00:00:00.000Z" } }),
      ),
    ).toThrowError(ValidationError);
  });
});

describe("payload closed vocabulary + hard constraints", () => {
  it("usage profiles and unknown fields fail closed", () => {
    expect(() =>
      parseExperienceIntentPayload(payloadFixture({ usageProfile: "gaming" })),
    ).toThrowError(ValidationError);
    expect(() => parseExperienceIntentPayload(payloadFixture({ budgetEur: 100 }))).toThrowError(
      /no money, no network facts/,
    );
  });

  it("hard constraints are exactly three booleans (never partial)", () => {
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({ hardConstraints: { requireEncryptedTransport: true } }),
      ),
    ).toThrowError(/never partial/);
    expect(() =>
      parseExperienceIntentPayload(
        payloadFixture({ hardConstraints: { requireEncryptedTransport: "yes", forbidRoaming: false, forbidOpenWifi: false } }),
      ),
    ).toThrowError(ValidationError);
    const payload = parseExperienceIntentPayload(payloadFixture());
    expect(payload.hardConstraints).toEqual({
      requireEncryptedTransport: true,
      forbidRoaming: false,
      forbidOpenWifi: true,
    });
  });

  it("STRUCTURAL NO-MONEY GUARANTEE: the canonical payload contains no money fields", () => {
    const payload = parseExperienceIntentPayload(payloadFixture());
    const canonical = canonicalizeJson(payload);
    expect(canonical).not.toMatch(/"(amount|currency|price|budget|cost_amount|minor_units|major_units|cents|eur|usd|gbp)"/i);
    // Cost exists ONLY as the sensitivity preference.
    expect(canonical).toContain('"costSensitivity":"medium"');
  });

  it("the parsed payload is deeply frozen", () => {
    const payload = parseExperienceIntentPayload(payloadFixture());
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.travelWindow)).toBe(true);
    expect(Object.isFrozen(payload.preferences)).toBe(true);
    expect(Object.isFrozen(payload.hardConstraints)).toBe(true);
  });
});
