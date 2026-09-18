/**
 * Shared deterministic world for the api-service tests: the REAL services/api
 * composed over the REAL @roamlink/auth boundary services and the
 * @roamlink/persistence in-memory adapter (the SQL adapter is exercised in
 * the persistence-postgres package and in the pglite integration test here).
 */
import {
  parseUtcInstant,
  parseUserId,
  tenantIdFromUser,
  type UtcInstant,
  type UserId,
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
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "@roamlink/auth";
import { createInMemoryPersistence, type InMemoryPersistence } from "@roamlink/persistence";
import type { WebhookVerifier } from "@roamlink/adcos";
import { createApiService, type ApiService } from "../src/index.js";

export const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");
export const PASSWORD_A = "correct-horse-battery";

export interface TestWorld {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicUuidGenerator;
  readonly persistence: InMemoryPersistence;
  readonly users: InMemoryUserRepository;
  readonly directory: InMemoryUserDirectory;
  readonly organizations: InMemoryOrganizationRepository;
  readonly memberships: InMemoryMembershipRepository;
  readonly administration: TestAdministration;
  readonly service: ApiService;
}

/**
 * Registers a user through the REAL envelope-gated administration service,
 * deterministically from a seed (mirrors packages/auth's test world).
 * Exported standalone so the pglite integration test reuses the exact same
 * construction.
 */
export async function registerSeedUser(
  administration: AccountAdministrationService,
  seed: number,
  now: () => UtcInstant,
  options?: { readonly password?: string },
): Promise<UserId> {
  const userId = userIdFromSeed(seed);
  await administration.registerUser(
    fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      idempotencyKey: `register-user-${seed}`,
      correlationId: `corr-register-user-${seed}`,
      createdAt: now(),
    }),
    {
      userId,
      email: `user-${seed}@example.com`,
      displayName: `User ${seed}`,
      password: options?.password ?? PASSWORD_A,
    },
  );
  return userId;
}

/** Seed-based convenience facade over the REAL administration service. */
export class TestAdministration {
  readonly #inner: AccountAdministrationService;
  readonly #clock: DeterministicClock;

  constructor(inner: AccountAdministrationService, clock: DeterministicClock) {
    this.#inner = inner;
    this.#clock = clock;
  }

  registerUser(seed: number, options?: { readonly password?: string }): Promise<UserId> {
    return registerSeedUser(this.#inner, seed, () => this.#clock.now(), options);
  }
}

export function createTestWorld(options?: { readonly webhookVerifier?: WebhookVerifier }): TestWorld {
  const clock = new DeterministicClock(T0);
  const ids = new DeterministicUuidGenerator(30_000);
  const membershipIds = new DeterministicUuidGenerator(40_000);
  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const organizations = new InMemoryOrganizationRepository();
  const memberships = new InMemoryMembershipRepository();
  const sessions = new InMemoryAuthSessionRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const hasher = new InsecureTestPasswordHasher();
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
  const persistence = createInMemoryPersistence();
  const service = createApiService({
    persistence,
    identity: { users, directory, credentials, sessions, memberships, organizations, ledger, hasher },
    webhookVerifier:
      options?.webhookVerifier ??
      {
        // Overridden per webhook test; the ingest path is tested elsewhere.
        verify: async () => {
          throw new Error("the webhook verifier must be configured for webhook tests");
        },
      },
    now: () => clock.now(),
    newId: () => ids.next(),
  });
  return {
    clock,
    ids,
    persistence,
    users,
    directory,
    organizations,
    memberships,
    administration: new TestAdministration(administration, clock),
    service,
  };
}

export function userIdFromSeed(seed: number): UserId {
  return parseUserId(deterministicUuidFromSeed(seed));
}

/** The personal tenant of a seeded user. */
export function tenantOf(seed: number) {
  return tenantIdFromUser(userIdFromSeed(seed));
}

/** Convenience headers for an authenticated mutation. */
export function mutationHeaders(input: {
  readonly actorId: string;
  readonly tenantId: string;
  readonly key: string;
  readonly expectedVersion?: number;
}): Record<string, string> {
  return {
    "x-roamlink-actor-id": input.actorId,
    "x-roamlink-tenant-id": input.tenantId,
    "x-roamlink-request-id": `req-${input.key}`,
    "x-roamlink-correlation-id": `corr-${input.key}`,
    "idempotency-key": input.key,
    ...(input.expectedVersion !== undefined
      ? { "x-roamlink-expected-version": String(input.expectedVersion) }
      : {}),
  };
}
