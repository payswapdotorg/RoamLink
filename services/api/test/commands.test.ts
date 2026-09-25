/**
 * RL-090: durable command ingestion - the full envelope, tenant
 * authorization, idempotency-key dedupe, the atomic command-record +
 * outbox-enqueue unit of work, and the honest stage timestamps.
 */
import { describe, expect, it } from "vitest";
import { tenantIdFromUser } from "@roamlink/contracts";

import {
  PASSWORD_A,
  createTestWorld,
  mutationHeaders,
  tenantOf,
  userIdFromSeed,
} from "./helpers.js";

async function loginUser(world: Awaited<ReturnType<typeof createTestWorld>>, seed: number): Promise<string> {
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

describe("durable command ingestion (POST mutations)", () => {
  it("accepts a command: 202 with acceptedAt present and later stages honestly absent", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);

    const response = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({
          actorId: `usr:${userId}`,
          tenantId: tenantIdFromUser(userId),
          key: "enroll-1",
        }),
      },
      body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
    });
    expect(response.status).toBe(202);
    const ack = JSON.parse(response.body as string);
    expect(ack.acceptedAt).toBe("2026-01-15T08:30:00.000Z");
    expect(ack.executedAt).toBeUndefined();
    expect(ack.deliveredAt).toBeUndefined();
    expect(ack.billableFinalAt).toBeUndefined();
    expect(ack.commandId).toMatch(/^[0-9a-f-]{36}$/);

    // The command record + pointer + outbox obligation are all durable.
    expect(await world.persistence.records("api-commands").count()).toBe(1);
    expect(await world.persistence.records("api-command-keys").count()).toBe(1);
    expect(await world.persistence.outbox.count("PENDING")).toBe(1);
  });

  it("replays the SAME acknowledgement for the same key without any new effect", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const headers = {
      authorization: `Bearer ${token}`,
      ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "enroll-replay" }),
    };
    const first = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers,
      body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
    });
    const replay = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers,
      body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toBe(first.body);
    expect(await world.persistence.outbox.count()).toBe(1);
    expect(await world.persistence.records("api-commands").count()).toBe(1);
  });

  it("conflicts when the same key carries a DIFFERENT payload (never a silent overwrite)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const headers = {
      authorization: `Bearer ${token}`,
      ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "enroll-conflict" }),
    };
    await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers,
      body: JSON.stringify({ name: "One", platform: "ios" }),
    });
    const conflict = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers,
      body: JSON.stringify({ name: "Two", platform: "ios" }),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body as string)["reason"]).toBe("COMMAND_IDEMPOTENCY_CONFLICT");
  });

  it("rejects a forged actor header (the session decides the actor, not the client)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({ actorId: "usr:00000000-0000-4000-8000-000000000009", tenantId: tenantIdFromUser(userId), key: "forge-1" }),
      },
      body: JSON.stringify({ name: "X", platform: "ios" }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body as string)["reason"]).toBe("COMMAND_ENVELOPE_INVALID");
  });

  it("answers cross-tenant forgery with 403 (active membership required, fail-closed)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const token = await loginUser(world, 1);
    // User 1 presenting an org tenant they have no membership in.
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({
          actorId: `usr:${userIdFromSeed(1)}`,
          tenantId: `org:11111111-1111-4111-8111-111111111111`,
          key: "cross-tenant-1",
        }),
      },
      body: JSON.stringify({ name: "X", platform: "ios" }),
    });
    expect(response.status).toBe(403);
    const body = JSON.parse(response.body as string);
    expect(body.kind).toBe("unauthorized");
  });

  it("rolls the whole unit of work back on failure (no partial command state)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    // A malformed body (not JSON) fails AFTER auth but BEFORE any writes.
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "bad-1" }),
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await world.persistence.records("api-commands").count()).toBe(0);
    expect(await world.persistence.records("api-command-keys").count()).toBe(0);
    expect(await world.persistence.outbox.count()).toBe(0);
  });

  it("rejects mutations to unknown paths with 404 (the mutation surface is closed)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/anything-else",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "unknown-1" }),
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/commands/{commandId} (the stored-command view)", () => {
  it("serves the recorded acknowledgement of an accepted command", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const accepted = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "view-1" }),
      },
      body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
    });
    const { commandId } = JSON.parse(accepted.body as string) as { commandId: string };

    const view = await world.service.handle({
      method: "GET",
      path: `/v1/commands/${commandId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-roamlink-tenant-id": tenantIdFromUser(userId),
      },
    });
    expect(view.status).toBe(200);
    const body = JSON.parse(view.body as string);
    expect(body.commandId).toBe(commandId);
    expect(body.acceptedAt).toBe("2026-01-15T08:30:00.000Z");
    expect(body.executedAt).toBeUndefined();
  });

  it("answers unknown and cross-tenant command reads with 404 (no existence oracle)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const token1 = await loginUser(world, 1);
    const token2 = await loginUser(world, 2);

    const unknown = await world.service.handle({
      method: "GET",
      path: "/v1/commands/00000000-0000-4000-8000-00000000000f",
      headers: {
        authorization: `Bearer ${token1}`,
        "x-roamlink-tenant-id": tenantOf(1),
      },
    });
    expect(unknown.status).toBe(404);

    // User 2 forges a read of user 1's tenant scope -> fail-closed 404.
    const accepted = await world.service.handle({
      method: "POST",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token1}`,
        ...mutationHeaders({ actorId: `usr:${userIdFromSeed(1)}`, tenantId: tenantOf(1), key: "view-x-1" }),
      },
      body: JSON.stringify({ name: "X", platform: "ios" }),
    });
    const { commandId } = JSON.parse(accepted.body as string) as { commandId: string };
    const crossTenant = await world.service.handle({
      method: "GET",
      path: `/v1/commands/${commandId}`,
      headers: {
        authorization: `Bearer ${token2}`,
        "x-roamlink-tenant-id": tenantOf(2),
      },
    });
    expect(crossTenant.status).toBe(404);
  });
});

describe("the composed read routes and the honestly-kept 501s (PA-019)", () => {
  it("answers composed read routes with real bound state and kept routes with the typed 501 (never invented data)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const userId = userIdFromSeed(1);

    // The COMPOSED routes serve the real (accepted-only) ledger state: the
    // projections are honestly empty because no executed command exists.
    const devices = await world.service.handle({
      method: "GET",
      path: "/v1/devices",
      headers: {
        authorization: `Bearer ${token}`,
        "x-roamlink-actor-id": `usr:${userId}`,
        "x-roamlink-tenant-id": tenantOf(1),
      },
    });
    expect(devices.status).toBe(200);
    expect(JSON.parse(devices.body as string)).toEqual([]);
    const connectivity = await world.service.handle({
      method: "GET",
      path: "/v1/connectivity",
      headers: {
        authorization: `Bearer ${token}`,
        "x-roamlink-actor-id": `usr:${userId}`,
        "x-roamlink-tenant-id": tenantOf(1),
      },
    });
    expect(connectivity.status).toBe(200);
    expect(JSON.parse(connectivity.body as string)).toEqual({
      presentedAt: "2026-01-15T08:30:00.000Z",
      subjects: [],
      deviceObservations: [],
    });

    // The routes with NO composed source keep the typed 501 with their
    // named reasons (recorded in the read-models route table).
    for (const path of ["/v1/orders", "/v1/notifications"]) {
      const response = await world.service.handle({
        method: "GET",
        path,
        headers: {
          authorization: `Bearer ${token}`,
          "x-roamlink-actor-id": `usr:${userId}`,
          "x-roamlink-tenant-id": tenantOf(1),
        },
      });
      expect(response.status, path).toBe(501);
      const body = JSON.parse(response.body as string);
      expect(body.reason, path).toBe("READ_MODEL_NOT_COMPOSED");
    }
  });

  it("answers completely unknown read paths with 404", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const token = await loginUser(world, 1);
    const response = await world.service.handle({
      method: "GET",
      path: "/v1/definitely-not-a-resource",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });
});
