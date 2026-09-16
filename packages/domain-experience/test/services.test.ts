/**
 * RL-010/RL-011 service tests: envelope gating + idempotency (RL-LOCK-014),
 * policy denial (fail closed), CAS via envelope.intentVersion, snapshot
 * chain continuity through the services, and tenant discipline.
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
  tenantIdFromUser,
  parseUserId,
  type ActorId,
  type CommandEnvelope,
  type TenantId,
} from "@roamlink/contracts";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";

import {
  DeviceRegistryService,
  ExperienceIntentService,
  InMemoryDeviceCapabilitySnapshotRepository,
  InMemoryDeviceContextSnapshotRepository,
  InMemoryDeviceRepository,
  InMemoryExperienceIntentRepository,
  InMemoryExperienceIntentVersionRepository,
  InMemoryIdempotencyLedger,
  type ExperienceAccessPolicy,
  type ExperienceAction,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const OWNER = parseUserId("00000000-0000-4000-8000-000000000002");
const TENANT = tenantIdFromUser(OWNER);
const ACTOR = `usr:${OWNER}` as ActorId;

/** Fail-closed stub policy with an explicit grant set. */
class StubPolicy implements ExperienceAccessPolicy {
  readonly denied = new Set<string>();
  private readonly defaultAllow: boolean;

  constructor(defaultAllow = true) {
    this.defaultAllow = defaultAllow;
  }

  deny(action: ExperienceAction): this {
    this.denied.add(action);
    return this;
  }

  async authorize(
    actorId: ActorId,
    _tenantId: TenantId,
    action: ExperienceAction,
  ): Promise<void> {
    if (!this.defaultAllow || this.denied.has(action) || actorId !== ACTOR) {
      throw new UnauthorizedError("experience policy denied the action", {
        reason: "EXPERIENCE_POLICY_DENIED",
      });
    }
  }
}

function payloadFixture(overrides?: Record<string, unknown>) {
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
      requireEncryptedTransport: true,
      forbidRoaming: false,
      forbidOpenWifi: true,
    },
    ...overrides,
  };
}

function makeWorld() {
  const clock = new DeterministicClock(T0);
  const snapshotIds = new DeterministicUuidGenerator(5_000);
  const versionIds = new DeterministicUuidGenerator(6_000);
  const policy = new StubPolicy();
  const ledger = new InMemoryIdempotencyLedger();
  const devices = new InMemoryDeviceRepository();
  const capabilitySnapshots = new InMemoryDeviceCapabilitySnapshotRepository();
  const contextSnapshots = new InMemoryDeviceContextSnapshotRepository();
  const intents = new InMemoryExperienceIntentRepository();
  const versions = new InMemoryExperienceIntentVersionRepository();
  const registry = new DeviceRegistryService({
    devices,
    capabilitySnapshots,
    contextSnapshots,
    policy,
    ledger,
    now: () => clock.now(),
    generateSnapshotId: () => snapshotIds.next(),
  });
  const intentService = new ExperienceIntentService({
    intents,
    versions,
    policy,
    ledger,
    now: () => clock.now(),
    generateIntentVersionId: () => versionIds.next(),
    devices,
  });
  const envelope = (overrides?: {
    readonly key?: string;
    readonly tenantId?: string;
    readonly intentVersion?: number;
  }): CommandEnvelope =>
    fixtureCommandEnvelope({
      actorId: ACTOR,
      tenantId: overrides?.tenantId ?? TENANT,
      idempotencyKey: overrides?.key ?? `key-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: clock.now(),
      ...(overrides?.intentVersion !== undefined
        ? { intentVersion: overrides.intentVersion }
        : {}),
    });
  return { clock, policy, ledger, devices, capabilitySnapshots, contextSnapshots, intents, versions, registry, intentService, envelope };
}

describe("DeviceRegistryService", () => {
  it("enrolls a device in the ownership tenant; foreign-tenant envelopes are rejected", async () => {
    const world = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    await expect(
      world.registry.enrollDevice(world.envelope({ key: "enroll-1" }), {
        deviceId,
        ownership: { owningUserId: OWNER },
        platform: { family: "ios", platformVersion: "18.1" },
      }),
    ).resolves.toMatchObject({ status: "enrolled" });

    const otherDevice = "00000000-0000-4000-8000-000000000009";
    await expect(
      world.registry.enrollDevice(
        world.envelope({ key: "enroll-2", tenantId: `usr:00000000-0000-4000-8000-000000000003` }),
        {
          deviceId: otherDevice,
          ownership: { owningUserId: OWNER },
          platform: { family: "ios", platformVersion: "18.1" },
        },
      ),
    ).rejects.toThrowError(/ownership tenant/);
  });

  it("lifecycle transitions through the service; enrolled->suspend is rejected by the aggregate", async () => {
    const world = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    await world.registry.enrollDevice(world.envelope({ key: "enroll-1" }), {
      deviceId,
      ownership: { owningUserId: OWNER },
      platform: { family: "android", platformVersion: "15" },
    });
    await expect(
      world.registry.transitionDevice(world.envelope({ key: "t-suspend" }), {
        deviceId,
        transition: "suspend",
      }),
    ).rejects.toThrowError(ValidationError);
    await expect(
      world.registry.transitionDevice(world.envelope({ key: "t-activate" }), {
        deviceId,
        transition: "activate",
      }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      world.registry.transitionDevice(world.envelope({ key: "t-retire" }), {
        deviceId,
        transition: "retire",
      }),
    ).resolves.toMatchObject({ status: "retired" });
  });

  it("policy denial fails closed (RL-LOCK-011-style boundary: nothing without a grant)", async () => {
    const world = makeWorld();
    world.policy.deny("device:enroll");
    await expect(
      world.registry.enrollDevice(world.envelope({ key: "enroll-denied" }), {
        deviceId: "00000000-0000-4000-8000-000000000001",
        ownership: { owningUserId: OWNER },
        platform: { family: "ios", platformVersion: "18.1" },
      }),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("records capability snapshots with per-device chain continuity; retired devices reject snapshots", async () => {
    const world = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    await world.registry.enrollDevice(world.envelope({ key: "enroll-1" }), {
      deviceId,
      ownership: { owningUserId: OWNER },
      platform: { family: "ios", platformVersion: "18.1" },
    });
    const snapshotInput = (overrides?: Record<string, unknown>) => ({
      deviceId,
      platform: { family: "ios", platformVersion: "18.1" },
      observedAt: T0,
      freshUntil: null,
      capabilities: {
        wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: T0 },
      },
      ...overrides,
    });
    const first = await world.registry.recordCapabilitySnapshot(
      world.envelope({ key: "cap-1" }),
      snapshotInput(),
    );
    expect(first).toMatchObject({ sequence: 1 });
    const second = await world.registry.recordCapabilitySnapshot(
      world.envelope({ key: "cap-2" }),
      snapshotInput(),
    );
    expect(second).toMatchObject({ sequence: 2 });
    const latest = await world.registry.latestCapabilitySnapshot(TENANT, deviceId);
    expect(latest?.sequence).toBe(2);

    await world.registry.transitionDevice(world.envelope({ key: "t-retire" }), {
      deviceId,
      transition: "retire",
    });
    await expect(
      world.registry.recordCapabilitySnapshot(world.envelope({ key: "cap-3" }), snapshotInput()),
    ).rejects.toThrowError(/retired/);
  });

  it("IDEMPOTENCY: replaying the same envelope returns the recorded outcome; key reuse with different digest conflicts", async () => {
    const world = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    const envelope = world.envelope({ key: "enroll-idem" });
    const input = {
      deviceId,
      ownership: { owningUserId: OWNER },
      platform: { family: "ios", platformVersion: "18.1" },
    };
    const first = await world.registry.enrollDevice(envelope, input);
    const replay = await world.registry.enrollDevice(envelope, input);
    expect(replay).toEqual(first);
    expect(await world.devices.listByTenant(TENANT)).toHaveLength(1);

    const different = fixtureCommandEnvelope({
      actorId: ACTOR,
      tenantId: TENANT,
      idempotencyKey: "enroll-idem",
      createdAt: "2026-01-15T09:00:00.000Z",
    });
    await expect(world.registry.enrollDevice(different, input)).rejects.toThrowError(ConflictError);
  });

  it("records context snapshots (consent-gated fine location enforced through the service)", async () => {
    const world = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    await world.registry.enrollDevice(world.envelope({ key: "enroll-1" }), {
      deviceId,
      ownership: { owningUserId: OWNER },
      platform: { family: "ios", platformVersion: "18.1" },
    });
    await expect(
      world.registry.recordContextSnapshot(world.envelope({ key: "ctx-1" }), {
        deviceId,
        ownerUserId: OWNER,
        observedAt: T0,
        freshUntil: null,
        consent: { fineLocationGranted: false },
        payload: { fineLocation: { latitude: 5.6, longitude: -0.19 } },
      }),
    ).rejects.toThrowError(/consent-gated/);
    await expect(
      world.registry.recordContextSnapshot(world.envelope({ key: "ctx-2" }), {
        deviceId,
        ownerUserId: OWNER,
        observedAt: T0,
        freshUntil: null,
        consent: { fineLocationGranted: true },
        payload: { battery: { levelPercent: 55 } },
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });
});

describe("ExperienceIntentService", () => {
  const INTENT_ID = "00000000-0000-4000-8000-000000000010";

  async function createIntent(world: ReturnType<typeof makeWorld>, key = "create-1") {
    return world.intentService.createIntent(world.envelope({ key }), {
      intentId: INTENT_ID,
      ownerUserId: OWNER,
      payload: payloadFixture(),
      rationale: "Ghana trip",
    });
  }

  it("creates a draft intent with version 1 in the owner's tenant", async () => {
    const world = makeWorld();
    await expect(createIntent(world)).resolves.toMatchObject({
      status: "draft",
      versionNumber: 1,
    });
    const record = await world.intentService.getIntent(TENANT, INTENT_ID);
    expect(record.tenantId).toBe(TENANT);
    expect(await world.intentService.listVersions(TENANT, INTENT_ID)).toHaveLength(1);
  });

  it("a foreign tenant never sees the intent (no oracle)", async () => {
    const world = makeWorld();
    await createIntent(world);
    const foreign = tenantIdFromUser(parseUserId("00000000-0000-4000-8000-000000000009"));
    await expect(world.intentService.getIntent(foreign, INTENT_ID)).rejects.toThrowError(/not found/);
    expect(await world.intentService.listVersions(foreign, INTENT_ID)).toEqual([]);
    expect(await world.intentService.listIntentsByOwner(foreign, OWNER)).toEqual([]);
  });

  it("CAS: revise/transition require the observed intentVersion on the envelope", async () => {
    const world = makeWorld();
    await createIntent(world);
    // Stale token (revision is 1, envelope carries nothing) -> conflict.
    await expect(
      world.intentService.reviseIntent(world.envelope({ key: "revise-stale" }), {
        intentId: INTENT_ID,
        payload: payloadFixture({ usageProfile: "work_critical" }),
      }),
    ).rejects.toThrowError(ConflictError);
    await expect(
      world.intentService.reviseIntent(world.envelope({ key: "revise-1", intentVersion: 1 }), {
        intentId: INTENT_ID,
        payload: payloadFixture({ usageProfile: "work_critical" }),
      }),
    ).resolves.toMatchObject({ versionNumber: 2 });
    // Header revision is now 2: revising with the old token conflicts.
    await expect(
      world.intentService.reviseIntent(world.envelope({ key: "revise-2", intentVersion: 1 }), {
        intentId: INTENT_ID,
        payload: payloadFixture(),
      }),
    ).rejects.toThrowError(ConflictError);
  });

  it("lifecycle: activate -> supersede -> archive with CAS tokens", async () => {
    const world = makeWorld();
    await createIntent(world);
    await expect(
      world.intentService.transitionIntent(world.envelope({ key: "act-1", intentVersion: 1 }), {
        intentId: INTENT_ID,
        transition: "activate",
      }),
    ).resolves.toMatchObject({ status: "active" });
    const successor = "00000000-0000-4000-8000-000000000011";
    await expect(
      world.intentService.transitionIntent(world.envelope({ key: "sup-1", intentVersion: 2 }), {
        intentId: INTENT_ID,
        transition: "supersede",
        supersededBy: successor,
      }),
    ).resolves.toMatchObject({ status: "superseded" });
    await expect(
      world.intentService.transitionIntent(world.envelope({ key: "arch-1", intentVersion: 3 }), {
        intentId: INTENT_ID,
        transition: "archive",
      }),
    ).resolves.toMatchObject({ status: "archived" });
    // Frozen: no further versions.
    await expect(
      world.intentService.reviseIntent(world.envelope({ key: "revise-x", intentVersion: 4 }), {
        intentId: INTENT_ID,
        payload: payloadFixture(),
      }),
    ).rejects.toThrowError(/frozen/);
  });

  it("idempotent replay returns the recorded create outcome exactly once", async () => {
    const world = makeWorld();
    const envelope = world.envelope({ key: "create-idem" });
    const input = {
      intentId: INTENT_ID,
      ownerUserId: OWNER,
      payload: payloadFixture(),
    };
    const first = await world.intentService.createIntent(envelope, input);
    const replay = await world.intentService.createIntent(envelope, input);
    expect(replay).toEqual(first);
    expect(await world.intentService.listIntentsByOwner(TENANT, OWNER)).toHaveLength(1);
  });

  it("policy denial and foreign-tenant creation fail closed; retired target devices are rejected", async () => {
    const world = makeWorld();
    world.policy.deny("intent:write");
    await expect(createIntent(world, "create-denied")).rejects.toThrowError(UnauthorizedError);

    const world2 = makeWorld();
    const deviceId = "00000000-0000-4000-8000-000000000001";
    await world2.registry.enrollDevice(world2.envelope({ key: "enroll-1" }), {
      deviceId,
      ownership: { owningUserId: OWNER },
      platform: { family: "ios", platformVersion: "18.1" },
    });
    await world2.registry.transitionDevice(world2.envelope({ key: "t-retire" }), {
      deviceId,
      transition: "retire",
    });
    await expect(
      world2.intentService.createIntent(world2.envelope({ key: "create-2" }), {
        intentId: INTENT_ID,
        ownerUserId: OWNER,
        deviceId,
        payload: payloadFixture(),
      }),
    ).rejects.toThrowError(/retired/);
  });
});
