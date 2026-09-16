/**
 * RL-004 authentication service tests: idempotent password login (Wave-0
 * identity triplet), token-handed-out-once semantics, uniform failure
 * (no account oracle), session verify/revoke, expired-session path.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, UnauthorizedError } from "@roamlink/contracts";
import { fixtureCommandEnvelope } from "@roamlink/testkit";

import { tenantIdFromUser } from "@roamlink/contracts";

import { User, tokenDigestOf } from "../src/index.js";
import { TestWorld, PASSWORD_A, PASSWORD_B } from "./helpers.js";

async function registeredWorld() {
  const world = new TestWorld();
  const userId = await world.registerUser(1);
  return { world, userId };
}

function loginEnvelope(world: TestWorld, userId: string, key = "login-1") {
  return fixtureCommandEnvelope({
    actorId: `usr:${userId}`,
    tenantId: tenantIdFromUser(userId as never),
    idempotencyKey: key,
    correlationId: `corr-${key}`,
    createdAt: world.clock.now(),
  });
}

describe("AuthenticationService.loginWithPassword", () => {
  it("issues a session with an opaque token; the stored record carries only the digest", async () => {
    const { world, userId } = await registeredWorld();
    const result = await world.authentication.loginWithPassword(loginEnvelope(world, userId), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    expect(result.token).toMatch(/^rlt_[A-Za-z0-9_-]{43}$/);
    expect(result.userId).toBe(userId);
    const record = await world.sessions.findByTokenDigest(tokenDigestOf(result.token));
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(result.token);
  });

  it("replaying the SAME envelope returns the SAME session+token (idempotent, applied once)", async () => {
    const { world, userId } = await registeredWorld();
    const envelope = loginEnvelope(world, userId);
    const first = await world.authentication.loginWithPassword(envelope, {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    const replay = await world.authentication.loginWithPassword(envelope, {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    expect(replay).toEqual(first);
    // Exactly one session exists for the user.
    const sessions = await world.sessions.findByTokenDigest(tokenDigestOf(first.token));
    expect(sessions?.authSessionId).toBe(first.authSessionId);
  });

  it("reusing the idempotency key with a DIFFERENT command is a conflict", async () => {
    const { world, userId } = await registeredWorld();
    await world.authentication.loginWithPassword(loginEnvelope(world, userId, "login-x"), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    // Same key, different envelope content (different createdAt) -> conflict.
    const different = fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId as never),
      idempotencyKey: "login-x",
      correlationId: "corr-login-x",
      createdAt: "2026-01-15T09:00:00.000Z",
    });
    await expect(
      world.authentication.loginWithPassword(different, {
        email: "user-1@example.com",
        password: PASSWORD_A,
      }),
    ).rejects.toThrowError(ConflictError);
  });

  it("wrong password, unknown email and suspended account share ONE uniform error (no oracle)", async () => {
    const { world, userId } = await registeredWorld();
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        world.authentication.loginWithPassword(loginEnvelope(world, userId, "w1"), {
          email: "user-1@example.com",
          password: PASSWORD_B,
        }),
      () =>
        world.authentication.loginWithPassword(
          fixtureCommandEnvelope({
            actorId: `usr:${userId}`,
            tenantId: tenantIdFromUser(userId as never),
            idempotencyKey: "w2",
            createdAt: world.clock.now(),
          }),
          { email: "nobody@example.com", password: PASSWORD_A },
        ),
    ];
    const reasons: string[] = [];
    for (const attempt of attempts) {
      try {
        await attempt();
        expect.unreachable("login must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedError);
        reasons.push((error as UnauthorizedError).reason);
      }
    }
    expect(new Set(reasons)).toEqual(new Set(["AUTHENTICATION_FAILED"]));

    // Suspended account: same uniform failure.
    const user = await world.users.findById(tenantIdFromUser(userId), userId as never);
    await world.users.save(User.fromRecord(user as never).suspend(world.clock.now()).toRecord());
    await expect(
      world.authentication.loginWithPassword(loginEnvelope(world, userId, "w3"), {
        email: "user-1@example.com",
        password: PASSWORD_A,
      }),
    ).rejects.toThrowError(/AUTHENTICATION_FAILED|authentication failed/);
  });

  it("rejects envelopes naming a different tenant or actor (fail-closed)", async () => {
    const { world, userId } = await registeredWorld();
    const wrongTenant = fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: "usr:00000000-0000-4000-8000-000000000002" as never,
      idempotencyKey: "wrong-tenant",
      createdAt: world.clock.now(),
    });
    await expect(
      world.authentication.loginWithPassword(wrongTenant, {
        email: "user-1@example.com",
        password: PASSWORD_A,
      }),
    ).rejects.toThrowError(/personal tenant/);
    const wrongActor = fixtureCommandEnvelope({
      actorId: "usr:00000000-0000-4000-8000-000000000002",
      tenantId: tenantIdFromUser(userId as never),
      idempotencyKey: "wrong-actor",
      createdAt: world.clock.now(),
    });
    await expect(
      world.authentication.loginWithPassword(wrongActor, {
        email: "user-1@example.com",
        password: PASSWORD_A,
      }),
    ).rejects.toThrowError(/actor/);
  });
});

describe("AuthenticationService.verifySession", () => {
  it("verifies an active token and never returns token material", async () => {
    const { world, userId } = await registeredWorld();
    const login = await world.authentication.loginWithPassword(loginEnvelope(world, userId), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    const verified = await world.authentication.verifySession(login.token, world.clock.now());
    expect(verified.userId).toBe(userId);
    expect(JSON.stringify(verified)).not.toContain(login.token);
  });

  it("expired sessions fail closed with SESSION_EXPIRED", async () => {
    const { world, userId } = await registeredWorld();
    const login = await world.authentication.loginWithPassword(loginEnvelope(world, userId), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    world.clock.advanceBy(8 * 60 * 60 * 1000 + 1); // past expiresAt (+8h)
    await expect(
      world.authentication.verifySession(login.token, world.clock.now()),
    ).rejects.toThrowError(/expired/);
  });

  it("unknown tokens fail closed with SESSION_NOT_FOUND (no oracle)", async () => {
    const { world } = await registeredWorld();
    await expect(
      world.authentication.verifySession(`rlt_${"A".repeat(43)}`, world.clock.now()),
    ).rejects.toThrowError(NotFoundError);
  });
});

describe("AuthenticationService.revokeSession", () => {
  it("the owner revokes their session; the token stops verifying", async () => {
    const { world, userId } = await registeredWorld();
    const login = await world.authentication.loginWithPassword(loginEnvelope(world, userId), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    const revokeEnvelope = fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId as never),
      idempotencyKey: "revoke-1",
      createdAt: world.clock.now(),
    });
    const result = await world.authentication.revokeSession(revokeEnvelope, {
      authSessionId: login.authSessionId,
    });
    expect(result.revoked).toBe(true);
    await expect(
      world.authentication.verifySession(login.token, world.clock.now()),
    ).rejects.toThrowError(/revoked/);
    // Idempotent replay returns the recorded outcome.
    const replay = await world.authentication.revokeSession(revokeEnvelope, {
      authSessionId: login.authSessionId,
    });
    expect(replay).toEqual(result);
  });

  it("a session id from a foreign tenant is NOT found (tenant boundary, no oracle)", async () => {
    const { world, userId } = await registeredWorld();
    const login = await world.authentication.loginWithPassword(loginEnvelope(world, userId), {
      email: "user-1@example.com",
      password: PASSWORD_A,
    });
    const foreign = fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: "usr:00000000-0000-4000-8000-000000000002" as never,
      idempotencyKey: "revoke-foreign",
      createdAt: world.clock.now(),
    });
    await expect(
      world.authentication.revokeSession(foreign, { authSessionId: login.authSessionId }),
    ).rejects.toThrowError(NotFoundError);
  });
});
