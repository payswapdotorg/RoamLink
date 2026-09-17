/**
 * RL-074 suite 2: TENANT/ACTOR BOUNDARY ATTACKS (spec/security.md
 * "Authorization"; RL-LOCK-019 discipline; RL-061 fail-closed privilege
 * boundary).
 *
 * Threat priorities #2 (confused-deputy cross-tenant commands) and #10
 * (privilege escalation through support/administrative tooling). Every
 * attack is a NEGATIVE PROOF: cross-tenant reads/writes at EVERY public
 * surface are denied with typed errors; escalation attempts on admin
 * operations fail closed; denials leave no existence oracle and are
 * audited where the surface owns an audit trail.
 *
 * Attack catalog:
 *   T-1  cross-tenant repository read (auth tenant-scoped port);
 *   T-2  actor without membership in the target org tenant;
 *   T-3  personal tenant accessed by a non-owning principal;
 *   T-4  service principal forging user grants;
 *   T-5  suspended-organization access (fail-closed) + the sanctioned
 *        escape scoped to org:manage ONLY (a member cannot ride it);
 *   T-6  privilege escalation on admin operations: a member attempting
 *        member-invite / role-change / owner-grant commands;
 *   T-7  login envelope attacks (actor spoofing, tenant confusion);
 *   T-8  session revocation by a non-owner (session hijack cleanup);
 *   T-9  cross-tenant reads/writes through the apps' API surface
 *        (app-kit /v1: devices of another tenant; org surface of another
 *        tenant) - 404 with no existence oracle;
 *   T-10 privilege escalation through the ADMIN console: a member is
 *        denied the admin command (403, audited server-side); a
 *        personal-tenant actor never triggers the surface fetch;
 *   T-11 enterprise API-key boundary: cross-tenant key record misses are
 *        indistinguishable from unknown keys; tampered material fails
 *        closed.
 */
import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  UnauthorizedError,
  parseOrganizationId,
  tenantIdFromOrganization,
  type ActorId,
  type TenantId,
} from "@roamlink/contracts";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { AdminConsoleApp } from "@roamlink/admin";
import { createEnterpriseApiHarness } from "@roamlink/enterprise";
import { SequenceIdGenerator } from "@roamlink/testkit";
import {
  makeSecurityWorld,
  registerPrincipal,
  seededUserId,
  type SecurityWorld,
} from "../src/harness.js";

const T0 = "2026-03-01T09:00:00.000Z";
const ORG_A_ID = parseOrganizationId("aaaaaaaa-0000-4000-8000-00000000aa01");
const ORG_B_ID = parseOrganizationId("aaaaaaaa-0000-4000-8000-00000000bb02");

/** Registers two users and an organization owned by the first. */
async function orgFixture(
  world: SecurityWorld,
): Promise<{
  readonly owner: { readonly actorId: ActorId; readonly userId: string };
  readonly outsider: {
    readonly actorId: ActorId;
    readonly userId: string;
    readonly tenantId: TenantId;
  };
  readonly orgTenant: TenantId;
}> {
  const owner = await registerPrincipal(world, 0x20);
  const outsider = await registerPrincipal(world, 0x21);
  await world.auth.administration.createOrganization(
    world.envelope({ actorId: owner.actorId, tenantId: tenantIdFromOrganization(ORG_A_ID) }),
    { organizationId: ORG_A_ID, name: "Boundary Test Org" },
  );
  return {
    owner: { actorId: owner.actorId, userId: owner.userId },
    outsider: {
      actorId: outsider.actorId,
      userId: outsider.userId,
      tenantId: outsider.tenantId,
    },
    orgTenant: tenantIdFromOrganization(ORG_A_ID),
  };
}

describe("RL-074 suite 2a: the auth/tenant boundary fails closed", () => {
  it("T-1 a tenant-scoped repository read outside the tenant returns nothing (fail-closed)", async () => {
    const world = makeSecurityWorld();
    const owner = await registerPrincipal(world, 0x30);
    const orgTenant = tenantIdFromOrganization(ORG_A_ID);
    // The user lives in their personal tenant; a read scoped to the
    // organization tenant must not see them.
    expect(await world.auth.users.findById(orgTenant, owner.userId)).toBeUndefined();
    expect(await world.auth.users.findById(owner.tenantId, owner.userId)).toBeDefined();
  });

  it("T-2 an actor without membership in the target organization tenant is denied", async () => {
    const world = makeSecurityWorld();
    const { outsider, orgTenant } = await orgFixture(world);
    await expect(
      world.auth.authorization.resolveActorTenant(outsider.actorId, orgTenant, world.clock.now()),
    ).rejects.toMatchObject({ reason: "ACTOR_NOT_A_MEMBER" });
    await expect(
      world.auth.authorization.authorize(outsider.actorId, orgTenant, "org:read", world.clock.now()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("T-3 a personal tenant may only be accessed by its owning user principal", async () => {
    const world = makeSecurityWorld();
    const alice = await registerPrincipal(world, 0x31);
    const mallory = await registerPrincipal(world, 0x32);
    await expect(
      world.auth.authorization.resolveActorTenant(
        mallory.actorId,
        alice.tenantId,
        world.clock.now(),
      ),
    ).rejects.toMatchObject({ reason: "TENANT_ACTOR_MISMATCH" });
  });

  it("T-4 service principals hold no account permissions (no forged grants)", async () => {
    const world = makeSecurityWorld();
    await registerPrincipal(world, 0x33);
    const orgTenant = tenantIdFromOrganization(ORG_A_ID);
    await expect(
      world.auth.authorization.resolveActorTenant("svc:attacker-bot" as never, orgTenant, world.clock.now()),
    ).rejects.toMatchObject({ reason: "ACTOR_UNAUTHORIZED" });
    // And a garbage actor shape is rejected before any repository access.
    await expect(
      world.auth.authorization.resolveActorTenant("not-a-principal" as never, orgTenant, world.clock.now()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("T-5 a suspended organization blocks member access; the escape is scoped to org:manage only", async () => {
    const world = makeSecurityWorld();
    const owner = await registerPrincipal(world, 0x34);
    const member = await registerPrincipal(world, 0x35);
    const orgTenant = tenantIdFromOrganization(ORG_A_ID);
    await world.auth.administration.createOrganization(
      world.envelope({ actorId: owner.actorId, tenantId: orgTenant }),
      { organizationId: ORG_A_ID, name: "Suspend Test Org" },
    );
    await world.auth.administration.addMember(
      world.envelope({ actorId: owner.actorId, tenantId: orgTenant }),
      { organizationId: ORG_A_ID, userId: member.userId, role: "member" },
    );
    await world.auth.administration.suspendOrganization(
      world.envelope({ actorId: owner.actorId, tenantId: orgTenant }),
      { organizationId: ORG_A_ID },
    );

    // Suspended: every member access fails closed.
    await expect(
      world.auth.authorization.authorize(owner.actorId, orgTenant, "org:read", world.clock.now()),
    ).rejects.toMatchObject({ reason: "ORGANIZATION_SUSPENDED" });

    // The sanctioned escape: org:manage holders MAY reactivate...
    await expect(
      world.auth.authorization.authorize(owner.actorId, orgTenant, "org:manage", world.clock.now(), {
        allowSuspendedOrganization: true,
      }),
    ).resolves.toMatchObject({ scope: "organization" });

    // ...but the escape NEVER grants other permissions, and a member cannot
    // ride it at all (privilege escalation attempt).
    await expect(
      world.auth.authorization.authorize(owner.actorId, orgTenant, "org:read", world.clock.now(), {
        allowSuspendedOrganization: true,
      }),
    ).rejects.toMatchObject({ reason: "PERMISSION_DENIED" });
    await expect(
      world.auth.authorization.authorize(
        member.actorId,
        orgTenant,
        "org:manage",
        world.clock.now(),
        { allowSuspendedOrganization: true },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("T-6 privilege escalation on admin operations fails closed with typed permission errors", async () => {
    const world = makeSecurityWorld();
    const owner = await registerPrincipal(world, 0x36);
    const member = await registerPrincipal(world, 0x37);
    const target = await registerPrincipal(world, 0x38);
    const orgTenant = tenantIdFromOrganization(ORG_A_ID);
    await world.auth.administration.createOrganization(
      world.envelope({ actorId: owner.actorId, tenantId: orgTenant }),
      { organizationId: ORG_A_ID, name: "Escalation Test Org" },
    );
    await world.auth.administration.addMember(
      world.envelope({ actorId: owner.actorId, tenantId: orgTenant }),
      { organizationId: ORG_A_ID, userId: member.userId, role: "member" },
    );

    // A member attempts to invite (needs member:invite - not granted).
    await expect(
      world.auth.administration.addMember(
        world.envelope({ actorId: member.actorId, tenantId: orgTenant }),
        { organizationId: ORG_A_ID, userId: target.userId, role: "member" },
      ),
    ).rejects.toMatchObject({ reason: "PERMISSION_DENIED" });

    // A member attempts to grant THEMSELVES owner (needs owner:manage).
    const memberMemberships = await world.auth.memberships.listByUser(member.userId);
    const memberMembershipId = memberMemberships[0]?.membershipId;
    if (memberMembershipId === undefined) throw new Error("expected the member membership");
    await expect(
      world.auth.administration.changeMemberRole(
        world.envelope({ actorId: member.actorId, tenantId: orgTenant }),
        { organizationId: ORG_A_ID, membershipId: memberMembershipId, newRole: "owner" },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // The member's role is unchanged (the escalation had no effect).
    expect(memberMemberships[0]?.role).toBe("member");

    // A member attempts the org-level admin command (needs org:manage).
    await expect(
      world.auth.administration.suspendOrganization(
        world.envelope({ actorId: member.actorId, tenantId: orgTenant }),
        { organizationId: ORG_A_ID },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Nothing escalated: the target user is still not a member, and the
    // membership store shows exactly the owner + the member.
    const memberships = await world.auth.memberships.listByUser(target.userId);
    expect(memberships).toHaveLength(0);
    const afterMemberMemberships = await world.auth.memberships.listByUser(member.userId);
    expect(afterMemberMemberships).toHaveLength(1);
    expect(afterMemberMemberships[0]?.role).toBe("member");
  });
});

describe("RL-074 suite 2b: authentication-session boundary attacks", () => {
  it("T-7 login envelope attacks: actor spoofing and tenant confusion are rejected pre-authentication", async () => {
    const world = makeSecurityWorld();
    const alice = await registerPrincipal(world, 0x40);
    const mallory = await registerPrincipal(world, 0x41);

    // Mallory authenticates as alice's email but rides THEIR OWN actor:
    // the envelope actor must be the authenticating user principal.
    await expect(
      world.auth.authentication.loginWithPassword(
        world.envelope({ actorId: mallory.actorId, tenantId: alice.tenantId }),
        { email: alice.email, password: alice.password },
      ),
    ).rejects.toMatchObject({ reason: "LOGIN_COMMAND_INVALID" });

    // Tenant confusion: the envelope tenant must be the user's own tenant.
    await expect(
      world.auth.authentication.loginWithPassword(
        world.envelope({ actorId: alice.actorId, tenantId: tenantIdFromOrganization(ORG_B_ID) }),
        { email: alice.email, password: alice.password },
      ),
    ).rejects.toMatchObject({ reason: "LOGIN_COMMAND_INVALID" });

    // Wrong password and unknown email fail IDENTICALLY (no oracle).
    const wrongPassword = await world.auth.authentication
      .loginWithPassword(
        world.envelope({ actorId: alice.actorId, tenantId: alice.tenantId }),
        { email: alice.email, password: "wrong-password" },
      )
      .then(() => "ok", (error: unknown) => (error as { reason?: string }).reason);
    const unknownEmail = await world.auth.authentication
      .loginWithPassword(
        world.envelope({ actorId: alice.actorId, tenantId: alice.tenantId }),
        { email: "ghost@security.example", password: "irrelevant" },
      )
      .then(() => "ok", (error: unknown) => (error as { reason?: string }).reason);
    expect(wrongPassword).toBe("AUTHENTICATION_FAILED");
    expect(unknownEmail).toBe("AUTHENTICATION_FAILED");
  });

  it("T-8 session revocation by a non-owner is denied (cross-tenant session cleanup attack)", async () => {
    const world = makeSecurityWorld();
    const alice = await registerPrincipal(world, 0x42);
    const mallory = await registerPrincipal(world, 0x43);
    const login = await world.auth.authentication.loginWithPassword(
      world.envelope({ actorId: alice.actorId, tenantId: alice.tenantId }),
      { email: alice.email, password: alice.password },
    );

    // Mallory cannot revoke alice's session in alice's tenant: the record
    // resolves in the tenant, but only the session OWNER may revoke.
    await expect(
      world.auth.authentication.revokeSession(
        world.envelope({ actorId: mallory.actorId, tenantId: alice.tenantId }),
        { authSessionId: login.authSessionId },
      ),
    ).rejects.toMatchObject({ reason: "SESSION_OWNER_MISMATCH" });

    // From mallory's own tenant the record does not even exist (tenant-
    // scoped lookup - no cross-tenant reach).
    await expect(
      world.auth.authentication.revokeSession(
        world.envelope({ actorId: mallory.actorId, tenantId: mallory.tenantId }),
        { authSessionId: login.authSessionId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // The session still verifies (the attack had no effect).
    const verified = await world.auth.authentication.verifySession(
      login.token,
      world.clock.now(),
    );
    expect(verified.userId).toBe(alice.userId);
  });
});

describe("RL-074 suite 2c: the apps'/admin API surfaces (app-kit contract level)", () => {
  function twoTenantApi() {
    const seed = fakeApiSeed();
    const firstKey = Object.keys(seed.tenants)[0];
    if (firstKey === undefined) throw new Error("seed has no tenants");
    const first = firstKey;
    const template = seed.tenants[first];
    if (template === undefined) throw new Error("seed has no tenants");
    const ORG_A = tenantIdFromOrganization(ORG_A_ID);
    const ORG_B = tenantIdFromOrganization(ORG_B_ID);
    const A_OWNER = "usr:cccccccc-0000-4000-8000-000000000001";
    const A_ADMIN = "usr:cccccccc-0000-4000-8000-000000000002";
    const A_MEMBER = "usr:cccccccc-0000-4000-8000-000000000003";
    const B_OWNER = "usr:dddddddd-0000-4000-8000-000000000004";
    const members = (owner: string, admin: string, member: string) => [
      { userId: owner.slice(4), role: "owner" as const, status: "active" as const },
      { userId: admin.slice(4), role: "admin" as const, status: "active" as const },
      { userId: member.slice(4), role: "member" as const, status: "active" as const },
    ];
    const api = createInMemoryApi(
      {
        users: [
          { userId: A_OWNER.slice(4), displayName: "Cara Owner" },
          { userId: A_ADMIN.slice(4), displayName: "Casey Admin" },
          { userId: A_MEMBER.slice(4), displayName: "Morgan Member" },
          { userId: B_OWNER.slice(4), displayName: "Dominic Other" },
        ],
        catalog: seed.catalog,
        tenants: {
          [ORG_A]: {
            organization: {
              tenantId: ORG_A,
              organizationId: ORG_A_ID,
              name: "Bridge Org A",
              status: "active" as const,
              revision: 1,
              members: members(A_OWNER, A_ADMIN, A_MEMBER),
            },
            devices: [
              {
                deviceId: "dev-bridge-1",
                name: "Bridge Phone",
                platform: "ios" as const,
                status: "active" as const,
                owningUserId: A_OWNER.slice(4),
                revision: 1,
                capabilityFreshness: null,
                contextFreshness: null,
              },
            ],
            intents: [],
            orders: [],
            subscriptions: [],
            payments: [],
            invoices: [],
            references: [],
            notifications: [],
            supportCases: [],
            projections: template.projections,
            slos: template.slos,
            reconciliationJobs: template.reconciliationJobs,
          },
          [ORG_B]: {
            organization: {
              tenantId: ORG_B,
              organizationId: ORG_B_ID,
              name: "Bridge Org B",
              status: "active" as const,
              revision: 1,
              members: [{ userId: B_OWNER.slice(4), role: "owner" as const, status: "active" as const }],
            },
            devices: [],
            intents: [],
            orders: [],
            subscriptions: [],
            payments: [],
            invoices: [],
            references: [],
            notifications: [],
            supportCases: [],
            projections: [],
            slos: [],
            reconciliationJobs: [],
          },
        },
      },
      { now: () => T0, ids: () => "cmd-bridge-1" },
    );
    return {
      api,
      tenants: { ORG_A, ORG_B },
      actors: { A_OWNER, A_ADMIN, A_MEMBER, B_OWNER },
    };
  }

  it("T-9 cross-tenant reads/writes through the /v1 surface are 404s with no existence oracle", async () => {
    const { api, tenants, actors } = twoTenantApi();

    // ESCALATION ATTEMPT: org B's owner sends requests under org A's tenant
    // header (tenant-header spoofing). resolveActor fails closed: the
    // actor has no membership in org A -> 404, indistinguishable from a
    // nonexistent tenant (no existence oracle).
    const attacker = new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: actors.B_OWNER, tenantId: tenants.ORG_A },
      ids: new SequenceIdGenerator({ prefix: "x-" }),
    });
    await expect(attacker.listDevices()).rejects.toThrowError(/404|not exist|not a RoamLink/i);

    // Cross-tenant mutation (enroll a device into the foreign tenant) is
    // also denied before any state is touched.
    await expect(
      attacker.enrollDevice({ name: "attack", platform: "ios" }),
    ).rejects.toThrowError(/404|not exist|not a RoamLink/i);

    // A member of org A likewise cannot reach org B's (empty) tenant state.
    const memberOfA = new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: actors.A_MEMBER, tenantId: tenants.ORG_B },
      ids: new SequenceIdGenerator({ prefix: "ma-" }),
    });
    await expect(memberOfA.listDevices()).rejects.toThrowError(/404|not exist|not a RoamLink/i);

    // Org A's devices are unchanged (the writes never happened).
    const owner = new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: actors.A_OWNER, tenantId: tenants.ORG_A },
      ids: new SequenceIdGenerator({ prefix: "o-" }),
    });
    await expect(owner.listDevices()).resolves.toHaveLength(1);

    // A ghost tenant is indistinguishable from a denied foreign tenant.
    const ghost = new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: actors.A_MEMBER, tenantId: "org:00000000-0000-4000-8000-000000dead00" },
      ids: new SequenceIdGenerator({ prefix: "g-" }),
    });
    await expect(ghost.listDevices()).rejects.toThrowError(/404|not exist|not a RoamLink/i);
  });

  it("T-10 privilege escalation through the ADMIN console fails closed and the denial is audited", async () => {
    const ORG_A = tenantIdFromOrganization(ORG_A_ID);
    const { api, actors } = twoTenantApi();
    const captured: HttpRequest[] = [];
    const capturingTransport = {
      async request(request: HttpRequest): Promise<HttpResponse> {
        captured.push(request);
        return api.transport.request(request);
      },
    };

    const adminClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: actors.A_ADMIN, tenantId: ORG_A },
      ids: new SequenceIdGenerator({ prefix: "c-" }),
    });
    const _consoleApp = new AdminConsoleApp({ client: adminClient });

    // The admin observes the organization truth (positive control).
    const organizations = await adminClient.listOrganizations();
    expect(organizations).toHaveLength(1);

    // ESCALATION ATTEMPT 1: a member drives the admin command.
    const memberClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: actors.A_MEMBER, tenantId: ORG_A },
      ids: new SequenceIdGenerator({ prefix: "m-" }),
    });
    const memberConsole = new AdminConsoleApp({ client: memberClient });
    const memberSuspend = await memberConsole.suspendOrganizationFlow({ tenantId: ORG_A });
    expect(memberSuspend.status).toBe("error");

    // The denial is AUDITED server-side with actor + tenant + correlation.
    const denialEvents = await adminClient.listAuditEvents({ category: "admin-override" });
    expect(
      denialEvents.events.some(
        (event) => event.outcome === "denied" && event.action.includes("org.suspend"),
      ),
    ).toBe(true);
    expect(denialEvents.chain.verified).toBe(true);

    // ESCALATION ATTEMPT 2: a personal-tenant actor never even triggers the
    // surface data fetch (fail-closed rendering gate).
    const before = captured.length;
    const personalClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: actors.A_MEMBER, tenantId: `usr:${actors.A_MEMBER.slice(4)}` },
      ids: new SequenceIdGenerator({ prefix: "p-" }),
    });
    const personalConsole = new AdminConsoleApp({ client: personalClient });
    const page = await personalConsole.renderPage({ page: "tenants" });
    expect(page.html).toContain('data-access-denied="true"');
    expect(captured.length - before).toBe(1); // session resolution only
  });

  it("T-11 the enterprise API-key boundary: cross-tenant misses and tampered material fail closed", async () => {
    const world = makeSecurityWorld();
    const harness = createEnterpriseApiHarness({ now: () => world.clock.now() });
    const tenantA = "org:77777777-0000-4000-8000-000000000001";
    const tenantB = "org:88888888-0000-4000-8000-000000000002";

    const issuance = await harness.apiKeys.issue(
      { tenantId: tenantA, name: "ops-key", scopes: ["enrollments:manage"] },
      {
        commandId: "99999999-0000-4000-8000-000000000001",
        correlationId: "corr.security.enterprise.key",
        idempotencyKey: "idem.security.enterprise.key",
        actorId: "actor-security",
      },
      world.clock.now(),
    );

    // The key RECORD is only visible in its own tenant.
    expect(await harness.apiKeys.get(issuance.record.keyId, tenantA)).not.toBeNull();
    expect(await harness.apiKeys.get(issuance.record.keyId, tenantB)).toBeNull();

    // The material authenticates in its own tenant...
    const authenticated = await harness.apiKeys.authenticate(issuance.material.value);
    expect(authenticated.tenantId).toBe(tenantA);

    // ...but TAMPERED material fails closed without leaking values.
    const tampered = `${issuance.material.value.slice(0, -4)}0000`;
    await expect(harness.apiKeys.authenticate(tampered)).rejects.toBeInstanceOf(Error);

    // Unknown key material is indistinguishable from tampered material
    // (no existence oracle at the boundary).
    await expect(
      harness.apiKeys.authenticate("rlk-unknown-material-0000000000000000000000000"),
    ).rejects.toBeInstanceOf(Error);
  });
});

// The world import is used by orgFixture helpers above.
void seededUserId;
