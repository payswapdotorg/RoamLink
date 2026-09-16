/**
 * RL-010/RL-011 in-memory adapter tests: CAS discipline, cross-tenant
 * fail-closed proofs (RL-LOCK-018) and chain-continuity enforcement.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, parseRevision, parseUtcInstant, tenantIdFromUser, parseUserId } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import {
  DeviceCapabilitySnapshot,
  DeviceContextSnapshot,
  Device,
  ExperienceIntent,
  ExperienceIntentVersion,
  InMemoryDeviceCapabilitySnapshotRepository,
  InMemoryDeviceContextSnapshotRepository,
  InMemoryDeviceRepository,
  InMemoryExperienceIntentRepository,
  InMemoryExperienceIntentVersionRepository,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const at = (iso: string) => parseUtcInstant(iso);
const OWNER = parseUserId(deterministicUuidFromSeed(2));
const TENANT = tenantIdFromUser(OWNER);
const FOREIGN_TENANT = tenantIdFromUser(parseUserId(deterministicUuidFromSeed(9)));

function deviceRecord(deviceId: string, revision = 1) {
  return new Device({
    deviceId,
    owningUserId: OWNER,
    platform: { family: "ios", platformVersion: "18.1" },
    status: "enrolled",
    enrolledAt: at(T0),
    updatedAt: at(T0),
    revision,
  }).toRecord();
}

function capabilitySnapshot(snapshotId: string, sequence: number, deviceId: string) {
  return {
    ...new DeviceCapabilitySnapshot({
      snapshotId,
      contractVersion: "0.1",
      sequence,
      deviceId,
      platform: { family: "ios", platformVersion: "18.1" },
      observedAt: T0,
      freshUntil: null,
      capabilities: {},
    }).toPlain(),
    tenantId: TENANT,
  };
}

describe("device repository: CAS + tenant boundary", () => {
  it("PROOF: stale and skipped revisions conflict; correct successor saves", async () => {
    const devices = new InMemoryDeviceRepository();
    const deviceId = deterministicUuidFromSeed(1);
    await devices.save(deviceRecord(deviceId));
    await expect(devices.save(deviceRecord(deviceId))).rejects.toThrowError(ConflictError);
    await expect(
      devices.save(deviceRecord(deviceId, parseRevision(3))),
    ).rejects.toThrowError(ConflictError);
    await devices.save(deviceRecord(deviceId, parseRevision(2)));
  });

  it("PROOF: reads through a foreign tenant fail closed (no oracle)", async () => {
    const devices = new InMemoryDeviceRepository();
    const deviceId = deterministicUuidFromSeed(1);
    await devices.save(deviceRecord(deviceId));
    expect(await devices.findById(FOREIGN_TENANT, deviceId as never)).toBeUndefined();
    expect(await devices.listByTenant(FOREIGN_TENANT)).toEqual([]);
    expect(await devices.findById(TENANT, deviceId as never)).toBeDefined();
    expect(await devices.listByTenant(TENANT)).toHaveLength(1);
  });
});

describe("capability snapshot repository: chain continuity", () => {
  it("sequences must be latest + 1 per device; replays and skips conflict", async () => {
    const snapshots = new InMemoryDeviceCapabilitySnapshotRepository();
    const deviceId = deterministicUuidFromSeed(1);
    await snapshots.save(capabilitySnapshot(deterministicUuidFromSeed(10), 1, deviceId));
    await expect(
      snapshots.save(capabilitySnapshot(deterministicUuidFromSeed(11), 3, deviceId)),
    ).rejects.toThrowError(/chain continuity/);
    await snapshots.save(capabilitySnapshot(deterministicUuidFromSeed(12), 2, deviceId));
    // Re-inserting an existing id: immutable conflict.
    await expect(
      snapshots.save(capabilitySnapshot(deterministicUuidFromSeed(12), 2, deviceId)),
    ).rejects.toThrowError(ConflictError);
    const latest = await snapshots.latestForDevice(TENANT, deviceId as never);
    expect(latest?.sequence).toBe(2);
    expect(await snapshots.listForDevice(TENANT, deviceId as never)).toHaveLength(2);
  });

  it("PROOF: chains are per-tenant; foreign tenants see nothing", async () => {
    const snapshots = new InMemoryDeviceCapabilitySnapshotRepository();
    const deviceId = deterministicUuidFromSeed(1);
    await snapshots.save(capabilitySnapshot(deterministicUuidFromSeed(10), 1, deviceId));
    expect(await snapshots.listForDevice(FOREIGN_TENANT, deviceId as never)).toEqual([]);
    expect(await snapshots.latestForDevice(FOREIGN_TENANT, deviceId as never)).toBeUndefined();
    expect(
      await snapshots.findById(FOREIGN_TENANT, deterministicUuidFromSeed(10) as never),
    ).toBeUndefined();
    // A foreign-tenant chain for the same device id starts fresh at 1.
    const foreignSnapshot = { ...capabilitySnapshot(deterministicUuidFromSeed(13), 1, deviceId), tenantId: FOREIGN_TENANT };
    await snapshots.save(foreignSnapshot);
  });
});

describe("context snapshot repository: same discipline", () => {
  it("enforces chain continuity and immutability", async () => {
    const snapshots = new InMemoryDeviceContextSnapshotRepository();
    const deviceId = deterministicUuidFromSeed(1);
    const record = new DeviceContextSnapshot({
      snapshotId: deterministicUuidFromSeed(20),
      contractVersion: "0.1",
      sequence: 1,
      deviceId,
      ownerUserId: OWNER,
      observedAt: T0,
      freshUntil: null,
      consent: { fineLocationGranted: false },
      payload: {},
    }).toPlain();
    await snapshots.save(record);
    await expect(snapshots.save(record)).rejects.toThrowError(ConflictError);
    const skip = { ...record, snapshotId: deterministicUuidFromSeed(21) as never, sequence: parseRevision(3) };
    await expect(snapshots.save(skip)).rejects.toThrowError(/chain continuity/);
    expect((await snapshots.latestForDevice(TENANT, deviceId as never))?.sequence).toBe(1);
  });
});

describe("intent repositories: CAS + insert-only versions", () => {
  it("intent headers CAS; versions are insert-only with chain continuity", async () => {
    const intents = new InMemoryExperienceIntentRepository();
    const versions = new InMemoryExperienceIntentVersionRepository();
    const intentId = deterministicUuidFromSeed(30);
    const v1 = deterministicUuidFromSeed(31);
    const v2 = deterministicUuidFromSeed(32);

    const header = new ExperienceIntent({
      intentId,
      ownerUserId: OWNER,
      status: "draft",
      currentVersionId: v1,
      currentVersionNumber: 1,
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    }).toRecord();
    await intents.save(header);
    await expect(intents.save(header)).rejects.toThrowError(ConflictError);

    const versionRecord = (id: string, n: number, supersedes?: string) =>
      new ExperienceIntentVersion({
        tenantId: TENANT,
        intentVersionId: id,
        intentId,
        versionNumber: n,
        payload: {
          travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
          usageProfile: "general",
          preferences: {
            reliability: "standard",
            latency: "insensitive",
            costSensitivity: "low",
            privacySensitivity: "low",
            preferredAccessClasses: [],
          },
          hardConstraints: {
            requireEncryptedTransport: false,
            forbidRoaming: false,
            forbidOpenWifi: false,
          },
        },
        ...(supersedes !== undefined ? { supersedes } : {}),
        createdAt: at(T0),
      }).toRecord();

    await versions.save(versionRecord(v1, 1));
    await expect(versions.save(versionRecord(v1, 1))).rejects.toThrowError(ConflictError);
    await expect(versions.save(versionRecord(v2, 3, v1))).rejects.toThrowError(/chain continuity/);
    await versions.save(versionRecord(v2, 2, v1));
    expect(await versions.listForIntent(TENANT, intentId as never)).toHaveLength(2);

    // Tenant boundary: foreign tenant sees neither headers nor versions.
    expect(await intents.findById(FOREIGN_TENANT, intentId as never)).toBeUndefined();
    expect(await intents.listByOwner(FOREIGN_TENANT, OWNER)).toEqual([]);
    expect(await versions.listForIntent(FOREIGN_TENANT, intentId as never)).toEqual([]);
    expect(await versions.findById(FOREIGN_TENANT, v1 as never)).toBeUndefined();
  });
});
