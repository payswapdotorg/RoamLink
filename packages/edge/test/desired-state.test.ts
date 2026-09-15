import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";
import { parseEdgeDesiredStateRecord } from "../src/index.js";
import { freshnessFixture } from "./helpers.js";

function recordInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    contractVersion: "0.1",
    deviceRef: "device-enrollment-ref-1",
    capabilityRequirement: { capability: "wifi_control" },
    parameters: { networkSsid: "Guest" },
    createdAt: fixtureUtcInstant(),
    revision: 1,
    lastKnownFreshness: freshnessFixture(),
    ...overrides,
  };
}

describe("parseEdgeDesiredStateRecord", () => {
  it("parses a valid record, freezes it and preserves the freshness payload", () => {
    const record = parseEdgeDesiredStateRecord(recordInput());
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.capabilityRequirement.capability).toBe("wifi_control");
    expect(record.capabilityRequirement.minimumEvidenceClass).toBe("OBSERVED");
    expect(record.parameters).toEqual({ networkSsid: "Guest" });
    expect(record.revision).toBe(1);
    expect(record.supersededBy).toBeUndefined();
    expect(record.lastKnownFreshness.freshnessState).toBe("FRESH");
  });

  it("round-trips through JSON", () => {
    const record = parseEdgeDesiredStateRecord(recordInput());
    const restored = parseEdgeDesiredStateRecord(JSON.parse(JSON.stringify(record)));
    expect(restored).toEqual(record);
  });

  it("supports the supersession chain", () => {
    const superseded = parseEdgeDesiredStateRecord(
      recordInput({
        revision: 2,
        supersededBy: "00000000-0000-4000-8000-0000000000d2",
      }),
    );
    expect(superseded.supersededBy).toBe("00000000-0000-4000-8000-0000000000d2");
    expect(() =>
      parseEdgeDesiredStateRecord(recordInput({ supersededBy: "not-a-uuid" })),
    ).toThrowError(/supersededBy/);
  });

  it("rejects unknown fields (including a plaintext command envelope)", () => {
    expect(() => parseEdgeDesiredStateRecord(recordInput({ command: {} }))).toThrowError(
      /unknown field/,
    );
    expect(() => parseEdgeDesiredStateRecord(recordInput({ extra: 1 }))).toThrowError(
      /unknown field/,
    );
  });

  it("rejects invalid revisions, versions, requirements, parameters and freshness", () => {
    expect(() => parseEdgeDesiredStateRecord(recordInput({ revision: 0 }))).toThrowError(
      /revision/,
    );
    expect(() => parseEdgeDesiredStateRecord(recordInput({ contractVersion: "9.9" }))).toThrowError(
      /contractVersion/,
    );
    expect(() =>
      parseEdgeDesiredStateRecord(
        recordInput({ capabilityRequirement: { capability: "wifi_super_control" } }),
      ),
    ).toThrowError(/capabilityRequirement/);
    expect(() =>
      parseEdgeDesiredStateRecord(
        recordInput({ capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "INFERRED" } }),
      ),
    ).toThrowError(/capabilityRequirement/);
    expect(() => parseEdgeDesiredStateRecord(recordInput({ parameters: { deep: {} } }))).toThrowError(
      /parameters/,
    );
    expect(() =>
      parseEdgeDesiredStateRecord(recordInput({ lastKnownFreshness: { bogus: true } })),
    ).toThrowError(/lastKnownFreshness/);
    expect(() =>
      parseEdgeDesiredStateRecord(recordInput({ createdAt: "2026-01-15 08:30:00" })),
    ).toThrowError(/createdAt/);
  });

  it("a stale last-known freshness is preserved honestly, not repaired", () => {
    const record = parseEdgeDesiredStateRecord(
      recordInput({
        lastKnownFreshness: {
          observedAt: fixtureUtcInstant(),
          receivedAt: fixtureUtcInstant(),
          freshUntil: fixtureUtcInstant(60_000),
          freshnessState: "STALE", // as recorded at observation time
        },
      }),
    );
    expect(record.lastKnownFreshness.freshnessState).toBe("STALE");
  });
});
