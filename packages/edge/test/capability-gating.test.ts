import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";
import {
  CAPABILITY_DEGRADE_REASONS,
  CAPABILITY_DENY_REASONS,
  CAPABILITY_EVIDENCE_CLASS_RANKS,
  EdgeCapabilitySnapshot,
  assertCapability,
  makeEdgeCapabilityRequirement,
} from "../src/index.js";
import { entry, snapshotInput, unknownEntry, FRESH_UNTIL, OBSERVED_AT } from "./helpers.js";

const AS_OF = fixtureUtcInstant(30_000); // inside the default freshness window

function snapshotWith(capability: string, entryValue: Record<string, unknown>) {
  return new EdgeCapabilitySnapshot(
    snapshotInput({ capabilities: { [capability]: entryValue } }),
  );
}

describe("requirement construction and validation", () => {
  it("resolves defaults from the capability definition", () => {
    const requirement = makeEdgeCapabilityRequirement({ capability: "wifi_control" });
    expect(requirement.capability).toBe("wifi_control");
    expect(requirement.minimumEvidenceClass).toBe("OBSERVED");
    expect(requirement.onInsufficient).toBe("deny");
    expect(requirement.maxAgeMs).toBeNull();
    // concurrent_interface_constraints defaults to REPORTED (OS-declared constraints)
    const reported = makeEdgeCapabilityRequirement({
      capability: "concurrent_interface_constraints",
    });
    expect(reported.minimumEvidenceClass).toBe("REPORTED");
  });

  it("rejects an unknown capability, a non-gating minimum and bad policies", () => {
    expect(() => makeEdgeCapabilityRequirement({ capability: "wifi_super_control" })).toThrowError(
      /closed edge capability vocabulary/,
    );
    expect(() =>
      makeEdgeCapabilityRequirement({ capability: "wifi_control", minimumEvidenceClass: "INFERRED" }),
    ).toThrowError(/can never gate/);
    expect(() =>
      makeEdgeCapabilityRequirement({ capability: "wifi_control", onInsufficient: "explode" }),
    ).toThrowError(/deny.*degrade/);
    expect(() =>
      makeEdgeCapabilityRequirement({ capability: "wifi_control", maxAgeMs: 0 }),
    ).toThrowError(/positive integer/);
  });

  it("the evidence ranking puts INFERRED/STALE/UNKNOWN below every gating class", () => {
    expect(CAPABILITY_EVIDENCE_CLASS_RANKS.AUTHENTICATED).toBeGreaterThan(
      CAPABILITY_EVIDENCE_CLASS_RANKS.OBSERVED,
    );
    expect(CAPABILITY_EVIDENCE_CLASS_RANKS.OBSERVED).toBeGreaterThan(
      CAPABILITY_EVIDENCE_CLASS_RANKS.REPORTED,
    );
    expect(CAPABILITY_EVIDENCE_CLASS_RANKS.REPORTED).toBeGreaterThan(
      CAPABILITY_EVIDENCE_CLASS_RANKS.DERIVED,
    );
    expect(CAPABILITY_EVIDENCE_CLASS_RANKS.DERIVED).toBeGreaterThan(0);
    for (const neverSufficient of ["INFERRED", "STALE", "UNKNOWN"] as const) {
      expect(CAPABILITY_EVIDENCE_CLASS_RANKS[neverSufficient]).toBe(0);
    }
  });
});

describe("gating truth table (RL-LOCK-011: evidence-based, never assumed)", () => {
  it("available + sufficient evidence + fresh -> ALLOW", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const decision = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.evidenceClass).toBe("OBSERVED");
      expect(decision.observedAt).toBe(OBSERVED_AT);
      expect(decision.evidence.kind).toBe("platform-api-probe");
    }
  });

  it("unavailable -> DENY by default; DEGRADE with onInsufficient=degrade", () => {
    const snapshot = snapshotWith(
      "wifi_control",
      entry({ status: "unavailable", evidenceClass: "OBSERVED" }),
    );
    const denied = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("capability-unavailable");
      expect(denied.evidenceClass).toBe("OBSERVED");
    }
    const degraded = assertCapability(
      snapshot,
      { capability: "wifi_control", onInsufficient: "degrade" },
      AS_OF,
    );
    expect(degraded.decision).toBe("degrade");
    if (degraded.decision === "degrade") {
      expect(degraded.reason).toBe("capability-unavailable");
    }
  });

  it("unknown status -> DENY by default; DEGRADE with reason", () => {
    const snapshot = snapshotWith("wifi_control", unknownEntry());
    const denied = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("capability-unknown");
      expect(denied.evidenceClass).toBe("UNKNOWN");
    }
    const degraded = assertCapability(
      snapshot,
      { capability: "wifi_control", onInsufficient: "degrade" },
      AS_OF,
    );
    expect(degraded.decision).toBe("degrade");
    if (degraded.decision === "degrade") {
      expect(degraded.reason).toBe("capability-unknown");
    }
  });

  it("missing entry (out-of-scope capability on this snapshot) -> deny/degrade as unknown", () => {
    const linuxSnapshot = new EdgeCapabilitySnapshot(snapshotInput({ family: "linux" }));
    const denied = assertCapability(linuxSnapshot, { capability: "esim_profile_install" }, AS_OF);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("capability-unknown");
      expect(denied.evidenceClass).toBeNull();
    }
    const degraded = assertCapability(
      linuxSnapshot,
      { capability: "esim_profile_install", onInsufficient: "degrade" },
      AS_OF,
    );
    expect(degraded.decision).toBe("degrade");
    if (degraded.decision === "degrade") {
      expect(degraded.reason).toBe("capability-unknown");
    }
  });

  it("requires-permission -> ALWAYS degrade with reason (even when onInsufficient=deny)", () => {
    const snapshot = snapshotWith(
      "wifi_control",
      entry({
        status: "requires-permission",
        evidence: { kind: "user-permission-state", source: "OS.PermissionCenter" },
      }),
    );
    for (const onInsufficient of ["deny", "degrade", undefined] as const) {
      const requirement =
        onInsufficient === undefined
          ? { capability: "wifi_control" }
          : { capability: "wifi_control", onInsufficient };
      const decision = assertCapability(snapshot, requirement, AS_OF);
      expect(decision.decision).toBe("degrade");
      if (decision.decision === "degrade") {
        expect(decision.reason).toBe("capability-requires-permission");
        expect(decision.detail).toContain("permission grant");
      }
    }
  });

  it("available but INFERRED evidence -> DENY evidence-class-insufficient (heuristics never gate)", () => {
    const snapshot = snapshotWith(
      "wifi_control",
      entry({ evidenceClass: "INFERRED", evidence: { kind: "os-statement", source: "DeviceMatrix" } }),
    );
    const denied = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("evidence-class-insufficient");
    }
    const degraded = assertCapability(
      snapshot,
      { capability: "wifi_control", onInsufficient: "degrade" },
      AS_OF,
    );
    expect(degraded.decision).toBe("degrade");
    if (degraded.decision === "degrade") {
      expect(degraded.reason).toBe("evidence-class-insufficient");
    }
  });

  it("per-capability default minimum: REPORTED suffices for concurrent_interface_constraints but not wifi_control", () => {
    const reported = snapshotWith(
      "concurrent_interface_constraints",
      entry({ evidenceClass: "REPORTED", evidence: { kind: "os-statement", source: "OS.BuildMatrix" } }),
    );
    expect(
      assertCapability(reported, { capability: "concurrent_interface_constraints" }, AS_OF)
        .decision,
    ).toBe("allow");

    const controlReported = snapshotWith(
      "wifi_control",
      entry({ evidenceClass: "REPORTED", evidence: { kind: "os-statement", source: "OS.BuildMatrix" } }),
    );
    const denied = assertCapability(controlReported, { capability: "wifi_control" }, AS_OF);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("evidence-class-insufficient");
    }
  });

  it("an explicit stricter minimum overrides the definition default", () => {
    const observed = snapshotWith("wifi_control", entry({ evidenceClass: "OBSERVED" }));
    const denied = assertCapability(
      observed,
      { capability: "wifi_control", minimumEvidenceClass: "AUTHENTICATED" },
      AS_OF,
    );
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("evidence-class-insufficient");
    }
  });
});

describe("freshness-aware gating (RL-LOCK-010)", () => {
  it("snapshot past its freshUntil -> deny/degrade evidence-stale", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const afterFreshUntil = fixtureUtcInstant(120_000); // freshUntil is +60s
    const denied = assertCapability(snapshot, { capability: "wifi_control" }, afterFreshUntil);
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("evidence-stale");
    }
    const degraded = assertCapability(
      snapshot,
      { capability: "wifi_control", onInsufficient: "degrade" },
      afterFreshUntil,
    );
    expect(degraded.decision).toBe("degrade");
    if (degraded.decision === "degrade") {
      expect(degraded.reason).toBe("evidence-stale");
    }
  });

  it("entry older than the requirement's maxAgeMs -> evidence-stale even when the snapshot is fresh", () => {
    const staleEntry = snapshotWith(
      "wifi_control",
      entry({ observedAt: fixtureUtcInstant(-120_000) }), // observed 2 min ago
    );
    const denied = assertCapability(
      staleEntry,
      { capability: "wifi_control", maxAgeMs: 60_000 },
      AS_OF,
    );
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toBe("evidence-stale");
    }
    // without a maxAgeMs bound, the still-fresh snapshot allows
    expect(assertCapability(staleEntry, { capability: "wifi_control" }, AS_OF).decision).toBe(
      "allow",
    );
  });

  it("no freshness guarantee (freshUntil null) and no maxAgeMs -> allow on evidence alone", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const noGuarantee = new EdgeCapabilitySnapshot(
      snapshotInput({
        capabilities: { wifi_control: entry() },
        freshUntil: null,
      }),
    );
    expect(assertCapability(noGuarantee, { capability: "wifi_control" }, fixtureUtcInstant(3_600_000)).decision).toBe(
      "allow",
    );
    expect(snapshot.freshUntil).toBe(FRESH_UNTIL);
  });
});

describe("purity and determinism (RL-LOCK-012: no AI, deterministic policy)", () => {
  it("the same inputs always yield the same decision", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const first = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    const second = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(second).toEqual(first);
  });

  it("gates on the plain serialized form identically to the class form", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const fromPlain = EdgeCapabilitySnapshot.fromPlain(
      JSON.parse(JSON.stringify(snapshot.toPlain())),
    );
    expect(
      assertCapability(fromPlain, { capability: "wifi_control" }, AS_OF),
    ).toEqual(assertCapability(snapshot, { capability: "wifi_control" }, AS_OF));
  });

  it("decisions are frozen", () => {
    const snapshot = snapshotWith("wifi_control", entry());
    const decision = assertCapability(snapshot, { capability: "wifi_control" }, AS_OF);
    expect(Object.isFrozen(decision)).toBe(true);
  });
});

describe("closed reason vocabularies", () => {
  it("deny and degrade reasons stay within their closed sets", () => {
    expect([...CAPABILITY_DENY_REASONS]).toEqual([
      "capability-unavailable",
      "capability-unknown",
      "evidence-class-insufficient",
      "evidence-stale",
    ]);
    expect([...CAPABILITY_DEGRADE_REASONS]).toEqual([
      "capability-requires-permission",
      "capability-unavailable",
      "capability-unknown",
      "evidence-class-insufficient",
      "evidence-stale",
    ]);
  });
});
