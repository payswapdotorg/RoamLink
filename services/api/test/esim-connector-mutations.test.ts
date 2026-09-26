/**
 * PA-023: the eSIM install/enable/remove + enterprise connector provisioning
 * mutation routes (the audit §3 mutation-parity gap).
 *
 * The battery proves the NO-INVENTION law for each of the four routes:
 *  - the positive acceptance: 202 with the typed four-stage acknowledgement
 *    (`acceptedAt` present, every later stage honestly absent — accepted,
 *    never fake-executed), the durable command record + key pointer + outbox
 *    obligation committing atomically, and the idempotency-key dedupe
 *    replaying the ORIGINAL acknowledgement with no new effect;
 *  - the same key with a DIFFERENT payload is the typed conflict (never a
 *    silent overwrite);
 *  - the negative matrix: the per-kind payload law (the server-side mirror
 *    of the app-kit serializers — same field names, same bounds, fail-closed
 *    typed rejections), the envelope laws (missing header set, forged actor,
 *    cross-tenant), and the session law (no bearer → 401) — every rejection
 *    leaves the durable command plane EMPTY.
 */
import { describe, expect, it } from "vitest";
import { tenantIdFromUser } from "@roamlink/contracts";

import {
  PASSWORD_A,
  createTestWorld,
  mutationHeaders,
  userIdFromSeed,
} from "./helpers.js";

async function loginUser(
  world: Awaited<ReturnType<typeof createTestWorld>>,
  seed: number,
): Promise<string> {
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

/** A logged-in session's mutation header set (actor/tenant/key + bearer). */
function authedMutationHeaders(input: {
  readonly token: string;
  readonly userId: string;
  readonly key: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.token}`,
    ...mutationHeaders({
      actorId: `usr:${input.userId}`,
      tenantId: tenantIdFromUser(input.userId as ReturnType<typeof userIdFromSeed>),
      key: input.key,
    }),
  };
}

const DEVICE_ID = "1a1a1a1a-0000-4000-8000-0000000000a1";
const PROFILE_ID = "2b2b2b2b-0000-4000-8000-0000000000b2";

async function post(
  world: Awaited<ReturnType<typeof createTestWorld>>,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await world.service.handle({
    method: "POST",
    path,
    headers,
    body,
  });
  return {
    status: response.status,
    body: response.body === undefined ? {} : (JSON.parse(response.body) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// esim.install (/v1/devices/{deviceId}/sim/install)
// ---------------------------------------------------------------------------

describe("esim.install (POST /v1/devices/{deviceId}/sim/install)", () => {
  it("accepts the install command durably: 202, four-stage ack with only `accepted` reached", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const response = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      authedMutationHeaders({ token, userId: `${userId}`, key: "esim-install-1" }),
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(response.status).toBe(202);
    expect(response.body["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
    expect(response.body["executedAt"]).toBeUndefined();
    expect(response.body["deliveredAt"]).toBeUndefined();
    expect(response.body["billableFinalAt"]).toBeUndefined();
    expect(response.body["commandId"]).toMatch(/^[0-9a-f-]{36}$/);
    // The envelope echo: the acknowledgement carries the caller's key +
    // correlation id (the typed acknowledgement, never invented state).
    expect(response.body["idempotencyKey"]).toBe("esim-install-1");
    expect(response.body["correlationId"]).toBe("corr-esim-install-1");
    // The command record + pointer + outbox obligation are all durable.
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    expect(await world.persistence.records("api-command-keys").count()).toBe(1);
    expect(await world.persistence.outbox.count("PENDING")).toBe(1);
  });

  it("replays the SAME acknowledgement for the same key with no new effect, and conflicts on a different payload", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-install-replay" });
    const body = JSON.stringify({ activationCode: "act-code-fixture-never-prod" });
    const first = await post(world, `/v1/devices/${DEVICE_ID}/sim/install`, headers, body);
    expect(first.status).toBe(202);
    const replay = await post(world, `/v1/devices/${DEVICE_ID}/sim/install`, headers, body);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    // Same key, DIFFERENT payload: the typed conflict, never a silent overwrite.
    const conflict = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify({ activationCode: "a-different-code" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body["reason"]).toBe("COMMAND_IDEMPOTENCY_CONFLICT");
    expect(await world.persistence.records("api-commands").count()).toBe(1);
  });

  it("serves the stored install command through GET /v1/commands/{commandId} (the durable read-back)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const accepted = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      authedMutationHeaders({ token, userId: `${userId}`, key: "esim-install-view" }),
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(accepted.status).toBe(202);
    const commandId = accepted.body["commandId"] as string;
    const view = await world.service.handle({
      method: "GET",
      path: `/v1/commands/${commandId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-roamlink-tenant-id": tenantIdFromUser(userId),
      },
    });
    expect(view.status).toBe(200);
    const body = JSON.parse(view.body as string) as Record<string, unknown>;
    expect(body["commandId"]).toBe(commandId);
    expect(body["idempotencyKey"]).toBe("esim-install-view");
    expect(body["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
    expect(body["executedAt"]).toBeUndefined();
  });

  it("rejects the negative matrix fail-closed (payload law + envelope law + session law; nothing durable)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-install-neg" });

    // The payload law — the server-side mirror of installEsimProfileBody.
    const missingCode = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify({}),
    );
    expect(missingCode.status).toBe(400);
    expect(missingCode.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const emptyCode = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify({ activationCode: "" }),
    );
    expect(emptyCode.status).toBe(400);
    expect(emptyCode.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const nonStringCode = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify({ activationCode: 12345 }),
    );
    expect(nonStringCode.status).toBe(400);
    expect(nonStringCode.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const unknownField = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify({ activationCode: "act-code-fixture-never-prod", carrierHint: "x" }),
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const arrayBody = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      headers,
      JSON.stringify(["activationCode"]),
    );
    expect(arrayBody.status).toBe(400);
    expect(arrayBody.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    // The path-bound id law (the client's requireDeviceId mirror).
    const badDeviceId = await post(
      world,
      "/v1/devices/not-a-uuid/sim/install",
      headers,
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(badDeviceId.status).toBe(400);
    expect(badDeviceId.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    // The envelope laws.
    const forgedActor = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({
          actorId: "usr:00000000-0000-4000-8000-000000000009",
          tenantId: tenantIdFromUser(userId),
          key: "esim-install-forged",
        }),
      },
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(forgedActor.status).toBe(400);
    expect(forgedActor.body["reason"]).toBe("COMMAND_ENVELOPE_INVALID");

    const { ["idempotency-key"]: _dropped, ...incompleteHeaders } = headers;
    const incomplete = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      incompleteHeaders,
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(incomplete.status).toBe(400);
    expect(incomplete.body["reason"]).toBe("COMMAND_ENVELOPE_INCOMPLETE");

    // The session law (no bearer → 401).
    const unauthenticated = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/install`,
      mutationHeaders({
        actorId: `usr:${userId}`,
        tenantId: tenantIdFromUser(userId),
        key: "esim-install-noauth",
      }),
      JSON.stringify({ activationCode: "act-code-fixture-never-prod" }),
    );
    expect(unauthenticated.status).toBe(401);

    // Nothing durable landed from any rejection.
    expect(await world.persistence.records("api-commands").count()).toBe(0);
    expect(await world.persistence.records("api-command-keys").count()).toBe(0);
    expect(await world.persistence.outbox.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// esim.remove (/v1/devices/{deviceId}/sim/profiles/{profileId}/remove)
// ---------------------------------------------------------------------------

describe("esim.remove (POST /v1/devices/{deviceId}/sim/profiles/{profileId}/remove)", () => {
  it("accepts the remove command durably (the ids ride the path; the body is empty)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-remove-1" });
    const response = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove`,
      headers,
      "{}",
    );
    expect(response.status).toBe(202);
    expect(response.body["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
    expect(response.body["executedAt"]).toBeUndefined();
    expect(response.body["idempotencyKey"]).toBe("esim-remove-1");
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    expect(await world.persistence.outbox.count("PENDING")).toBe(1);

    // Idempotent replay: same key + same payload replays the original ack.
    const replay = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove`,
      headers,
      "{}",
    );
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(response.body);
    expect(await world.persistence.records("api-commands").count()).toBe(1);

    // The conflict law (same key, different payload).
    const conflict = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove`,
      headers,
      JSON.stringify({ unexpected: true }),
    );
    expect(conflict.status).toBe(400); // the payload law rejects before the conflict is reached
    expect(conflict.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");
  });

  it("rejects the negative matrix fail-closed (payload law: no body fields, canonical ids)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-remove-neg" });

    const unknownField = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove`,
      headers,
      JSON.stringify({ profileId: PROFILE_ID }),
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const badProfileId = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/not-a-uuid/remove`,
      headers,
      "{}",
    );
    expect(badProfileId.status).toBe(400);
    expect(badProfileId.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const badDeviceId = await post(
      world,
      `/v1/devices/not-a-uuid/sim/profiles/${PROFILE_ID}/remove`,
      headers,
      "{}",
    );
    expect(badDeviceId.status).toBe(400);
    expect(badDeviceId.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    // A forged actor header never reaches the payload law (envelope first).
    const forgedActor = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove`,
      {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({
          actorId: "usr:00000000-0000-4000-8000-000000000009",
          tenantId: tenantIdFromUser(userId),
          key: "esim-remove-forged",
        }),
      },
      "{}",
    );
    expect(forgedActor.status).toBe(400);
    expect(forgedActor.body["reason"]).toBe("COMMAND_ENVELOPE_INVALID");

    expect(await world.persistence.records("api-commands").count()).toBe(0);
    expect(await world.persistence.outbox.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// esim.enable (/v1/devices/{deviceId}/sim/profiles/{profileId}/enable)
// ---------------------------------------------------------------------------

describe("esim.enable (POST /v1/devices/{deviceId}/sim/profiles/{profileId}/enable)", () => {
  it("accepts the enable command durably (the desired state rides the body)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-enable-1" });
    const response = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({ enabled: true }),
    );
    expect(response.status).toBe(202);
    expect(response.body["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
    expect(response.body["executedAt"]).toBeUndefined();
    expect(response.body["idempotencyKey"]).toBe("esim-enable-1");
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    expect(await world.persistence.outbox.count("PENDING")).toBe(1);

    const replay = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({ enabled: true }),
    );
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(response.body);
    expect(await world.persistence.records("api-commands").count()).toBe(1);

    // Same key, DIFFERENT payload: the typed conflict (never silent).
    const conflict = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({ enabled: false }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body["reason"]).toBe("COMMAND_IDEMPOTENCY_CONFLICT");
  });

  it("rejects the negative matrix fail-closed (enabled must be a boolean; no other fields)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "esim-enable-neg" });

    const missingEnabled = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({}),
    );
    expect(missingEnabled.status).toBe(400);
    expect(missingEnabled.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const stringEnabled = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({ enabled: "true" }),
    );
    expect(stringEnabled.status).toBe(400);
    expect(stringEnabled.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const unknownField = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/enable`,
      headers,
      JSON.stringify({ enabled: true, force: true }),
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const badProfileId = await post(
      world,
      `/v1/devices/${DEVICE_ID}/sim/profiles/not-a-uuid/enable`,
      headers,
      JSON.stringify({ enabled: true }),
    );
    expect(badProfileId.status).toBe(400);
    expect(badProfileId.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    expect(await world.persistence.records("api-commands").count()).toBe(0);
    expect(await world.persistence.outbox.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// connector.provision (/v1/enterprise/workspace/connector/provision)
// ---------------------------------------------------------------------------

describe("connector.provision (POST /v1/enterprise/workspace/connector/provision)", () => {
  it("accepts the provisioning command durably: 202, accepted only (execution is the worker path)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const response = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      authedMutationHeaders({ token, userId: `${userId}`, key: "connector-provision-1" }),
      JSON.stringify({ connectorId: "demo-connector" }),
    );
    expect(response.status).toBe(202);
    expect(response.body["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
    expect(response.body["executedAt"]).toBeUndefined();
    expect(response.body["deliveredAt"]).toBeUndefined();
    expect(response.body["billableFinalAt"]).toBeUndefined();
    expect(response.body["commandId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body["idempotencyKey"]).toBe("connector-provision-1");
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    expect(await world.persistence.records("api-command-keys").count()).toBe(1);
    expect(await world.persistence.outbox.count("PENDING")).toBe(1);
  });

  it("replays the SAME acknowledgement for the same key and conflicts on a different label", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "connector-replay" });
    const first = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({ connectorId: "workspace-main" }),
    );
    expect(first.status).toBe(202);
    const replay = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({ connectorId: "workspace-main" }),
    );
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    const conflict = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({ connectorId: "workspace-other" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body["reason"]).toBe("COMMAND_IDEMPOTENCY_CONFLICT");
  });

  it("rejects the negative matrix fail-closed (the bounded printable label law, never a secret)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "connector-neg" });

    // The label rule mirrored EXACTLY from provisionConnectorBody:
    // /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/ — bounded printable, never a secret.
    for (const [label, issue] of [
      ["", "missing (empty string)"],
      ["has space", "contains a space"],
      [".leading-dot", "does not start alphanumeric"],
      ["a".repeat(65), "exceeds the 64-character bound"],
      ["Bearer sekret-token", "secret-shaped value"],
      ["ünïcödé", "non-ASCII"],
    ] as const) {
      const rejected = await post(
        world,
        "/v1/enterprise/workspace/connector/provision",
        headers,
        JSON.stringify({ connectorId: label }),
      );
      expect(rejected.status, `connectorId ${issue}`).toBe(400);
      expect(rejected.body["reason"], `connectorId ${issue}`).toBe("COMMAND_PAYLOAD_INVALID");
    }

    const missingLabel = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({}),
    );
    expect(missingLabel.status).toBe(400);
    expect(missingLabel.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const nonStringLabel = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({ connectorId: 42 }),
    );
    expect(nonStringLabel.status).toBe(400);
    expect(nonStringLabel.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    const unknownField = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      headers,
      JSON.stringify({ connectorId: "demo-connector", enrollmentRef: "org:123" }),
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.body["reason"]).toBe("COMMAND_PAYLOAD_INVALID");

    // The enrollment reference and capability inputs are RESOLVED server-side
    // against the acting tenant's journey (app-kit provisionConnectorBody
    // contract): a customer command that carries them is rejected, never read.

    // Cross-tenant forgery: the typed 403 (active membership required).
    await world.administration.registerUser(2);
    const crossTenant = await post(
      world,
      "/v1/enterprise/workspace/connector/provision",
      {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({
          actorId: `usr:${userId}`,
          tenantId: "org:11111111-1111-4111-8111-111111111111",
          key: "connector-cross-tenant",
        }),
      },
      JSON.stringify({ connectorId: "demo-connector" }),
    );
    expect(crossTenant.status).toBe(403);

    expect(await world.persistence.records("api-commands").count()).toBe(0);
    expect(await world.persistence.records("api-command-keys").count()).toBe(0);
    expect(await world.persistence.outbox.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The mutation surface stays closed: near-miss paths answer 404
// ---------------------------------------------------------------------------

describe("the eSIM/connector mutation surface stays closed (near-miss paths are 404)", () => {
  it("rejects near-miss eSIM/connector paths with 404 (no invented routes)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);
    const headers = authedMutationHeaders({ token, userId: `${userId}`, key: "near-miss" });
    for (const path of [
      `/v1/devices/${DEVICE_ID}/sim/enable`, // enable rides /profiles/{profileId}
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/disable`, // enable carries the state
      `/v1/devices/${DEVICE_ID}/sim/uninstall`, // removal is /profiles/{profileId}/remove
      "/v1/enterprise/workspace/connector/deprovision",
      "/v1/enterprise/connector/provision",
      `/v1/devices/${DEVICE_ID}/sim/profiles/${PROFILE_ID}/remove/extra`,
    ]) {
      const response = await post(world, path, headers, "{}");
      expect(response.status, path).toBe(404);
    }
    expect(await world.persistence.records("api-commands").count()).toBe(0);
  });
});
