import { describe, expect, it } from "vitest";
import { ValidationError, canonicalizeJson, parseUtcInstant } from "@roamlink/contracts";
import {
  ADCOS_PROJECTION_RESOURCE_TYPES,
  parseAdcosProjectionRecord,
  projectionFreshnessIsConsistent,
  projectionIdFor,
  type AdcosProjectionRecord,
} from "../src/index.js";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function validRecord(overrides?: Partial<AdcosProjectionRecord>): AdcosProjectionRecord {
  return {
    projection_id: "prj.connectivity_contract.contract-77",
    source_authority: "adcos",
    canonical_resource_type: "connectivity_contract",
    canonical_resource_id: "contract-77",
    source_version: 4,
    event_id: "evt-9",
    payload_digest: "a".repeat(64),
    observed_at: T0,
    received_at: T0,
    fresh_until: "2026-01-15T08:31:00.000Z",
    freshness_state: "FRESH",
    evidence_class: "AUTHENTICATED",
    projection_version: 1,
    payload: { state: "CONTRACT_ACTIVE", resource_version: 4 },
    ...overrides,
  } as AdcosProjectionRecord;
}

describe("the §8 projection record shape (RL-034)", () => {
  it("carries EXACTLY the documented fields plus the payload", () => {
    const record = parseAdcosProjectionRecord(validRecord());
    expect(Object.keys(record).sort()).toEqual([
      "canonical_resource_id",
      "canonical_resource_type",
      "event_id",
      "evidence_class",
      "fresh_until",
      "freshness_state",
      "observed_at",
      "payload",
      "payload_digest",
      "projection_id",
      "projection_version",
      "received_at",
      "source_authority",
      "source_version",
    ]);
  });

  it("the deterministic projection identity is prj.<type>.<id>", () => {
    expect(projectionIdFor("connectivity_intent", "intent-1")).toBe("prj.connectivity_intent.intent-1");
    expect(projectionIdFor("connectivity_lease", "lease-9")).toBe("prj.connectivity_lease.lease-9");
    expect(() => projectionIdFor("connectivity_contract", "bad id with spaces")).toThrow(ValidationError);
  });

  it("parses a valid record and rejects unknown fields", () => {
    expect(() => parseAdcosProjectionRecord(validRecord({ invented: true } as never))).toThrow(ValidationError);
    for (const field of [
      "projection_id",
      "source_authority",
      "canonical_resource_type",
      "canonical_resource_id",
      "payload_digest",
      "freshness_state",
      "evidence_class",
      "projection_version",
      "payload",
    ]) {
      const missing = { ...validRecord() } as Record<string, unknown>;
      delete missing[field];
      expect(() => parseAdcosProjectionRecord(missing), `missing ${field}`).toThrow(ValidationError);
    }
  });

  it("rejects an inconsistent projection_id / resource pair", () => {
    expect(() =>
      parseAdcosProjectionRecord(validRecord({ canonical_resource_id: "contract-99" })),
    ).toThrow(ValidationError);
  });

  it("rejects resource types outside the closed vocabulary (no sessions/paths)", () => {
    expect(() =>
      parseAdcosProjectionRecord(
        validRecord({
          canonical_resource_type: "connectivity_session" as never,
          projection_id: "prj.connectivity_session.session-1",
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      parseAdcosProjectionRecord(
        validRecord({
          canonical_resource_type: "network_path" as never,
          projection_id: "prj.network_path.path-1",
        }),
      ),
    ).toThrow(ValidationError);
    // RL-LOCK-004/005: no session or path resource types exist at all
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).not.toContain("connectivity_session");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).not.toContain("network_path");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).toContain("connectivity_intent");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).toContain("connectivity_contract");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).toContain("connectivity_lease");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).toContain("contract_usage");
    expect(ADCOS_PROJECTION_RESOURCE_TYPES).toContain("contract_assurance");
  });

  it("rejects invalid freshness states, evidence classes, digests and versions", () => {
    expect(() => parseAdcosProjectionRecord(validRecord({ freshness_state: "MAYBE" as never }))).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosProjectionRecord(validRecord({ evidence_class: "GUESSED" as never }))).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosProjectionRecord(validRecord({ payload_digest: "xyz" as never }))).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosProjectionRecord(validRecord({ projection_version: 0 as never }))).toThrow(ValidationError);
    expect(() => parseAdcosProjectionRecord(validRecord({ source_version: -1 as never }))).toThrow(ValidationError);
  });

  it("accepts null observation fields with the UNKNOWN state (absence is valid)", () => {
    const record = parseAdcosProjectionRecord(
      validRecord({
        source_version: null,
        event_id: null,
        observed_at: null,
        received_at: null,
        fresh_until: null,
        freshness_state: "UNKNOWN",
        evidence_class: "UNKNOWN",
      }),
    );
    expect(record.freshness_state).toBe("UNKNOWN");
    expect(record.source_version).toBeNull();
    expect(record.event_id).toBeNull();
  });

  it("the freshness consistency helper evaluates honestly", () => {
    const fresh = validRecord();
    expect(projectionFreshnessIsConsistent(fresh, T0)).toBe(true);
    expect(projectionFreshnessIsConsistent(fresh, parseUtcInstant("2026-01-15T08:32:00.000Z"))).toBe(false);
    const unknown = validRecord({
      observed_at: null,
      received_at: null,
      fresh_until: null,
      freshness_state: "UNKNOWN",
      evidence_class: "UNKNOWN",
    });
    expect(projectionFreshnessIsConsistent(unknown, T0)).toBe(true);
    expect(projectionFreshnessIsConsistent(unknown, parseUtcInstant("2026-01-15T09:00:00.000Z"))).toBe(true);
  });

  it("payload digests are deterministic across key order", () => {
    const a = canonicalizeJson({ b: 1, a: 2 });
    const b = canonicalizeJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});
