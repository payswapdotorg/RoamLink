/**
 * RL-010 DeviceCapabilitySnapshot tests: honesty rules (RL-LOCK-011),
 * absence-as-data, evidence tagging (RL-LOCK-010), chain continuity,
 * contract-version pinning and immutability.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import { DeviceCapabilitySnapshot } from "../src/index.js";

const OBSERVED_AT = "2026-01-15T08:30:00.000Z";
const FRESH_UNTIL = "2026-01-15T08:31:00.000Z";
const at = (iso: string) => parseUtcInstant(iso);

function snapshotInput(overrides?: Record<string, unknown>) {
  return {
    snapshotId: deterministicUuidFromSeed(10),
    contractVersion: "0.1",
    sequence: 1,
    deviceId: deterministicUuidFromSeed(1),
    platform: { family: "ios", platformVersion: "18.1" },
    observedAt: OBSERVED_AT,
    freshUntil: FRESH_UNTIL,
    capabilities: {
      wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: OBSERVED_AT },
    },
    ...overrides,
  };
}

describe("honesty rules (RL-LOCK-011)", () => {
  it("rejects a non-unknown status backed by UNKNOWN evidence (never guess)", () => {
    expect(
      () =>
        new DeviceCapabilitySnapshot(
          snapshotInput({
            capabilities: {
              wifi_control: { status: "available", evidenceClass: "UNKNOWN", observedAt: OBSERVED_AT },
            },
          }),
        ),
    ).toThrowError(/requires evidence whose class is not UNKNOWN/);
  });

  it("accepts an honest unknown status with UNKNOWN evidence", () => {
    const snapshot = new DeviceCapabilitySnapshot(
      snapshotInput({
        capabilities: {
          wifi_control: { status: "unknown", evidenceClass: "UNKNOWN", observedAt: OBSERVED_AT },
        },
      }),
    );
    expect(snapshot.capabilityStatus("wifi_control")).toBe("unknown");
  });

  it("rejects entry keys outside the closed vocabulary and unknown entry fields", () => {
    expect(
      () =>
        new DeviceCapabilitySnapshot(
          snapshotInput({ capabilities: { teleportation: { status: "unknown", evidenceClass: "UNKNOWN", observedAt: OBSERVED_AT } } }),
        ),
    ).toThrowError(/outside the closed capability vocabulary/);
    expect(
      () =>
        new DeviceCapabilitySnapshot(
          snapshotInput({
            capabilities: {
              wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: OBSERVED_AT, guess: 1 },
            },
          }),
        ),
    ).toThrowError(/unknown field/);
  });
});

describe("absence is data, not error (RL-LOCK-011)", () => {
  it("an EMPTY capabilities record is valid; every capability reports unknown", () => {
    const snapshot = new DeviceCapabilitySnapshot(snapshotInput({ capabilities: {} }));
    expect(snapshot.capabilityStatus("wifi_observation")).toBe("unknown");
    expect(snapshot.entryFor("wifi_observation")).toBeUndefined();
    expect(snapshot.capabilityMatrix()).toMatchObject({ wifi_observation: "unknown" });
  });

  it("the capability matrix covers ALL eleven names with statuses", () => {
    const snapshot = new DeviceCapabilitySnapshot(snapshotInput());
    const matrix = snapshot.capabilityMatrix();
    expect(Object.keys(matrix)).toHaveLength(11);
    expect(matrix.wifi_observation).toBe("available");
    expect(matrix.vpn_network_extension).toBe("unknown");
  });
});

describe("immutability + evidence + chain", () => {
  it("the snapshot is deeply frozen with per-entry evidence and observed instants", () => {
    const snapshot = new DeviceCapabilitySnapshot(snapshotInput());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    const entry = snapshot.entryFor("wifi_observation");
    expect(entry).toMatchObject({ status: "available", evidenceClass: "OBSERVED" });
    expect(entry?.observedAt).toBe(OBSERVED_AT);
    expect(snapshot.observedAt).toBe(OBSERVED_AT);
    expect(snapshot.freshUntil).toBe(FRESH_UNTIL);
  });

  it("freshUntil may be null (no freshness guarantee established)", () => {
    const snapshot = new DeviceCapabilitySnapshot(snapshotInput({ freshUntil: null }));
    expect(snapshot.freshUntil).toBeNull();
  });

  it("chain continuity: succeeds() requires same device and sequence + 1", () => {
    const first = new DeviceCapabilitySnapshot(snapshotInput({ sequence: 1 }));
    const second = new DeviceCapabilitySnapshot(
      snapshotInput({ snapshotId: deterministicUuidFromSeed(11), sequence: 2 }),
    );
    const skip = new DeviceCapabilitySnapshot(
      snapshotInput({ snapshotId: deterministicUuidFromSeed(12), sequence: 3 }),
    );
    const otherDevice = new DeviceCapabilitySnapshot(
      snapshotInput({
        snapshotId: deterministicUuidFromSeed(13),
        sequence: 2,
        deviceId: deterministicUuidFromSeed(9),
      }),
    );
    expect(second.succeeds(first)).toBe(true);
    expect(skip.succeeds(first)).toBe(false);
    expect(otherDevice.succeeds(first)).toBe(false);
    expect(first.succeeds(first)).toBe(false);
  });

  it("contract version is pinned: incompatible versions fail closed", () => {
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ contractVersion: "0.2" }))).toThrowError(
      /must not be newer than minor/,
    );
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ contractVersion: "1.0" }))).toThrowError(
      /must share the domain-experience contract major/,
    );
    // An OLDER minor of the same major is readable (additive tolerance).
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ contractVersion: "0.0" }))).not.toThrow();
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ contractVersion: "0" }))).toThrowError(
      ValidationError,
    );
  });

  it("digests are deterministic content identities; records round-trip", () => {
    const snapshot = new DeviceCapabilitySnapshot(snapshotInput());
    const same = new DeviceCapabilitySnapshot(snapshotInput());
    expect(snapshot.digest()).toBe(same.digest());
    const roundTripped = DeviceCapabilitySnapshot.fromPlain(snapshot.toPlain());
    expect(roundTripped.digest()).toBe(snapshot.digest());
    expect(roundTripped.toPlain()).toEqual(snapshot.toPlain());
  });

  it("timestamps are parsed strictly (naive time rejected)", () => {
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ observedAt: "2026-01-15T08:30:00" }))).toThrowError(
      ValidationError,
    );
    expect(() => new DeviceCapabilitySnapshot(snapshotInput({ observedAt: at(OBSERVED_AT) }))).toBeDefined();
  });
});
