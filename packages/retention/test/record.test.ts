/**
 * RL-054 record tests: classification validation - purpose limitation,
 * consent gating for stricter categories, minimization bounds, and the
 * tombstone erasure semantics (spec/data-model.md "Privacy").
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { fixtureUtcInstant, fixtureTenantId } from "@roamlink/testkit";

import {
  DEFAULT_RETENTION_POLICY,
  parseClassifiedRecord,
  parseStoredRetentionRecord,
  tombstoneRecord,
} from "../src/index.js";

const T0 = fixtureUtcInstant();
const TENANT = fixtureTenantId();
const DAY = 24 * 60 * 60 * 1000;

function recordInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    recordId: "retention-record-1",
    tenantId: TENANT,
    deviceId: "device-enrollment-ref-1",
    dataCategory: "diagnostics",
    purposes: ["diagnostics"],
    collectedAt: T0,
    consent: false,
    payload: { signalStrengthDbm: -67, radio: "lte" },
    ...overrides,
  };
}

describe("parseClassifiedRecord (admission validation)", () => {
  it("parses a valid record and computes the policy expiry (never caller-set)", () => {
    const record = parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput());
    expect(record.dataCategory).toBe("diagnostics");
    expect(record.purposes).toEqual(["diagnostics"]);
    // diagnostics window is 90d in the default policy
    expect(record.expiresAt).toBe(fixtureUtcInstant(90 * DAY));
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("computes the STRICTER location expiry from the 24h window", () => {
    const record = parseClassifiedRecord(
      DEFAULT_RETENTION_POLICY,
      recordInput({
        dataCategory: "location",
        purposes: ["connectivity-experience"],
        consent: true,
        payload: { latitude: 50.1, longitude: 8.7 },
      }),
    );
    expect(record.expiresAt).toBe(fixtureUtcInstant(DAY));
  });

  it("rejects records without a classification or with an out-of-vocabulary one", () => {
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, {
        ...recordInput(),
        dataCategory: "carrier-metadata",
      }),
    ).toThrowError(/closed retention data-category vocabulary/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, { ...recordInput(), dataCategory: undefined }),
    ).toThrowError(ValidationError);
  });

  it("rejects empty or out-of-vocabulary purpose declarations", () => {
    expect(() => parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ purposes: [] })))
      .toThrowError(/non-empty purpose list/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ purposes: ["marketing"] })),
    ).toThrowError(/purpose vocabulary/);
  });

  it("enforces purpose limitation per category (location serves only connectivity-experience)", () => {
    expect(() =>
      parseClassifiedRecord(
        DEFAULT_RETENTION_POLICY,
        recordInput({
          dataCategory: "location",
          purposes: ["diagnostics"],
          consent: true,
          payload: {},
        }),
      ),
    ).toThrowError(/may not serve this purpose/);
  });

  it("REQUIRES explicit consent for location and network identifiers (stricter controls)", () => {
    for (const dataCategory of ["location", "network-identifiers"] as const) {
      expect(() =>
        parseClassifiedRecord(
          DEFAULT_RETENTION_POLICY,
          recordInput({
            dataCategory,
            purposes: ["connectivity-experience"],
            consent: false,
            payload: { digest: "0123456789abcdef" },
          }),
        ),
      ).toThrowError(/requires an explicit consent grant/);
    }
  });

  it("enforces the minimization byte bound per category", () => {
    const oversized = { blob: "x".repeat(600) };
    expect(() =>
      parseClassifiedRecord(
        DEFAULT_RETENTION_POLICY,
        recordInput({
          dataCategory: "location",
          purposes: ["connectivity-experience"],
          consent: true,
          payload: oversized,
        }),
      ),
    ).toThrowError(/minimization bound/);
  });

  it("rejects secret-shaped payloads (RL-LOCK-016 admission)", () => {
    // Built from parts so the source never carries a complete literal
    // credential (the repo's pre-commit secret scan would block it).
    const pemFixture = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
    expect(() =>
      parseClassifiedRecord(
        DEFAULT_RETENTION_POLICY,
        recordInput({ payload: { vpnPassword: "hunter2" } }),
      ),
    ).toThrowError(/secret-shaped material/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, {
        ...recordInput(),
        payload: { key: pemFixture },
      }),
    ).toThrowError(/secret-shaped material/);
  });

  it("rejects non-canonical payloads, bad tenants and unknown fields", () => {
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ payload: { bad: () => 1 } })),
    ).toThrowError(/canonicalizable JSON/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ tenantId: "acme" })),
    ).toThrowError(/tenantId/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ extra: true })),
    ).toThrowError(/unknown field/);
    expect(() =>
      parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput({ collectedAt: "2026-01-15" })),
    ).toThrowError(/collectedAt/);
  });
});

describe("tombstone erasure semantics", () => {
  it("a tombstone drops the payload and keeps auditable metadata", () => {
    const record = parseStoredRetentionRecord(
      DEFAULT_RETENTION_POLICY,
      recordInput(),
    );
    const tombstone = tombstoneRecord(record, fixtureUtcInstant(1000));
    expect(tombstone.payload).toBeNull();
    expect(tombstone.tombstonedAt).toBe(fixtureUtcInstant(1000));
    expect(tombstone.dataCategory).toBe(record.dataCategory);
    expect(tombstone.purposes).toEqual(record.purposes);
    expect(tombstone.tenantId).toBe(record.tenantId);
  });

  it("tombstoning twice is rejected (idempotence is the caller's contract)", () => {
    const record = parseStoredRetentionRecord(DEFAULT_RETENTION_POLICY, recordInput());
    const tombstone = tombstoneRecord(record, fixtureUtcInstant(1000));
    expect(() => tombstoneRecord(tombstone, fixtureUtcInstant(2000))).toThrowError(
      /already a tombstone/,
    );
  });

  it("a stored tombstone must not carry a payload (erasure is real)", () => {
    expect(() =>
      parseStoredRetentionRecord(
        DEFAULT_RETENTION_POLICY,
        recordInput({ tombstonedAt: fixtureUtcInstant(1000), payload: { not: "gone" } }),
      ),
    ).toThrowError(/must not carry a payload/);
  });

  it("a live stored record round-trips through parseStoredRetentionRecord", () => {
    const parsed = parseStoredRetentionRecord(
      DEFAULT_RETENTION_POLICY,
      recordInput(),
    );
    expect(parsed.tombstonedAt).toBeNull();
    expect(parsed.payload).toEqual({ signalStrengthDbm: -67, radio: "lte" });
  });
});
