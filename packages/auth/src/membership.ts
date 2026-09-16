/**
 * Membership aggregate + the frozen account permission map (RL-004).
 *
 * A Membership links a User to an Organization with a role. Memberships are
 * scoped to the ORGANIZATION tenant (`org:<OrganizationId>`): listing them is
 * an organization-scoped read; the actor->tenant resolution read (list by
 * user, across tenants) is the single sanctioned cross-namespace read in the
 * auth port set (see ports.ts).
 *
 * The permission map is FROZEN: roles are owner/admin/member and the
 * permission grants are data, not policy negotiation. Owner protection is
 * structural: only owners hold `owner:manage`, and administrative services
 * additionally enforce last-owner protection (an organization can never lose
 * its last active owner).
 */
import {
  ValidationError,
  parseMembershipId,
  parseOrganizationId,
  parseRevision,
  parseUserId,
  parseUtcInstant,
  tenantIdFromOrganization,
  type MembershipId,
  type OrganizationId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

export const MEMBERSHIP_STATUSES = ["active", "revoked"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" && (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

/**
 * The closed account-permission vocabulary (RL-004 boundary permissions).
 *
 * Domain packages (e.g. @roamlink/domain-experience) define their OWN action
 * policy ports and adapt this map in the composition layer - never by
 * importing auth internals (RL-LOCK-019 disjoint ownership).
 */
export const ACCOUNT_PERMISSIONS = [
  "account:read",
  "account:manage",
  "org:read",
  "org:manage",
  "member:read",
  "member:invite",
  "member:manage",
  "owner:manage",
] as const;

export type AccountPermission = (typeof ACCOUNT_PERMISSIONS)[number];

export function isAccountPermission(value: unknown): value is AccountPermission {
  return typeof value === "string" && (ACCOUNT_PERMISSIONS as readonly string[]).includes(value);
}

/** Parse an account permission (closed vocabulary, no echo of the value). */
export function parseAccountPermission(value: unknown): AccountPermission {
  if (!isAccountPermission(value)) {
    throw new ValidationError(
      "value is not a member of the closed account permission vocabulary (account:read, account:manage, org:read, org:manage, member:read, member:invite, member:manage, owner:manage)",
      {
        reason: "ACCOUNT_PERMISSION_INVALID",
        details: [{ path: "AccountPermission", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

const PERSONAL_TENANT_PERMISSIONS: readonly AccountPermission[] = ["account:read", "account:manage"];

const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly AccountPermission[]>> =
  Object.freeze({
    owner: Object.freeze([...ACCOUNT_PERMISSIONS]),
    admin: Object.freeze([
      "org:read",
      "org:manage",
      "member:read",
      "member:invite",
      "member:manage",
    ] as const),
    member: Object.freeze(["org:read", "member:read"] as const),
  });

/** The frozen permission grants for a role (defensive copy of a frozen tuple). */
export function permissionsForRole(role: MembershipRole): readonly AccountPermission[] {
  if (!isMembershipRole(role)) {
    throw new ValidationError("role must be owner, admin or member", {
      reason: "MEMBERSHIP_ROLE_INVALID",
      details: [{ path: "MembershipRole", issue: "outside the closed vocabulary" }],
    });
  }
  return ROLE_PERMISSIONS[role];
}

/** Structural permission check: does the role grant the permission? */
export function roleHasPermission(role: MembershipRole, permission: AccountPermission): boolean {
  return permissionsForRole(role).includes(permission);
}

/** Permissions available to a user acting in their OWN personal tenant. */
export function personalTenantPermissions(): readonly AccountPermission[] {
  return PERSONAL_TENANT_PERMISSIONS;
}

/** Serialized (plain) form of a membership record. */
export interface MembershipRecord {
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Membership} constructor. */
export interface MembershipInput {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "membershipId",
  "organizationId",
  "userId",
  "role",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Membership rejected: ${label} - ${issue}`, {
    reason: "MEMBERSHIP_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

/**
 * The Membership aggregate. Deeply frozen; transitions return new instances.
 * Revocation is terminal - a revoked membership is never re-activated (a new
 * membership must be created instead, with a fresh audit trail).
 */
export class Membership {
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: MembershipInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.membershipId = parseField(
      "membershipId",
      "must be a canonical lowercase UUID",
      () => parseMembershipId(input.membershipId),
    );
    this.organizationId = parseField(
      "organizationId",
      "must be a canonical lowercase UUID",
      () => parseOrganizationId(input.organizationId),
    );
    this.tenantId = tenantIdFromOrganization(this.organizationId);
    this.userId = parseField("userId", "must be a canonical lowercase UUID", () =>
      parseUserId(input.userId),
    );
    if (!isMembershipRole(input.role)) {
      field("role", "must be 'owner', 'admin' or 'member'");
    }
    this.role = input.role;
    if (!isMembershipStatus(input.status)) {
      field("status", "must be 'active' or 'revoked'");
    }
    this.status = input.status;
    this.createdAt = parseField(
      "createdAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.createdAt),
    );
    this.updatedAt = parseField(
      "updatedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.updatedAt),
    );
    this.revision = parseField(
      "revision",
      "must be a positive integer (optimistic-concurrency token)",
      () => parseRevision(input.revision),
    );
    Object.freeze(this);
  }

  /**
   * Revokes the membership (terminal). Last-owner protection is enforced by
   * the administration service, which sees all memberships of the
   * organization (the aggregate alone cannot know).
   */
  revoke(at: UtcInstant): Membership {
    if (this.status !== "active") {
      field("status", "only an active membership can be revoked");
    }
    return this.with({ status: "revoked", updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  /** Changes the role (active memberships only). */
  changeRole(role: MembershipRole, at: UtcInstant): Membership {
    if (this.status !== "active") {
      field("status", "only an active membership can change role");
    }
    if (!isMembershipRole(role)) {
      field("role", "must be 'owner', 'admin' or 'member'");
    }
    if (role === this.role) {
      field("role", "the membership already carries this role (no-op change)");
    }
    return this.with({ role, updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  private with(overrides: {
    role?: MembershipRole;
    status?: MembershipStatus;
    updatedAt?: UtcInstant;
    revision?: Revision;
  }): Membership {
    return new Membership({
      membershipId: this.membershipId,
      organizationId: this.organizationId,
      userId: this.userId,
      role: overrides.role ?? this.role,
      status: overrides.status ?? this.status,
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: overrides.revision ?? this.revision,
    });
  }

  toRecord(): MembershipRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      membershipId: this.membershipId,
      organizationId: this.organizationId,
      userId: this.userId,
      role: this.role,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: MembershipRecord): Membership {
    return new Membership({
      membershipId: record.membershipId,
      organizationId: record.organizationId,
      userId: record.userId,
      role: record.role,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}
