import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";
import {
  DEVICE_ACTION_STATUSES,
  DeviceActionRequest,
  DeviceActionResult,
  EdgeCapabilitySnapshot,
  assertCapability,
  deviceActionResultFromGate,
  parseDeviceActionId,
  parseDeviceActionParameters,
  parseDeviceActionStatus,
} from "../src/index.js";
import type { DeviceActionRequestInput } from "../src/index.js";
import { commandFixture, entry, snapshotInput } from "./helpers.js";

const ACTION_ID = parseDeviceActionId("00000000-0000-4000-8000-00000000aaaa");
const OTHER_ACTION_ID = parseDeviceActionId("00000000-0000-4000-8000-00000000bbbb");
const COMPLETED_AT = fixtureUtcInstant(5_000);

function requestInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    actionId: ACTION_ID,
    capabilityRequirement: { capability: "wifi_control" },
    parameters: { networkSsid: "Guest", timeoutSeconds: 30 },
    command: commandFixture(),
    dedupeKey: "action-dedupe-1",
    ...overrides,
  };
}

describe("DeviceActionRequest", () => {
  it("constructs a valid, frozen request and round-trips through JSON", () => {
    const request = new DeviceActionRequest(
      requestInput() as unknown as DeviceActionRequestInput,
    );
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.capabilityRequirement.capability).toBe("wifi_control");
    expect(request.command.commandId).toBe(commandFixture().commandId);
    expect(request.dedupeKey).toBe("action-dedupe-1");
    expect(Object.isFrozen(request.parameters)).toBe(true);

    const restored = DeviceActionRequest.fromPlain(
      JSON.parse(JSON.stringify(request.toPlain())),
    );
    expect(restored.toPlain()).toEqual(request.toPlain());
  });

  it("rejects unknown fields and invalid ids/keys", () => {
    expect(() =>
      new DeviceActionRequest(requestInput({ extra: true }) as unknown as DeviceActionRequestInput),
    ).toThrowError(/unknown field/);
    expect(() =>
      new DeviceActionRequest(
        requestInput({ actionId: "not-a-uuid" }) as unknown as DeviceActionRequestInput,
      ),
    ).toThrowError(/actionId/);
    expect(() =>
      new DeviceActionRequest(
        requestInput({ dedupeKey: "bad key!" }) as unknown as DeviceActionRequestInput,
      ),
    ).toThrowError(/dedupeKey/);
    expect(() =>
      new DeviceActionRequest(
        requestInput({ command: { nonsense: true } }) as unknown as DeviceActionRequestInput,
      ),
    ).toThrowError(/command/);
    expect(() =>
      new DeviceActionRequest(
        requestInput({ capabilityRequirement: { capability: "nope" } }) as unknown as DeviceActionRequestInput,
      ),
    ).toThrowError(/capabilityRequirement/);
  });
});

describe("DeviceActionParameters validation", () => {
  it("accepts bounded JSON primitives and freezes the record", () => {
    const parameters = parseDeviceActionParameters({
      ssid: "Guest Network",
      attempts: 3,
      strict: true,
      tag: null,
    });
    expect(Object.isFrozen(parameters)).toBe(true);
    expect(parameters).toEqual({
      ssid: "Guest Network",
      attempts: 3,
      strict: true,
      tag: null,
    });
  });

  it("rejects nested structures, undefined, bad keys, oversized and control-char values", () => {
    expect(() => parseDeviceActionParameters({ nested: { deep: 1 } })).toThrowError(
      /string, number, boolean or null/,
    );
    expect(() => parseDeviceActionParameters({ list: [1, 2] })).toThrowError(
      /string, number, boolean or null/,
    );
    expect(() => parseDeviceActionParameters({ hole: undefined })).toThrowError(/undefined/);
    expect(() => parseDeviceActionParameters({ "bad key!": 1 })).toThrowError(/safe labels/);
    expect(() => parseDeviceActionParameters({ big: "x".repeat(257) })).toThrowError(/256/);
    expect(() => parseDeviceActionParameters({ ctrl: "bad\u0007" })).toThrowError(/control/);
    expect(() => parseDeviceActionParameters({ nan: Number.NaN })).toThrowError(/finite/);
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 33; i += 1) tooMany[`k${i}`] = i;
    expect(() => parseDeviceActionParameters(tooMany)).toThrowError(/at most 32/);
  });
});

describe("DeviceActionResult honesty rules (RL-LOCK-011, spec/mobile.md)", () => {
  it("the status vocabulary is exactly the five honest outcomes", () => {
    expect([...DEVICE_ACTION_STATUSES]).toEqual([
      "accepted",
      "executed-observed",
      "degraded",
      "unsupported",
      "failed",
    ]);
    for (const status of DEVICE_ACTION_STATUSES) {
      expect(parseDeviceActionStatus(status)).toBe(status);
    }
    expect(() => parseDeviceActionStatus("executed")).toThrowError();
    expect(() => parseDeviceActionStatus("success")).toThrowError();
  });

  it("executed-observed REQUIRES platform evidence - physical success is never declared without it", () => {
    expect(
      () =>
        new DeviceActionResult({
          actionId: ACTION_ID,
          status: "executed-observed",
          completedAt: COMPLETED_AT,
        }),
    ).toThrowError(/executed-observed REQUIRES platform evidence/);

    expect(
      () =>
        new DeviceActionResult({
          actionId: ACTION_ID,
          status: "executed-observed",
          completedAt: COMPLETED_AT,
          evidence: { kind: "none" },
        }),
    ).toThrowError(/kind 'none' is only valid inside capability snapshots/);

    // with real evidence it constructs, and carries no reason
    const result = new DeviceActionResult({
      actionId: ACTION_ID,
      status: "executed-observed",
      completedAt: COMPLETED_AT,
      evidence: { kind: "platform-api-probe", source: "NEHotspotConfiguration" },
    });
    expect(result.status).toBe("executed-observed");
    expect(result.evidence?.source).toBe("NEHotspotConfiguration");
    expect(result.reason).toBeUndefined();
  });

  it("accepted carries NEITHER evidence NOR reason (acceptance is not physical success)", () => {
    expect(
      () =>
        new DeviceActionResult({
          actionId: ACTION_ID,
          status: "accepted",
          completedAt: COMPLETED_AT,
          evidence: { kind: "platform-api-probe", source: "Queue" },
        }),
    ).toThrowError(/not physical success/);
    expect(
      () =>
        new DeviceActionResult({
          actionId: ACTION_ID,
          status: "accepted",
          completedAt: COMPLETED_AT,
          reason: "execution-failed",
        }),
    ).toThrowError(/accepted carries no result reason/);
    // plain acceptance is fine
    const accepted = new DeviceActionResult({
      actionId: ACTION_ID,
      status: "accepted",
      completedAt: COMPLETED_AT,
    });
    expect(accepted.evidence).toBeUndefined();
    expect(accepted.reason).toBeUndefined();
  });

  it("degraded / unsupported / failed REQUIRE a closed-vocabulary reason", () => {
    for (const status of ["degraded", "unsupported", "failed"] as const) {
      expect(
        () =>
          new DeviceActionResult({
            actionId: ACTION_ID,
            status,
            completedAt: COMPLETED_AT,
          }),
      ).toThrowError(/requires a machine-readable reason/);
    }
    expect(
      () =>
        new DeviceActionResult({
          actionId: ACTION_ID,
          status: "failed",
          completedAt: COMPLETED_AT,
          reason: "because",
        }),
    ).toThrowError(/closed device-action result-reason vocabulary/);
    // an evidenced failure is allowed (failure evidence is still evidence)
    const failed = new DeviceActionResult({
      actionId: ACTION_ID,
      status: "failed",
      completedAt: COMPLETED_AT,
      reason: "execution-failed",
      evidence: { kind: "platform-api-probe", source: "NEHotspotConfiguration" },
    });
    expect(failed.reason).toBe("execution-failed");
    expect(failed.evidence?.kind).toBe("platform-api-probe");
  });

  it("round-trips through JSON preserving optional fields only when set", () => {
    const result = new DeviceActionResult({
      actionId: ACTION_ID,
      status: "degraded",
      completedAt: COMPLETED_AT,
      reason: "capability-requires-permission",
      detail: "user permission required; manual guidance shown",
    });
    const restored = DeviceActionResult.fromPlain(
      JSON.parse(JSON.stringify(result.toPlain())),
    );
    expect(restored.toPlain()).toEqual(result.toPlain());
    expect(restored.evidence).toBeUndefined();

    const json = JSON.stringify(result.toPlain());
    expect(json).not.toContain("evidence");
  });
});

describe("deviceActionResultFromGate (honest-by-construction gate outcomes)", () => {
  it("maps a DENY gate to unsupported (never attempted) preserving the reason and echo", () => {
    const unavailable = new EdgeCapabilitySnapshot(
      snapshotInput({
        capabilities: { wifi_control: entry({ status: "unavailable" }) },
      }),
    );
    const deniedGate = assertCapability(unavailable, { capability: "wifi_control" }, COMPLETED_AT);
    expect(deniedGate.decision).toBe("deny");

    const unsupported = deviceActionResultFromGate(OTHER_ACTION_ID, deniedGate, COMPLETED_AT);
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.reason).toBe("capability-unavailable");
    expect(unsupported.gateDecision).toEqual(deniedGate);
    expect(unsupported.evidence).toBeUndefined(); // never attempted -> no evidence claim
  });

  it("maps a DEGRADE gate to degraded with the gate's reason", () => {
    const permission = new EdgeCapabilitySnapshot(
      snapshotInput({
        capabilities: {
          wifi_control: entry({
            status: "requires-permission",
            evidence: { kind: "user-permission-state", source: "OS.PermissionCenter" },
          }),
        },
      }),
    );
    const degradedGate = assertCapability(permission, { capability: "wifi_control" }, COMPLETED_AT);
    expect(degradedGate.decision).toBe("degrade");

    const degradedResult = deviceActionResultFromGate(OTHER_ACTION_ID, degradedGate, COMPLETED_AT);
    expect(degradedResult.status).toBe("degraded");
    expect(degradedResult.reason).toBe("capability-requires-permission");
  });

  it("an ALLOW gate never produces a result - execution must record evidence instead", () => {
    const snapshot = new EdgeCapabilitySnapshot(snapshotInput());
    const gate = assertCapability(snapshot, { capability: "wifi_control" }, COMPLETED_AT);
    expect(gate.decision).toBe("allow");
    expect(() => deviceActionResultFromGate(OTHER_ACTION_ID, gate, COMPLETED_AT)).toThrowError(
      /allowed gate decision does not produce a device-action result/,
    );
  });
});
