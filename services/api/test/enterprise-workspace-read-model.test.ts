/**
 * PA-024: the enterprise workspace read model composed on the real runtime
 * (closes the audit §3 plain-404 finding) — the composition battery.
 *
 * The workspace read (GET /v1/enterprise/workspace) composes ONLY what the
 * service's bound state asserts, section by section:
 *
 *  - WRITE-THEN-READ round trip: the connector-provisioning command (the
 *    PA-023 mutation route) is durably accepted through the real /v1
 *    boundary, the read honestly serves the pre-execution state (accepted
 *    is NOT executed — the connector section stays null), the worker
 *    plane's executed-stage write is applied through the SAME ledger
 *    discipline the command-ledger writer uses, and the read then serves
 *    the projected REAL provisioning record (the domain's creation state);
 *  - the ORGANIZATION section composes the acting org tenant's REAL
 *    organization record from the bound identity stores (and the honest
 *    null for a personal tenant — never a fabricated workspace identity);
 *  - the unbound sections (enrollment / policy / integrations) stay the
 *    contract's honest nulls — an absent section is not an assertion;
 *  - the CONTRACT DIFF: every composed response body parses under the
 *    frozen app-kit fail-closed parser (parseEnterpriseWorkspaceResource
 *    — the deterministic fake API is the contract reference);
 *  - tenant scoping fails closed (missing tenant context, forged actor
 *    headers, foreign tenants, unauthenticated reads, cross-tenant
 *    projections).
 */
import { describe, expect, it } from "vitest";
import { tenantIdFromUser, type UtcInstant } from "@roamlink/contracts";
import { parseEnterpriseWorkspaceResource } from "@roamlink/app-kit";

import {
  PASSWORD_A,
  createTestWorld,
  mutationHeaders,
  tenantOf,
  userIdFromSeed,
  type TestWorld,
} from "./helpers.js";

/** A deterministic later instant (the worker plane's execution time). */
const T1: UtcInstant = "2026-01-15T09:00:00.000Z" as UtcInstant;
const T2: UtcInstant = "2026-01-15T09:30:00.000Z" as UtcInstant;

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

async function get(
  world: TestWorld,
  session: Session,
  path: string = "/v1/enterprise/workspace",
): Promise<{ status: number; body: string }> {
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

/** The provisioning record ids the simulated executor records (deterministic). */
const CONNECTOR_ID = "1f000000-0000-4000-8000-000000000006";
const CONNECTOR_ID_2 = "1f000000-0000-4000-8000-000000000007";

const WORKSPACE_PATH = "/v1/enterprise/workspace";
const PROVISION_PATH = "/v1/enterprise/workspace/connector/provision";

describe("the composed enterprise workspace read model (write-then-read round trip)", () => {
  it("serves the honest pre-execution state, then the executed connector projection, under the contract parser", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    // The connector-provisioning command is durably accepted (the PA-023
    // mutation route, through the real /v1 boundary).
    const accepted = await post(world, session, PROVISION_PATH, "provision-connector-1", {
      connectorId: "workspace-main",
    });
    expect(accepted.status).toBe(202);

    // Accepted is NOT executed: the connector section stays null (nothing
    // was invented by the read — the projection law).
    const before = parseEnterpriseWorkspaceResource(JSON.parse((await get(world, session)).body));
    expect(before.connector).toBeNull();

    // The worker plane executes the provisioning and records the created
    // connector provisioning record (the domain's resource vocabulary).
    await markExecuted(world, accepted.commandId, T1, {
      type: "connector_provisioning",
      id: CONNECTOR_ID,
    });

    const after = parseEnterpriseWorkspaceResource(JSON.parse((await get(world, session)).body));
    const connector = after.connector;
    if (connector === null) throw new Error("connector section missing");
    expect(connector.provisioningId).toBe(CONNECTOR_ID);
    // The domain's creation state (packages/enterprise's provisioning
    // record): in-flight `provisioning`; the provisioned/failed/revoked
    // transitions are domain-execution facts the bound state never asserts.
    expect(connector.state).toBe("provisioning");
    expect(connector.createdAt).toBe(T1); // a provisioning record exists from execution
    expect(connector.updatedAt).toBe(T1);
    // The later-stage transitions are never invented (absent, not guessed).
    expect("provisionedAt" in connector).toBe(false);
    expect("failureReason" in connector).toBe(false);
    expect("revokedAt" in connector).toBe(false);
  });

  it("composes the LATEST executed provisioning attempt (the one-active-attempt law's current record)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    const session = await sessionOf(world, 1);

    const first = await post(world, session, PROVISION_PATH, "provision-connector-2a", {
      connectorId: "first-attempt",
    });
    await markExecuted(world, first.commandId, T1, {
      type: "connector_provisioning",
      id: CONNECTOR_ID,
    });
    // A later attempt executes (an earlier active attempt would have been
    // terminal by the domain's law before a later one could execute).
    const second = await post(world, session, PROVISION_PATH, "provision-connector-2b", {
      connectorId: "retry-attempt",
    });
    await markExecuted(world, second.commandId, T2, {
      type: "connector_provisioning",
      id: CONNECTOR_ID_2,
    });

    const workspace = parseEnterpriseWorkspaceResource(
      JSON.parse((await get(world, session)).body),
    );
    const connector = workspace.connector;
    if (connector === null) throw new Error("connector section missing");
    expect(connector.provisioningId).toBe(CONNECTOR_ID_2);
    expect(connector.createdAt).toBe(T2);
    expect(connector.updatedAt).toBe(T2);
  });
});

describe("the composed enterprise workspace organization section (identity-backed)", () => {
  it("serves the acting org tenant's REAL organization record; a personal tenant composes the honest null", async () => {
    const world = createTestWorld();
    const owner = userIdFromSeed(1);
    await world.administration.registerUser(1);
    const organizationId = "4dc7f531-6317-4246-9be0-8a1793ad2bf3";
    const orgTenantId = `org:${organizationId}`;
    await world.administration.createOrganization(1, organizationId, "Acahat Travel Co");

    // A personal tenant carries no organization: the honest null section
    // (never a fabricated workspace identity, never an existence probe).
    const personal = await sessionOf(world, 1);
    const personalWorkspace = parseEnterpriseWorkspaceResource(
      JSON.parse((await get(world, personal)).body),
    );
    expect(personalWorkspace.organization).toBeNull();
    // The unbound sections keep the contract's honest nulls.
    expect(personalWorkspace.enrollment).toBeNull();
    expect(personalWorkspace.policy).toBeNull();
    expect(personalWorkspace.integrations).toBeNull();
    expect(personalWorkspace.connector).toBeNull();

    // The owner reads the workspace in the ORGANIZATION tenant: the
    // organization section is the REAL bound identity record.
    const orgSession: Session = { ...personal, actorId: `usr:${owner}`, tenantId: orgTenantId };
    const orgWorkspace = parseEnterpriseWorkspaceResource(
      JSON.parse((await get(world, orgSession)).body),
    );
    const organization = orgWorkspace.organization;
    if (organization === null) throw new Error("organization section missing");
    expect(organization.tenantId).toBe(orgTenantId);
    expect(organization.organizationId).toBe(organizationId);
    expect(organization.name).toBe("Acahat Travel Co");
    expect(organization.status).toBe("active");
  });
});

describe("the composed enterprise workspace read's tenant discipline", () => {
  it("fails closed on a missing tenant context, a forged actor header, a foreign tenant, and no session", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const session = await sessionOf(world, 1);

    const missingTenant = await world.service.handle({
      method: "GET",
      path: WORKSPACE_PATH,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(missingTenant.status).toBe(400);
    expect(JSON.parse(missingTenant.body as string)["reason"]).toBe("READ_CONTEXT_INCOMPLETE");

    const forgedActor = await world.service.handle({
      method: "GET",
      path: WORKSPACE_PATH,
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
      path: WORKSPACE_PATH,
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
      path: WORKSPACE_PATH,
      headers: {
        "x-roamlink-actor-id": session.actorId,
        "x-roamlink-tenant-id": session.tenantId,
      },
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("never serves another tenant's executed provisioning (tenant boundary first)", async () => {
    const world = createTestWorld();
    await world.administration.registerUser(1);
    await world.administration.registerUser(2);
    const session1 = await sessionOf(world, 1);
    const session2 = await sessionOf(world, 2);

    const accepted = await post(world, session1, PROVISION_PATH, "workspace-tenant-1", {
      connectorId: "tenant-one-connector",
    });
    await markExecuted(world, accepted.commandId, T1, {
      type: "connector_provisioning",
      id: CONNECTOR_ID,
    });

    const own = parseEnterpriseWorkspaceResource(JSON.parse((await get(world, session1)).body));
    expect(own.connector?.provisioningId).toBe(CONNECTOR_ID);
    // The other tenant's read serves ITS OWN (null) projection: no
    // existence oracle, no cross-tenant leak.
    const theirs = parseEnterpriseWorkspaceResource(JSON.parse((await get(world, session2)).body));
    expect(theirs.connector).toBeNull();
    expect(theirs.organization).toBeNull();
  });
});
