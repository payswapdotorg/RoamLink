/**
 * RL-043 admission tests: capability-gated action admission over the closed
 * DeviceCapabilitySnapshot vocabulary - supported, unsupported and
 * absent-evidence paths (RL-LOCK-011, RL-LOCK-018: the tests fail when the
 * gate is bypassable, not only when the happy path breaks).
 */
import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";

import { admitDeviceAction, blockedAdmissionReason } from "../src/index.js";
import { actionRequest, entry, snapshot, T0 } from "./helpers.js";

describe("admitDeviceAction - supported path", () => {
  it("admits an evidenced available capability (allow)", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const admission = admitDeviceAction(
      snapshot({ entries: { wifi_control: entry() } }),
      request,
      T0,
    );
    expect(admission.admission).toBe("ADMITTED");
    if (admission.admission !== "ADMITTED") return;
    expect(admission.gate.evidenceClass).toBe("OBSERVED");
    expect(admission.gate.evidence.kind).toBe("platform-api-probe");
  });

  it("admits with a stricter-than-default evidence requirement when evidence holds", () => {
    const request = actionRequest({
      capability: "concurrent_interface_constraints",
      parameters: { simultaneous: 2 },
    });
    const admission = admitDeviceAction(
      snapshot({
        entries: {
          concurrent_interface_constraints: entry({ evidenceClass: "REPORTED" }),
        },
      }),
      request,
      T0,
    );
    expect(admission.admission).toBe("ADMITTED");
  });
});

describe("admitDeviceAction - unsupported paths (typed, diagnosable)", () => {
  it("blocks a capability the platform evidence records as unavailable", () => {
    const request = actionRequest({ capability: "esim_profile_install" });
    const admission = admitDeviceAction(
      snapshot({ entries: { esim_profile_install: entry({ status: "unavailable" }) } }),
      request,
      T0,
    );
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    if (admission.admission === "ADMITTED") throw new Error("expected blocked");
    expect(blockedAdmissionReason(admission)).toBe("capability-unavailable");
    expect(admission.result.status).toBe("unsupported");
  });

  it("blocks a capability whose entry is honestly unknown (absence of evidence)", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const admission = admitDeviceAction(
      snapshot({
        entries: {
          wifi_control: entry({
            status: "unknown",
            evidenceClass: "UNKNOWN",
            evidence: { kind: "none" },
          }),
        },
      }),
      request,
      T0,
    );
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    expect(blockedAdmissionReason(admission)).toBe("capability-unknown");
  });

  it("blocks an available claim backed only by INFERRED evidence (RL-LOCK-011)", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const admission = admitDeviceAction(
      snapshot({ entries: { wifi_control: entry({ evidenceClass: "INFERRED" }) } }),
      request,
      T0,
    );
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    expect(blockedAdmissionReason(admission)).toBe("evidence-class-insufficient");
  });

  it("blocks when the snapshot-wide freshness guarantee has expired (stale evidence)", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const admission = admitDeviceAction(
      snapshot({
        entries: { wifi_control: entry() },
        freshUntil: T0,
        observedAt: T0,
      }),
      request,
      // evaluate strictly after the freshness boundary instant
      fixtureUtcInstant(60_000),
    );
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    expect(blockedAdmissionReason(admission)).toBe("evidence-stale");
  });

  it("blocks an unsupported capability/platform combination (out-of-scope on macos)", () => {
    // esim_profile_install is not in scope for macos: the snapshot cannot even
    // carry an entry, so the gate denies with capability-unknown - typed, not
    // a best-effort guess.
    const request = actionRequest({ capability: "esim_profile_install" });
    const admission = admitDeviceAction(snapshot({ family: "macos" }), request, T0);
    expect(admission.admission).toBe("BLOCKED-UNSUPPORTED");
    expect(blockedAdmissionReason(admission)).toBe("capability-unknown");
  });

  it("degrades (never denies) a requires-permission capability to manual guidance", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const admission = admitDeviceAction(
      snapshot({
        entries: {
          wifi_control: entry({
            status: "requires-permission",
            evidence: { kind: "user-permission-state", source: "OS.PermissionCenter" },
          }),
        },
      }),
      request,
      T0,
    );
    expect(admission.admission).toBe("BLOCKED-DEGRADED");
    if (admission.admission !== "BLOCKED-DEGRADED") throw new Error("expected degraded");
    expect(blockedAdmissionReason(admission)).toBe("capability-requires-permission");
    expect(admission.result.status).toBe("degraded");
  });

  it("fails closed on a capability outside the DeviceCapabilitySnapshot vocabulary (additive-drift defense)", () => {
    // The RL-040 request constructor already rejects unknown names; this is
    // the SECOND line of defense - an additive contract change on the edge
    // side (RL-LOCK-017) could introduce a name the registry vocabulary does
    // not know yet. Such a request must fail closed at admission, never pass.
    const plain = actionRequest().toPlain();
    const drifted = {
      ...plain,
      capabilityRequirement: {
        ...plain.capabilityRequirement,
        capability: "satellite_beam_control",
      },
    } as unknown as Parameters<typeof admitDeviceAction>[1];
    expect(() => admitDeviceAction(snapshot(), drifted, T0)).toThrowError(
      /outside the DeviceCapabilitySnapshot closed vocabulary/,
    );
  });
});

describe("admitDeviceAction - determinism", () => {
  it("is a pure function of its inputs (RL-LOCK-012: deterministic policy only)", () => {
    const request = actionRequest({ capability: "wifi_control" });
    const snap = snapshot({ entries: { wifi_control: entry() } });
    const first = admitDeviceAction(snap, request, T0);
    const second = admitDeviceAction(snap, request, T0);
    expect(first).toEqual(second);
  });
});
