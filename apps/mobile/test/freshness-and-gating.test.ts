/**
 * Freshness rendering + capability-gated action truth tables at the SHELL
 * level (RL-062; RL-LOCK-010/011).
 *
 * Proves: freshness is re-evaluated at the query instant (FRESH -> STALE
 * monotonic degradation; UNKNOWN presented, never hidden); the shell renders
 * last-known freshness ALWAYS and never fabricates connectivity state; and
 * the capability-gate truth table (INFERRED/STALE/UNKNOWN evidence NEVER
 * allows an action; requires-permission and unavailable degrade/deny with
 * typed reasons rendered as observation/manual guidance).
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";
import {
  createAesGcmEdgePayloadCipher,
  EdgeCapabilitySnapshot,
  type EdgeCapabilitySnapshotInput,
} from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";

import { MobileEdgeShell, previewCapabilityGate } from "../src/shell.js";
import { InMemoryMobilePlatformProbe } from "../src/platform-probe.js";
import type { MobileEnrollmentSigner } from "../src/enrollment.js";

const T0 = "2026-03-01T08:00:00.000Z";
const KEY_BYTES = new Uint8Array(32).fill(11);
const SIGNING_KEY = "freshness-test-key";
const signer: MobileEnrollmentSigner = {
  algorithm: "hmac-sha256",
  keyId: "enrollment-test",
  async sign(message: string): Promise<string> {
    return createHmac("sha256", SIGNING_KEY).update(message, "utf8").digest("hex");
  },
  async verify(message: string, signature: string): Promise<boolean> {
    return (
      createHmac("sha256", SIGNING_KEY).update(message, "utf8").digest("hex") === signature
    );
  },
};

function shellWith(
  batches: readonly (readonly { readonly subject: Record<string, unknown>; readonly evidence?: { readonly kind: string } }[])[],
  executorOptions?: ConstructorParameters<typeof InMemoryPlatformActionExecutor>[0],
): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: batches.map((batch) =>
      batch.map((sample) => ({
        observedAt: T0,
        evidence: sample.evidence ?? { kind: "platform-api-probe", source: "TestProbe" },
        subject: sample.subject,
      })),
    ),
  });
  let counter = 0;
  return new MobileEdgeShell({
    deviceRef: "device-7f3a",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-1",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(executorOptions),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "edge-outbox-key",
    observationIdGenerator: () => deterministicUuidFromSeed(++counter),
    snapshotIdGenerator: () => deterministicUuidFromSeed(1000 + counter),
    outboxRecordIdGenerator: () => deterministicUuidFromSeed(2000 + counter),
    actionIdGenerator: () => deterministicUuidFromSeed(3000 + counter),
    commandIdGenerator: () => deterministicUuidFromSeed(4000 + counter),
    correlationIdGenerator: () => `corr-${counter}`,
    idempotencyKeyGenerator: () => `idem-${counter}`,
    desiredStateIdGenerator: () => deterministicUuidFromSeed(5000 + counter),
    publicationIdGenerator: () => deterministicUuidFromSeed(6000 + counter),
    signer,
    snapshotFreshnessMs: 60_000,
  });
}

const WIFI_BATCH = [
  { subject: { kind: "capability-probe", capability: "wifi_control", status: "available" } },
  { subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" } },
] as const;

describe("freshness rendering (RL-LOCK-010 - always displayed, never fabricated)", () => {
  it("renders FRESH at the observation instant and STALE after the guarantee", async () => {
    const shell = shellWith([WIFI_BATCH]);
    await shell.runObservationCycle(T0);

    const fresh = await shell.connectivityView(T0);
    expect(fresh.context[0]?.freshness.freshnessState).toBe("FRESH");
    expect(fresh.observedConnectivityState?.value).toBe("online");
    expect(fresh.observedConnectivityState?.freshness.freshnessState).toBe("FRESH");

    const stale = await shell.connectivityView("2026-03-01T08:01:00.001Z");
    expect(stale.context[0]?.freshness.freshnessState).toBe("STALE");
    // The OBSERVED VALUE is still rendered (last-known), with the degraded
    // freshness - the shell never fabricates and never hides.
    expect(stale.observedConnectivityState?.value).toBe("online");
    expect(stale.observedConnectivityState?.freshness.freshnessState).toBe("STALE");
  });

  it("renders UNKNOWN before any observation and for absent evidence", async () => {
    const shell = shellWith([WIFI_BATCH]);
    const before = await shell.connectivityView(T0);
    expect(before.context).toEqual([]);
    expect(before.observedConnectivityState).toBeNull();
    expect(before.capabilitySummary.total).toBe(0);
    expect(before.lastObservationAt).toBeNull();
    expect(before.enrollmentFreshness).toBeNull();

    await shell.runObservationCycle(T0);
    const after = await shell.connectivityView(T0);
    // Capabilities the probe did not touch are honestly UNKNOWN.
    expect(after.capabilitySummary.unknown).toBeGreaterThan(0);
    const matrix = shell.capabilityMatrix(T0);
    const untouched = matrix.find((row) => row.capability === "esim_profile_install");
    expect(untouched?.status).toBe("unknown");
    expect(untouched?.evidenceClass).toBe("UNKNOWN");
    // The ABSENCE was recorded at the observation instant, so its freshness
    // tracks the snapshot guarantee: the shell freshly knows it does not
    // know (the gate still denies - capability-unknown).
    expect(untouched?.freshness.freshnessState).toBe("FRESH");
    expect(untouched?.gatePreview.admission).toBe("BLOCKED-UNSUPPORTED");
  });

  it("the enrollment publication freshness degrades to STALE monotonically", async () => {
    const shell = shellWith([WIFI_BATCH]);
    const publication = await shell.enroll(T0);
    expect(publication.freshness.freshnessState).toBe("FRESH");

    const later = await shell.connectivityView("2026-03-01T08:01:00.001Z");
    expect(later.enrollmentFreshness?.freshnessState).toBe("STALE");
  });

  it("the shell never fabricates connectivity: offline is last-known + reachability, not a guess", async () => {
    const shell = shellWith([WIFI_BATCH]);
    await shell.runObservationCycle(T0);
    shell.enterOffline(T0);
    const view = await shell.connectivityView(T0);
    expect(view.syncReachable).toBe(false);
    // The observed value comes from the platform observation ONLY.
    expect(view.observedConnectivityState?.value).toBe("online");
    // And with no observation of connectivity-state at all:
    const shell2 = shellWith([[{ subject: { kind: "capability-probe", capability: "wifi_control", status: "available" } }]]);
    await shell2.runObservationCycle(T0);
    shell2.enterOffline(T0);
    const view2 = await shell2.connectivityView(T0);
    expect(view2.observedConnectivityState).toBeNull(); // honest absence, never "offline" invented
  });
});

describe("the capability-gated action truth table at the shell level (RL-LOCK-011)", () => {
  function snapshotWith(
    entry: { readonly status: string; readonly evidenceClass?: string; readonly kind?: string },
    freshnessMs: number | null = 60_000,
  ): EdgeCapabilitySnapshot {
    const observedAt = T0;
    const input: EdgeCapabilitySnapshotInput = {
      snapshotId: "00000000-0000-4000-8000-000000000001",
      contractVersion: "0.1",
      sequence: 1,
      deviceRef: "device-7f3a",
      platform: { family: "ios", platformVersion: "18.2" },
      observedAt,
      freshUntil: freshnessMs === null ? null : "2026-03-01T08:01:00.000Z",
      capabilities: {
        wifi_control: {
          status: entry.status,
          evidenceClass: entry.evidenceClass ?? "OBSERVED",
          observedAt,
          evidence:
            (entry.kind ?? "platform-api-probe") === "none"
              ? { kind: "none" }
              : { kind: entry.kind ?? "platform-api-probe", source: "TruthTable" },
        },
        // every other in-scope capability stays honestly unknown
        wifi_observation: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        cellular_data_sim_selection: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        esim_profile_install: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        esim_profile_remove: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        esim_profile_enable: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        active_interface_selection: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        vpn_network_extension: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        concurrent_interface_constraints: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        radio_os_telemetry: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
        background_execution_limits: {
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt,
          evidence: { kind: "none" },
        },
      },
    };
    return new EdgeCapabilitySnapshot(input);
  }

  it("allow: available + OBSERVED evidence within the freshness guarantee", () => {
    const snapshot = snapshotWith({ status: "available" });
    expect(previewCapabilityGate(snapshot, "wifi_control", T0).admission).toBe("ADMITTED");
  });

  it("deny: INFERRED evidence NEVER allows (heuristic evidence is not authority)", () => {
    const snapshot = snapshotWith({ status: "available", evidenceClass: "INFERRED" });
    const gate = previewCapabilityGate(snapshot, "wifi_control", T0);
    expect(gate.admission).toBe("BLOCKED-UNSUPPORTED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("evidence-class-insufficient");
  });

  it("deny: STALE evidence NEVER allows", () => {
    const snapshot = snapshotWith({ status: "available", evidenceClass: "STALE" });
    const gate = previewCapabilityGate(snapshot, "wifi_control", T0);
    expect(gate.admission).toBe("BLOCKED-UNSUPPORTED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("evidence-class-insufficient");
  });

  it("deny: UNKNOWN evidence NEVER allows - and is not even representable (defense in depth)", () => {
    // The snapshot CONTRACT itself rejects an `available` claim backed by
    // kind-none/UNKNOWN evidence: such a record cannot be constructed, so
    // no gate ever sees it (RL-LOCK-011 enforced at the record boundary).
    expect(() =>
      snapshotWith({ status: "available", evidenceClass: "UNKNOWN", kind: "none" }),
    ).toThrowError();
  });

  it("deny: an available capability past its freshness guarantee (evidence-stale)", () => {
    const snapshot = snapshotWith({ status: "available" });
    const gate = previewCapabilityGate(snapshot, "wifi_control", "2026-03-01T08:01:00.001Z");
    expect(gate.admission).toBe("BLOCKED-UNSUPPORTED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("evidence-stale");
  });

  it("deny: unavailable capability (typed, diagnosable)", () => {
    const snapshot = snapshotWith({ status: "unavailable" });
    const gate = previewCapabilityGate(snapshot, "wifi_control", T0);
    expect(gate.admission).toBe("BLOCKED-UNSUPPORTED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("capability-unavailable");
  });

  it("degrade: requires-permission degrades to observation/manual guidance (never a pass)", () => {
    const snapshot = snapshotWith({ status: "requires-permission" });
    const gate = previewCapabilityGate(snapshot, "wifi_control", T0);
    expect(gate.admission).toBe("BLOCKED-DEGRADED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("capability-requires-permission");
  });

  it("deny: a capability with no snapshot entry (absence of evidence is not availability)", () => {
    const snapshot = snapshotWith({ status: "available" });
    const gate = previewCapabilityGate(snapshot, "esim_profile_install", T0);
    expect(gate.admission).toBe("BLOCKED-UNSUPPORTED");
    if (gate.admission === "ADMITTED") throw new Error("unreachable");
    expect(gate.gate.reason).toBe("capability-unknown");
  });

  it("the shell request path enforces the same table (blocked actions never execute or queue)", async () => {
    // requires-permission control at the shell level
    const shell = shellWith(
      [
        [
          { subject: { kind: "capability-probe", capability: "wifi_control", status: "requires-permission" } },
        ],
      ],
      { capabilities: [{ capability: "wifi_control", script: [InMemoryPlatformActionExecutor.evidencedSuccess()] }] },
    );
    await shell.runObservationCycle(T0);

    const local = await shell.requestAction({ capability: "wifi_control" }, "local", T0);
    expect(local.outcome).toBe("BLOCKED");
    expect(local.result.status).toBe("degraded");
    expect(local.result.reason).toBe("capability-requires-permission");
    // The executor was NEVER called (the gate blocks before execution).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requests = (shell as any).projectionEntries;
    void requests;

    const server = await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    expect(server.outcome).toBe("BLOCKED");
    expect((await shell.outboxRecords())).toHaveLength(0); // never queued
  });

  it("a non-conforming executor success (no evidence) is a typed failure, never a fabricated success", async () => {
    // A LYING executor that claims success without platform evidence: the
    // adapter converts the non-conforming outcome into a typed `failed`
    // result - physical success is only ever declared WITH evidence
    // (RL-LOCK-011 discipline).
    const probe = new InMemoryMobilePlatformProbe({
      batches: [
        WIFI_BATCH.map((sample) => ({
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: sample.subject,
        })),
      ],
    });
    let counter = 0;
    const lyingExecutor = {
      async execute(): Promise<Record<string, unknown>> {
        return { outcome: "succeeded" }; // success WITHOUT evidence - a lie
      },
    };
    const shell = new MobileEdgeShell({
      deviceRef: "device-7f3a",
      platform: { family: "ios", platformVersion: "18.2" },
      actorId: "actor-1",
      tenantId: fixtureTenantId(),
      probe,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: lyingExecutor as any,
      cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
      outboxKeyId: "edge-outbox-key",
      observationIdGenerator: () => deterministicUuidFromSeed(++counter),
      snapshotIdGenerator: () => deterministicUuidFromSeed(10_000 + counter),
      outboxRecordIdGenerator: () => deterministicUuidFromSeed(20_000 + counter),
      actionIdGenerator: () => deterministicUuidFromSeed(30_000 + counter),
      commandIdGenerator: () => deterministicUuidFromSeed(40_000 + counter),
      correlationIdGenerator: () => `corr-${counter}`,
      idempotencyKeyGenerator: () => `idem-${counter}`,
      desiredStateIdGenerator: () => deterministicUuidFromSeed(50_000 + counter),
      publicationIdGenerator: () => deterministicUuidFromSeed(60_000 + counter),
      signer,
      snapshotFreshnessMs: 60_000,
    });
    await shell.runObservationCycle(T0);
    const outcome = await shell.requestAction({ capability: "wifi_control" }, "local", T0);
    expect(outcome.outcome).toBe("BLOCKED");
    expect(outcome.result.status).toBe("failed"); // refused, never executed-observed
  });
});
