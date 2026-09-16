/**
 * RL-041 tests: raw observation parsing, the closed evidence-kind->class
 * map (AUTHENTICATED unreachable), the observation engine's merge rules,
 * chain discipline - and the NEGATIVE PROOFS that engine-produced snapshots
 * can never allow an action on INFERRED/STALE/UNKNOWN evidence
 * (RL-LOCK-011; spec/definition-of-done.md "happy path only = incomplete").
 */
import { describe, expect, it } from "vitest";

import {
  EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND,
  EdgeCapabilitySnapshot,
  EdgeContextSnapshot,
  EdgeObservationEngine,
  assertCapability,
  edgeCapabilitiesInScope,
  isEvidenceClassProducibleByObservations,
  parseEdgeObservation,
} from "../src/index.js";
import type { EdgeObservation } from "../src/index.js";
import { DeterministicUuidGenerator, fixtureUtcInstant } from "@roamlink/testkit";

const T0 = fixtureUtcInstant();
const T1 = fixtureUtcInstant(1_000);
const T2 = fixtureUtcInstant(2_000);

function observation(overrides?: Record<string, unknown>): EdgeObservation {
  return parseEdgeObservation({
    observationId: "00000000-0000-4000-8000-0000000000a1",
    deviceRef: "device-enrollment-ref-1",
    observedAt: T0,
    platform: { family: "ios", platformVersion: "18.2" },
    evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
    subject: { kind: "capability-probe", capability: "wifi_observation", status: "available" },
    ...overrides,
  });
}

function engine(freshnessMs: number | null = 60_000): EdgeObservationEngine {
  return new EdgeObservationEngine({
    snapshotIdGenerator: (() => {
      const ids = new DeterministicUuidGenerator(101);
      return () => ids.next();
    })(),
    snapshotFreshnessMs: freshnessMs,
  });
}

describe("parseEdgeObservation", () => {
  it("parses a valid capability probe", () => {
    const parsed = observation();
    expect(parsed.subject).toEqual({
      kind: "capability-probe",
      capability: "wifi_observation",
      status: "available",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects closed-vocabulary violations and unknown fields", () => {
    expect(() => observation({ subject: { kind: "telemetry", x: 1 } })).toThrow(/capability-probe.*context-observation/);
    expect(() => observation({ subject: { kind: "capability-probe", capability: "teleport", status: "available" } })).toThrow(
      /closed edge capability/,
    );
    expect(() => observation({ subject: { kind: "capability-probe", capability: "wifi_observation", status: "maybe" } })).toThrow(
      /capability status/,
    );
    expect(() => observation({ subject: { kind: "context-observation", contextField: "ssid", value: "home" } })).toThrow(
      /closed context-field/,
    );
    expect(() =>
      observation({ subject: { kind: "context-observation", contextField: "connectivity-state", value: "maybe" } }),
    ).toThrow(/closed value vocabulary/);
    expect(() => observation({ extra: true })).toThrow(/unknown field/);
    expect(() => observation({ observedAt: "2026-01-15T08:30:00" })).toThrow(/zone designator/);
  });

  it("enforces the none-evidence honesty rule at parse time", () => {
    expect(() =>
      observation({
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "available" },
      }),
    ).toThrow(/absence of evidence/);
    expect(() =>
      observation({
        evidence: { kind: "none" },
        subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
      }),
    ).toThrow(/absence of evidence/);
    // unknown claims without evidence are legal (honest absence)
    expect(() =>
      observation({
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
    ).not.toThrow();
  });
});

describe("the closed evidence-kind -> class map (RL-LOCK-011)", () => {
  it("assigns exactly OBSERVED/REPORTED/UNKNOWN and never AUTHENTICATED/INFERRED/STALE", () => {
    expect(EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND).toEqual({
      "platform-api-probe": "OBSERVED",
      "os-statement": "REPORTED",
      "user-permission-state": "OBSERVED",
      none: "UNKNOWN",
    });
    expect(isEvidenceClassProducibleByObservations("AUTHENTICATED")).toBe(false);
    expect(isEvidenceClassProducibleByObservations("INFERRED")).toBe(false);
    expect(isEvidenceClassProducibleByObservations("STALE")).toBe(false);
    expect(isEvidenceClassProducibleByObservations("OBSERVED")).toBe(true);
  });
});

describe("EdgeObservationEngine - capability chains", () => {
  it("starts a genesis chain at sequence 1 with honest unknown entries for untouched capabilities", () => {
    const result = engine().applyCapabilityObservation(null, observation(), T0);
    const snapshot = result.snapshot;
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.deviceRef).toBe("device-enrollment-ref-1");
    expect(snapshot.observedAt).toBe(T0);
    expect(snapshot.freshUntil).toBe(fixtureUtcInstant(60_000));
    const inScope = edgeCapabilitiesInScope("ios");
    expect(Object.keys(snapshot.capabilities).sort()).toEqual([...inScope].sort());
    expect(snapshot.capabilities["wifi_observation"]).toMatchObject({
      status: "available",
      evidenceClass: "OBSERVED",
    });
    // untouched capabilities are honest unknowns - never guesses
    expect(snapshot.capabilities["vpn_network_extension"]).toEqual({
      status: "unknown",
      evidenceClass: "UNKNOWN",
      observedAt: T0,
      evidence: { kind: "none" },
    });
    expect(result.applied).toEqual([
      expect.objectContaining({ key: "wifi_observation", applied: true, reason: "recorded" }),
    ]);
  });

  it("advances the chain (sequence + 1) and succeeds() links", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        subject: { kind: "capability-probe", capability: "wifi_control", status: "available" },
      }),
      T1,
    ).snapshot;
    expect(second.succeeds(first)).toBe(true);
    expect(second.sequence).toBe(2);
    // untouched entries are carried over unchanged (structural equality: the
    // snapshot constructor deep-freezes fresh entry objects on parse)
    expect(second.capabilities["wifi_observation"]).toEqual(first.capabilities["wifi_observation"]);
  });

  it("RAISES the evidence class only with genuine evidence corroborating the same status", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(
      null,
      observation({ evidence: { kind: "os-statement", source: "OS.declaration" } }),
      T0,
    ).snapshot;
    expect(first.capabilities["wifi_observation"]?.evidenceClass).toBe("REPORTED");
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
      }),
      T1,
    );
    expect(second.snapshot.capabilities["wifi_observation"]).toMatchObject({
      status: "available",
      evidenceClass: "OBSERVED",
      observedAt: T1,
    });
    expect(second.applied[0]).toMatchObject({ reason: "raised-evidence-class", applied: true });
  });

  it("RETAINS the stronger existing evidence when a weaker observation corroborates", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot; // OBSERVED
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        evidence: { kind: "os-statement", source: "OS.declaration" }, // REPORTED < OBSERVED
      }),
      T1,
    );
    expect(second.snapshot.capabilities["wifi_observation"]?.evidenceClass).toBe("OBSERVED");
    expect(second.snapshot.capabilities["wifi_observation"]?.observedAt).toBe(T0);
    expect(second.applied[0]).toMatchObject({
      reason: "corroborated-existing-evidence",
      applied: false,
    });
  });

  it("replaces the entry when the claim changes (newest genuine observation wins)", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unavailable" },
      }),
      T1,
    );
    expect(second.snapshot.capabilities["wifi_observation"]).toMatchObject({
      status: "unavailable",
      evidenceClass: "OBSERVED",
      observedAt: T1,
    });
    expect(second.applied[0]).toMatchObject({ reason: "changed-claim", applied: true });
  });

  it("absence of evidence never contradicts a recorded entry", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
      T1,
    );
    expect(second.snapshot.capabilities["wifi_observation"]).toEqual(first.capabilities["wifi_observation"]);
    expect(second.applied[0]).toMatchObject({
      reason: "no-evidence-cannot-contradict",
      applied: false,
    });
  });

  it("a genuine probe may record unknown (platform could not determine)", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    const second = eng.applyCapabilityObservation(
      first,
      observation({
        observationId: "00000000-0000-4000-8000-0000000000a2",
        observedAt: T1,
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
      T1,
    );
    expect(second.snapshot.capabilities["wifi_observation"]).toMatchObject({
      status: "unknown",
      evidenceClass: "OBSERVED",
    });
  });

  it("fail-closed chain + scope + time validation", () => {
    const eng = engine();
    const first = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    // device mismatch
    expect(() =>
      eng.applyCapabilityObservation(
        first,
        observation({ observationId: "00000000-0000-4000-8000-0000000000a2", deviceRef: "other-device" }),
        T1,
      ),
    ).toThrow(/device reference/);
    // platform family mismatch
    expect(() =>
      eng.applyCapabilityObservation(
        first,
        observation({
          observationId: "00000000-0000-4000-8000-0000000000a2",
          platform: { family: "android", platformVersion: "15" },
          subject: { kind: "capability-probe", capability: "wifi_observation", status: "available" },
        }),
        T1,
      ),
    ).toThrow(/platform family/);
    // out-of-scope capability for the family
    expect(() =>
      eng.applyCapabilityObservation(
        null,
        observation({
          platform: { family: "macos", platformVersion: "15.1" },
          subject: { kind: "capability-probe", capability: "concurrent_interface_constraints", status: "available" },
        }),
        T0,
      ),
    ).toThrow(/not in scope/);
    // observation observed after the merge instant (time travel)
    expect(() => eng.applyCapabilityObservation(null, observation({ observedAt: T2 }), T1)).toThrow(
      /merge instant/,
    );
    // wrong subject kind for the method
    expect(() =>
      eng.applyCapabilityObservation(
        null,
        observation({
          subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
        }),
        T0,
      ),
    ).toThrow(/not a capability-probe/);
  });
});

describe("EdgeObservationEngine - context chains", () => {
  function contextObservation(overrides?: Record<string, unknown>): EdgeObservation {
    return parseEdgeObservation({
      observationId: "00000000-0000-4000-8000-0000000000b1",
      deviceRef: "device-enrollment-ref-1",
      observedAt: T0,
      platform: { family: "ios", platformVersion: "18.2" },
      evidence: { kind: "platform-api-probe", source: "NWPathMonitor" },
      subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
      ...overrides,
    });
  }

  it("builds a total context snapshot with honest unknowns", () => {
    const result = engine().applyContextObservation(null, contextObservation(), T0);
    const snapshot = result.snapshot;
    expect(snapshot.sequence).toBe(1);
    expect(Object.keys(snapshot.entries).sort()).toEqual([
      "active-interface-kind",
      "connectivity-state",
      "interface-metered",
    ]);
    expect(snapshot.entries["connectivity-state"]).toMatchObject({
      value: "online",
      evidenceClass: "OBSERVED",
    });
    expect(snapshot.entries["active-interface-kind"]).toEqual({
      value: "unknown",
      evidenceClass: "UNKNOWN",
      observedAt: T0,
      evidence: { kind: "none" },
    });
    expect(snapshot.digest()).toMatch(/^[0-9a-f]{64}$/);
    expect(EdgeContextSnapshot.fromPlain(JSON.parse(JSON.stringify(snapshot.toPlain()))).toPlain()).toEqual(
      snapshot.toPlain(),
    );
  });

  it("applies the same merge discipline to context values", () => {
    const eng = engine();
    const first = eng
      .applyContextObservation(
        null,
        contextObservation({ evidence: { kind: "os-statement", source: "OS.declaration" } }),
        T0,
      )
      .snapshot;
    expect(first.entries["connectivity-state"]?.evidenceClass).toBe("REPORTED");
    const raised = eng.applyContextObservation(first, contextObservation({ observedAt: T1 }), T1);
    expect(raised.snapshot.entries["connectivity-state"]?.evidenceClass).toBe("OBSERVED");
    const changed = eng.applyContextObservation(
      raised.snapshot,
      contextObservation({
        observationId: "00000000-0000-4000-8000-0000000000b2",
        observedAt: T2,
        subject: { kind: "context-observation", contextField: "connectivity-state", value: "offline" },
      }),
      T2,
    );
    expect(changed.snapshot.entries["connectivity-state"]).toMatchObject({ value: "offline" });
    expect(changed.snapshot.succeeds(raised.snapshot)).toBe(true);
  });

  it("none-evidence cannot contradict a recorded context value", () => {
    const eng = engine();
    const first = eng.applyContextObservation(null, contextObservation(), T0).snapshot;
    const second = eng.applyContextObservation(
      first,
      contextObservation({
        observationId: "00000000-0000-4000-8000-0000000000b2",
        observedAt: T1,
        evidence: { kind: "none" },
        subject: { kind: "context-observation", contextField: "connectivity-state", value: "unknown" },
      }),
      T1,
    );
    expect(second.snapshot.entries["connectivity-state"]).toEqual(first.entries["connectivity-state"]);
  });
});

describe("batch application", () => {
  it("folds mixed observation kinds in order and keeps absent chains null", () => {
    const eng = engine();
    const batch = eng.applyObservations(
      null,
      null,
      [
        observation(),
        observation({
          observationId: "00000000-0000-4000-8000-0000000000a2",
          observedAt: T1,
          subject: { kind: "capability-probe", capability: "wifi_control", status: "requires-permission" },
        }),
        observation({
          observationId: "00000000-0000-4000-8000-0000000000b1",
          subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
        }),
      ],
      T1,
    );
    expect(batch.capability.snapshot?.sequence).toBe(2);
    expect(batch.capability.applied.map((a) => a.key)).toEqual(["wifi_observation", "wifi_control"]);
    expect(batch.context.snapshot?.sequence).toBe(1);
    expect(batch.context.applied.map((a) => a.key)).toEqual(["connectivity-state"]);

    const empty = eng.applyObservations(null, null, [], T0);
    expect(empty.capability.snapshot).toBeNull();
    expect(empty.context.snapshot).toBeNull();
  });
});

describe("NEGATIVE PROOFS - evidence-class rank enforcement (RL-LOCK-011)", () => {
  it("a genesis snapshot of unknowns never allows an action", () => {
    const snapshot = engine().applyCapabilityObservation(
      null,
      observation({
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
      T0,
    ).snapshot;
    const decision = assertCapability(
      snapshot,
      { capability: "wifi_observation" },
      fixtureUtcInstant(1_000),
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("capability-unknown");
    }
  });

  it("INFERRED and STALE evidence can NEVER allow an action (even with status available)", () => {
    for (const evidenceClass of ["INFERRED", "STALE"] as const) {
      const snapshot = new EdgeCapabilitySnapshot({
        snapshotId: "00000000-0000-4000-8000-0000000000c1",
        contractVersion: "0.1",
        sequence: 1,
        deviceRef: "device-enrollment-ref-1",
        platform: { family: "ios", platformVersion: "18.2" },
        observedAt: T0,
        freshUntil: fixtureUtcInstant(60_000),
        capabilities: Object.fromEntries(
          edgeCapabilitiesInScope("ios").map((name) => [
            name,
            name === "wifi_observation"
              ? {
                  status: "available",
                  evidenceClass,
                  observedAt: T0,
                  evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
                }
              : {
                  status: "unknown",
                  evidenceClass: "UNKNOWN",
                  observedAt: T0,
                  evidence: { kind: "none" },
                },
          ]),
        ),
      });
      const decision = assertCapability(
        snapshot,
        { capability: "wifi_observation", onInsufficient: "degrade" },
        fixtureUtcInstant(1_000),
      );
      expect(decision.decision, `class ${evidenceClass} must never allow`).not.toBe("allow");
      if (decision.decision !== "allow") {
        expect(decision.reason).toBe("evidence-class-insufficient");
      }
    }
  });

  it("the RL-040 contract itself refuses status available with class UNKNOWN outright", () => {
    expect(
      () =>
        new EdgeCapabilitySnapshot({
          snapshotId: "00000000-0000-4000-8000-0000000000c1",
          contractVersion: "0.1",
          sequence: 1,
          deviceRef: "device-enrollment-ref-1",
          platform: { family: "ios", platformVersion: "18.2" },
          observedAt: T0,
          freshUntil: fixtureUtcInstant(60_000),
          capabilities: Object.fromEntries(
            edgeCapabilitiesInScope("ios").map((name) => [
              name,
              name === "wifi_observation"
                ? {
                    status: "available",
                    evidenceClass: "UNKNOWN",
                    observedAt: T0,
                    evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
                  }
                : {
                    status: "unknown",
                    evidenceClass: "UNKNOWN",
                    observedAt: T0,
                    evidence: { kind: "none" },
                  },
            ]),
          ),
        }),
    ).toThrow(/real platform evidence/);
  });

  it("engine-produced snapshots never contain AUTHENTICATED, INFERRED or STALE classes", () => {
    const eng = engine();
    let snapshot = eng.applyCapabilityObservation(null, observation(), T0).snapshot;
    // hammer the chain with every evidence kind and both claims
    const kinds = ["platform-api-probe", "os-statement", "user-permission-state", "none"] as const;
    let counter = 0;
    for (const kind of kinds) {
      for (const status of ["available", "unavailable", "requires-permission", "unknown"] as const) {
        counter += 1;
        snapshot = eng.applyCapabilityObservation(
          snapshot,
          observation({
            observationId: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
            observedAt: T1,
            evidence:
              kind === "none"
                ? { kind: "none" }
                : { kind, source: kind === "os-statement" ? "OS.declaration" : "TestProbe.framework" },
            subject: {
              kind: "capability-probe",
              capability: "wifi_observation",
              status: kind === "none" ? "unknown" : status,
            },
          }),
          T1,
        ).snapshot;
      }
    }
    const classes = new Set(
      Object.values(snapshot.capabilities).map((entry) => entry?.evidenceClass),
    );
    expect(classes.has("AUTHENTICATED")).toBe(false);
    expect(classes.has("INFERRED")).toBe(false);
    expect(classes.has("STALE")).toBe(false);
    expect([...classes].every((c) => (["OBSERVED", "REPORTED", "UNKNOWN"] as string[]).includes(c as string))).toBe(
      true,
    );
  });
});
