/**
 * PA-026 — THE ENTERPRISE EXECUTOR BATTERY: the domain's transition
 * functions as executors on the worker seam PA-025 composed, over the REAL
 * shared persistence (pglite + the real infra/migrations).
 *
 * The full sanctioned chain, nothing faked:
 *
 *   an enterprise command ACCEPTED through the command plane (the REAL
 *   ingestCommand discipline the /v1 routes call — the future enterprise
 *   surface's ingestion path, at packages/enterprise's own pinned route
 *   templates; NO services/api mutation route is invented, per the PA-023
 *   parity law and the recorded UI-journey finding)
 *     -> ONE bounded tick over the SAME execution seam (createBoundedWorkerTick
 *        + commandLedgerDeliveryPort + createEnterpriseCommandExecutors)
 *       -> the domain's own pure functions apply
 *          (applyEnterpriseEnrollmentCommand / negotiateConnectorProvisioning)
 *          over the bound shared-persistence stores
 *         -> the ledger CAS-writes the executed stage + the resource
 *           -> the enrollment journey records + the connector provisioning
 *              record persist in the bound partitions (the same partitions
 *              the workspace read serves).
 *
 * Plus the mandated honest negatives: the pre-execution state (accepted is
 * NOT executed — the read serves the prior state, never the future one);
 * the connector's retryable refusal without a bound enrollment; the
 * idempotent re-tick (nothing advances twice); and the registrar law
 * (verification's tenant comes ONLY from the registrar port, bound here to
 * the REAL @roamlink/auth administration boundary).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseOrganizationId,
  parseUserId,
  parseUtcInstant,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  deterministicUuidFromSeed,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";
import {
  AccountAdministrationService,
  AuthorizationService,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
  parsePasswordSecret,
} from "@roamlink/auth";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
  type PostgresPersistence,
} from "@roamlink/persistence-postgres";
import {
  ingestCommand,
  createPersistenceConnectorProvisioningStore,
  createPersistenceEnrollmentStore,
} from "@roamlink/api-service";
import type { OrganizationRegistrar } from "@roamlink/enterprise";

import {
  commandLedgerDeliveryPort,
  createBoundedWorkerTick,
  createCommandLedger,
  createEnterpriseCommandExecutors,
  type BoundedWorkerTick,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

/** The deterministic epoch the battery starts at. */
const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");

export const PASSWORD_A = "correct-horse-battery";

/** One enterprise execution world: the real persistence + identity + seam. */
interface EnterpriseWorld {
  readonly clock: DeterministicClock;
  readonly driver: { close(): Promise<void> };
  readonly persistence: PostgresPersistence;
  readonly authorization: AuthorizationService;
  readonly administration: AccountAdministrationService;
  /** The registrar binding over the REAL auth administration boundary. */
  readonly registrar: OrganizationRegistrar;
  readonly tick: BoundedWorkerTick;
  readonly enrollments: ReturnType<typeof createPersistenceEnrollmentStore>;
  readonly provisioning: ReturnType<typeof createPersistenceConnectorProvisioningStore>;
  /** The organization tenants the registrar provisioned (in order). */
  provisionedTenants(): readonly string[];
  dispose(): Promise<void>;
}

async function createEnterpriseWorld(): Promise<EnterpriseWorld> {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const driver = createPgliteDriver(db);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  const persistence = createPostgresPersistence(driver);

  const clock = new DeterministicClock(T0);
  const membershipIds = new DeterministicUuidGenerator(50_000);
  const orgIds = new DeterministicUuidGenerator(80_000);

  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const memberships = new InMemoryMembershipRepository();
  const organizations = new InMemoryOrganizationRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const hasher = new InsecureTestPasswordHasher();
  const authorization = new AuthorizationService(memberships, organizations);
  const administration = new AccountAdministrationService({
    users,
    directory,
    credentials,
    organizations,
    memberships,
    ledger,
    hasher,
    authorization,
    now: () => clock.now(),
    generateMembershipId: () => membershipIds.next(),
  });

  // The registrar binding: verification's ONLY tenant source, bound to the
  // REAL auth administration boundary (production binds the auth domain —
  // the organization + the requesting user's owner membership are REAL
  // identity-store facts, never enterprise-domain inventions).
  const provisionedTenants: string[] = [];
  const registrar: OrganizationRegistrar = {
    async provisionOrganization(input) {
      const organizationId = orgIds.next();
      const created = await administration.createOrganization(
        fixtureCommandEnvelope({
          commandId: orgIds.next(),
          actorId: input.requestedBy,
          tenantId: tenantIdFromOrganization(parseOrganizationId(organizationId)),
          idempotencyKey: `registrar-${organizationId}`,
          correlationId: `corr-registrar-${organizationId}`,
          createdAt: clock.now(),
        }),
        { organizationId, name: input.organizationName },
      );
      provisionedTenants.push(created.tenantId);
      return { tenantId: created.tenantId, organizationId: created.organizationId };
    },
  };

  // The execution seam: the SAME bounded-tick path PA-025 composed, with the
  // ENTERPRISE executor table (the domain's transition functions + the
  // bound stores).
  const tick = createBoundedWorkerTick(
    { mode: "development", databaseUrl: undefined },
    {
      persistence,
      delivery: commandLedgerDeliveryPort({
        executors: createEnterpriseCommandExecutors({ persistence, registrar }),
        ledger: createCommandLedger({ persistence }),
        now: () => clock.now(),
      }),
      now: () => clock.now(),
    },
  );

  return {
    clock,
    driver: db,
    persistence,
    authorization,
    administration,
    registrar,
    tick,
    enrollments: createPersistenceEnrollmentStore(persistence),
    provisioning: createPersistenceConnectorProvisioningStore(persistence),
    provisionedTenants: () => [...provisionedTenants],
    dispose: () => db.close(),
  };
}

/** Registers a customer through the REAL administration boundary. */
async function registerCustomer(
  world: EnterpriseWorld,
  seed: number,
): Promise<{ readonly actorId: string; readonly tenantId: string }> {
  const userId = parseUserId(deterministicUuidFromSeed(seed));
  const actorId = `usr:${userId}`;
  const tenantId = tenantIdFromUser(userId);
  await world.administration.registerUser(
    fixtureCommandEnvelope({
      actorId,
      tenantId,
      idempotencyKey: `register-${seed}`,
      correlationId: `corr-register-${seed}`,
      createdAt: world.clock.now(),
    }),
    {
      userId,
      email: `enterprise-${seed}@example.com`,
      displayName: `Enterprise ${seed}`,
      password: parsePasswordSecret(PASSWORD_A),
    },
  );
  return { actorId, tenantId };
}

/**
 * Accepts one enterprise command through the REAL command-plane ingest (the
 * same ingestCommand discipline the /v1 mutation routes call), at the
 * packages/enterprise route templates — the future enterprise surface's
 * ingestion path. NO services/api mutation route is invented.
 */
async function ingest(
  world: EnterpriseWorld,
  input: {
    readonly path: string;
    readonly kind: string;
    readonly actorId: string;
    readonly tenantId: string;
    readonly key: string;
    readonly body: unknown;
  },
): Promise<{ readonly commandId: string }> {
  const ack = await ingestCommand({
    request: {
      method: "POST",
      path: input.path,
      headers: {
        "x-roamlink-actor-id": input.actorId,
        "x-roamlink-tenant-id": input.tenantId,
        "x-roamlink-request-id": `req-${input.key}`,
        "x-roamlink-correlation-id": `corr-${input.key}`,
        "idempotency-key": input.key,
      },
      body: JSON.stringify(input.body),
    },
    path: input.path,
    commandKind: input.kind,
    actorId: input.actorId as never,
    authorization: world.authorization,
    persistence: world.persistence,
    now: () => world.clock.now(),
    newCommandId: () => deterministicUuidFromSeed(90_000 + Number(input.key.split("-").at(-1) ?? 0)),
  });
  return { commandId: ack.commandId };
}

/** One tick's report (the honest outcome summary). */
async function executeTick(world: EnterpriseWorld): Promise<Record<string, unknown>> {
  const report = await world.tick.execute();
  return report as unknown as Record<string, unknown>;
}

/** Reads the stored command straight from the durable ledger. */
async function storedCommandOf(
  world: EnterpriseWorld,
  commandId: string,
): Promise<Record<string, unknown> | null> {
  const record = await world.persistence.records("api-commands").get(commandId);
  return record === null ? null : (record.value as Record<string, unknown>);
}

describe("PA-026 the enterprise executors (the domain transitions on the worker seam)", () => {
  it("executes the enrollment journey through the bounded tick: draft -> submitted -> verified (registrar-bound tenant) -> active", async () => {
    const world = await createEnterpriseWorld();
    try {
      const customer = await registerCustomer(world, 1);

      // --- create: accepted, then EXECUTED by ONE tick --------------------
      const created = await ingest(world, {
        path: "/v1/enterprise/enrollments",
        kind: "enrollment.create",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "enroll-create-1",
        body: { organizationName: "Acahat Freight Co" },
      });
      // The honest pre-state: accepted is NOT executed; the bound store
      // holds nothing yet (the projection law).
      expect(await world.enrollments.get(created.commandId)).toBeNull();

      world.clock.advanceBy(60_000);
      let report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ claimed: 1, executed: 1, delivered: 1, remainingPending: 0 });

      const draft = await world.enrollments.get(created.commandId);
      expect(draft).not.toBeNull();
      expect(draft).toMatchObject({
        enrollmentId: created.commandId,
        organizationName: "Acahat Freight Co",
        state: "draft",
        tenantId: null,
        requestedBy: customer.actorId,
        revision: 1,
      });
      const stored = await storedCommandOf(world, created.commandId);
      expect(stored?.["executedAt"]).toBe(world.clock.now());
      expect(stored?.["resource"]).toEqual({
        type: "enterprise_enrollment",
        id: created.commandId,
        version: 1,
      });

      // --- submit ----------------------------------------------------------
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/submit`,
        kind: "enrollment.submit",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "enroll-submit-2",
        body: {},
      });
      world.clock.advanceBy(60_000);
      report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ executed: 1 });
      expect((await world.enrollments.get(created.commandId))?.state).toBe("submitted");

      // --- verify: the tenant comes ONLY from the registrar port ----------
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/verify`,
        kind: "enrollment.verify",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "enroll-verify-3",
        body: {},
      });
      world.clock.advanceBy(60_000);
      report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ executed: 1 });

      const verified = await world.enrollments.get(created.commandId);
      expect(verified?.state).toBe("verified");
      expect(verified?.verifiedAt).toBe(world.clock.now());
      // The registrar provisioned EXACTLY ONE organization through the REAL
      // auth administration boundary, and the record bound its tenant.
      expect(world.provisionedTenants()).toHaveLength(1);
      expect(verified?.tenantId).toBe(world.provisionedTenants()[0]);
      expect(verified?.revision).toBe(3);

      // --- activate --------------------------------------------------------
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/activate`,
        kind: "enrollment.activate",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "enroll-activate-4",
        body: {},
      });
      world.clock.advanceBy(60_000);
      report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ executed: 1 });
      const active = await world.enrollments.get(created.commandId);
      expect(active?.state).toBe("active");
      expect(active?.activatedAt).toBe(world.clock.now());
      expect(active?.revision).toBe(4);
    } finally {
      await world.dispose();
    }
  });

  it("serves the honest pre-execution state: a verify ACCEPTED but not yet ticked leaves the record submitted (never the future state)", async () => {
    const world = await createEnterpriseWorld();
    try {
      const customer = await registerCustomer(world, 2);
      const created = await ingest(world, {
        path: "/v1/enterprise/enrollments",
        kind: "enrollment.create",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "prestate-create-1",
        body: { organizationName: "Acahat Freight Co" },
      });
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/submit`,
        kind: "enrollment.submit",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "prestate-submit-2",
        body: {},
      });
      world.clock.advanceBy(60_000);
      await executeTick(world); // the create executes; a same-tick sibling
      // ordering where submit is attempted first is the honest retryable
      // refusal — the at-least-once discipline converges it on the next
      // tick (the multi-tick law, exactly like every executed journey).
      world.clock.advanceBy(60_000);
      await executeTick(world);
      expect((await world.enrollments.get(created.commandId))?.state).toBe("submitted");

      // The verify command is DURABLY ACCEPTED but NOT executed: the bound
      // record keeps the submitted state (the read would serve submitted,
      // never the future verified one), and the registrar provisioned
      // NOTHING (verification is the only tenant source).
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/verify`,
        kind: "enrollment.verify",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "prestate-verify-3",
        body: {},
      });
      expect((await world.enrollments.get(created.commandId))?.state).toBe("submitted");
      expect(world.provisionedTenants()).toHaveLength(0);

      // The NEXT tick executes it: only then does the state advance.
      world.clock.advanceBy(60_000);
      await executeTick(world);
      expect((await world.enrollments.get(created.commandId))?.state).toBe("verified");
      expect(world.provisionedTenants()).toHaveLength(1);
    } finally {
      await world.dispose();
    }
  });

  it("converges a same-tick sibling ordering honestly: a transition attempted before its sibling create is the retryable refusal that the next tick completes", async () => {
    const world = await createEnterpriseWorld();
    try {
      const customer = await registerCustomer(world, 5);
      // BOTH commands are pending on ONE tick: the claimed set's order is
      // the database's own (the UPDATE..RETURNING set, not a dependency
      // order) — whichever order the tick attempts them in, the outcome is
      // honest: the create applies, an early submit retries, and the NEXT
      // tick completes the journey (at-least-once + idempotence).
      const created = await ingest(world, {
        path: "/v1/enterprise/enrollments",
        kind: "enrollment.create",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "sibling-create-1",
        body: { organizationName: "Acahat Freight Co" },
      });
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/submit`,
        kind: "enrollment.submit",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "sibling-submit-2",
        body: {},
      });
      world.clock.advanceBy(60_000);
      const first = await executeTick(world);
      const firstOutbox = first["outbox"] as Record<string, unknown>;
      // Whatever order the tick attempted, the CREATE is executed (its
      // executor is order-independent) and the submit either executed with
      // it or honestly retried — never invented, never dropped.
      expect(firstOutbox["executed"]).toBeGreaterThanOrEqual(1);
      expect(
        (firstOutbox["executed"] as number) + (firstOutbox["retryableFailures"] as number),
      ).toBe(2);
      expect(await world.enrollments.get(created.commandId)).not.toBeNull();

      // The convergence tick: any retried sibling completes (the backoff
      // has elapsed), and nothing else is pending afterwards.
      world.clock.advanceBy(120_000);
      const second = await executeTick(world);
      expect(second["outbox"]).toMatchObject({ remainingPending: 0 });
      const finalState = (await world.enrollments.get(created.commandId))?.state;
      expect(finalState === "submitted" || finalState === "draft").toBe(true);
      if (finalState === "draft") {
        // The submit's retry window had not elapsed yet at the second tick
        // (the backoff schedule is the persistence port's own): one more
        // bounded tick completes it — the multi-tick law.
        world.clock.advanceBy(120_000);
        await executeTick(world);
        expect((await world.enrollments.get(created.commandId))?.state).toBe("submitted");
      }
    } finally {
      await world.dispose();
    }
  });

  it("executes the connector.provision command through the domain's negotiation and persists the provisioning record", async () => {
    const world = await createEnterpriseWorld();
    try {
      const customer = await registerCustomer(world, 3);
      // The enrollment journey reaches active first (the connector rides on
      // the tenant's bound enrollment — the domain record's own reference).
      // One command per tick: the deterministic walk (the sibling-ordering
      // convergence is its own battery leg above).
      const created = await ingest(world, {
        path: "/v1/enterprise/enrollments",
        kind: "enrollment.create",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "connector-create-1",
        body: { organizationName: "Acahat Freight Co" },
      });
      world.clock.advanceBy(60_000);
      await executeTick(world);
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/submit`,
        kind: "enrollment.submit",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "connector-submit-2",
        body: {},
      });
      world.clock.advanceBy(60_000);
      await executeTick(world);
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/verify`,
        kind: "enrollment.verify",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "connector-verify-3",
        body: {},
      });
      world.clock.advanceBy(60_000);
      await executeTick(world);
      await ingest(world, {
        path: `/v1/enterprise/enrollments/${created.commandId}/activate`,
        kind: "enrollment.activate",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "connector-activate-4",
        body: {},
      });
      world.clock.advanceBy(60_000);
      await executeTick(world);
      const orgTenantId = (await world.enrollments.get(created.commandId))?.tenantId;
      expect(orgTenantId).toBeDefined();
      expect((await world.enrollments.get(created.commandId))?.state).toBe("active");

      // The PA-023 mutation route's command, ingested through the command
      // plane in the ORGANIZATION tenant (the registrar made the requesting
      // actor the organization's owner — the boundary authorizes them).
      const provisioned = await ingest(world, {
        path: "/v1/enterprise/workspace/connector/provision",
        kind: "connector.provision",
        actorId: customer.actorId,
        tenantId: orgTenantId as string,
        key: "connector-provision-5",
        body: { connectorId: "workspace-main" },
      });
      // Accepted is NOT executed: no provisioning record yet.
      expect(
        await world.provisioning.get(provisioned.commandId, orgTenantId as string),
      ).toBeNull();

      world.clock.advanceBy(60_000);
      const report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ executed: 1, delivered: 1, remainingPending: 0 });

      // The domain's own negotiation result, persisted in the bound store:
      // the guaranteed floor composition (observation + user-guided actions)
      // negotiates the honest user-guided mode — an enterprise mode is never
      // claimed without enterprise infrastructure.
      const record = await world.provisioning.get(
        provisioned.commandId,
        orgTenantId as string,
      );
      expect(record).not.toBeNull();
      expect(record).toMatchObject({
        provisioningId: provisioned.commandId,
        tenantId: orgTenantId,
        enrollmentId: created.commandId,
        connectorId: "workspace-main",
        state: "provisioned",
        operatingMode: "user-guided",
        revision: 1,
      });
      expect(record?.capabilities).toEqual(["observation", "user-guided-actions"]);

      const stored = await storedCommandOf(world, provisioned.commandId);
      expect(stored?.["resource"]).toEqual({
        type: "connector_provisioning",
        id: provisioned.commandId,
        version: 1,
      });

      // The idempotent re-tick: nothing advances twice.
      world.clock.advanceBy(60_000);
      const again = await executeTick(world);
      expect(again["outbox"]).toMatchObject({ claimed: 0, executed: 0, remainingPending: 0 });
    } finally {
      await world.dispose();
    }
  });

  it("refuses the connector provisioning without a bound enrollment (the honest retryable refusal, never invented)", async () => {
    const world = await createEnterpriseWorld();
    try {
      const customer = await registerCustomer(world, 4);
      // A PERSONAL tenant with no enrollment bound: the connector
      // provisioning has no enrollment reference — the executor refuses
      // (retryable: the enrollment may verify on a later tick).
      const provisioned = await ingest(world, {
        path: "/v1/enterprise/workspace/connector/provision",
        kind: "connector.provision",
        actorId: customer.actorId,
        tenantId: customer.tenantId,
        key: "no-enrollment-provision-1",
        body: { connectorId: "workspace-main" },
      });
      world.clock.advanceBy(60_000);
      const report = await executeTick(world);
      expect(report["outbox"]).toMatchObject({ retryableFailures: 1, executed: 0 });
      // The ledger's stage truth: NOT executed (never invented success).
      const stored = await storedCommandOf(world, provisioned.commandId);
      expect(stored?.["executedAt"]).toBeNull();
      expect(stored?.["resource"]).toBeNull();
    } finally {
      await world.dispose();
    }
  });
});
