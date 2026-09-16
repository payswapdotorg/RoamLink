/**
 * Shared deterministic fixtures for the auth test suite (RL-004).
 *
 * Everything is wired through the REAL ports and services with in-memory
 * adapters, a deterministic clock and deterministic UUID generators, so the
 * tenant-boundary, idempotency and fail-closed proofs are reproducible.
 */
import { parseUserId, tenantIdFromUser, type TenantId, type UserId } from "@roamlink/contracts";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  deterministicUuidFromSeed,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";

import {
  AccountAdministrationService,
  AuthenticationService,
  AuthorizationService,
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "../src/index.js";

export const T0 = "2026-01-15T08:30:00.000Z";

export const PASSWORD_A = "correct-horse-battery";
export const PASSWORD_B = "another-staple-battery";

/** Deterministic user id from a seed (canonical UUID via testkit). */
export function userSeed(seed: number): UserId {
  return parseUserId(deterministicUuidFromSeed(seed));
}

/** Deterministic organization id from a seed. */
export function orgSeed(seed: number): string {
  return deterministicUuidFromSeed(seed);
}

export function tenantOfUser(userId: UserId): TenantId {
  return tenantIdFromUser(userId);
}

/** A fully wired in-memory world for auth tests. */
export class TestWorld {
  readonly clock: DeterministicClock;
  readonly sessionIds: DeterministicUuidGenerator;
  readonly membershipIds: DeterministicUuidGenerator;
  readonly users: InMemoryUserRepository;
  readonly directory: InMemoryUserDirectory;
  readonly credentials: InMemoryCredentialRepository;
  readonly organizations: InMemoryOrganizationRepository;
  readonly memberships: InMemoryMembershipRepository;
  readonly sessions: InMemoryAuthSessionRepository;
  readonly ledger: InMemoryIdempotencyLedger;
  readonly authorization: AuthorizationService;
  readonly administration: AccountAdministrationService;
  readonly authentication: AuthenticationService;

  constructor() {
    this.clock = new DeterministicClock(T0);
    this.sessionIds = new DeterministicUuidGenerator(10_000);
    this.membershipIds = new DeterministicUuidGenerator(20_000);
    this.users = new InMemoryUserRepository();
    this.directory = new InMemoryUserDirectory(this.users);
    this.credentials = new InMemoryCredentialRepository();
    this.organizations = new InMemoryOrganizationRepository();
    this.memberships = new InMemoryMembershipRepository();
    this.sessions = new InMemoryAuthSessionRepository();
    this.ledger = new InMemoryIdempotencyLedger();
    this.authorization = new AuthorizationService(this.memberships, this.organizations);
    this.administration = new AccountAdministrationService({
      users: this.users,
      directory: this.directory,
      credentials: this.credentials,
      organizations: this.organizations,
      memberships: this.memberships,
      ledger: this.ledger,
      hasher: new InsecureTestPasswordHasher(),
      authorization: this.authorization,
      now: () => this.clock.now(),
      generateMembershipId: () => this.membershipIds.next(),
    });
    this.authentication = new AuthenticationService({
      users: this.users,
      directory: this.directory,
      credentials: this.credentials,
      sessions: this.sessions,
      hasher: new InsecureTestPasswordHasher(),
      ledger: this.ledger,
      now: () => this.clock.now(),
      generateSessionId: () => this.sessionIds.next(),
    });
  }

  /** Registers a user via the real administration service (envelope-gated). */
  async registerUser(seed: number, options?: { readonly password?: string }): Promise<UserId> {
    const userId = userSeed(seed);
    await this.administration.registerUser(
      fixtureCommandEnvelope({
        actorId: `usr:${userId}`,
        tenantId: tenantIdFromUser(userId),
        idempotencyKey: `register-user-${seed}`,
        correlationId: `corr-register-user-${seed}`,
        createdAt: this.clock.now(),
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

  /** Creates an org (owner = seed user) via the administration service. */
  async createOrganization(ownerSeed: number, organizationSeed: number): Promise<string> {
    const ownerId = userSeed(ownerSeed);
    const organizationId = orgSeed(organizationSeed);
    await this.administration.createOrganization(
      fixtureCommandEnvelope({
        actorId: `usr:${ownerId}`,
        tenantId: `org:${organizationId}`,
        idempotencyKey: `create-org-${organizationSeed}`,
        correlationId: `corr-create-org-${organizationSeed}`,
        createdAt: this.clock.now(),
      }),
      { organizationId, name: `Org ${organizationSeed}` },
    );
    return organizationId;
  }

  /** Adds a member to an org via the administration service. */
  async addMember(
    actorSeed: number,
    organizationId: string,
    memberUserId: UserId,
    role: "owner" | "admin" | "member",
    keySuffix: string,
  ): Promise<{ membershipId: string; role: string }> {
    return this.administration.addMember(
      fixtureCommandEnvelope({
        actorId: `usr:${userSeed(actorSeed)}`,
        tenantId: `org:${organizationId}`,
        idempotencyKey: `add-member-${keySuffix}`,
        correlationId: `corr-add-member-${keySuffix}`,
        createdAt: this.clock.now(),
      }),
      { organizationId, userId: memberUserId, role },
    );
  }
}
