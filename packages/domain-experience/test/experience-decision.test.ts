/**
 * RL-013 ExperienceDecision read-model tests: explainability (every outcome
 * factor traces to the input evidence that produced it), freshness/evidence
 * weighting truth tables, immutability, determinism, and the authority
 * invariants (derived status never overwrites the authoritative intent
 * status; the builder never mutates domain state).
 */
import { describe, expect, it } from "vitest";
import {
  ValidationError,
  canonicalJsonDigest,
  makeFreshness,
  parseExperienceDecisionId,
  parseUserId,
  parseUtcInstant,
  tenantIdFromUser,
  type Freshness,
  type TenantId,
  type UserId,
} from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import {
  DeviceCapabilitySnapshot,
  DeviceContextSnapshot,
  ExperienceIntent,
  ExperienceIntentVersion,
  buildExperienceDecision,
  parseExperienceDecision,
  EVIDENCE_CLASS_WEIGHTS,
  evidenceWeight,
  weakestEvidenceClass,
  type CapabilitySnapshotInput,
  type ExperienceDecisionRecord,
  type ExperienceIntentRecord,
  type ExperienceIntentVersionRecord,
} from "../src/index.js";

const OWNER: UserId = parseUserId("00000000-0000-4000-8000-000000000002");
const TENANT: TenantId = tenantIdFromUser(OWNER);
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const DECISION_ID = parseExperienceDecisionId("00000000-0000-4000-8000-0000000000e1");
const T0 = "2026-01-15T08:30:00.000Z";
const AT = "2026-01-15T09:00:00.000Z";

function intentPayloadFixture(overrides?: Record<string, unknown>) {
  return {
    travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
    usageProfile: "travel_international",
    preferences: {
      reliability: "high",
      latency: "interactive",
      costSensitivity: "medium",
      privacySensitivity: "high",
      preferredAccessClasses: ["trusted_wifi"],
    },
    hardConstraints: {
      requireEncryptedTransport: false,
      forbidRoaming: false,
      forbidOpenWifi: false,
    },
    ...overrides,
  };
}

function decisionInputFixture(options?: {
  intentStatus?: ExperienceIntentRecord["status"];
  withDevice?: boolean;
  payload?: Record<string, unknown>;
}): {
  intent: ExperienceIntentRecord;
  version: ExperienceIntentVersionRecord;
} {
  const intentVersionId = "00000000-0000-4000-8000-0000000000a1";
  const intentId = "00000000-0000-4000-8000-0000000000b2";
  const status = options?.intentStatus ?? "active";
  const version = new ExperienceIntentVersion({
    tenantId: TENANT,
    intentVersionId,
    intentId,
    versionNumber: 1,
    payload: intentPayloadFixture(options?.payload),
    createdAt: T0,
  });
  const intent = new ExperienceIntent({
    intentId,
    ownerUserId: OWNER,
    ...(options?.withDevice === false ? {} : { deviceId: DEVICE_ID }),
    status,
    ...(status === "superseded"
      ? { supersededBy: "00000000-0000-4000-8000-0000000000f9" }
      : {}),
    currentVersionId: version.intentVersionId,
    currentVersionNumber: version.versionNumber,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  });
  return { intent: intent.toRecord(), version: version.toRecord() };
}

function capabilitySnapshotFixture(options?: {
  freshUntil?: string | null;
  wifiStatus?: "available" | "unavailable" | "requires-permission" | "unknown";
  evidenceClass?: "AUTHENTICATED" | "OBSERVED" | "REPORTED" | "DERIVED" | "INFERRED";
  omitEntries?: boolean;
  deviceId?: string;
}): CapabilitySnapshotInput {
  const snapshot = new DeviceCapabilitySnapshot({
    snapshotId: "00000000-0000-4000-8000-0000000000c3",
    contractVersion: "0.1",
    sequence: 1,
    deviceId: options?.deviceId ?? DEVICE_ID,
    platform: { family: "ios", platformVersion: "18.2.0" },
    observedAt: T0,
    freshUntil: options?.freshUntil === undefined ? "2026-01-15T10:00:00.000Z" : options?.freshUntil,
    capabilities: options?.omitEntries
      ? {}
      : {
          wifi_observation: {
            status: options?.wifiStatus ?? "available",
            evidenceClass: options?.evidenceClass ?? "OBSERVED",
            observedAt: T0,
          },
          wifi_control: {
            status: options?.wifiStatus ?? "available",
            evidenceClass: options?.evidenceClass ?? "OBSERVED",
            observedAt: T0,
          },
        },
  });
  return { ...snapshot.toPlain(), tenantId: TENANT };
}

function contextSnapshotFixture(options?: {
  freshUntil?: string | null;
  deviceId?: string;
}): ReturnType<typeof DeviceContextSnapshot.prototype.toPlain> {
  return new DeviceContextSnapshot({
    snapshotId: "00000000-0000-4000-8000-0000000000c4",
    contractVersion: "0.1",
    sequence: 1,
    deviceId: options?.deviceId ?? DEVICE_ID,
    ownerUserId: OWNER,
    observedAt: T0,
    freshUntil: options?.freshUntil === undefined ? "2026-01-15T10:00:00.000Z" : options?.freshUntil,
    consent: { fineLocationGranted: false },
    payload: { battery: { levelPercent: 82 } },
  }).toPlain();
}

function build(
  input: {
    intent: ExperienceIntentRecord;
    version: ExperienceIntentVersionRecord;
  },
  evidence?: {
    capability?: CapabilitySnapshotInput | null;
    context?: ReturnType<typeof DeviceContextSnapshot.prototype.toPlain> | null;
  },
  at: string = AT,
): ExperienceDecisionRecord {
  return buildExperienceDecision({
    decisionId: DECISION_ID,
    intent: input.intent,
    intentVersion: input.version,
    ...(evidence?.capability !== undefined ? { capabilitySnapshot: evidence.capability } : {}),
    ...(evidence?.context !== undefined ? { contextSnapshot: evidence.context } : {}),
    at,
  });
}

// ---------------------------------------------------------------------------
// Evidence weighting truth table
// ---------------------------------------------------------------------------

describe("RL-013 evidence weighting", () => {
  const CASES = [
    ["AUTHENTICATED", "FRESH", 4],
    ["OBSERVED", "FRESH", 3],
    ["REPORTED", "FRESH", 2],
    ["DERIVED", "FRESH", 2],
    ["INFERRED", "FRESH", 1],
    ["AUTHENTICATED", "STALE", 0],
    ["OBSERVED", "STALE", 0],
    ["AUTHENTICATED", "UNKNOWN", 0],
    ["DERIVED", "UNKNOWN", 0],
  ] as const;

  for (const [evidenceClass, freshnessState, expectedWeight] of CASES) {
    it(`evidenceWeight(${evidenceClass}, ${freshnessState}) = ${expectedWeight}`, () => {
      const base = makeFreshness(
        {
          observedAt: parseUtcInstant(T0),
          receivedAt: parseUtcInstant(T0),
          freshUntil: freshnessState === "UNKNOWN" ? null : parseUtcInstant(T0),
        },
        parseUtcInstant(T0),
      );
      // Force the recorded state to the row under test (weights are a pure
      // function of class + state).
      const freshness: Freshness = { ...base, freshnessState };
      expect(freshness.freshnessState).toBe(freshnessState);
      expect(evidenceWeight(evidenceClass, freshness)).toBe(expectedWeight);
      expect(EVIDENCE_CLASS_WEIGHTS[evidenceClass]).toBeGreaterThanOrEqual(expectedWeight);
    });
  }

  it("weakestEvidenceClass returns the minimum rank (empty = UNKNOWN)", () => {
    expect(weakestEvidenceClass([])).toBe("UNKNOWN");
    expect(weakestEvidenceClass(["AUTHENTICATED", "OBSERVED"])).toBe("OBSERVED");
    expect(weakestEvidenceClass(["INFERRED", "DERIVED"])).toBe("INFERRED");
    // REPORTED and DERIVED tie at rank 2: the first of the weakest rank wins.
    expect(weakestEvidenceClass(["REPORTED", "DERIVED", "OBSERVED"])).toBe("REPORTED");
  });
});

// ---------------------------------------------------------------------------
// Derived-status truth table
// ---------------------------------------------------------------------------

describe("RL-013 derived status truth table", () => {
  it("draft intent -> experience_pending regardless of evidence", () => {
    const pair = decisionInputFixture({ intentStatus: "draft" });
    const decision = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    expect(decision.derivedStatus).toBe("experience_pending");
    expect(decision.subject.intentStatus).toBe("draft");
  });

  for (const status of ["superseded", "archived", "canceled"] as const) {
    it(`terminal intent (${status}) -> experience_closed regardless of evidence`, () => {
      const pair = decisionInputFixture({ intentStatus: status });
      const supersededIntent = {
        ...pair.intent,
        ...(status === "superseded"
          ? { supersededBy: "00000000-0000-4000-8000-0000000000f9" }
          : {}),
      } as ExperienceIntentRecord;
      const decision = build(
        { intent: supersededIntent, version: pair.version },
        { capability: capabilitySnapshotFixture(), context: contextSnapshotFixture() },
      );
      expect(decision.derivedStatus).toBe("experience_closed");
      expect(decision.subject.intentStatus).toBe(status);
    });
  }

  it("active + fresh capability + fresh context -> experience_supported", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    expect(decision.derivedStatus).toBe("experience_supported");
  });

  it("active + fresh capability + absent context -> experience_supported (context is enrichment)", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, { capability: capabilitySnapshotFixture(), context: null });
    expect(decision.derivedStatus).toBe("experience_supported");
  });

  it("active + stale capability -> experience_degraded", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture({ freshUntil: "2026-01-15T08:45:00.000Z" }),
      context: contextSnapshotFixture(),
    });
    expect(decision.derivedStatus).toBe("experience_degraded");
    const capabilityInput = decision.inputs.find((i) => i.kind === "device-capability-snapshot");
    expect(capabilityInput?.weight).toBe(0);
    expect(capabilityInput?.freshness?.freshnessState).toBe("STALE");
  });

  it("active + fresh capability + stale context -> experience_degraded", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture({ freshUntil: "2026-01-15T08:45:00.000Z" }),
    });
    expect(decision.derivedStatus).toBe("experience_degraded");
  });

  it("active + no evidence at all -> experience_unresolved", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, { capability: null, context: null });
    expect(decision.derivedStatus).toBe("experience_unresolved");
    expect(decision.inputs).toHaveLength(1); // intent input only
  });

  it("active + unproven capability (no freshness guarantee) -> experience_unresolved", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture({ freshUntil: null }),
      context: contextSnapshotFixture(),
    });
    expect(decision.derivedStatus).toBe("experience_unresolved");
    const capabilityInput = decision.inputs.find((i) => i.kind === "device-capability-snapshot");
    expect(capabilityInput?.freshness?.freshnessState).toBe("UNKNOWN");
    expect(capabilityInput?.weight).toBe(0);
  });

  it("active + fresh evidence + unavailable mapped capability -> experience_degraded with a limiting factor", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture({ wifiStatus: "unavailable" }),
      context: null,
    });
    expect(decision.derivedStatus).toBe("experience_degraded");
    expect(
      decision.factors.some(
        (f) => f.code === "capability.limitation" && f.outcome === "limits",
      ),
    ).toBe(true);
  });

  it("active + fresh evidence + requires-permission capability -> experience_degraded", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture({ wifiStatus: "requires-permission" }),
      context: null,
    });
    expect(decision.derivedStatus).toBe("experience_degraded");
    expect(
      decision.factors.some(
        (f) => f.code === "capability.permission_required" && f.outcome === "limits",
      ),
    ).toBe(true);
  });

  it("external access classes (wired, satellite) produce external factors, never device claims", () => {
    const pair = decisionInputFixture({
      payload: intentPayloadFixture({
        preferences: {
          reliability: "high",
          latency: "interactive",
          costSensitivity: "medium",
          privacySensitivity: "high",
          preferredAccessClasses: ["wired", "satellite"],
        },
      }),
    });
    const decision = build(pair, { capability: capabilitySnapshotFixture() });
    const external = decision.factors.filter((f) => f.code === "access_class.external");
    expect(external).toHaveLength(2);
    for (const factor of external) {
      expect(factor.outcome).toBe("unknown");
      expect(factor.inputRef).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Explainability: outcomes trace to input evidence
// ---------------------------------------------------------------------------

describe("RL-013 explainability", () => {
  it("every device-derived factor references the snapshot input that produced it", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    const inputIds = new Set(decision.inputs.map((i) => i.recordId));
    for (const factor of decision.factors) {
      if (factor.inputRef !== undefined) {
        expect(factor.inputRef.kind).toBe(
          factor.code === "evidence.context" ? "device-context-snapshot" : "device-capability-snapshot",
        );
        expect(inputIds.has(factor.inputRef.recordId)).toBe(true);
      }
    }
    const limitation = decision.factors.find((f) => f.code === "capability.limitation");
    expect(limitation).toBeUndefined();
  });

  it("a limiting capability factor names the input record it came from", () => {
    const pair = decisionInputFixture();
    const capability = capabilitySnapshotFixture({ wifiStatus: "unavailable" });
    const decision = build(pair, { capability });
    const limitation = decision.factors.find((f) => f.code === "capability.limitation");
    expect(limitation?.inputRef?.recordId).toBe(capability.snapshotId);
    expect(limitation?.detail).toContain("unavailable");
  });

  it("hard constraints produce explicit factors (which constraint produced which outcome)", () => {
    const pair = decisionInputFixture({
      payload: intentPayloadFixture({
        hardConstraints: {
          requireEncryptedTransport: true,
          forbidRoaming: true,
          forbidOpenWifi: true,
        },
      }),
    });
    const decision = build(pair, { capability: capabilitySnapshotFixture() });
    const hard = decision.factors.filter((f) => f.code === "constraint.hard");
    expect(hard).toHaveLength(3);
    for (const factor of hard) {
      expect(factor.outcome).toBe("limits");
    }
  });

  it("the intent input carries the version payload digest (input digests are explicit)", () => {
    const pair = decisionInputFixture();
    const decision = build(pair, { capability: null, context: null });
    const intentInput = decision.inputs.find((i) => i.kind === "experience-intent");
    expect(intentInput?.digest).toBe(pair.version.payloadDigest);
    expect(intentInput?.sourceAuthority).toBe("roamlink");
    expect(intentInput?.evidenceClass).toBe("DERIVED");
  });

  it("snapshot input digests are the canonical digest of the snapshot records", () => {
    const pair = decisionInputFixture();
    const capability = capabilitySnapshotFixture();
    const context = contextSnapshotFixture();
    const decision = build(pair, { capability, context });
    const capabilityInput = decision.inputs.find((i) => i.kind === "device-capability-snapshot");
    const contextInput = decision.inputs.find((i) => i.kind === "device-context-snapshot");
    expect(capabilityInput?.digest).toBe(canonicalJsonDigest(capability));
    expect(contextInput?.digest).toBe(canonicalJsonDigest(context));
  });

  it("factors are ordered deterministically (intent, access classes, evidence, constraints)", () => {
    const pair = decisionInputFixture({
      payload: intentPayloadFixture({
        hardConstraints: {
          requireEncryptedTransport: true,
          forbidRoaming: false,
          forbidOpenWifi: true,
        },
      }),
    });
    const decision = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    const codes = decision.factors.map((f) => f.code);
    expect(codes.indexOf("intent.status")).toBe(0);
    expect(codes.indexOf("access_class.device_evidence")).toBeGreaterThan(0);
    expect(codes.indexOf("evidence.capability")).toBeGreaterThan(
      codes.indexOf("access_class.device_evidence"),
    );
    expect(codes.indexOf("constraint.hard")).toBeGreaterThan(
      codes.indexOf("evidence.context"),
    );
  });
});

// ---------------------------------------------------------------------------
// Immutability, determinism, validation
// ---------------------------------------------------------------------------

describe("RL-013 immutability and determinism", () => {
  it("the record is deeply frozen", () => {
    const decision = build(decisionInputFixture(), { capability: capabilitySnapshotFixture() });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.inputs)).toBe(true);
    expect(Object.isFrozen(decision.factors)).toBe(true);
    expect(Object.isFrozen(decision.subject)).toBe(true);
    for (const input of decision.inputs) {
      expect(Object.isFrozen(input)).toBe(true);
    }
  });

  it("identical inputs + instant produce an identical record (deterministic rebuild)", () => {
    const pair = decisionInputFixture();
    const a = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    const b = build(pair, {
      capability: capabilitySnapshotFixture(),
      context: contextSnapshotFixture(),
    });
    expect(b).toEqual(a);
  });

  it("a later evaluation instant degrades freshness (monotone, explicit time)", () => {
    const pair = decisionInputFixture();
    const early = build(pair, { capability: capabilitySnapshotFixture() }, "2026-01-15T09:30:00.000Z");
    const late = build(pair, { capability: capabilitySnapshotFixture() }, "2026-01-15T10:30:00.000Z");
    expect(early.derivedStatus).toBe("experience_supported");
    expect(late.derivedStatus).toBe("experience_degraded");
    expect(early.computedAt).not.toBe(late.computedAt);
  });

  it("the builder does not mutate the input records", () => {
    const pair = decisionInputFixture();
    const capability = capabilitySnapshotFixture();
    const intentBefore = structuredClone(pair.intent);
    const versionBefore = structuredClone(pair.version);
    const capabilityBefore = structuredClone(capability);
    build(pair, { capability });
    expect(pair.intent).toEqual(intentBefore);
    expect(pair.version).toEqual(versionBefore);
    expect(capability).toEqual(capabilityBefore);
  });

  it("the DeterministicClock drives the evaluation instant (testkit clock)", () => {
    const clock = new DeterministicClock("2026-01-15T09:00:00.000Z");
    const decision = build(decisionInputFixture(), { capability: capabilitySnapshotFixture() }, clock.now());
    expect(decision.computedAt).toBe(clock.now());
  });
});

// ---------------------------------------------------------------------------
// Validation (fail-closed)
// ---------------------------------------------------------------------------

describe("RL-013 validation", () => {
  it("rejects a version that does not belong to the intent", () => {
    const pair = decisionInputFixture();
    const foreign = {
      ...pair.version,
      intentId: "00000000-0000-4000-8000-0000000000ee",
    } as typeof pair.version;
    expect(() => build({ intent: pair.intent, version: foreign })).toThrow(ValidationError);
  });

  it("rejects a non-current version", () => {
    const pair = decisionInputFixture();
    const stale = {
      ...pair.version,
      versionNumber: 2,
      supersedes: pair.version.intentVersionId,
    } as typeof pair.version;
    expect(() => build({ intent: pair.intent, version: stale })).toThrow(ValidationError);
  });

  it("rejects device evidence when the intent names no device", () => {
    const pair = decisionInputFixture({ withDevice: false });
    expect(() =>
      build(pair, { capability: capabilitySnapshotFixture({ deviceId: "00000000-0000-4000-8000-0000000000d2" }) }),
    ).toThrow(ValidationError);
  });

  it("rejects a snapshot for a different device than the intent targets", () => {
    const pair = decisionInputFixture();
    expect(() =>
      build(pair, {
        capability: capabilitySnapshotFixture({ deviceId: "00000000-0000-4000-8000-0000000000d3" }),
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a snapshot from another tenant", () => {
    const pair = decisionInputFixture();
    const foreign = {
      ...capabilitySnapshotFixture(),
      tenantId: "usr:00000000-0000-4000-8000-0000000000ff" as TenantId,
    };
    expect(() => build(pair, { capability: foreign })).toThrow(ValidationError);
  });

  it("rejects an invalid decision id", () => {
    const pair = decisionInputFixture();
    expect(() =>
      buildExperienceDecision({
        decisionId: "not-a-uuid",
        intent: pair.intent,
        intentVersion: pair.version,
        at: AT,
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("RL-013 round-trip (persisted read-model snapshots)", () => {
  it("parseExperienceDecision round-trips a built record", () => {
    const decision = build(
      decisionInputFixture({
        payload: intentPayloadFixture({
          hardConstraints: {
            requireEncryptedTransport: true,
            forbidRoaming: false,
            forbidOpenWifi: false,
          },
        }),
      }),
      { capability: capabilitySnapshotFixture(), context: contextSnapshotFixture() },
    );
    const parsed = parseExperienceDecision(JSON.parse(JSON.stringify(decision)));
    expect(parsed).toEqual(decision);
  });

  it("rejects unknown fields on the record (closed vocabulary)", () => {
    const decision = build(decisionInputFixture());
    const extended = { ...decision, connectivityState: "path_active" };
    expect(() => parseExperienceDecision(extended)).toThrow(ValidationError);
  });

  it("rejects an unknown derived status", () => {
    const decision = build(decisionInputFixture());
    const corrupted = { ...decision, derivedStatus: "delivered" };
    expect(() => parseExperienceDecision(corrupted)).toThrow(ValidationError);
  });
});
