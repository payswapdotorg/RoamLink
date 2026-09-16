/**
 * RL-004 session aggregate tests (issue/verify/revoke, bounded lifetime,
 * inclusive expiry boundary) and in-memory repository tests (CAS + the
 * cross-tenant fail-closed proofs, RL-LOCK-018-style boundary tests).
 */
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError, parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import {
  AuthSession,
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserRepository,
  Organization,
  Membership,
  User,
  tokenDigestOf,
  generateAuthToken,
} from "../src/index.js";

import { T0, userSeed } from "./helpers.js";

const at = (iso: string) => parseUtcInstant(iso);

const DIGEST = tokenDigestOf(generateAuthToken());
const SESSION_ID = deterministicUuidFromSeed(500);

function sessionInput(overrides?: Partial<Parameters<typeof AuthSession.issue>[0]>) {
  return {
    authSessionId: SESSION_ID,
    userId: userSeed(1),
    tokenDigest: DIGEST,
    issuedAt: at(T0),
    ...overrides,
  };
}

describe("AuthSession aggregate", () => {
  it("issues with the default lifetime and computes expiresAt", () => {
    const session = AuthSession.issue(sessionInput());
    expect(session.issuedAt).toBe(T0);
    expect(session.expiresAt).toBe("2026-01-15T16:30:00.000Z"); // +8h
    expect(session.revision).toBe(1);
    expect(Object.isFrozen(session)).toBe(true);
  });

  it("rejects lifetimes outside the bounds", () => {
    expect(() => AuthSession.issue(sessionInput({ lifetimeMs: 59_999 }))).toThrowError(ValidationError);
    expect(() => AuthSession.issue(sessionInput({ lifetimeMs: 43_200_001 }))).toThrowError(
      ValidationError,
    );
    AuthSession.issue(sessionInput({ lifetimeMs: 60_000 }));
    AuthSession.issue(sessionInput({ lifetimeMs: 43_200_000 }));
  });

  it("verify() is valid THROUGH the expiry instant (inclusive boundary) and rejects after", () => {
    const session = AuthSession.issue(sessionInput({ lifetimeMs: 60_000 }));
    expect(session.verify(session.expiresAt).status).toBe("active");
    expect(() => session.verify(at("2026-01-15T08:31:00.001Z"))).toThrowError(/expired/);
  });

  it("verify() rejects revoked sessions; revoke is idempotent and bumps the revision once", () => {
    const session = AuthSession.issue(sessionInput());
    const revoked = session.revoke(at("2026-01-15T09:00:00.000Z"));
    expect(revoked.revokedAt).toBe("2026-01-15T09:00:00.000Z");
    expect(revoked.revision).toBe(2);
    expect(() => revoked.verify(at("2026-01-15T09:00:01.000Z"))).toThrowError(/revoked/);
    expect(revoked.revoke(at("2026-01-15T09:05:00.000Z"))).toBe(revoked); // no-op
    expect(revoked.revision).toBe(2);
  });

  it("status() reports active/expired/revoked and rejects revokedAt before issuedAt", () => {
    const session = AuthSession.issue(sessionInput({ lifetimeMs: 60_000 }));
    expect(session.status(at("2026-01-15T08:30:30.000Z"))).toBe("active");
    expect(session.status(at("2026-01-15T08:32:00.000Z"))).toBe("expired");
    expect(session.revoke(at("2026-01-15T08:30:10.000Z")).status(at("2026-01-15T08:29:00.000Z"))).toBe(
      "revoked",
    );
    expect(
      () =>
        new AuthSession({
          authSessionId: SESSION_ID,
          userId: userSeed(1),
          tokenDigest: DIGEST,
          issuedAt: at(T0),
          expiresAt: "2026-01-15T09:30:00.000Z",
          revokedAt: at("2026-01-15T08:00:00.000Z"),
          revision: 1,
        }),
    ).toThrowError(ValidationError);
  });
});

describe("in-memory repositories: optimistic concurrency (CAS)", () => {
  it("rejects stale writes with a typed ConflictError, never silent overwrite", async () => {
    const users = new InMemoryUserRepository();
    const userId = userSeed(1);
    const record = new User({
      userId,
      email: "u@example.com",
      displayName: "U",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    }).toRecord();
    await users.save(record);
    // Revision-1 write again (stale): conflict.
    await expect(users.save(record)).rejects.toThrowError(ConflictError);
    // Skip-ahead write (revision 3 without stored 2): conflict.
    await expect(
      users.save({ ...record, revision: 3 as never }),
    ).rejects.toThrowError(ConflictError);
    // Correct successor (revision 2) succeeds.
    await users.save({ ...record, displayName: "U2" as never, revision: 2 as never });
    const stored = await users.findById(record.tenantId, userId);
    expect(stored?.displayName).toBe("U2");
  });

  it("membership/org/session stores enforce the same CAS discipline", async () => {
    const orgs = new InMemoryOrganizationRepository();
    const org = new Organization({
      organizationId: deterministicUuidFromSeed(2),
      name: "Acahat",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    }).toRecord();
    await orgs.save(org);
    await expect(orgs.save(org)).rejects.toThrowError(ConflictError);
    await expect(
      orgs.save({ ...org, name: "Acahat2" as never, revision: 2 as never }),
    ).resolves.toBeUndefined();

    const memberships = new InMemoryMembershipRepository();
    const membership = new Membership({
      membershipId: deterministicUuidFromSeed(3),
      organizationId: deterministicUuidFromSeed(2),
      userId: userSeed(1),
      role: "member",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    }).toRecord();
    await memberships.save(membership);
    await expect(memberships.save(membership)).rejects.toThrowError(ConflictError);

    const sessions = new InMemoryAuthSessionRepository();
    const session = AuthSession.issue({
      authSessionId: SESSION_ID,
      userId: userSeed(1),
      tokenDigest: DIGEST,
      issuedAt: at(T0),
    }).toRecord();
    await sessions.save(session);
    await expect(sessions.save(session)).rejects.toThrowError(ConflictError);
  });

  it("credential store enforces CAS too", async () => {
    const credentials = new InMemoryCredentialRepository();
    const userId = userSeed(1);
    const record = {
      tenantId: `usr:${userId}` as never,
      userId,
      algorithm: "insecure-test-sha256",
      digest: "a".repeat(64),
      updatedAt: at(T0),
      revision: 1 as never,
    };
    await credentials.save(record);
    await expect(credentials.save(record)).rejects.toThrowError(ConflictError);
  });
});

describe("in-memory repositories: cross-tenant fail-closed proofs", () => {
  it("PROOF: user/credential reads through a foreign tenant return undefined (no oracle)", async () => {
    const users = new InMemoryUserRepository();
    const credentials = new InMemoryCredentialRepository();
    const a = userSeed(1);
    const b = userSeed(2);
    const user = new User({
      userId: a,
      email: "a@example.com" as never,
      displayName: "A",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    });
    await users.save(user.toRecord());
    await credentials.save({
      tenantId: user.tenantId,
      userId: a,
      algorithm: "insecure-test-sha256",
      digest: "a".repeat(64),
      updatedAt: at(T0),
      revision: 1 as never,
    });

    // Foreign personal tenant: everything fails closed.
    const foreignTenant = `usr:${b}` as never;
    expect(await users.findById(foreignTenant, a)).toBeUndefined();
    expect(await users.findByEmail(foreignTenant, "a@example.com" as never)).toBeUndefined();
    expect(await credentials.findByUserId(foreignTenant, a)).toBeUndefined();
    // Correct tenant still resolves.
    expect((await users.findById(user.tenantId, a))?.email).toBe("a@example.com");
  });

  it("PROOF: organization/membership reads through a foreign tenant fail closed", async () => {
    const organizations = new InMemoryOrganizationRepository();
    const memberships = new InMemoryMembershipRepository();
    const orgId = deterministicUuidFromSeed(2);
    const org = new Organization({
      organizationId: orgId,
      name: "Acahat",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    });
    await organizations.save(org.toRecord());
    const membership = new Membership({
      membershipId: deterministicUuidFromSeed(3),
      organizationId: orgId,
      userId: userSeed(1),
      role: "owner",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    });
    await memberships.save(membership.toRecord());

    const foreignTenant = "usr:00000000-0000-4000-8000-000000000009" as never;
    expect(await organizations.findById(foreignTenant, orgId as never)).toBeUndefined();
    expect(
      await memberships.findById(foreignTenant, membership.membershipId as never),
    ).toBeUndefined();
    expect(await memberships.listByOrganization(foreignTenant, orgId as never)).toEqual([]);
    // The sanctioned listByUser read still resolves (actor -> tenants).
    expect(await memberships.listByUser(userSeed(1))).toHaveLength(1);
  });

  it("PROOF: session reads are tenant-scoped by id; only the token-digest bearer read is global", async () => {
    const sessions = new InMemoryAuthSessionRepository();
    const record = AuthSession.issue({
      authSessionId: SESSION_ID,
      userId: userSeed(1),
      tokenDigest: DIGEST,
      issuedAt: at(T0),
    }).toRecord();
    await sessions.save(record);

    const foreignTenant = "usr:00000000-0000-4000-8000-000000000009" as never;
    expect(await sessions.findById(foreignTenant, record.authSessionId)).toBeUndefined();
    expect(await sessions.findById(record.tenantId, record.authSessionId)).toBeDefined();
    // The bearer read resolves by digest (possession of the token).
    expect(await sessions.findByTokenDigest(DIGEST)).toBeDefined();
    expect(await sessions.findByTokenDigest(tokenDigestOf(generateAuthToken()))).toBeUndefined();
  });

  it("stored records are frozen copies: mutating the caller's object cannot rewrite history", async () => {
    const users = new InMemoryUserRepository();
    const userId = userSeed(1);
    const record = new User({
      userId,
      email: "u@example.com",
      displayName: "U",
      status: "active",
      createdAt: at(T0),
      updatedAt: at(T0),
      revision: 1,
    }).toRecord();
    await users.save(record);
    const stored = await users.findById(record.tenantId, userId);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as unknown as { displayName?: string }).displayName = "Hacked";
    }).toThrowError(TypeError);
  });
});
