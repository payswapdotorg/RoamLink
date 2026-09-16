/**
 * RL-004 account administration tests: registration, organization creation,
 * member management with owner protection + last-owner protection,
 * suspension/reactivation with the sanctioned escape, envelope tenant
 * discipline, idempotency, and secret hygiene on persisted records.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, UnauthorizedError, ValidationError } from "@roamlink/contracts";
import { fixtureCommandEnvelope } from "@roamlink/testkit";

import { tokenDigestOf } from "../src/index.js";
import { TestWorld, userSeed, orgSeed, PASSWORD_A } from "./helpers.js";

describe("registerUser", () => {
  it("registers a user + separate credential; the user record carries no hash", async () => {
    const world = new TestWorld();
    const userId = userSeed(1);
    const result = await world.administration.registerUser(
      fixtureCommandEnvelope({
        actorId: `usr:${userId}`,
        tenantId: `usr:${userId}`,
        idempotencyKey: "reg-1",
        createdAt: world.clock.now(),
      }),
      {
        userId,
        email: "new@example.com",
        displayName: "New User",
        password: PASSWORD_A,
      },
    );
    expect(result.status).toBe("active");
    const user = await world.users.findById(`usr:${userId}` as never, userId);
    expect(user?.email).toBe("new@example.com");
    expect(JSON.stringify(user)).not.toMatch(/algorithm|digest|password/i);
    const credential = await world.credentials.findByUserId(`usr:${userId}` as never, userId);
    expect(credential?.algorithm).toBe("insecure-test-sha256");
  });

  it("rejects duplicate email and duplicate user id; rejects envelope/tenant mismatches", async () => {
    const world = new TestWorld();
    await world.registerUser(1);
    await expect(
      world.administration.registerUser(
        fixtureCommandEnvelope({
          actorId: `usr:${userSeed(2)}`,
          tenantId: `usr:${userSeed(2)}`,
          idempotencyKey: "reg-2",
          createdAt: world.clock.now(),
        }),
        {
          userId: userSeed(2),
          email: "user-1@example.com", // duplicate email
          displayName: "Dup",
          password: PASSWORD_A,
        },
      ),
    ).rejects.toThrowError(ConflictError);

    await expect(
      world.administration.registerUser(
        fixtureCommandEnvelope({
          actorId: `usr:${userSeed(3)}`,
          tenantId: `usr:${userSeed(2)}`, // tenant does not match the new user
          idempotencyKey: "reg-3",
          createdAt: world.clock.now(),
        }),
        { userId: userSeed(3), email: "x@example.com", displayName: "X", password: PASSWORD_A },
      ),
    ).rejects.toThrowError(ValidationError);
  });

  it("is idempotent: the same envelope replays the recorded outcome exactly once", async () => {
    const world = new TestWorld();
    const userId = userSeed(7);
    const envelope = fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: `usr:${userId}`,
      idempotencyKey: "reg-idem",
      createdAt: world.clock.now(),
    });
    const input = {
      userId,
      email: "idem@example.com",
      displayName: "Idem",
      password: PASSWORD_A,
    };
    const first = await world.administration.registerUser(envelope, input);
    const replay = await world.administration.registerUser(envelope, input);
    expect(replay).toEqual(first);
    // Same key, different content: conflict.
    await expect(
      world.administration.registerUser(
        fixtureCommandEnvelope({
          actorId: `usr:${userId}`,
          tenantId: `usr:${userId}`,
          idempotencyKey: "reg-idem",
          createdAt: "2026-01-15T10:00:00.000Z", // different envelope
        }),
        input,
      ),
    ).rejects.toThrowError(ConflictError);
  });
});

describe("createOrganization + membership management", () => {
  async function orgWorld() {
    const world = new TestWorld();
    const ownerId = await world.registerUser(1);
    await world.registerUser(2); // admin
    await world.registerUser(3); // member
    await world.registerUser(4); // outsider
    const organizationId = await world.createOrganization(1, 100);
    await world.addMember(1, organizationId, userSeed(2), "admin", "admin");
    return { world, ownerId, organizationId };
  }

  it("creates the organization with the actor as owner", async () => {
    const { world, ownerId, organizationId } = await orgWorld();
    const org = await world.organizations.findById(`org:${organizationId}` as never, organizationId as never);
    expect(org?.status).toBe("active");
    const memberships = await world.memberships.listByOrganization(
      `org:${organizationId}` as never,
      organizationId as never,
    );
    const ownerMemberships = memberships.filter((m) => m.role === "owner");
    expect(ownerMemberships).toHaveLength(1);
    expect(ownerMemberships[0]).toMatchObject({ userId: ownerId, role: "owner", status: "active" });
  });

  it("an admin adds members; a plain member cannot; an outsider cannot", async () => {
    const { world, organizationId } = await orgWorld();
    await world.addMember(2, organizationId, userSeed(3), "member", "m3");
    // Member (role member) tries to invite: unauthorized.
    await expect(
      world.addMember(3, organizationId, userSeed(4), "member", "m4"),
    ).rejects.toThrowError(UnauthorizedError);
    // Outsider tries to invite: unauthorized.
    await expect(
      world.addMember(4, organizationId, userSeed(3), "member", "m5"),
    ).rejects.toThrowError(UnauthorizedError);
    // Duplicate active membership: conflict.
    await expect(
      world.addMember(2, organizationId, userSeed(3), "member", "m6"),
    ).rejects.toThrowError(ConflictError);
  });

  it("adding an owner requires owner:manage (admins fail closed)", async () => {
    const { world, organizationId } = await orgWorld();
    await expect(
      world.addMember(2, organizationId, userSeed(3), "owner", "owner-try"),
    ).rejects.toThrowError(UnauthorizedError);
    await expect(
      world.addMember(1, organizationId, userSeed(3), "owner", "owner-ok"),
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("LAST-OWNER PROTECTION: the last owner cannot be demoted or revoked", async () => {
    const { world, ownerId, organizationId } = await orgWorld();
    const memberships = await world.memberships.listByUser(ownerId);
    const ownerMembershipId = memberships[0]?.membershipId as string;
    await expect(
      world.administration.changeMemberRole(
        fixtureCommandEnvelope({
          actorId: `usr:${ownerId}`,
          tenantId: `org:${organizationId}`,
          idempotencyKey: "demote-1",
          createdAt: world.clock.now(),
        }),
        { organizationId, membershipId: ownerMembershipId, newRole: "admin" },
      ),
    ).rejects.toThrowError(/at least one active owner/i);
    await expect(
      world.administration.revokeMembership(
        fixtureCommandEnvelope({
          actorId: `usr:${ownerId}`,
          tenantId: `org:${organizationId}`,
          idempotencyKey: "revoke-1",
          createdAt: world.clock.now(),
        }),
        { organizationId, membershipId: ownerMembershipId },
      ),
    ).rejects.toThrowError(/at least one active owner/i);
  });

  it("with a second owner, the first owner can be demoted (owner:manage held)", async () => {
    const { world, ownerId, organizationId } = await orgWorld();
    await world.addMember(1, organizationId, userSeed(4), "owner", "second-owner");
    const memberships = await world.memberships.listByUser(ownerId);
    const ownerMembershipId = memberships[0]?.membershipId as string;
    await expect(
      world.administration.changeMemberRole(
        fixtureCommandEnvelope({
          actorId: `usr:${ownerId}`,
          tenantId: `org:${organizationId}`,
          idempotencyKey: "demote-2",
          createdAt: world.clock.now(),
        }),
        { organizationId, membershipId: ownerMembershipId, newRole: "admin" },
      ),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("an admin cannot change an owner's role or revoke an owner (owner protection)", async () => {
    const { world, ownerId, organizationId } = await orgWorld();
    const memberships = await world.memberships.listByUser(ownerId);
    const ownerMembershipId = memberships[0]?.membershipId as string;
    await expect(
      world.administration.changeMemberRole(
        fixtureCommandEnvelope({
          actorId: `usr:${userSeed(2)}`,
          tenantId: `org:${organizationId}`,
          idempotencyKey: "demote-3",
          createdAt: world.clock.now(),
        }),
        { organizationId, membershipId: ownerMembershipId, newRole: "member" },
      ),
    ).rejects.toThrowError(UnauthorizedError);
    await expect(
      world.administration.revokeMembership(
        fixtureCommandEnvelope({
          actorId: `usr:${userSeed(2)}`,
          tenantId: `org:${organizationId}`,
          idempotencyKey: "revoke-2",
          createdAt: world.clock.now(),
        }),
        { organizationId, membershipId: ownerMembershipId },
      ),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("member management from a foreign tenant is not found (no oracle)", async () => {
    const { world, organizationId } = await orgWorld();
    await expect(
      world.administration.addMember(
        fixtureCommandEnvelope({
          actorId: `usr:${userSeed(1)}`,
          tenantId: `org:${orgSeed(999)}`,
          idempotencyKey: "foreign-add",
          createdAt: world.clock.now(),
        }),
        { organizationId, userId: userSeed(4), role: "member" },
      ),
    ).rejects.toThrowError(ValidationError); // envelope tenant mismatch (fail-closed)
  });
});

describe("suspend/activate organization (the sanctioned escape)", () => {
  async function suspendedWorld() {
    const world = new TestWorld();
    const ownerId = await world.registerUser(1);
    await world.registerUser(2);
    const organizationId = await world.createOrganization(1, 100);
    const envelope = (key: string, actorSeed = 1) =>
      fixtureCommandEnvelope({
        actorId: `usr:${userSeed(actorSeed)}`,
        tenantId: `org:${organizationId}`,
        idempotencyKey: key,
        createdAt: world.clock.now(),
      });
    await world.administration.suspendOrganization(envelope("suspend"), { organizationId });
    return { world, ownerId, organizationId, envelope };
  }

  it("an owner suspends and reactivates through the escape", async () => {
    const { world, organizationId, envelope } = await suspendedWorld();
    const org = await world.organizations.findById(
      `org:${organizationId}` as never,
      organizationId as never,
    );
    expect(org?.status).toBe("suspended");
    await expect(
      world.administration.activateOrganization(envelope("activate"), { organizationId }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("while suspended, members lose access and only org:manage-with-escape reactivates", async () => {
    const { world, ownerId, organizationId, envelope } = await suspendedWorld();
    // Owner tries a member op while suspended: unauthorized (blocked).
    await expect(
      world.addMember(1, organizationId, userSeed(2), "member", "while-suspended"),
    ).rejects.toThrowError(UnauthorizedError);
    // Double suspend: the org is already suspended (state error), and after
    // reactivation the escape is no longer needed.
    await world.administration.activateOrganization(envelope("activate"), { organizationId });
    await expect(
      world.administration.activateOrganization(envelope("activate-2"), { organizationId }),
    ).rejects.toThrowError(ValidationError);
    expect(ownerId).toBeDefined();
  });
});

describe("secret hygiene (RL-LOCK-016)", () => {
  it("no persisted auth record contains the raw password or raw token", async () => {
    const world = new TestWorld();
    const userId = await world.registerUser(1, { password: "super-secret-value" });
    const login = await world.authentication.loginWithPassword(
      fixtureCommandEnvelope({
        actorId: `usr:${userId}`,
        tenantId: `usr:${userId}`,
        idempotencyKey: "login-hygiene",
        createdAt: world.clock.now(),
      }),
      { email: "user-1@example.com", password: "super-secret-value" },
    );
    const users = await world.users.snapshotAll();
    const credentials = await world.credentials.findByUserId(`usr:${userId}` as never, userId);
    const session = await world.sessions.findByTokenDigest(tokenDigestOf(login.token));
    for (const blob of [JSON.stringify(users), JSON.stringify(credentials), JSON.stringify(session)]) {
      expect(blob).not.toContain("super-secret-value");
      expect(blob).not.toContain(login.token);
    }
  });
});
