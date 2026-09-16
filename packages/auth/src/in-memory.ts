/**
 * In-memory adapters for the auth ports (RL-004).
 *
 * TEST/LOCAL-DEVELOPMENT DOUBLES with the SAME semantics a durable
 * implementation (RL-003 persistence) must provide:
 *  - tenant-scoped reads fail closed across tenants (no existence oracle);
 *  - writes are compare-and-swap on the record revision;
 *  - stored records are deep-frozen plain copies (mutation of the caller's
 *    object cannot rewrite history, and stored records cannot be mutated).
 *
 * The tenant-boundary proofs in the test suite run against THESE adapters:
 * if a durable adapter regresses the boundary, the same proofs must be run
 * against it before it ships (RL-LOCK-018).
 */
import {
  ConflictError,
  type Digest,
  type MembershipId,
  type OrganizationId,
  type TenantId,
  type UserId,
} from "@roamlink/contracts";

import type { AuthSessionId } from "./ids.js";
import type { EmailAddress } from "./contact.js";
import type {
  AuthSessionRepository,
  CredentialRecord,
  CredentialRepository,
  MembershipRepository,
  OrganizationRepository,
  UserDirectory,
  UserRepository,
} from "./ports.js";
import type { AuthSessionRecord } from "./session.js";
import type { MembershipRecord } from "./membership.js";
import type { OrganizationRecord } from "./organization.js";
import type { UserRecord } from "./user.js";

function revisionConflict(): ConflictError {
  return new ConflictError(
    "optimistic-concurrency conflict: the stored revision does not match the expected predecessor (the record changed concurrently, or already exists); re-read and retry - never overwrite silently",
    { reason: "REVISION_CONFLICT" },
  );
}

/** Copy + deep freeze so stored state can never be mutated from outside. */
function frozenCopy<T>(record: T): T {
  return Object.freeze(structuredClone(record));
}

function assertCas<T extends { readonly revision: number; readonly tenantId: TenantId }>(
  stored: T | undefined,
  next: T,
): void {
  if (stored === undefined) {
    if (next.revision !== 1) throw revisionConflict();
    return;
  }
  if (stored.revision !== next.revision - 1 || stored.tenantId !== next.tenantId) {
    throw revisionConflict();
  }
}

/**
 * In-memory user repository (tenant-scoped, fail-closed, CAS).
 *
 * `snapshotAll()` is an ADAPTER-INTERNAL seam backing the user-directory
 * resolution (durable implementations use an email index instead); it is not
 * part of the {@link UserRepository} port and must not be used by services.
 */
export class InMemoryUserRepository implements UserRepository {
  readonly #byId = new Map<string, UserRecord>();

  async save(record: UserRecord): Promise<void> {
    const stored = this.#byId.get(record.userId);
    assertCas(stored, record);
    this.#byId.set(record.userId, frozenCopy(record));
  }

  async findById(tenantId: TenantId, userId: UserId): Promise<UserRecord | undefined> {
    const record = this.#byId.get(userId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async findByEmail(tenantId: TenantId, email: EmailAddress): Promise<UserRecord | undefined> {
    for (const record of this.#byId.values()) {
      if (record.tenantId === tenantId && record.email === email) return record;
    }
    return undefined;
  }

  snapshotAll(): readonly UserRecord[] {
    return Object.freeze([...this.#byId.values()]);
  }
}

/**
 * In-memory email -> UserId directory. Returns ids only - never records -
 * so the authentication resolution cannot leak tenant-scoped user data.
 */
export class InMemoryUserDirectory implements UserDirectory {
  private readonly users: InMemoryUserRepository;

  constructor(users: InMemoryUserRepository) {
    this.users = users;
  }

  async resolveUserIdByEmail(email: EmailAddress): Promise<UserId | undefined> {
    for (const record of this.users.snapshotAll()) {
      if (record.email === email) return record.userId;
    }
    return undefined;
  }
}

/** In-memory credential store (tenant-scoped, fail-closed, CAS). */
export class InMemoryCredentialRepository implements CredentialRepository {
  readonly #byUserId = new Map<string, CredentialRecord>();

  async save(record: CredentialRecord): Promise<void> {
    const stored = this.#byUserId.get(record.userId);
    assertCas(stored, record);
    this.#byUserId.set(record.userId, frozenCopy(record));
  }

  async findByUserId(tenantId: TenantId, userId: UserId): Promise<CredentialRecord | undefined> {
    const record = this.#byUserId.get(userId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }
}

/** In-memory organization repository (tenant-scoped, fail-closed, CAS). */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  readonly #byId = new Map<string, OrganizationRecord>();

  async save(record: OrganizationRecord): Promise<void> {
    const stored = this.#byId.get(record.organizationId);
    assertCas(stored, record);
    this.#byId.set(record.organizationId, frozenCopy(record));
  }

  async findById(
    tenantId: TenantId,
    organizationId: OrganizationId,
  ): Promise<OrganizationRecord | undefined> {
    const record = this.#byId.get(organizationId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }
}

/** In-memory membership repository (tenant-scoped + sanctioned listByUser). */
export class InMemoryMembershipRepository implements MembershipRepository {
  readonly #byId = new Map<string, MembershipRecord>();

  async save(record: MembershipRecord): Promise<void> {
    const stored = this.#byId.get(record.membershipId);
    assertCas(stored, record);
    this.#byId.set(record.membershipId, frozenCopy(record));
  }

  async findById(
    tenantId: TenantId,
    membershipId: MembershipId,
  ): Promise<MembershipRecord | undefined> {
    const record = this.#byId.get(membershipId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listByOrganization(
    tenantId: TenantId,
    organizationId: OrganizationId,
  ): Promise<readonly MembershipRecord[]> {
    const records: MembershipRecord[] = [];
    for (const record of this.#byId.values()) {
      if (record.tenantId === tenantId && record.organizationId === organizationId) {
        records.push(record);
      }
    }
    return Object.freeze(records);
  }

  async listByUser(userId: UserId): Promise<readonly MembershipRecord[]> {
    const records: MembershipRecord[] = [];
    for (const record of this.#byId.values()) {
      if (record.userId === userId) records.push(record);
    }
    return Object.freeze(records);
  }
}

/** In-memory auth-session repository (digest-only, CAS, bearer read). */
export class InMemoryAuthSessionRepository implements AuthSessionRepository {
  readonly #byId = new Map<string, AuthSessionRecord>();
  readonly #byTokenDigest = new Map<string, AuthSessionRecord>();

  async save(record: AuthSessionRecord): Promise<void> {
    const stored = this.#byId.get(record.authSessionId);
    assertCas(stored, record);
    const copy = frozenCopy(record);
    this.#byId.set(record.authSessionId, copy);
    this.#byTokenDigest.set(record.tokenDigest, copy);
  }

  async findById(
    tenantId: TenantId,
    authSessionId: AuthSessionId,
  ): Promise<AuthSessionRecord | undefined> {
    const record = this.#byId.get(authSessionId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async findByTokenDigest(tokenDigest: Digest): Promise<AuthSessionRecord | undefined> {
    return this.#byTokenDigest.get(tokenDigest);
  }
}
