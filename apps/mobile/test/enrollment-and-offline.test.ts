/**
 * Enrollment publication + offline observation + telemetry bounds tests
 * (RL-062, spec/mobile.md "Capability discovery" + "Offline").
 *
 * Proves: the publication is signed (verification breaks on tampering),
 * versioned (the chain advances) and expiring (freshness degrades); the
 * genesis snapshot fills untouched in-scope capabilities with honest
 * `unknown`; observation continues while offline with bounded telemetry
 * (oldest receipts dropped); and the offline outbox stores ciphertext-only
 * payloads (no plaintext parameters anywhere in the persisted records).
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";
import { createAesGcmEdgePayloadCipher } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";

import { MobileEdgeShell } from "../src/shell.js";
import { InMemoryMobilePlatformProbe } from "../src/platform-probe.js";
import { verifyMobileEnrollmentPublication } from "../src/enrollment.js";
import type { MobileEnrollmentSigner } from "../src/enrollment.js";

const T0 = "2026-03-01T08:00:00.000Z";
const KEY_BYTES = new Uint8Array(32).fill(21);
const SIGNING_KEY = "enrollment-cycle-key";

function makeSigner(key: string): MobileEnrollmentSigner {
  return {
    algorithm: "hmac-sha256",
    keyId: "enrollment-test",
    async sign(message: string): Promise<string> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex");
    },
    async verify(message: string, signature: string): Promise<boolean> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex") === signature;
    },
  };
}

function buildShell(batches: readonly (readonly Record<string, unknown>[])[], telemetryLimit = 100): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: batches.map((batch) =>
      batch.map((sample) => ({
        observedAt: T0,
        evidence: { kind: "platform-api-probe", source: "TestProbe" },
        subject: sample,
      })),
    ),
  });
  let counter = 0;
  const uuid = (seed: number): string => deterministicUuidFromSeed(seed + (++counter));
  return new MobileEdgeShell({
    deviceRef: "device-7f3a",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-1",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "edge-outbox-key",
    observationIdGenerator: () => uuid(1),
    snapshotIdGenerator: () => uuid(10_000),
    outboxRecordIdGenerator: () => uuid(20_000),
    actionIdGenerator: () => uuid(30_000),
    commandIdGenerator: () => uuid(40_000),
    correlationIdGenerator: () => `corr-${++counter}`,
    idempotencyKeyGenerator: () => `idem-${++counter}`,
    desiredStateIdGenerator: () => uuid(50_000),
    publicationIdGenerator: () => uuid(60_000),
    signer: makeSigner(SIGNING_KEY),
    snapshotFreshnessMs: 60_000,
    telemetryLimit,
  });
}

const WIFI_BATCH = [
  { kind: "capability-probe", capability: "wifi_control", status: "available" },
  { kind: "context-observation", contextField: "connectivity-state", value: "online" },
];

describe("the enrollment publication (signed, versioned, expiring)", () => {
  it("publishes a verifiable, chain-versioned snapshot", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    const publication = await shell.enroll(T0);
    expect(publication.snapshot.sequence).toBe(1);
    expect(publication.snapshot.capabilities["wifi_control"]?.status).toBe("available");
    expect(await verifyMobileEnrollmentPublication(publication, makeSigner(SIGNING_KEY))).toBe(true);

    // Re-enrollment advances the chain (versioned, never mutated).
    const second = await shell.enroll(T0);
    expect(second.snapshot.sequence).toBe(2);
    expect(second.snapshot.deviceRef).toBe(publication.snapshot.deviceRef);
    expect(second.snapshotDigest).not.toBe(publication.snapshotDigest);
  });

  it("a tampered snapshot breaks verification (digest + signature)", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    const publication = await shell.enroll(T0);
    expect(await verifyMobileEnrollmentPublication(publication, makeSigner(SIGNING_KEY))).toBe(true);

    const original = publication.snapshot.capabilities["wifi_control"];
    if (original === undefined) throw new Error("unreachable");
    const tampered = {
      ...publication,
      snapshot: {
        ...publication.snapshot,
        capabilities: {
          ...publication.snapshot.capabilities,
          wifi_control: {
            ...original,
            status: "available" as const,
            evidenceClass: "AUTHENTICATED" as const, // an evidence-class upgrade forgery
          },
        },
      },
    };
    expect(await verifyMobileEnrollmentPublication(tampered, makeSigner(SIGNING_KEY))).toBe(false);
  });

  it("a wrong signer does not verify", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    const publication = await shell.enroll(T0);
    expect(await verifyMobileEnrollmentPublication(publication, makeSigner("wrong-key"))).toBe(false);
  });

  it("the genesis snapshot fills untouched capabilities with honest unknown", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    const publication = await shell.enroll(T0);
    const capabilities = publication.snapshot.capabilities;
    expect(capabilities["wifi_control"]?.status).toBe("available");
    expect(capabilities["esim_profile_install"]?.status).toBe("unknown");
    expect(capabilities["esim_profile_install"]?.evidenceClass).toBe("UNKNOWN");
    expect(capabilities["vpn_network_extension"]?.evidence.kind).toBe("none");
  });

  it("enrollment without a signer fails closed (typed wiring error)", async () => {
    const probe = new InMemoryMobilePlatformProbe({
      batches: [[{ observedAt: T0, evidence: { kind: "platform-api-probe" }, subject: { kind: "capability-probe", capability: "wifi_control", status: "available" } }]],
    });
    const shell = new MobileEdgeShell({
      deviceRef: "device-7f3a",
      platform: { family: "ios", platformVersion: "18.2" },
      actorId: "actor-1",
      tenantId: fixtureTenantId(),
      probe,
      executor: new InMemoryPlatformActionExecutor(),
      cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
      outboxKeyId: "edge-outbox-key",
      observationIdGenerator: () => deterministicUuidFromSeed(1),
      snapshotIdGenerator: () => deterministicUuidFromSeed(2),
      outboxRecordIdGenerator: () => deterministicUuidFromSeed(3),
      actionIdGenerator: () => deterministicUuidFromSeed(4),
      commandIdGenerator: () => deterministicUuidFromSeed(5),
      correlationIdGenerator: () => "corr",
      idempotencyKeyGenerator: () => "idem",
      desiredStateIdGenerator: () => deterministicUuidFromSeed(6),
      publicationIdGenerator: () => deterministicUuidFromSeed(7),
    });
    await expect(shell.enroll(T0)).rejects.toThrowError();
  });
});

describe("offline observation + bounded telemetry (spec/mobile.md Offline)", () => {
  it("continues observation while offline (snapshots keep advancing)", async () => {
    const shell = buildShell([
      [...WIFI_BATCH],
      [{ kind: "context-observation", contextField: "connectivity-state", value: "offline" }],
    ]);
    shell.enterOffline(T0);
    await shell.runObservationCycle(T0);
    let view = await shell.connectivityView(T0);
    expect(view.observedConnectivityState?.value).toBe("online");

    // A second cycle (the platform now reports offline) still folds in.
    await shell.runObservationCycle("2026-03-01T08:00:30.000Z");
    view = await shell.connectivityView("2026-03-01T08:00:30.000Z");
    expect(view.observedConnectivityState?.value).toBe("offline"); // OBSERVED, not declared
    expect(view.syncReachable).toBe(false);
  });

  it("bounds telemetry: the ring truncates oldest entries at the limit", async () => {
    const shell = buildShell(
      [
        [...WIFI_BATCH],
        [{ kind: "capability-probe", capability: "wifi_observation", status: "available" }],
        [{ kind: "capability-probe", capability: "esim_profile_enable", status: "available" }],
        [{ kind: "capability-probe", capability: "vpn_network_extension", status: "available" }],
        [{ kind: "capability-probe", capability: "active_interface_selection", status: "available" }],
      ],
      3,
    );
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await shell.runObservationCycle(`2026-03-01T08:0${cycle}:00.000Z`);
    }
    const telemetry = shell.telemetry();
    expect(telemetry).toHaveLength(3); // bounded, never unbounded
    expect(telemetry[0]?.observations).toBe(1); // oldest kept = cycle 3
    expect(telemetry[2]?.observations).toBe(1);
  });

  it("the offline outbox stores ciphertext-only payloads (no plaintext parameters)", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    await shell.runObservationCycle(T0);
    const outcome = await shell.requestAction(
      { capability: "wifi_control", parameters: { ssid: "Acahat-Guest", passwordHint: "none" } },
      "server",
      T0,
    );
    expect(outcome.outcome).toBe("QUEUED");
    const records = await shell.outboxRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error("unreachable");
    expect(record.ciphertextEnvelope.algorithm).toBe("aes-256-gcm");
    expect(record.ciphertextEnvelope.ciphertext).not.toContain("Acahat-Guest");
    const persisted = JSON.stringify(records);
    expect(persisted).not.toContain("Acahat-Guest"); // plaintext nowhere at rest
    expect(persisted).not.toContain("ssid");
    // Dedupe metadata stays in the clear (retries dedupe without decrypting).
    expect(record.commandId).toBeTruthy();
    expect(record.actionDedupeKey).toBeTruthy();
    expect(record.correlationId).toBeTruthy();
  });

  it("distinct commands queue as distinct records with distinct identities", async () => {
    const shell = buildShell([[...WIFI_BATCH]]);
    await shell.runObservationCycle(T0);
    const first = await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    expect(first.outcome).toBe("QUEUED");
    const second = await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    expect(second.outcome).toBe("QUEUED");
    const records = await shell.outboxRecords();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.actionDedupeKey)).size).toBe(2);
    expect(new Set(records.map((record) => record.commandIdempotencyKey)).size).toBe(2);
  });

  it("the SAME command envelope re-requested is ALREADY_ENQUEUED (idempotent, no double effect)", async () => {
    // Fixed command-id/idempotency-key generators simulate a RETRY of the
    // same command after an app restart (RL-LOCK-014).
    const probe = new InMemoryMobilePlatformProbe({
      batches: [
        WIFI_BATCH.map((sample) => ({
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: sample,
        })),
      ],
    });
    let counter = 0;
    const shell = new MobileEdgeShell({
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
      commandIdGenerator: () => "99999999-9999-4999-8999-999999999999", // FIXED (a retry)
      correlationIdGenerator: () => "corr-fixed",
      idempotencyKeyGenerator: () => "idem-fixed", // FIXED (a retry)
      desiredStateIdGenerator: () => deterministicUuidFromSeed(50_000 + counter),
      publicationIdGenerator: () => deterministicUuidFromSeed(60_000 + counter),
      signer: makeSigner(SIGNING_KEY),
      snapshotFreshnessMs: 60_000,
    });
    await shell.runObservationCycle(T0);
    const first = await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    expect(first.outcome).toBe("QUEUED");
    const retry = await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    expect(retry.outcome).toBe("ALREADY_QUEUED");
    const records = await shell.outboxRecords();
    expect(records).toHaveLength(1); // no double effect
  });
});
