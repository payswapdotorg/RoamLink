import { describe, expect, it } from "vitest";
import { ValidationError, canonicalJsonDigest } from "@roamlink/contracts";
import {
  EDGE_CAPABILITY_STATUSES,
  EdgeCapabilitySnapshot,
  isEdgeCapabilityStatus,
  parseEdgeCapabilityStatus,
} from "../src/index.js";
import { entry, snapshotInput, unknownEntry, FRESH_UNTIL, OBSERVED_AT } from "./helpers.js";

describe("closed capability status vocabulary", () => {
  it("is exactly available / unavailable / requires-permission / unknown", () => {
    expect([...EDGE_CAPABILITY_STATUSES]).toEqual([
      "available",
      "unavailable",
      "requires-permission",
      "unknown",
    ]);
    for (const status of EDGE_CAPABILITY_STATUSES) {
      expect(parseEdgeCapabilityStatus(status)).toBe(status);
      expect(isEdgeCapabilityStatus(status)).toBe(true);
    }
    for (const bad of ["enabled", "maybe", "", 1, null]) {
      expect(() => parseEdgeCapabilityStatus(bad)).toThrowError(/status vocabulary/);
      expect(isEdgeCapabilityStatus(bad)).toBe(false);
    }
  });
});

describe("EdgeCapabilitySnapshot construction", () => {
  it("accepts a total, evidenced snapshot for the full ios scope and freezes it deeply", () => {
    const snapshot = new EdgeCapabilitySnapshot(snapshotInput());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.platform)).toBe(true);
    const first = snapshot.entryFor("wifi_observation");
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.observedAt).toBe(OBSERVED_AT);
    expect(snapshot.freshUntil).toBe(FRESH_UNTIL);
  });

  it("is immutable: mutation attempts throw (strict-mode frozen object)", () => {
    const snapshot = new EdgeCapabilitySnapshot(snapshotInput());
    expect(() => {
      (snapshot as unknown as { hack?: number }).hack = 1;
    }).toThrowError(TypeError);
  });

  it("supports a linux snapshot whose entries cover exactly the linux scope", () => {
    const snapshot = new EdgeCapabilitySnapshot(snapshotInput({ family: "linux" }));
    expect(snapshot.entryFor("wifi_control")).toBeDefined();
    expect(snapshot.entryFor("esim_profile_install")).toBeUndefined();
  });

  it("rejects unknown top-level fields (fail-closed, RL-LOCK-017)", () => {
    const input = { ...snapshotInput(), extra: "no" };
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(/unknown field/);
  });
});

describe("in-scope totality (platform scope is a contract)", () => {
  it("rejects a snapshot missing an in-scope capability entry", () => {
    const input = snapshotInput({ dropCapabilities: ["wifi_control"] });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /missing required in-scope capability entry/,
    );
  });

  it("rejects an out-of-scope entry (esim on linux)", () => {
    const input = snapshotInput({
      family: "linux",
      capabilities: { esim_profile_install: entry() },
    });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /not in scope for the snapshot's platform family/,
    );
  });

  it("rejects an unknown capability name in the entries", () => {
    const input = snapshotInput({
      capabilities: { wifi_super_control: entry() },
    });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /closed edge capability vocabulary/,
    );
  });

  it("'unknown' entries satisfy totality honestly (absence of evidence is valid)", () => {
    const input = snapshotInput({ capabilities: { wifi_control: unknownEntry() } });
    const snapshot = new EdgeCapabilitySnapshot(input);
    expect(snapshot.entryFor("wifi_control")?.status).toBe("unknown");
  });
});

describe("entry honesty rules (RL-LOCK-011)", () => {
  it("rejects 'available' with no platform evidence", () => {
    const input = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "available",
          evidenceClass: "OBSERVED",
          observedAt: OBSERVED_AT,
          evidence: { kind: "none" },
        },
      },
    });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /non-unknown status claim requires real platform evidence/,
    );
  });

  it("rejects 'unavailable' claimed with UNKNOWN evidence class (evidence cuts both ways)", () => {
    const input = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "unavailable",
          evidenceClass: "UNKNOWN",
          observedAt: OBSERVED_AT,
          evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
        },
      },
    });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /non-unknown status claim requires real platform evidence/,
    );
  });

  it("accepts an inconclusive probe: 'unknown' status with OBSERVED evidence", () => {
    const input = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "unknown",
          evidenceClass: "OBSERVED",
          observedAt: OBSERVED_AT,
          evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
        },
      },
    });
    const snapshot = new EdgeCapabilitySnapshot(input);
    expect(snapshot.entryFor("wifi_control")?.status).toBe("unknown");
    expect(snapshot.entryFor("wifi_control")?.evidenceClass).toBe("OBSERVED");
  });

  it("accepts an honestly recorded INFERRED availability (recording is honest; gating rejects it)", () => {
    const input = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "available",
          evidenceClass: "INFERRED",
          observedAt: OBSERVED_AT,
          evidence: { kind: "os-statement", source: "DeviceModelMatrix" },
        },
      },
    });
    const snapshot = new EdgeCapabilitySnapshot(input);
    expect(snapshot.entryFor("wifi_control")?.evidenceClass).toBe("INFERRED");
  });

  it("validates evidence payloads: bad source label / oversized detail rejected", () => {
    const badSource = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "available",
          evidenceClass: "OBSERVED",
          observedAt: OBSERVED_AT,
          evidence: { kind: "platform-api-probe", source: "bad source!" },
        },
      },
    });
    expect(() => new EdgeCapabilitySnapshot(badSource)).toThrowError(/safe label/);

    const longDetail = "x".repeat(129);
    const badDetail = snapshotInput({
      capabilities: {
        wifi_control: {
          status: "available",
          evidenceClass: "OBSERVED",
          observedAt: OBSERVED_AT,
          evidence: {
            kind: "platform-api-probe",
            source: "TestProbe.framework",
            detail: longDetail,
          },
        },
      },
    });
    expect(() => new EdgeCapabilitySnapshot(badDetail)).toThrowError(/128 chars/);
  });

  it("rejects unknown entry fields", () => {
    const input = snapshotInput({
      capabilities: {
        wifi_control: { ...entry(), radioChipset: " Qualcomm X75 " },
      },
    });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(/unknown field/);
  });
});

describe("platform descriptor validation", () => {
  it("accepts the default descriptor and rejects unknown families / malformed versions", () => {
    expect(() => new EdgeCapabilitySnapshot(snapshotInput())).not.toThrow();

    const badFamily = snapshotInput();
    (badFamily as { platform: Record<string, unknown> }).platform = {
      family: "webos",
      platformVersion: "1",
    };
    expect(() => new EdgeCapabilitySnapshot(badFamily)).toThrowError(
      /platform.family/,
    );

    const badVersion = snapshotInput();
    (badVersion as { platform: Record<string, unknown> }).platform = {
      family: "ios",
      platformVersion: "  padded  ",
    };
    expect(() => new EdgeCapabilitySnapshot(badVersion)).toThrowError(
      /platformVersion/,
    );
  });
});

describe("versioning (RL-LOCK-017)", () => {
  it("rejects a newer minor than the implemented edge contract version", () => {
    const input = snapshotInput({ contractVersion: "0.2" });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /must not be newer than minor/,
    );
  });

  it("rejects a different major", () => {
    const input = snapshotInput({ contractVersion: "1.0" });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      /must share the edge contract major/,
    );
  });

  it("rejects a malformed version string", () => {
    const input = snapshotInput({ contractVersion: "v0.1" });
    expect(() => new EdgeCapabilitySnapshot(input)).toThrowError(
      ValidationError,
    );
  });
});

describe("serialization, digest and chain continuity", () => {
  it("round-trips through JSON via toPlain/fromPlain with an identical digest", () => {
    const snapshot = new EdgeCapabilitySnapshot(snapshotInput());
    const restored = EdgeCapabilitySnapshot.fromPlain(
      JSON.parse(JSON.stringify(snapshot.toPlain())),
    );
    expect(restored.toPlain()).toEqual(snapshot.toPlain());
    expect(restored.digest()).toBe(snapshot.digest());
    expect(restored.digest()).toBe(canonicalJsonDigest(snapshot.toPlain()));
  });

  it("equal content digests equally; changed content digests differently", () => {
    const a = new EdgeCapabilitySnapshot(snapshotInput());
    const b = new EdgeCapabilitySnapshot(snapshotInput());
    const c = new EdgeCapabilitySnapshot(
      snapshotInput({ observedAt: "2026-01-15T09:30:00.000Z" }),
    );
    expect(a.digest()).toBe(b.digest());
    expect(a.digest()).not.toBe(c.digest());
  });

  it("succeeds() verifies device-scoped sequence continuity (reordering is detected)", () => {
    const first = new EdgeCapabilitySnapshot(
      snapshotInput({ sequence: 1, snapshotId: "00000000-0000-4000-8000-000000000001" }),
    );
    const second = new EdgeCapabilitySnapshot(
      snapshotInput({ sequence: 2, snapshotId: "00000000-0000-4000-8000-000000000002" }),
    );
    const otherDevice = new EdgeCapabilitySnapshot(
      snapshotInput({
        sequence: 2,
        snapshotId: "00000000-0000-4000-8000-000000000003",
        deviceRef: "device-enrollment-ref-2",
      }),
    );
    const third = new EdgeCapabilitySnapshot(
      snapshotInput({ sequence: 3, snapshotId: "00000000-0000-4000-8000-000000000004" }),
    );
    expect(second.succeeds(first)).toBe(true);
    // gap: sequence 3 does not directly succeed sequence 1
    expect(third.succeeds(first)).toBe(false);
    // different device: never succeeds
    expect(otherDevice.succeeds(first)).toBe(false);
  });
});
