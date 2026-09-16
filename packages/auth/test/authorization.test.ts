/**
 * RL-004 boundary authorization tests: the fail-closed actor->tenant matrix.
 * Every path that is not an explicit grant must throw UnauthorizedError.
 */
import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@roamlink/contracts";
import { fixtureCommandEnvelope } from "@roamlink/testkit";

import { TestWorld, userSeed } from "./helpers.js";

async function worldWithOrg() {
  const world = new TestWorld();
  const owner = await world.registerUser(1);
  const admin = await world.registerUser(2);
  const member = await world.registerUser(3);
  const outsider = await world.registerUser(4);
  const organizationId = await world.createOrganization(1, 100);
  await world.addMember(1, organizationId, admin, "admin", "admin");
  await world.addMember(1, organizationId, member, "member", "member");
  return { world, owner, admin, member, outsider, organizationId };
}

describe("AuthorizationService fail-closed matrix", () => {
  it("resolves the personal tenant for its own user principal only", async () => {
    const { world, owner } = await worldWithOrg();
    const tenantId = `usr:${owner}` as never;
    const resolution = await world.authorization.resolveActorTenant(
      `usr:${owner}` as never,
      tenantId,
      world.clock.now(),
    );
    expect(resolution.scope).toBe("user");
    // Another user's personal tenant: fail closed.
    await expect(
      world.authorization.resolveActorTenant(
        `usr:${userSeed(2)}` as never,
        tenantId,
        world.clock.now(),
      ),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("grants role-based permissions in an organization tenant", async () => {
    const { world, owner, admin, member, organizationId } = await worldWithOrg();
    const tenantId = `org:${organizationId}` as never;
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, tenantId, "owner:manage", world.clock.now()),
    ).resolves.toMatchObject({ scope: "organization", role: "owner" });
    await expect(
      world.authorization.authorize(`usr:${admin}` as never, tenantId, "member:invite", world.clock.now()),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      world.authorization.authorize(`usr:${member}` as never, tenantId, "org:read", world.clock.now()),
    ).resolves.toMatchObject({ role: "member" });
  });

  it("denies permissions the role does not hold", async () => {
    const { world, admin, member, organizationId } = await worldWithOrg();
    const tenantId = `org:${organizationId}` as never;
    await expect(
      world.authorization.authorize(`usr:${admin}` as never, tenantId, "owner:manage", world.clock.now()),
    ).rejects.toThrowError(UnauthorizedError);
    await expect(
      world.authorization.authorize(`usr:${member}` as never, tenantId, "member:invite", world.clock.now()),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("denies non-members and members of OTHER organizations (no cross-tenant oracle)", async () => {
    const { world, outsider, admin, organizationId } = await worldWithOrg();
    const tenantId = `org:${organizationId}` as never;
    await expect(
      world.authorization.authorize(`usr:${outsider}` as never, tenantId, "org:read", world.clock.now()),
    ).rejects.toThrowError(/no active membership/);
    // Admin of org A reading a non-existent org B tenant id: same failure.
    await expect(
      world.authorization.authorize(
        `usr:${admin}` as never,
        "org:00000000-0000-4000-8000-000000000099" as never,
        "org:read",
        world.clock.now(),
      ),
    ).rejects.toThrowError(/no active membership/);
  });

  it("fails closed for malformed actor principals and service principals", async () => {
    const { world, owner } = await worldWithOrg();
    const tenantId = `usr:${owner}` as never;
    await expect(
      world.authorization.resolveActorTenant("garbage" as never, tenantId, world.clock.now()),
    ).rejects.toThrowError(UnauthorizedError);
    await expect(
      world.authorization.resolveActorTenant("svc:edge-sync" as never, tenantId, world.clock.now()),
    ).rejects.toThrowError(/service principals/i);
  });

  it("denies org permissions in personal tenants and account permissions in org tenants", async () => {
    const { world, owner, organizationId } = await worldWithOrg();
    const personalTenant = `usr:${owner}` as never;
    const orgTenant = `org:${organizationId}` as never;
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, personalTenant, "org:read", world.clock.now()),
    ).rejects.toThrowError(/personal tenant/);
    // account:manage is a personal-tenant permission; in an org tenant the
    // plain member role does not hold it (fail closed on role grants).
    const member = userSeed(3);
    await expect(
      world.authorization.authorize(`usr:${member}` as never, orgTenant, "account:manage", world.clock.now()),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("a suspended organization blocks access; the sanctioned escape unblocks ONLY org:manage", async () => {
    const { world, owner, organizationId } = await worldWithOrg();
    const tenantId = `org:${organizationId}` as never;
    await world.administration.suspendOrganization(
      fixtureCommandEnvelope({
        actorId: `usr:${owner}`,
        tenantId,
        idempotencyKey: "suspend-org-1",
        createdAt: world.clock.now(),
      }),
      { organizationId },
    );
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, tenantId, "org:read", world.clock.now()),
    ).rejects.toThrowError(/suspended/);
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, tenantId, "org:manage", world.clock.now()),
    ).rejects.toThrowError(/suspended/);
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, tenantId, "org:manage", world.clock.now(), {
        allowSuspendedOrganization: true,
      }),
    ).resolves.toMatchObject({ scope: "organization" });
    // The escape never widens beyond org:manage.
    await expect(
      world.authorization.authorize(`usr:${owner}` as never, tenantId, "org:read", world.clock.now(), {
        allowSuspendedOrganization: true,
      }),
    ).rejects.toThrowError(/escape is scoped/);
  });

  it("a revoked membership loses access immediately", async () => {
    const { world, organizationId } = await worldWithOrg();
    const tenantId = `org:${organizationId}` as never;
    const member = userSeed(3);
    const listed = await world.memberships.listByUser(member);
    const membershipId = listed[0]?.membershipId as string;
    await world.administration.revokeMembership(
      fixtureCommandEnvelope({
        actorId: `usr:${userSeed(1)}`,
        tenantId,
        idempotencyKey: "revoke-member-1",
        createdAt: world.clock.now(),
      }),
      { organizationId, membershipId },
    );
    await expect(
      world.authorization.authorize(`usr:${member}` as never, tenantId, "org:read", world.clock.now()),
    ).rejects.toThrowError(/no active membership/);
  });
});
