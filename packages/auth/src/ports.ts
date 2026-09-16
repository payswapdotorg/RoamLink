/**
 * Tenant-scoped repository ports for the auth domain (RL-004).
 *
 * MULTI-TENANCY BY CONSTRUCTION: every record carries its Wave-0 TenantId and
 * every port read takes the tenant namespace FIRST. A read through the wrong
 * tenant returns `undefined` (or an empty list) - there is no existence
 * oracle across tenants, and cross-tenant access fails closed. The in-memory
 * adapters (in-memory.ts) PROVE this in tests.
 *
 * Sanctioned cross-namespace reads (exactly two, both resolution reads that
 * cannot know the tenant before resolving):
 *  - {@link MembershipRepository.listByUser}: actor -> organization tenants;
 *  - {@link AuthSessionRepository.findByTokenDigest}: bearer-token
 *    authentication (possession of the token digest IS the capability).
 *
 * All writes are compare-and-swap on the record revision: saving a record
 * whose revision is not exactly stored+1 (or 1 for an insert) throws a typed
 * ConflictError, mirroring the RL-003 optimistic-concurrency primitives.
 */
import type {
  Digest,
  MembershipId,
  OrganizationId,
  Revision,
  TenantId,
  UtcInstant,
  UserId,
} from "@roamlink/contracts";

import type { AuthSessionId } from "./ids.js";
import type { EmailAddress } from "./contact.js";
import type { MembershipRecord } from "./membership.js";
import type { OrganizationRecord } from "./organization.js";
import type { AuthSessionRecord } from "./session.js";
import type { UserRecord } from "./user.js";

/** Marker: every persisted auth record is tenant-scoped. */
export interface TenantScopedRecord {
  readonly tenantId: TenantId;
}

/** User directory: email -> UserId resolution for the authentication path. */
export interface UserDirectory {
  /** Resolves the (unique) user id for an email; undefined when unknown. */
  resolveUserIdByEmail(email: EmailAddress): Promise<UserId | undefined>;
}

/** Tenant-scoped user repository (personal tenants `usr:<UserId>`). */
export interface UserRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: UserRecord): Promise<void>;
  findById(tenantId: TenantId, userId: UserId): Promise<UserRecord | undefined>;
  findByEmail(tenantId: TenantId, email: EmailAddress): Promise<UserRecord | undefined>;
}

/**
 * A stored password credential (hash material only, never the secret).
 * SEPARATE repository from users by design (RL-LOCK-016): account reads can
 * never leak password-hash material.
 */
export interface CredentialRecord extends TenantScopedRecord {
  readonly userId: UserId;
  readonly algorithm: string;
  readonly digest: string;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Credential store port. */
export interface CredentialRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: CredentialRecord): Promise<void>;
  findByUserId(tenantId: TenantId, userId: UserId): Promise<CredentialRecord | undefined>;
}

/** Tenant-scoped organization repository (org tenants `org:<OrganizationId>`). */
export interface OrganizationRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: OrganizationRecord): Promise<void>;
  findById(tenantId: TenantId, organizationId: OrganizationId): Promise<OrganizationRecord | undefined>;
}

/**
 * Tenant-scoped membership repository (org tenants). `listByUser` is the
 * single sanctioned cross-namespace resolution read: actor -> tenants.
 */
export interface MembershipRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: MembershipRecord): Promise<void>;
  findById(tenantId: TenantId, membershipId: MembershipId): Promise<MembershipRecord | undefined>;
  listByOrganization(
    tenantId: TenantId,
    organizationId: OrganizationId,
  ): Promise<readonly MembershipRecord[]>;
  /** THE sanctioned cross-namespace read (actor -> organization tenants). */
  listByUser(userId: UserId): Promise<readonly MembershipRecord[]>;
}

/** Auth-session repository. Persists token DIGESTS only (RL-LOCK-016). */
export interface AuthSessionRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: AuthSessionRecord): Promise<void>;
  findById(tenantId: TenantId, authSessionId: AuthSessionId): Promise<AuthSessionRecord | undefined>;
  /**
   * Bearer-token authentication read (sanctioned cross-namespace): the digest
   * is the capability; the token itself is never stored.
   */
  findByTokenDigest(tokenDigest: Digest): Promise<AuthSessionRecord | undefined>;
}
