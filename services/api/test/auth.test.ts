/**
 * RL-090: the authentication gate and the auth/session endpoints through the
 * REAL @roamlink/auth boundary (password login, bearer session verification,
 * no-oracle failures).
 */
import { describe, expect, it } from "vitest";
import { tenantIdFromUser } from "@roamlink/contracts";
import { parseActorSessionResource } from "@roamlink/app-kit";

import { PASSWORD_A, T0, createTestWorld, mutationHeaders, userIdFromSeed } from "./helpers.js";

describe("the authentication gate", () => {
  it("rejects requests without a bearer token with the same 401 for every failure shape", async () => {
    const world = createTestWorld();
    const noHeader = await world.service.handle({ method: "GET", path: "/v1/users/me", headers: {} });
    expect(noHeader.status).toBe(401);
    const body = JSON.parse(noHeader.body as string);
    expect(body.reason).toBe("AUTHENTICATION_FAILED");

    const garbage = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(garbage.status).toBe(401);
    expect(JSON.parse(garbage.body as string).reason).toBe("AUTHENTICATION_FAILED");

    const malformed = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(malformed.status).toBe(401);
  });
});

describe("POST /v1/auth/session (password login)", () => {
  it("issues a session through the auth boundary and hands the token out exactly once", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);

    const response = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "login-1" }),
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body as string) as Record<string, unknown>;
    expect(body["userId"]).toBe(userId);
    expect(body["tenantId"]).toBe(tenantIdFromUser(userId));
    expect(typeof body["token"]).toBe("string");
    expect(String(body["token"])).toMatch(/^rlt_/);
    expect(body["expiresAt"]).toBe("2026-01-15T16:30:00.000Z"); // 8h lifetime
    expect(world.clock.now()).toBe(T0); // the clock is not consulted by the handler
  });

  it("answers the SAME token on an idempotent replay (RL-LOCK-014)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const headers = mutationHeaders({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      key: "login-replay-1",
    });
    const first = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers,
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    const replay = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers,
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body as string)["token"]).toBe(JSON.parse(first.body as string)["token"]);
    expect(JSON.parse(replay.body as string)["authSessionId"]).toBe(
      JSON.parse(first.body as string)["authSessionId"],
    );
  });

  it("fails with the same 401 for unknown email and wrong password (no oracle)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const userId = userIdFromSeed(1);

    const unknownEmail = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "login-x1" }),
      body: JSON.stringify({ email: "nobody@example.com", password: PASSWORD_A }),
    });
    const wrongPassword = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "login-x2" }),
      body: JSON.stringify({ email: "user-1@example.com", password: "not-the-password" }),
    });
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(JSON.parse(unknownEmail.body as string)).toEqual(JSON.parse(wrongPassword.body as string));
  });

  it("rejects a reused idempotency key with a DIFFERENT payload (typed conflict)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const headers = mutationHeaders({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      key: "login-conflict-1",
    });
    await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers,
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    const conflict = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers,
      body: JSON.stringify({ email: "user-1@example.com", password: "different-password" }),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body as string)["reason"]).not.toBe("AUTHENTICATION_FAILED");
  });

  it("rejects an incomplete mutation header envelope before any auth work", async () => {
    const world = createTestWorld();
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: { "x-roamlink-actor-id": "usr:x", "x-roamlink-tenant-id": "usr:x" },
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body as string);
    expect(body.reason).toBe("COMMAND_ENVELOPE_INCOMPLETE");
    expect(JSON.stringify(body.details)).toContain("idempotency-key");
  });
});

describe("GET /v1/users/me (the principal view)", () => {
  it("serves the session-derived principal after login", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const login = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: mutationHeaders({
        actorId: `usr:${userId}`,
        tenantId: tenantIdFromUser(userId),
        key: "login-me-1",
      }),
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    const token = JSON.parse(login.body as string)["token"] as string;

    const me = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const body = JSON.parse(me.body as string);
    expect(body["userId"]).toBe(userId);
    expect(body["actorId"]).toBe(`usr:${userId}`);
    // The response IS the contracted ActorSessionResource - no invented
    // fields. The strict app-kit parser (unknown fields rejected) accepting
    // the body is the drift guard: a response that invents extra fields is a
    // contract violation on every fail-closed consumer (the apps' clients,
    // the host's ops surface).
    expect(() => parseActorSessionResource(body)).not.toThrow();
    expect(body["personalTenantId"]).toBeUndefined();
    expect(body["sessionExpiresAt"]).toBeUndefined();
    // The ActorSessionResource fields (app-kit's fail-closed admin gate
    // parses this shape): the session is personal-tenant scoped, so the
    // boundary's own personal-tenant answers are served - nothing invented.
    expect(body["tenantId"]).toBe(tenantIdFromUser(userId));
    expect(body["scope"]).toBe("user");
    expect(body["role"]).toBeNull();
    expect(Array.isArray(body["permissions"])).toBe(true);
  });

  it("refuses an expired session (fail-closed, same 401 shape)", async () => {
    const world = createTestWorld();
    const userId = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const login = await world.service.handle({
      method: "POST",
      path: "/v1/auth/session",
      headers: mutationHeaders({
        actorId: `usr:${userId}`,
        tenantId: tenantIdFromUser(userId),
        key: "login-me-2",
      }),
      body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
    });
    const token = JSON.parse(login.body as string)["token"] as string;
    // Advance the deterministic clock past the 8h session lifetime.
    world.clock.advanceTo("2026-01-15T16:30:00.001Z");
    const me = await world.service.handle({
      method: "GET",
      path: "/v1/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
    expect(JSON.parse(me.body as string)["reason"]).toBe("AUTHENTICATION_FAILED");
  });
});
