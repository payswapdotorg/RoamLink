/**
 * PA-025 — the shared deterministic world for the worker-endpoint battery:
 * the REAL services/api composition over an embedded real PostgreSQL
 * (pglite, the real infra/migrations) PLUS the REAL authenticated bounded
 * worker-tick endpoint over the SAME persistence — so the execution-facts
 * battery drives the full sanctioned chain: API-plane durable acceptance ->
 * SIGNED scheduled delivery -> one bounded tick over the workers execution
 * seam -> executed-stage CAS writes -> read-model projections.
 */
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseUserId, parseUtcInstant, tenantIdFromUser, type UtcInstant } from "@roamlink/contracts";
import { DeterministicClock, DeterministicUuidGenerator, deterministicUuidFromSeed, fixtureCommandEnvelope } from "@roamlink/testkit";
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
  parsePasswordSecret,
} from "@roamlink/auth";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { createApiService, type ApiService } from "@roamlink/api-service";
import { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry } from "@roamlink/webhook-inbox";
import {
  QSTASH_SIGNATURE_HEADER,
  renderQStashSignatureHeader,
} from "@roamlink/provider-qstash";
import { type PostgresPersistence } from "@roamlink/persistence-postgres";

import { createWorkerTickEndpoint, type WorkerTickEndpoint } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

/** The deterministic epoch the battery starts at. */
export const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");

/** The receiver-side signing key of the battery's QStash plane (test-only). */
export const SIGNING_KEY = "battery-worker-tick-signing-key-never-prod";
export const WRONG_SIGNING_KEY = "battery-wrong-key-never-prod";

export const PASSWORD_A = "correct-horse-battery";

export interface ExecutionWorld {
  readonly clock: DeterministicClock;
  readonly driver: { close(): Promise<void> };
  readonly persistence: PostgresPersistence;
  readonly service: ApiService;
  readonly endpoint: WorkerTickEndpoint;
  /** The registered customer's session facts (the API plane's principal). */
  readonly session: {
    readonly token: string;
    readonly actorId: string;
    readonly tenantId: string;
  };
  /** Deterministic resource ids the demo executors allocate. */
  readonly resourceIds: DeterministicUuidGenerator;
  dispose(): Promise<void>;
}

export interface ExecutionWorldOptions {
  /** The bounded claim per tick (the cap under test). */
  readonly outboxBatchSize?: number;
  /** Overrides the receiver-side signing keys (the negative matrix). */
  readonly signingKeys?: { readonly current: string | undefined; readonly next?: string | undefined };
  /** Registration seed (derives the deterministic user id). */
  readonly seed?: number;
}

export async function createExecutionWorld(options: ExecutionWorldOptions = {}): Promise<ExecutionWorld> {
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
  const commandIds = new DeterministicUuidGenerator(60_000);
  const resourceIds = new DeterministicUuidGenerator(70_000);
  const membershipIds = new DeterministicUuidGenerator(50_000);

  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const memberships = new InMemoryMembershipRepository();
  const organizations = new InMemoryOrganizationRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const hasher = new InsecureTestPasswordHasher();

  const seed = options.seed ?? 1;
  const userId = parseUserId(deterministicUuidFromSeed(seed));
  const actorId = `usr:${userId}`;
  const tenantId = tenantIdFromUser(userId);
  const email = `worker-tick-${seed}@example.com`;
  const administration = new AccountAdministrationService({
    users,
    directory,
    credentials,
    organizations,
    memberships,
    ledger,
    hasher,
    authorization: new AuthorizationService(memberships, organizations),
    now: () => clock.now(),
    generateMembershipId: () => membershipIds.next(),
  });
  await administration.registerUser(
    fixtureCommandEnvelope({
      actorId,
      tenantId,
      idempotencyKey: `register-${seed}`,
      correlationId: `corr-register-${seed}`,
      createdAt: clock.now(),
    }),
    { userId, email, displayName: `Worker Tick ${seed}`, password: parsePasswordSecret(PASSWORD_A) },
  );

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
      hasher,
    },
    webhookVerifier: new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({ "whk-battery": "battery-webhook-secret-never-prod" }),
    }),
    now: () => clock.now(),
    newId: () => commandIds.next(),
  });

  // The session token (the API plane's own login route).
  const login = await service.handle({
    method: "POST",
    path: "/v1/auth/session",
    headers: {
      "x-roamlink-actor-id": actorId,
      "x-roamlink-tenant-id": tenantId,
      "x-roamlink-request-id": `req-login-${seed}`,
      "x-roamlink-correlation-id": `corr-login-${seed}`,
      "idempotency-key": `login-${seed}`,
    },
    body: JSON.stringify({ email, password: PASSWORD_A }),
  });
  if (login.status !== 200) {
    await db.close();
    throw new Error(`the battery login failed with status ${login.status}`);
  }
  const token = (JSON.parse(login.body as string) as { token: string }).token;

  const endpoint = createWorkerTickEndpoint({
    persistence,
    now: () => clock.now(),
    signingKeys: options.signingKeys ?? { current: SIGNING_KEY },
    ...(options.outboxBatchSize !== undefined ? { outboxBatchSize: options.outboxBatchSize } : {}),
    newResourceId: () => resourceIds.next(),
  });

  return {
    clock,
    driver: db,
    persistence,
    service,
    endpoint,
    session: { token, actorId, tenantId },
    resourceIds,
    dispose: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// The signed-delivery helpers (the QStash scheduled delivery shape)
// ---------------------------------------------------------------------------

/** The closed tick job body the schedule delivers (byte-exact). */
export const TICK_JOB_BODY = JSON.stringify({ kind: "worker.tick" });

/**
 * Builds ONE signed worker.tick delivery request — exactly the shape the
 * QStash scheduled transport delivers to the receiver URL (the pinned
 * signature header over the byte-exact body).
 */
export function signedTickRequest(input: {
  readonly body?: string;
  readonly at?: string;
  readonly signingKey?: string;
  readonly withSignature?: boolean;
}): Request {
  const body = input.body ?? TICK_JOB_BODY;
  const at = input.at ?? T0;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.withSignature !== false) {
    headers[QSTASH_SIGNATURE_HEADER] = renderQStashSignatureHeader(
      input.signingKey ?? SIGNING_KEY,
      Math.floor(Date.parse(at) / 1000),
      body,
    );
  }
  return new Request("https://worker.example.test/api/worker/tick", {
    method: "POST",
    headers,
    body,
  });
}

/** Convenience headers for an authenticated mutation through the API plane. */
export function mutationHeaders(input: {
  readonly actorId: string;
  readonly tenantId: string;
  readonly token: string;
  readonly key: string;
  readonly expectedVersion?: number;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.token}`,
    "x-roamlink-actor-id": input.actorId,
    "x-roamlink-tenant-id": input.tenantId,
    "x-roamlink-request-id": `req-${input.key}`,
    "x-roamlink-correlation-id": `corr-${input.key}`,
    "idempotency-key": input.key,
    ...(input.expectedVersion !== undefined ? { "x-roamlink-expected-version": String(input.expectedVersion) } : {}),
  };
}

/** Convenience headers for an authenticated business read. */
export function readHeaders(input: { readonly token: string; readonly actorId: string; readonly tenantId: string }): Record<string, string> {
  return {
    authorization: `Bearer ${input.token}`,
    "x-roamlink-actor-id": input.actorId,
    "x-roamlink-tenant-id": input.tenantId,
  };
}
