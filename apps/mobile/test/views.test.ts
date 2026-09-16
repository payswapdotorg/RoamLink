/**
 * View rendering tests (RL-062).
 *
 * Proves the structural honesty rules of the screens: freshness badges are
 * ALWAYS rendered (FRESH/STALE/UNKNOWN with the observed instant); blocked
 * controls render observation/manual guidance text (never a fake success and
 * never a hidden reason); the outbox screen renders the honest
 * queued-not-executed boundary; the offline banner renders last-known state;
 * and no view ever fabricates a connectivity claim.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";
import { createAesGcmEdgePayloadCipher, parseDeviceActionId } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";

import { MobileEdgeShell, type MobileConnectivityView, type MobileActionResult } from "../src/shell.js";
import { InMemoryMobilePlatformProbe } from "../src/platform-probe.js";
import {
  actionHistoryScreen,
  actionOutcomeScreen,
  capabilityMatrixScreen,
  connectivityScreen,
  enrollmentScreen,
  manualGuidanceFor,
  outboxScreen,
  reachabilityBanner,
} from "../src/views.js";
import type { MobileEnrollmentPublication } from "../src/enrollment.js";

const T0 = "2026-03-01T08:00:00.000Z";
const AT = parseUtcInstant(T0);
const ACTION_ID_1 = parseDeviceActionId("00000000-0000-4000-8000-000000000001");
const ACTION_ID_2 = parseDeviceActionId("00000000-0000-4000-8000-000000000002");
const ACTION_ID_3 = parseDeviceActionId("00000000-0000-4000-8000-000000000003");
const KEY_BYTES = new Uint8Array(32).fill(31);
const SIGNING_KEY = "views-test-key";

function buildShell(): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: [
      [
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "capability-probe", capability: "wifi_control", status: "available" },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "capability-probe", capability: "esim_profile_install", status: "requires-permission" },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
        },
      ],
    ],
  });
  let counter = 0;
  return new MobileEdgeShell({
    deviceRef: "device-7f3a",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-1",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
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
    signer: {
      algorithm: "hmac-sha256",
      keyId: "enrollment-test",
      async sign(message: string): Promise<string> {
        return createHmac("sha256", SIGNING_KEY).update(message, "utf8").digest("hex");
      },
      async verify(): Promise<boolean> {
        return true;
      },
    },
    snapshotFreshnessMs: 60_000,
  });
}

describe("the connectivity screen (freshness ALWAYS rendered)", () => {
  it("renders the observed value with a FRESH badge and the timestamps", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const view = await shell.connectivityView(T0);
    const html = connectivityScreen(view).html;
    expect(html).toContain("connectivity-state");
    expect(html).toContain("online");
    expect(html).toContain("FRESH");
  });

  it("renders STALE after the freshness guarantee (last-known, degraded honestly)", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const view = await shell.connectivityView("2026-03-01T08:01:00.001Z");
    const html = connectivityScreen(view).html;
    expect(html).toContain("online"); // last-known value still displayed
    expect(html).toContain("STALE");
    expect(html).not.toContain(">FRESH<");
  });

  it("renders UNKNOWN when nothing was observed (absence is a valid state)", () => {
    const view: MobileConnectivityView = {
      at: AT,
      syncReachable: true,
      observedConnectivityState: null,
      context: [],
      capabilitySummary: { available: 0, unknown: 0, total: 0 },
      outbox: { pending: 0, inFlight: 0, synced: 0, deadLettered: 0 },
      lastObservationAt: null,
      enrollmentFreshness: null,
    };
    const html = connectivityScreen(view).html;
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("no observations yet");
  });

  it("the offline banner renders last-known state, never a fabricated one", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    shell.enterOffline(T0);
    const view = await shell.connectivityView(T0);
    const html = reachabilityBanner(view).html;
    expect(html).toContain("Offline");
    expect(html).toContain("observation continues");
    expect(html).toContain("online"); // the OBSERVED last-known value
    expect(html).toContain("FRESH");
  });
});

describe("the capability matrix screen (the truth table rendered)", () => {
  it("renders status, evidence, freshness and the gate preview per capability", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const rows = shell.capabilityMatrix(T0);
    const html = capabilityMatrixScreen(rows).html;

    const available = rows.find((row) => row.capability === "wifi_control");
    expect(available?.gatePreview.admission).toBe("ADMITTED");
    expect(html).toContain("wifi_control");
    expect(html).toContain("allow");

    const requiresPermission = rows.find((row) => row.capability === "esim_profile_install");
    expect(requiresPermission?.gatePreview.admission).toBe("BLOCKED-DEGRADED");
    expect(html).toContain("capability-requires-permission");
    expect(html).toContain("requires-permission");
    expect(html).toContain("UNKNOWN"); // untouched capabilities render UNKNOWN
  });
});

describe("the action outcome screen (degraded controls show guidance)", () => {
  it("renders a blocked control's reason and manual guidance", () => {
    const outcome: MobileActionResult = {
      mode: "local",
      outcome: "BLOCKED",
      result: {
        actionId: ACTION_ID_1,
        status: "degraded",
        completedAt: AT,
        reason: "capability-requires-permission",
        gateDecision: {
          decision: "degrade",
          capability: "wifi_control",
          reason: "capability-requires-permission",
          detail: "the platform requires an explicit permission grant",
          evidenceClass: "OBSERVED",
          observedAt: AT,
        },
      },
    };
    const html = actionOutcomeScreen(outcome, "wifi_control").html;
    expect(html).toContain("degraded");
    expect(html).toContain("Manual guidance");
    expect(html).toContain("Grant the wifi control permission");
    expect(html).toContain("never fakes success");
  });

  it("renders a queued server command with the honest queued-is-not-executed note", () => {
    const outcome: MobileActionResult = {
      mode: "server",
      outcome: "QUEUED",
      result: {
        actionId: ACTION_ID_2,
        status: "accepted",
        completedAt: AT,
      },
    };
    const html = actionOutcomeScreen(outcome, "wifi_control").html;
    expect(html).toContain("encrypted offline outbox");
    expect(html).toContain("queued is NOT executed");
  });

  it("renders an executed-observed local action (evidence-backed success)", () => {
    const outcome: MobileActionResult = {
      mode: "local",
      outcome: "EXECUTED",
      result: {
        actionId: ACTION_ID_3,
        status: "executed-observed",
        completedAt: AT,
        evidence: { kind: "platform-api-probe", source: "TestExecutor" },
      },
    };
    const html = actionOutcomeScreen(outcome, "wifi_control").html;
    expect(html).toContain("executed-observed");
    expect(html).not.toContain("Manual guidance");
  });

  it("the closed guidance map covers the deny/degrade reasons", () => {
    for (const reason of [
      "capability-requires-permission",
      "capability-unavailable",
      "capability-unknown",
      "evidence-class-insufficient",
      "evidence-stale",
      "action-unsupported",
    ]) {
      expect(manualGuidanceFor(reason, "wifi_control").length).toBeGreaterThan(10);
    }
  });
});

describe("the outbox + history screens (queued != executed)", () => {
  it("renders outbox records with boundary states and ciphertext note", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    const records = await shell.outboxRecords();
    const html = outboxScreen(records).html;
    expect(html).toContain("ciphertext-only");
    expect(html).toContain("pending");
  });

  it("renders the action history with sync boundaries and result sources", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    const entries = await shell.projectionEntries();
    const html = actionHistoryScreen(entries).html;
    expect(html).toContain("synced means the server ACCEPTED");
    expect(html).toContain("pending");
  });
});

describe("the enrollment screen (signed, versioned, expiring)", () => {
  it("renders the digest, signature metadata and freshness", async () => {
    const shell = buildShell();
    const publication: MobileEnrollmentPublication = await shell.enroll(T0);
    const html = enrollmentScreen(publication, {
      observedAt: publication.freshness.observedAt,
      receivedAt: publication.freshness.receivedAt,
      freshUntil: publication.freshness.freshUntil,
      freshnessState: publication.freshness.freshnessState,
    }).html;
    expect(html).toContain("hmac-sha256");
    expect(html).toContain(publication.snapshotDigest.slice(0, 16));
    expect(html).toContain("FRESH");
  });

  it("renders STALE when the publication expired", async () => {
    const shell = buildShell();
    const publication = await shell.enroll(T0);
    const html = enrollmentScreen(publication, {
      observedAt: publication.freshness.observedAt,
      receivedAt: publication.freshness.receivedAt,
      freshUntil: publication.freshness.freshUntil,
      freshnessState: "STALE",
    }).html;
    expect(html).toContain("STALE");
  });
});
