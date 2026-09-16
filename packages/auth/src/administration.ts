/**
 * Account administration service (RL-004).
 *
 * Envelope-gated, idempotent use cases for the account lifecycle:
 * registerUser, createOrganization, addMember, changeMemberRole,
 * revokeMembership, suspendOrganization, activateOrganization.
 *
 * Invariants enforced HERE (where the whole organization is visible):
 *  - owner protection: only holders of `owner:manage` (owners) may add,
 *    re-role or revoke owners;
 *  - last-owner protection: an organization can never lose its last active
 *    owner (changeRole and revokeMembership both check);
 *  - suspended-organization reactivation uses the single sanctioned
 *    authorization escape (authorization.ts);
 *  - every mutation runs through the Wave-0 command envelope +
 *    idempotency ledger (RL-LOCK-014) and CAS-guarded repository writes.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseMembershipId,
  parseOrganizationId,
  parseRevision,
  parseUserId,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type MembershipId,
  type OrganizationId,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { admitCommand, commitCommand, type IdempotencyLedger } from "./idempotency.js";
import { parseActorPrincipal } from "./ids.js";
import { parseEmailAddress, type EmailAddress } from "./contact.js";
import { parsePasswordSecret, type PasswordHasher, type PasswordSecret } from "./password.js";
import { Membership, type MembershipRecord, type MembershipRole } from "./membership.js";
import { Organization } from "./organization.js";
import type {
  CredentialRepository,
  MembershipRepository,
  OrganizationRepository,
  UserDirectory,
  UserRepository,
} from "./ports.js";
import type { AuthorizationService } from "./authorization.js";
import { User } from "./user.js";

export interface AccountAdministrationDeps {
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly credentials: CredentialRepository;
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  readonly ledger: IdempotencyLedger;
  readonly hasher: PasswordHasher;
  readonly authorization: AuthorizationService;
  readonly now: () => UtcInstant;
  /** Supplies fresh membership ids. */
  readonly generateMembershipId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`account command rejected: ${issue}`, {
    reason: "ACCOUNT_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

function notFound(what: string, reason: string): never {
  throw new NotFoundError(`${what} not found in the command tenant`, { reason });
}

/** Account lifecycle use cases (all envelope-gated and idempotent). */
export class AccountAdministrationService {
  private readonly deps: AccountAdministrationDeps;

  constructor(deps: AccountAdministrationDeps) {
    this.deps = deps;
  }

  /**
   * Self-registration: creates the user (personal tenant `usr:<UserId>`) and
   * the initial password credential. The envelope must already name the new
   * user's tenant and principal - ids are caller-generated (canonical UUIDs)
   * so the envelope can be built before the call.
   */
  async registerUser(
    envelope: CommandEnvelope,
    input: {
      readonly userId: string;
      readonly email: string;
      readonly displayName: string;
      readonly password: string;
    },
  ): Promise<{ readonly userId: string; readonly tenantId: string; readonly status: string }> {
    type Outcome = { readonly userId: string; readonly tenantId: string; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const userId = parseUserId(input.userId);
    const email: EmailAddress = parseEmailAddress(input.email);
    const password: PasswordSecret = parsePasswordSecret(input.password);

    const principal = this.userPrincipalOf(envelope.actorId);
    if (principal !== userId) {
      commandInvalid("self-registration requires the envelope actor to be the new user principal");
    }
    const tenantId = tenantIdFromUser(userId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the new user's personal tenant");
    }

    const existingById = await this.deps.users.findById(tenantId, userId);
    if (existingById !== undefined) {
      throw new ConflictError("the user id is already registered", {
        reason: "USER_ALREADY_EXISTS",
      });
    }
    // Email uniqueness is GLOBAL across personal tenants: resolve through
    // the user directory (the sanctioned email->id index), never through a
    // cross-tenant scan.
    const existingByEmail = await this.deps.directory.resolveUserIdByEmail(email);
    if (existingByEmail !== undefined) {
      throw new ConflictError("the email address is already registered", {
        reason: "EMAIL_ALREADY_REGISTERED",
      });
    }

    const at = this.deps.now();
    const user = new User({
      userId,
      email,
      displayName: input.displayName,
      status: "active",
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
    await this.deps.users.save(user.toRecord());

    const hash = await this.deps.hasher.hash(password);
    await this.deps.credentials.save({
      tenantId,
      userId,
      algorithm: hash.algorithm,
      digest: hash.digest,
      updatedAt: at,
      revision: parseRevision(1),
    });

    const outcome: CanonicalJsonValue = Object.freeze({
      userId,
      tenantId,
      status: user.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /**
   * Creates an organization (tenant `org:<OrganizationId>`) with the acting
   * user as its owner. The actor must be an existing active user.
   */
  async createOrganization(
    envelope: CommandEnvelope,
    input: { readonly organizationId: string; readonly name: string },
  ): Promise<{
    readonly organizationId: string;
    readonly tenantId: string;
    readonly membershipId: string;
    readonly role: MembershipRole;
  }> {
    type Outcome = {
      readonly organizationId: string;
      readonly tenantId: string;
      readonly membershipId: string;
      readonly role: MembershipRole;
    };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the new organization's tenant");
    }
    const ownerId = this.userPrincipalOf(envelope.actorId);
    const owner = await this.deps.users.findById(tenantIdFromUser(ownerId), ownerId);
    if (owner === undefined || owner.status !== "active") {
      throw new ConflictError("the acting user must be an existing active user", {
        reason: "OWNER_INVALID",
      });
    }

    const existing = await this.deps.organizations.findById(tenantId, organizationId);
    if (existing !== undefined) {
      throw new ConflictError("the organization id already exists", {
        reason: "ORGANIZATION_ALREADY_EXISTS",
      });
    }

    const at = this.deps.now();
    const organization = new Organization({
      organizationId,
      name: input.name,
      status: "active",
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
    await this.deps.organizations.save(organization.toRecord());

    const membership = new Membership({
      membershipId: this.deps.generateMembershipId(),
      organizationId,
      userId: ownerId,
      role: "owner",
      status: "active",
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
    await this.deps.memberships.save(membership.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      organizationId,
      tenantId,
      membershipId: membership.membershipId,
      role: membership.role,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Adds a member to the organization (adding an owner requires owner:manage). */
  async addMember(
    envelope: CommandEnvelope,
    input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly role: MembershipRole;
    },
  ): Promise<{ readonly membershipId: string; readonly role: MembershipRole }> {
    type Outcome = { readonly membershipId: string; readonly role: MembershipRole };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the organization's tenant");
    }
    await this.deps.authorization.authorize(
      envelope.actorId,
      tenantId,
      input.role === "owner" ? "owner:manage" : "member:invite",
      this.deps.now(),
    );

    const userId = parseUserId(input.userId);
    const user = await this.deps.users.findById(tenantIdFromUser(userId), userId);
    if (user === undefined || user.status !== "active") {
      throw new ConflictError("the target user must be an existing active user", {
        reason: "MEMBER_USER_INVALID",
      });
    }
    const existing = await this.findActiveMembershipOfUser(tenantId, organizationId, userId);
    if (existing !== undefined) {
      throw new ConflictError("the user already has an active membership in the organization", {
        reason: "MEMBER_ALREADY_ACTIVE",
      });
    }

    const at = this.deps.now();
    const membership = new Membership({
      membershipId: this.deps.generateMembershipId(),
      organizationId,
      userId,
      role: input.role,
      status: "active",
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
    await this.deps.memberships.save(membership.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      membershipId: membership.membershipId,
      role: membership.role,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Changes a member's role (owner changes require owner:manage; last-owner protected). */
  async changeMemberRole(
    envelope: CommandEnvelope,
    input: {
      readonly organizationId: string;
      readonly membershipId: string;
      readonly newRole: MembershipRole;
    },
  ): Promise<{ readonly membershipId: string; readonly role: MembershipRole }> {
    type Outcome = { readonly membershipId: string; readonly role: MembershipRole };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the organization's tenant");
    }
    const membershipId = parseMembershipId(input.membershipId);
    const membership = await this.findMembership(tenantId, membershipId);
    const requiresOwner = membership.role === "owner" || input.newRole === "owner";
    await this.deps.authorization.authorize(
      envelope.actorId,
      tenantId,
      requiresOwner ? "owner:manage" : "member:manage",
      this.deps.now(),
    );

    if (membership.role === "owner" && input.newRole !== "owner") {
      await this.assertNotLastOwner(tenantId, organizationId, membership.toRecord());
    }

    const changed = membership.changeRole(input.newRole, this.deps.now());
    await this.deps.memberships.save(changed.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      membershipId: changed.membershipId,
      role: changed.role,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Revokes a membership (revoking an owner requires owner:manage; last-owner protected). */
  async revokeMembership(
    envelope: CommandEnvelope,
    input: { readonly organizationId: string; readonly membershipId: string },
  ): Promise<{ readonly membershipId: string; readonly revoked: boolean }> {
    type Outcome = { readonly membershipId: string; readonly revoked: boolean };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the organization's tenant");
    }
    const membershipId = parseMembershipId(input.membershipId);
    const membership = await this.findMembership(tenantId, membershipId);
    await this.deps.authorization.authorize(
      envelope.actorId,
      tenantId,
      membership.role === "owner" ? "owner:manage" : "member:manage",
      this.deps.now(),
    );

    if (membership.role === "owner") {
      await this.assertNotLastOwner(tenantId, organizationId, membership.toRecord());
    }

    const revoked = membership.revoke(this.deps.now());
    await this.deps.memberships.save(revoked.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      membershipId: revoked.membershipId,
      revoked: revoked.status === "revoked",
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Suspends the organization (blocks all member access). */
  async suspendOrganization(
    envelope: CommandEnvelope,
    input: { readonly organizationId: string },
  ): Promise<{ readonly organizationId: OrganizationId; readonly status: string }> {
    type Outcome = { readonly organizationId: OrganizationId; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the organization's tenant");
    }
    await this.deps.authorization.authorize(
      envelope.actorId,
      tenantId,
      "org:manage",
      this.deps.now(),
    );
    const organization = await this.findOrganization(tenantId, organizationId);
    const suspended = organization.suspend(this.deps.now());
    await this.deps.organizations.save(suspended.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      organizationId: suspended.organizationId,
      status: suspended.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /**
   * Reactivates a suspended organization. Uses the SINGLE sanctioned
   * suspended-organization authorization escape (owner + org:manage while
   * suspended); without the escape a suspended org could never recover.
   */
  async activateOrganization(
    envelope: CommandEnvelope,
    input: { readonly organizationId: string },
  ): Promise<{ readonly organizationId: OrganizationId; readonly status: string }> {
    type Outcome = { readonly organizationId: OrganizationId; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const organizationId = parseOrganizationId(input.organizationId);
    const tenantId = tenantIdFromOrganization(organizationId);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must be the organization's tenant");
    }
    await this.deps.authorization.authorize(
      envelope.actorId,
      tenantId,
      "org:manage",
      this.deps.now(),
      { allowSuspendedOrganization: true },
    );
    const organization = await this.findOrganization(tenantId, organizationId);
    const activated = organization.activate(this.deps.now());
    await this.deps.organizations.save(activated.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      organizationId: activated.organizationId,
      status: activated.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  // --- helpers -----------------------------------------------------------------

  /** Parses the user principal of the actor (fail-closed). */
  private userPrincipalOf(actorId: string): UserId {
    const principal = parseActorPrincipal(actorId);
    if (principal.kind !== "user") {
      commandInvalid("the envelope actor must be a user principal");
    }
    return principal.userId;
  }

  private async findMembership(
    tenantId: TenantId,
    membershipId: MembershipId,
  ): Promise<Membership> {
    const record = await this.deps.memberships.findById(tenantId, membershipId);
    if (record === undefined) {
      notFound("membership", "MEMBERSHIP_NOT_FOUND");
    }
    return Membership.fromRecord(record);
  }

  private async findActiveMembershipOfUser(
    tenantId: TenantId,
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<MembershipRecord | undefined> {
    const all = await this.deps.memberships.listByOrganization(tenantId, organizationId);
    return all.find((m) => m.userId === userId && m.status === "active");
  }

  private async findOrganization(
    tenantId: TenantId,
    organizationId: OrganizationId,
  ): Promise<Organization> {
    const record = await this.deps.organizations.findById(tenantId, organizationId);
    if (record === undefined) {
      notFound("organization", "ORGANIZATION_NOT_FOUND");
    }
    return Organization.fromRecord(record);
  }

  private async assertNotLastOwner(
    tenantId: TenantId,
    organizationId: OrganizationId,
    membership: MembershipRecord,
  ): Promise<void> {
    const all = await this.deps.memberships.listByOrganization(tenantId, organizationId);
    const activeOwners = all.filter((m) => m.status === "active" && m.role === "owner");
    const isLastActiveOwner =
      activeOwners.length === 1 && activeOwners[0]?.membershipId === membership.membershipId;
    if (isLastActiveOwner) {
      throw new ConflictError(
        "the organization must retain at least one active owner (last-owner protection)",
        { reason: "LAST_OWNER_PROTECTION" },
      );
    }
  }
}
