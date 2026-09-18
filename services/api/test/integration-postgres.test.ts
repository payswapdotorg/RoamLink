/**
 * RL-090/RL-091 integration: the api-service over the REAL PostgreSQL
 * adapter (pglite) with the REAL infra/migrations applied - proving the full
 * call chain HTTP -> application command -> persistence on real SQL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { tenantIdFromUser } from "@roamlink/contracts";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import {
  AccountAdministrationService,
  AuthorizationService,
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "@roamlink/auth";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";

import { PASSWORD_A, T0, mutationHeaders, registerSeedUser, userIdFromSeed } from "./helpers.js";
import { ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES, buildAdcosWebhookSignatureMessage } from "@roamlink/adcos";
import { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry, signWebhookDelivery } from "@roamlink/webhook-inbox";
import { createApiService } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const KEY_ID = "whk-int-1";
const SECRET = "integration-signing-secret-never-in-prod";

async function createPostgresBackedService() {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const db = new PGlite();
  const driver = createPgliteDriver(db);
  const clock = new DeterministicClock(T0);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  const persistence = createPostgresPersistence(driver);

  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const memberships = new InMemoryMembershipRepository();
  const organizations = new InMemoryOrganizationRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const membershipIds = new DeterministicUuidGenerator(50_000);
  const commandIds = new DeterministicUuidGenerator(60_000);
  const administration = new AccountAdministrationService({
    users,
    directory,
    credentials,
    organizations,
    memberships,
    ledger,
    hasher: new InsecureTestPasswordHasher(),
    authorization: new AuthorizationService(memberships, organizations),
    now: () => clock.now(),
    generateMembershipId: () => membershipIds.next(),
  });
  const service = createApiService({
    persistence,
    identity: {
      users,
      directory,
      credentials,
      sessions: new InMemoryAuthSessionRepository(),
      memberships,
      organizations,
      ledger,
      hasher: new InsecureTestPasswordHasher(),
    },
    webhookVerifier: new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({ [KEY_ID]: SECRET }),
    }),
    now: () => clock.now(),
    newId: () => commandIds.next(),
  });
  return { driver, clock, administration, persistence, service };
}

describe("the api-service over real PostgreSQL (pglite + real migrations)", () => {
  it("persists accepted commands and their outbox obligations in real SQL", async () => {
    const world = await createPostgresBackedService();
    try {
      const userId = userIdFromSeed(1);
      await registerSeedUser(world.administration, 1, () => world.clock.now());
      const login = await world.service.handle({
        method: "POST",
        path: "/v1/auth/session",
        headers: mutationHeaders({
          actorId: `usr:${userId}`,
          tenantId: tenantIdFromUser(userId),
          key: "pg-login-1",
        }),
        body: JSON.stringify({ email: "user-1@example.com", password: PASSWORD_A }),
      });
      expect(login.status).toBe(200);
      const token = JSON.parse(login.body as string)["token"] as string;

      const accepted = await world.service.handle({
        method: "POST",
        path: "/v1/devices",
        headers: {
          authorization: `Bearer ${token}`,
          ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "pg-enroll-1" }),
        },
        body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
      });
      expect(accepted.status).toBe(202);
      const ack = JSON.parse(accepted.body as string);

      // The command record + pointer + outbox row live in PostgreSQL.
      expect(await world.persistence.records("api-commands").count()).toBe(1);
      expect(await world.persistence.records("api-command-keys").count()).toBe(1);
      expect(await world.persistence.outbox.count("PENDING")).toBe(1);
      const outboxRecord = (await world.persistence.outbox.list("PENDING"))[0];
      expect(outboxRecord?.idempotencyKey).toBe("pg-enroll-1");

      // The command view is served from the durable store.
      const view = await world.service.handle({
        method: "GET",
        path: `/v1/commands/${ack.commandId}`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-roamlink-tenant-id": tenantIdFromUser(userId),
        },
      });
      expect(view.status).toBe(200);
      expect(JSON.parse(view.body as string)["commandId"]).toBe(ack.commandId);

      // Idempotent replay against the durable store: no new rows.
      const replay = await world.service.handle({
        method: "POST",
        path: "/v1/devices",
        headers: {
          authorization: `Bearer ${token}`,
          ...mutationHeaders({ actorId: `usr:${userId}`, tenantId: tenantIdFromUser(userId), key: "pg-enroll-1" }),
        },
        body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
      });
      expect(replay.status).toBe(202);
      expect(replay.body).toBe(accepted.body);
      expect(await world.persistence.outbox.count()).toBe(1);
    } finally {
      await world.driver.close();
    }
  });

  it("admits webhook deliveries into the real durable inbox", async () => {
    const world = await createPostgresBackedService();
    try {
      const payload = JSON.stringify({
        event_id: "evt-pg-0001",
        event_type: "connectivity_contract.state_changed",
        resource_id: "res-0001",
        resource_kind: "connectivity_contract",
        resource_version: 3,
        occurred_at: T0,
        api_version: "2.0",
        environment: "sandbox",
        correlation_id: "corr-pg-0001",
      });
      const message = buildAdcosWebhookSignatureMessage({
        keyId: KEY_ID,
        timestamp: T0,
        deliveryId: "del-pg-0001",
        payload,
      });
      const response = await world.service.handle({
        method: "POST",
        path: "/v1/webhooks/adcos",
        headers: {
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature]: signWebhookDelivery(SECRET, message),
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp]: T0,
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId]: KEY_ID,
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId]: "evt-pg-0001",
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId]: "del-pg-0001",
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence]: "0",
          [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm]: "hmac-sha256",
        },
        body: payload,
      });
      expect(response.status).toBe(202);
      const body = JSON.parse(response.body as string);
      expect(body.outcome).toBe("ADMITTED");
      // The ADMITTED row is in the real inbox table (partial unique index enforced).
      expect(await world.persistence.inbox.count("ADMITTED")).toBe(1);
      expect(await world.persistence.inbox.count("DUPLICATE")).toBe(0);
    } finally {
      await world.driver.close();
    }
  });
});
