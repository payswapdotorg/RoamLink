/**
 * PA-019: the business read models composed on the real runtime (closes
 * F-016-2) — the composition battery.
 *
 * Every composed read model is asserted end to end over the REAL service
 * composed over the house in-memory persistence (the SQL adapter is
 * exercised by the pglite integration test and the hosted e2e journeys):
 *
 *  - WRITE-THEN-READ round trips per model: a mutation is durably accepted
 *    through the real /v1 boundary, the read honestly serves the
 *    pre-execution state (accepted is NOT executed — the projection stays
 *    empty), the worker plane's executed-stage write is applied through the
 *    SAME ledger discipline the command-ledger writer uses, and the read
 *    then serves the projected REAL state;
 *  - the CONTRACT DIFF: every composed response body parses under the
 *    frozen app-kit fail-closed parser of its resource (the deterministic
 *    fake API is the contract reference — unknown fields, wrong
 *    vocabularies and missing facts all reject);
 *  - the kept-501 routes answer the typed READ_MODEL_NOT_COMPOSED with
 *    their NAMED reasons (honest skips, never invented data);
 *  - the read surface contract: every READ_MODEL_ROUTES pattern is answered
 *    (composed or kept-501 — never the plain 404);
 *  - tenant scoping fails closed (forged actor headers, foreign tenants,
 *    unknown ids).
 */
import { describe, expect, it } from "vitest";
import { tenantIdFromUser, type UtcInstant } from "@roamlink/contracts";
import {
  parseConnectivityOverviewResource,
  parseDeviceList,
  parseDeviceResource,
  parseExperienceIntentList,
  parseExperienceIntentResource,
  parseOrganizationList,
  parseReconciliationJobList,
  parseSupportCaseList,
  parseUserResource,
} from "@roamlink/app-kit";

import {
  PASSWORD_A,
  createTestWorld,
  mutationHeaders,
  tenantOf,
  userIdFromSeed,
  type TestWorld,
} from "./helpers.js";
import { READ_MODEL_ROUTES } from "../src/api-service.js";
import { READ_MODELS_NOT_COMPOSED } from "../src/read-models.js";

/** A deterministic later instant (the worker plane's execution time). */
const T1: UtcInstant = "2026-01-15T09:00:00.000Z" as UtcInstant;
const T2: UtcInstant = "2026-01-15T09:30:00.000Z" as UtcInstant;
const T3: UtcInstant = "2026-01-15T10:00:00.000Z" as UtcInstant;

async function loginUser(world: TestWorld, seed: number): Promise<string> {
  const userId = userIdFromSeed(seed);
  const login = await world.service.handle({
    method: "POST",
    path: "/v1/auth/session",
    headers: mutationHeaders({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      key: `login-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    }),
    body: JSON.stringify({ email: `user-${seed}@example.com`, password: PASSWORD_A }),
  });
  return JSON.parse(login.body as string)["token"] as string;
}

interface Session {
  readonly token: string;
  readonly actorId: string;
  readonly tenantId: string;
}

async function sessionOf(world: TestWorld, seed: number): Promise<Session> {
  const userId = userIdFromSeed(seed);
  return {
    token: await loginUser(world, seed),
    actorId: `usr:${userId}`,
    tenantId: tenantOf(seed),
  };
}

/** Read headers for an authenticated business read. */
function readHeaders(session: Session): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    "x-roamlink-actor-id": session.actorId,
    "x-roamlink-tenant-id": session.tenantId,
  };
}

async function post(
  world: TestWorld,
  session: Session,
  path: string,
  key: string,
  body: unknown,
): Promise<{ readonly commandId: string; readonly status: number }> {
  const response = await world.service.handle({
    method: "POST",
    path,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...mutationHeaders({ actorId: session.actorId, tenantId: session.tenantId, key }),
    },
    body: JSON.stringify(body),
  });
  const parsed = JSON.parse(response.body ?? "{}") as Record<string, unknown>;
  return { commandId: String(parsed["commandId"] ?? ""), status: response.status };
}

async function get(world: TestWorld, session: Session, path: string): Promise<{ status: number; body: string }> {
  const response = await world.service.handle({
    method: "GET",
    path,
    headers: readHeaders(session),
  });
  return { status: response.status, body: response.body ?? "" };
}

/**
 * Applies the worker plane's executed-stage write through the SAME ledger
 * discipline the command-ledger writer uses (services/workers
 * command-ledger.ts: CAS on the stored version), recording the resource the
 * executor applied — the durable record of what execution created. This is
 * the battery's simulation of the worker plane, exactly like the workers'
 * own tests seed the ledger.
 */
async function markExecuted(
  world: TestWorld,
  commandId: string,
  at: UtcInstant,
  resource: { readonly type: string; readonly id: string; readonly version?: number } | null,
): Promise<void> {
  const unitOfWork = await world.persistence.begin();
  try {
    const stored = await world.persistence.records("api-commands").get(commandId);
    if (stored === null) throw new Error("command missing");
    const command = stored.value as Record<string, unknown>;
    if (command["executedAt"] !== null) {
      await unitOfWork.rollback();
      return;
    }
    await unitOfWork.records("api-commands").compareAndSwap(commandId, stored.version, {
      ...command,
      executedAt: at,
      resource,
    } as never);
    await unitOfWork.commit();
  } catch (error) {
    await unitOfWork.rollback();
    throw error;
  }
}

/** The device ids the simulated executor records (deterministic). */
const DEVICE_ID = "1a000000-0000-4000-8000-000000000001";
const INTENT_ID = "1b000000-0000-4000-8000-000000000002";
const PAYMENT_ID = "1c000000-0000-4000-8000-000000000003";
const ORDER_ID = "1d000000-0000-4000-8000-000000000004";
const CASE_ID = "1e000000-0000-4000-8000-000000000005";

describe("the composed device read model (write-then-read round trip)", () => {
  it("serves the honest pre-execution state, then the executed projection, under the contract parser", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const accepted = await post(world, session, "/v1/devices", "enroll-device-1", {
      name: "RoamLink One",
      platform: "ios",
    });
    expect(accepted.status).toBe(202);

    // Accepted is NOT executed: the device projection stays empty (nothing
    // was invented by the read).
    const before = await get(world, session, "/v1/devices");
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body)).toEqual([]);

    // The worker plane executes the enrollment and records the created device.
    await markExecuted(world, accepted.commandId, T1, { type: "device", id: DEVICE_ID });

    const list = await get(world, session, "/v1/devices");
    expect(list.status).toBe(200);
    const devices = parseDeviceList(JSON.parse(list.body));
    expect(devices).toHaveLength(1);
    const device = devices[0];
    if (device === undefined) throw new Error("device missing");
    expect(device.deviceId).toBe(DEVICE_ID);
    expect(device.name).toBe("RoamLink One");
    expect(device.platform).toBe("ios");
    expect(device.status).toBe("enrolled");
    expect(device.ownership).toEqual({ userId: userIdFromSeed(1) });
    expect(device.revision).toBe(1);
    expect(device.createdAt).toBe(T1);
    expect(device.updatedAt).toBe(T1);
    expect(device.capabilityFreshness).toBeNull();
    expect(device.contextFreshness).toBeNull();

    // The single-resource read serves the same projection (contract parser).
    const single = await get(world, session, `/v1/devices/${DEVICE_ID}`);
    expect(single.status).toBe(200);
    expect(parseDeviceResource(JSON.parse(single.body))).toEqual(device);

    // An unknown device id is the honest 404 (no existence oracle).
    const unknown = await get(world, session, "/v1/devices/09090909-0000-4000-8000-000000000009");
    expect(unknown.status).toBe(404);
  });

  it("advances the projection through executed update and retire commands (revision + status)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const enroll = await post(world, session, "/v1/devices", "enroll-device-2", {
      name: "Travel Router",
      platform: "linux",
    });
    await markExecuted(world, enroll.commandId, T1, { type: "device", id: DEVICE_ID });
    const update = await post(world, session, `/v1/devices/${DEVICE_ID}/update`, "update-device-2", {
      name: "Travel Router (renamed)",
    });
    expect(update.status).toBe(202);
    // Accepted-only update: the projection is unchanged.
    expect(parseDeviceList(JSON.parse((await get(world, session, "/v1/devices")).body))[0]?.name)
      .toBe("Travel Router");
    await markExecuted(world, update.commandId, T2, { type: "device", id: DEVICE_ID });

    const afterUpdate = parseDeviceList(JSON.parse((await get(world, session, "/v1/devices")).body));
    expect(afterUpdate[0]?.name).toBe("Travel Router (renamed)");
    expect(afterUpdate[0]?.platform).toBe("linux");
    expect(afterUpdate[0]?.revision).toBe(2);
    expect(afterUpdate[0]?.updatedAt).toBe(T2);

    const retire = await post(world, session, `/v1/devices/${DEVICE_ID}/retire`, "retire-device-2", {});
    await markExecuted(world, retire.commandId, T3, { type: "device", id: DEVICE_ID });
    const afterRetire = parseDeviceList(JSON.parse((await get(world, session, "/v1/devices")).body));
    expect(afterRetire[0]?.status).toBe("retired");
    expect(afterRetire[0]?.revision).toBe(3);
    expect(afterRetire[0]?.updatedAt).toBe(T3);
  });
});

describe("the composed experience-intent read model (+versions)", () => {
  it("projects the create/activate/supersede lifecycle from the executed commands", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const create = await post(world, session, "/v1/experience-intents", "intent-create-1", {
      deviceId: "0f0f0f0f-0000-4000-8000-000000000001",
      rationale: "Stay connected while traveling",
      accessClasses: ["any_internet"],
    });
    expect(create.status).toBe(202);
    // Accepted is NOT executed: no goal exists yet.
    expect(JSON.parse((await get(world, session, "/v1/experience-intents")).body)).toEqual([]);

    await markExecuted(world, create.commandId, T1, { type: "experience_intent", id: INTENT_ID });
    const created = parseExperienceIntentList(
      JSON.parse((await get(world, session, "/v1/experience-intents")).body),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.intentId).toBe(INTENT_ID);
    expect(created[0]?.deviceId).toBe("0f0f0f0f-0000-4000-8000-000000000001");
    expect(created[0]?.status).toBe("draft");
    expect(created[0]?.revision).toBe(1);
    // A draft intent has no ACTIVE version: the current version section is
    // the honest null (exactly the contract reference's shape).
    expect(created[0]?.currentVersion).toBeNull();
    expect(created[0]?.versions).toHaveLength(1);
    expect(created[0]?.versions[0]?.status).toBe("draft");
    expect(created[0]?.versions[0]?.rationale).toBe("Stay connected while traveling");
    expect(created[0]?.decision).toBeNull();

    const activate = await post(
      world,
      session,
      `/v1/experience-intents/${INTENT_ID}/activate`,
      "intent-activate-1",
      {},
    );
    expect(activate.status).toBe(202);
    await markExecuted(world, activate.commandId, T2, { type: "experience_intent", id: INTENT_ID, version: 2 });
    const active = parseExperienceIntentList(
      JSON.parse((await get(world, session, "/v1/experience-intents")).body),
    );
    expect(active[0]?.status).toBe("active");
    expect(active[0]?.revision).toBe(2);
    expect(active[0]?.currentVersion?.versionNumber).toBe(1);
    expect(active[0]?.versions.map((version) => version.status)).toEqual(["active"]);

    const supersede = await post(
      world,
      session,
      `/v1/experience-intents/${INTENT_ID}/versions`,
      "intent-supersede-1",
      { rationale: "Prefer trusted Wi-Fi when it is good enough", accessClasses: ["any_internet", "metered_cost_cap"] },
    );
    expect(supersede.status).toBe(202);
    await markExecuted(world, supersede.commandId, T3, { type: "experience_intent", id: INTENT_ID, version: 3 });
    const superseded = parseExperienceIntentList(
      JSON.parse((await get(world, session, "/v1/experience-intents")).body),
    );
    expect(superseded[0]?.revision).toBe(3);
    expect(superseded[0]?.versions.map((version) => version.status)).toEqual(["superseded", "active"]);
    expect(superseded[0]?.currentVersion?.versionNumber).toBe(2);
    expect(superseded[0]?.currentVersion?.rationale)
      .toBe("Prefer trusted Wi-Fi when it is good enough");

    // The single read and the versions read serve the same projection.
    const single = await get(world, session, `/v1/experience-intents/${INTENT_ID}`);
    expect(single.status).toBe(200);
    const versions = await get(world, session, `/v1/experience-intents/${INTENT_ID}/versions`);
    expect(versions.status).toBe(200);
    expect(JSON.parse(versions.body)).toEqual(
      (parseExperienceIntentResource(JSON.parse(single.body)).versions).map((version) => ({
        intentVersionId: version.intentVersionId,
        versionNumber: version.versionNumber,
        status: version.status,
        rationale: version.rationale,
        accessClasses: [...version.accessClasses],
        createdAt: version.createdAt,
      })),
    );

    const unknown = await get(world, session, "/v1/experience-intents/09090909-0000-4000-8000-000000000009");
    expect(unknown.status).toBe(404);
  });
});

describe("the composed payment read model", () => {
  it("projects executed payment.record commands with their real money facts (state pending)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const recorded = await post(world, session, "/v1/payments", "payment-record-1", {
      orderId: ORDER_ID,
      amountMinor: 2499,
      currency: "USD",
    });
    expect(recorded.status).toBe(202);
    expect(JSON.parse((await get(world, session, "/v1/payments")).body)).toEqual([]);

    await markExecuted(world, recorded.commandId, T1, { type: "payment", id: PAYMENT_ID });
    const payments = JSON.parse((await get(world, session, "/v1/payments")).body) as Record<string, unknown>[];
    expect(payments).toHaveLength(1);
    expect(payments[0]).toEqual({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: { amountMinor: 2499, currency: "USD" },
      state: "pending",
      recordedAt: T1,
    });
  });
});

describe("the composed connectivity read model", () => {
  it("serves the honest aggregate: executed subjects + device observations, evidence stated as absent", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    // With no executed state at all: the REAL empty overview.
    const empty = parseConnectivityOverviewResource(
      JSON.parse((await get(world, session, "/v1/connectivity")).body),
    );
    expect(empty.subjects).toEqual([]);
    expect(empty.deviceObservations).toEqual([]);

    const enroll = await post(world, session, "/v1/devices", "connectivity-enroll-1", {
      name: "Acahat Phone",
      platform: "ios",
    });
    await markExecuted(world, enroll.commandId, T1, { type: "device", id: DEVICE_ID });
    const order = await post(world, session, "/v1/orders", "connectivity-order-1", {
      lines: [{ variantId: "05050505-0000-4000-8000-000000000005", quantity: 1 }],
    });
    await markExecuted(world, order.commandId, T2, { type: "order", id: ORDER_ID });

    const overview = parseConnectivityOverviewResource(
      JSON.parse((await get(world, session, "/v1/connectivity")).body),
    );
    expect(overview.subjects).toHaveLength(1);
    const subject = overview.subjects[0];
    if (subject === undefined) throw new Error("subject missing");
    expect(subject.subjectType).toBe("order");
    expect(subject.subjectId).toBe(ORDER_ID);
    expect(subject.commercialState).toBe("placed");
    expect(subject.referenceStatus).toBe("none");
    expect(subject.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(subject.evidence).toBeNull();
    expect(overview.deviceObservations).toEqual([
      {
        deviceId: DEVICE_ID,
        deviceName: "Acahat Phone",
        capabilityFreshness: null,
        contextFreshness: null,
        lastObservedAt: null,
      },
    ]);

    // An executed order.complete advances the subject's commercial state.
    const complete = await post(world, session, `/v1/orders/${ORDER_ID}/complete`, "connectivity-complete-1", {});
    await markExecuted(world, complete.commandId, T3, { type: "order", id: ORDER_ID, version: 2 });
    const completed = parseConnectivityOverviewResource(
      JSON.parse((await get(world, session, "/v1/connectivity")).body),
    );
    expect(completed.subjects[0]?.commercialState).toBe("completed");
  });
});

describe("the composed support-case read model", () => {
  it("projects the create + transition lifecycle with the carried related references", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const created = await post(world, session, "/v1/support-cases", "support-create-1", {
      subject: "My connectivity has no delivery evidence yet",
      description: "I paid but the delivery progress view cannot confirm anything yet.",
      priority: "high",
      relatedRefs: [
        { kind: "order", id: ORDER_ID },
        { kind: "device", id: DEVICE_ID },
      ],
    });
    expect(created.status).toBe(202);
    expect(JSON.parse((await get(world, session, "/v1/support-cases")).body)).toEqual([]);

    await markExecuted(world, created.commandId, T1, { type: "support_case", id: CASE_ID });
    const cases = parseSupportCaseList(JSON.parse((await get(world, session, "/v1/support-cases")).body));
    expect(cases).toHaveLength(1);
    const supportCase = cases[0];
    if (supportCase === undefined) throw new Error("case missing");
    expect(supportCase.caseId).toBe(CASE_ID);
    expect(supportCase.subject).toBe("My connectivity has no delivery evidence yet");
    expect(supportCase.priority).toBe("high");
    expect(supportCase.status).toBe("open");
    expect(supportCase.createdByUserId).toBe(userIdFromSeed(1));
    expect(supportCase.relatedRefs).toEqual([
      { kind: "order", id: ORDER_ID },
      { kind: "device", id: DEVICE_ID },
    ]);
    expect(supportCase.messages).toEqual([]);
    expect(supportCase.revision).toBe(1);

    const transition = await post(
      world,
      session,
      `/v1/support-cases/${CASE_ID}/transitions`,
      "support-transition-1",
      { transition: "startProgress" },
    );
    expect(transition.status).toBe(202);
    await markExecuted(world, transition.commandId, T2, { type: "support_case", id: CASE_ID, version: 2 });
    const progressed = parseSupportCaseList(JSON.parse((await get(world, session, "/v1/support-cases")).body));
    expect(progressed[0]?.status).toBe("in_progress");
    expect(progressed[0]?.revision).toBe(2);
    expect(progressed[0]?.updatedAt).toBe(T2);

    const single = await get(world, session, `/v1/support-cases/${CASE_ID}`);
    expect(single.status).toBe(200);
    expect(parseSupportCaseList([JSON.parse(single.body)])[0]?.caseId).toBe(CASE_ID);
    const unknown = await get(world, session, "/v1/support-cases/09090909-0000-4000-8000-000000000009");
    expect(unknown.status).toBe(404);
  });
});

describe("the composed user read model (identity-backed)", () => {
  it("serves the registered principal's real user record; unknown and malformed ids fail closed", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const session = await sessionOf(world, 1);

    const userId = userIdFromSeed(1);
    const read = await get(world, session, `/v1/users/${userId}`);
    expect(read.status).toBe(200);
    expect(parseUserResource(JSON.parse(read.body))).toEqual({
      userId,
      displayName: "User 1",
      principalKind: "user",
    });

    // Another registered user resolves too (the directory read), but an
    // unknown id is the honest 404.
    const other = await get(world, session, `/v1/users/${userIdFromSeed(2)}`);
    expect(other.status).toBe(200);
    const unknown = await get(world, session, "/v1/users/09090909-0000-4000-8000-000000000009");
    expect(unknown.status).toBe(404);
    const malformed = await get(world, session, "/v1/users/not-a-uuid");
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)["reason"]).toBe("READ_PATH_INVALID");
  });
});

describe("the composed organization read model (identity-backed)", () => {
  it("serves the acting organization + its members to an org:read holder; personal tenants fail closed", async () => {
    const world = createTestWorld();
    const owner = userIdFromSeed(1);
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const organizationId = "2dc7f531-6317-4246-9be0-8a1793ad2bf3";
    const tenantId = `org:${organizationId}`;
    await world.administration.createOrganization(1, organizationId, "Acahat Travel Co");
    await world.administration.addMember(1, organizationId, userIdFromSeed(2), "member");

    const personal = await sessionOf(world, 1);
    const personalRead = await get(world, personal, "/v1/organizations");
    expect(personalRead.status).toBe(403);
    expect(JSON.parse(personalRead.body)["reason"]).toBe("PERMISSION_DENIED");

    // The owner signs in and reads the organization tenant's member list.
    const orgSession: Session = {
      token: personal.token,
      actorId: `usr:${owner}`,
      tenantId,
    };
    const list = await get(world, orgSession, "/v1/organizations");
    expect(list.status).toBe(200);
    const organizations = parseOrganizationList(JSON.parse(list.body));
    expect(organizations).toHaveLength(1);
    const organization = organizations[0];
    if (organization === undefined) throw new Error("organization missing");
    expect(organization.tenantId).toBe(tenantId);
    expect(organization.name).toBe("Acahat Travel Co");
    expect(organization.status).toBe("active");
    expect(organization.members).toEqual([
      { userId: userIdFromSeed(1), role: "owner", status: "active" },
      { userId: userIdFromSeed(2), role: "member", status: "active" },
    ]);

    // An actor with no membership in the organization tenant fails closed.
    await world.administration.registerUser(3);
    const outsider = await sessionOf(world, 3);
    const foreign = await get(world, { ...outsider, tenantId }, "/v1/organizations");
    expect(foreign.status).toBe(403);
  });
});

describe("the composed reconciliation-jobs read model (durable job records)", () => {
  it("serves the acting tenant's job records through the contract parser; cross-tenant records stay invisible", async () => {
    const world = createTestWorld();
    const owner = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const organizationId = "3dc7f531-6317-4246-9be0-8a1793ad2bf3";
    const tenantId = `org:${organizationId}`;
    await world.administration.createOrganization(1, organizationId, "Jobs Org");

    // Empty first: no job records exist for this tenant.
    const session: Session = { token: await loginUser(world, 1), actorId: `usr:${owner}`, tenantId };
    expect(JSON.parse((await get(world, session, "/v1/reconciliation-jobs")).body)).toEqual([]);

    // Seed the job record exactly the reconciliation boundary persists it
    // (the §5 record in the adcos-reconciliation-jobs repository).
    const unitOfWork = await world.persistence.begin();
    await unitOfWork.records("adcos-reconciliation-jobs").insert("job-0001", {
      job_id: "job-0001",
      correlation_id: "corr-job-1",
      idempotency_key: "job-1",
      actor_id: `usr:${owner}`,
      tenant_id: tenantId,
      created_at: T1,
      retry: { attempt: 1 },
      trigger_reason: "manual",
      status: "COMPLETED",
      started_at: T1,
      completed_at: T2,
      actions: [
        {
          action_id: "job-0001#1",
          action_type: "FRESHNESS_SWEEP",
          outcome: "ALREADY_CONSISTENT",
          resource_type: "connectivity_contract",
          resource_id: "res-1",
          detail: "freshness sweep verified the projection",
          attempted_at: T1,
          attempts: 1,
        },
      ],
      summary: {
        scanned: 1,
        repaired: 0,
        alreadyConsistent: 1,
        degradedStale: 0,
        degradedUnknown: 0,
        canonicalAbsent: 0,
        deferred: 0,
        failed: 0,
      },
    } as never);
    // A platform-tenant job: invisible to the acting org tenant (tenant
    // boundary first, no cross-tenant oracle).
    await unitOfWork.records("adcos-reconciliation-jobs").insert("job-0002", {
      job_id: "job-0002",
      correlation_id: "corr-job-2",
      idempotency_key: "job-2",
      actor_id: `usr:${owner}`,
      tenant_id: "org:00000000-0000-4000-8000-000000000001",
      created_at: T1,
      retry: { attempt: 1 },
      trigger_reason: "scheduled",
      status: "COMPLETED",
      started_at: T1,
      completed_at: T2,
      actions: [],
      summary: null,
    } as never);
    await unitOfWork.commit();

    const jobs = parseReconciliationJobList(
      JSON.parse((await get(world, session, "/v1/reconciliation-jobs")).body),
    );
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (job === undefined) throw new Error("job missing");
    expect(job.jobId).toBe("job-0001");
    expect(job.status).toBe("COMPLETED");
    expect(job.trigger).toBe("manual");
    expect(job.commandId).toBe("job-0001");
    expect(job.correlationId).toBe("corr-job-1");
    expect(job.idempotencyKey).toBe("job-1");
    expect(job.startedAt).toBe(T1);
    expect(job.completedAt).toBe(T2);
    expect(job.actions).toEqual([
      {
        actionType: "FRESHNESS_SWEEP",
        outcome: "ALREADY_CONSISTENT",
        targetType: "connectivity_contract",
        targetId: "res-1",
        detail: "freshness sweep verified the projection",
        at: T1,
      },
    ]);

    // Personal tenants keep the org-scoped 403 (the admin read law).
    const personal = await sessionOf(world, 1);
    const personalRead = await get(world, personal, "/v1/reconciliation-jobs");
    expect(personalRead.status).toBe(403);
  });
});

describe("the kept-501 routes (honest skips, named reasons)", () => {
  it("answers every route with no composed source with the typed 501 and its named reason", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const kept: readonly { readonly path: string; readonly code: string }[] = [
      { path: "/v1/products", code: "PRODUCT_CATALOG_NOT_BOUND" },
      { path: "/v1/orders", code: "ORDER_PRICE_FACTS_NOT_BOUND" },
      { path: `/v1/orders/${ORDER_ID}`, code: "ORDER_PRICE_FACTS_NOT_BOUND" },
      { path: "/v1/subscriptions", code: "SUBSCRIPTION_STATE_NOT_BOUND" },
      { path: "/v1/notifications", code: "NOTIFICATION_STORE_NOT_BOUND" },
      { path: "/v1/audit-events", code: "AUDIT_CHAIN_NOT_BOUND" },
      { path: "/v1/projection-health", code: "PROJECTION_HEALTH_SOURCE_NOT_BOUND" },
      { path: "/v1/integration-health", code: "INTEGRATION_HEALTH_SOURCE_NOT_BOUND" },
    ];
    for (const route of kept) {
      const response = await get(world, session, route.path);
      expect(response.status, route.path).toBe(501);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body["reason"], route.path).toBe("READ_MODEL_NOT_COMPOSED");
      expect(body["kind"], route.path).toBe("unavailable");
      expect(String(body["message"]), route.path).toContain(route.code);
      const details = body["details"] as { readonly issue: string }[];
      expect(details?.[0]?.issue, route.path).toContain(route.code);
    }
  });
});

describe("the read surface contract (READ_MODEL_ROUTES coverage)", () => {
  it("every read-route pattern is answered (composed or kept-501 — never the plain 404)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    // The frozen surface: 20 read-route patterns — 12 composed, 8 kept-501.
    expect(READ_MODEL_ROUTES).toHaveLength(20);
    expect(Object.keys(READ_MODELS_NOT_COMPOSED)).toHaveLength(8);

    // A representative concrete path for every frozen route pattern (the
    // placeholder `[^/]+` segments substituted with sample ids).
    const sampleId = "0f0f0f0f-0000-4000-8000-0000000000aa";
    const representative: readonly string[] = READ_MODEL_ROUTES.map((pattern) =>
      pattern.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replaceAll("[^/]+", sampleId)
        .replaceAll("\\/", "/"),
    );
    expect(new Set(representative).size).toBe(READ_MODEL_ROUTES.length);

    for (const path of representative) {
      const response = await get(world, session, path);
      // Every pattern must be ROUTED: a single-resource read may honestly
      // 404 for the sample id (no existence oracle), but the ROUTE-GAP 404
      // ("no API resource exists at this path") must never appear.
      if (response.status === 404) {
        const body = JSON.parse(response.body) as Record<string, unknown>;
        expect(String(body["message"]), path).not.toContain("no API resource exists");
      } else {
        expect([200, 403, 501], path).toContain(response.status);
      }
    }

    // A non-read path still answers the honest 404.
    const unknown = await get(world, session, "/v1/definitely-not-a-resource");
    expect(unknown.status).toBe(404);
  });
});

describe("the composed reads' tenant discipline", () => {
  it("fails closed on a missing tenant context, a forged actor header, and a foreign tenant", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const session = await sessionOf(world, 1);

    const missingTenant = await world.service.handle({
      method: "GET",
      path: "/v1/devices",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(missingTenant.status).toBe(400);
    expect(JSON.parse(missingTenant.body as string)["reason"]).toBe("READ_CONTEXT_INCOMPLETE");

    const forgedActor = await world.service.handle({
      method: "GET",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-roamlink-actor-id": `usr:${userIdFromSeed(2)}`,
        "x-roamlink-tenant-id": session.tenantId,
      },
    });
    expect(forgedActor.status).toBe(400);
    expect(JSON.parse(forgedActor.body as string)["reason"]).toBe("READ_CONTEXT_INVALID");

    // Another user's personal tenant: the boundary's typed refusal (the
    // command plane's own cross-tenant law).
    const foreignTenant = await world.service.handle({
      method: "GET",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-roamlink-actor-id": session.actorId,
        "x-roamlink-tenant-id": tenantOf(2),
      },
    });
    expect(foreignTenant.status).toBe(403);

    // And an unauthenticated read is refused before any read model answer.
    const unauthenticated = await world.service.handle({
      method: "GET",
      path: "/v1/devices",
      headers: { "x-roamlink-actor-id": session.actorId, "x-roamlink-tenant-id": session.tenantId },
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("never serves another tenant's executed commands (tenant boundary first)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const session1 = await sessionOf(world, 1);
    const session2 = await sessionOf(world, 2);

    const accepted = await post(world, session1, "/v1/devices", "tenant-enroll-1", {
      name: "Acahat Phone",
      platform: "ios",
    });
    await markExecuted(world, accepted.commandId, T1, { type: "device", id: DEVICE_ID });

    const own = parseDeviceList(JSON.parse((await get(world, session1, "/v1/devices")).body));
    expect(own).toHaveLength(1);
    // The other tenant's read serves ITS OWN (empty) projection: no
    // existence oracle, no cross-tenant leak.
    const theirs = JSON.parse((await get(world, session2, "/v1/devices")).body);
    expect(theirs).toEqual([]);
    const foreignSingle = await get(world, session2, `/v1/devices/${DEVICE_ID}`);
    expect(foreignSingle.status).toBe(404);
  });
});
