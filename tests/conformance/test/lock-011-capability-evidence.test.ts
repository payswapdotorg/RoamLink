/**
 * RL-LOCK-011 conformance suite: device capability is evidence-based.
 *
 * The implementation cannot assume OS/radio capabilities not exposed by
 * the platform. Unsupported controls degrade gracefully (observation and
 * manual guidance, never best-effort guesses).
 *
 * GREEN PROOFS:
 *  - a capability snapshot entry REQUIRES evidence (status + evidence
 *    class + observed instant) and a member of the closed 11-name
 *    vocabulary;
 *  - the edge capability gate denies/degrades UNKNOWN and absent
 *    capabilities, and evidence below the required class;
 *  - stale evidence (freshUntil in the past) denies/degrades;
 *  - device-action admission of an unsupported capability returns a typed
 *    BLOCKED-UNSUPPORTED outcome (never EXECUTED).
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a capability claimed WITHOUT evidence is rejected (red when
 *    admitted);
 *  - a capability name outside the closed vocabulary is rejected;
 *  - an available capability with UNKNOWN evidence never allows an action
 *    (the toggle flips the allow expectation).
 */
import { describe, expect, it } from "vitest";
import { DeviceCapabilitySnapshot, DEVICE_CAPABILITY_NAMES } from "@roamlink/domain-experience";
import { EdgeCapabilitySnapshot, assertCapability, edgeCapabilitiesInScope } from "@roamlink/edge";
import { admitDeviceAction } from "@roamlink/edge-actions";
import { violationEnabled } from "../src/index.js";

const LOCK = "RL-LOCK-011";
const T0 = "2026-01-15T08:30:00.000Z";
const T_LATER = "2026-01-15T08:40:00.000Z";

const SNAPSHOT_BASE = {
  snapshotId: "00000000-0000-4000-8000-0000000000d1",
  contractVersion: "0.1",
  sequence: 1,
  deviceId: "00000000-0000-4000-8000-0000000000d2",
  platform: { family: "ios", platformVersion: "18.2" },
  observedAt: T0,
  freshUntil: "2026-01-15T09:30:00.000Z",
  capabilities: {
    wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: T0 },
    wifi_control: { status: "unavailable", evidenceClass: "OBSERVED", observedAt: T0 },
    esim_profile_install: { status: "requires-permission", evidenceClass: "OBSERVED", observedAt: T0 },
  },
} as const;

describe(`${LOCK}: device capability is evidence-based`, () => {
  it("green: an evidence-tagged snapshot parses cleanly over the closed 11-name vocabulary", () => {
    expect(DEVICE_CAPABILITY_NAMES.length).toBe(11);
    const snapshot = new DeviceCapabilitySnapshot({ ...SNAPSHOT_BASE });
    expect(snapshot.capabilities.wifi_observation?.status).toBe("available");
  });

  it("negative proof: a capability claimed without an evidence class is rejected (red when admitted)", () => {
    const violating = {
      ...SNAPSHOT_BASE,
      capabilities: {
        wifi_control: { status: "available" }, // no evidenceClass, no observedAt
      },
    };
    if (violationEnabled(LOCK)) {
      expect(() => new DeviceCapabilitySnapshot(violating)).not.toThrow();
    } else {
      expect(() => new DeviceCapabilitySnapshot(violating)).toThrow(
        /must be a Wave-0 evidence class|evidenceClass/,
      );
    }
  });

  it("negative proof: a capability name outside the closed vocabulary is rejected (red when admitted)", () => {
    const violating = {
      ...SNAPSHOT_BASE,
      capabilities: {
        teleport_radio: { status: "available", evidenceClass: "OBSERVED", observedAt: T0 },
      },
    };
    if (violationEnabled(LOCK)) {
      expect(() => new DeviceCapabilitySnapshot(violating)).not.toThrow();
    } else {
      expect(() => new DeviceCapabilitySnapshot(violating)).toThrow(
        /key is outside the closed capability vocabulary/,
      );
    }
  });

  it("green: absent evidence (unknown capability) never allows an action", () => {
    const snapshot = edgeSnapshot({
      wifi_observation: { status: "unknown", evidenceClass: "UNKNOWN", observedAt: T0 },
    });
    const decision = assertCapability(
      snapshot,
      { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
      T_LATER as never,
    );
    expect(decision.decision).not.toBe("allow");
    if (decision.decision !== "allow") {
      expect(decision.reason).toBe("capability-unknown");
    }
  });

  it("green: evidence below the required class never allows", () => {
    const snapshot = edgeSnapshot({
      wifi_control: { status: "available", evidenceClass: "INFERRED", observedAt: T0 },
    });
    const decision = assertCapability(
      snapshot,
      { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
      T_LATER as never,
    );
    expect(decision.decision).not.toBe("allow");
    if (decision.decision !== "allow") {
      expect(decision.reason).toBe("evidence-class-insufficient");
    }
  });

  it("green: stale evidence never allows (freshness is first-class at the gate)", () => {
    const snapshot = edgeSnapshot({
      wifi_control: { status: "available", evidenceClass: "OBSERVED", observedAt: T0 },
      // freshUntil in the past relative to the evaluation instant
    });
    const decision = assertCapability(
      snapshot,
      { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
      "2026-01-15T11:00:00.000Z" as never,
    );
    expect(decision.decision).not.toBe("allow");
    if (decision.decision !== "allow") {
      expect(decision.reason).toBe("evidence-stale");
    }
  });

  it("negative proof: an unknown-evidence capability allowing an action is a violation (red when allowed)", () => {
    const snapshot = edgeSnapshot({
      wifi_control: { status: "unknown", evidenceClass: "UNKNOWN", observedAt: T0 },
    });
    const decision = assertCapability(
      snapshot,
      { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
      T_LATER as never,
    );
    if (violationEnabled(LOCK)) {
      expect(decision.decision).toBe("allow");
    } else {
      expect(decision.decision).not.toBe("allow");
    }
  });

  it("green: device-action admission returns a typed BLOCKED outcome for unsupported capabilities (never executes)", () => {
    const snapshot = edgeSnapshot({
      wifi_control: { status: "unavailable", evidenceClass: "OBSERVED", observedAt: T0 },
    });
    const request = makeActionRequest("wifi_control");
    const admission = admitDeviceAction(snapshot, request, T_LATER as never);
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    if (admission.admission !== "ADMITTED") {
      expect(admission.result.reason).toBeDefined();
      expect(admission.result.status).toBe("unsupported");
    }
  });

  it("green: requires-permission capabilities ALWAYS degrade (observation/manual guidance)", () => {
    const snapshot = edgeSnapshot({
      esim_profile_install: { status: "requires-permission", evidenceClass: "OBSERVED", observedAt: T0 },
    });
    const admission = admitDeviceAction(
      snapshot,
      makeActionRequest("esim_profile_install"),
      T_LATER as never,
    );
    expect(admission.admission).toBe("BLOCKED-DEGRADED");
  });

  it("negative proof: an out-of-vocabulary capability in a device action fails closed (red when it passes)", () => {
    const snapshot = edgeSnapshot({});
    if (violationEnabled(LOCK)) {
      expect(() =>
        admitDeviceAction(snapshot, makeActionRequest("quantum_tunnel"), T_LATER as never),
      ).not.toThrow();
    } else {
      expect(() =>
        admitDeviceAction(snapshot, makeActionRequest("quantum_tunnel"), T_LATER as never),
      ).toThrow(/outside the DeviceCapabilitySnapshot closed vocabulary/);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds an EdgeCapabilitySnapshot for the `embedded` platform family,
 * filling every IN-SCOPE capability with an honest `unknown` entry unless
 * the caller provides a specific one (in-scope completeness is the
 * snapshot's own contract; we only vary the entries under test).
 */
function edgeSnapshot(
  capabilities: Record<string, { status: string; evidenceClass: string; observedAt: string }>,
): EdgeCapabilitySnapshot {
  const inScope = edgeCapabilitiesInScope("embedded");
  const filled: Record<string, unknown> = {};
  for (const name of inScope) {
    filled[name] = {
      status: "unknown",
      evidenceClass: "UNKNOWN",
      observedAt: T0,
      evidence: { kind: "none" },
    };
  }
  for (const [name, entry] of Object.entries(capabilities)) {
    filled[name] = {
      status: entry.status,
      evidenceClass: entry.evidenceClass,
      observedAt: entry.observedAt,
      evidence:
        entry.status === "unknown"
          ? { kind: "none" }
          : { kind: "platform-api-probe", source: "os-capability-probe" },
    };
  }
  return new EdgeCapabilitySnapshot({
    snapshotId: "00000000-0000-4000-8000-0000000000e1",
    contractVersion: "0.1",
    sequence: 1,
    deviceRef: "dev:00000000-0000-4000-8000-0000000000e2",
    platform: { family: "embedded", platformVersion: "1.0" },
    observedAt: T0,
    freshUntil: "2026-01-15T09:30:00.000Z",
    capabilities: filled,
  });
}

function makeActionRequest(capability: string) {
  return {
    actionId: "00000000-0000-4000-8000-0000000000e3",
    capabilityRequirement: { capability, minimumEvidenceClass: "OBSERVED" },
    command: {
      commandId: "00000000-0000-4000-8000-0000000000e3",
      correlationId: "corr-act-1",
      idempotencyKey: "idem-act-1",
      actorId: "actor-1",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: "action-1",
    parameters: {},
  } as never;
}
