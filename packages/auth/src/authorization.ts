/**
 * Actor -> tenant resolution and boundary authorization (RL-004).
 *
 * Authorization is checked at the RoamLink boundary (spec/security.md
 * "Authorization"): every mutation resolves the actor to a tenant and checks
 * the account permission map BEFORE touching state. Everything fails closed:
 * unknown actor shapes, service principals without grants, missing/revoked
 * memberships and suspended organizations are all UnauthorizedError - with
 * messages that never echo actor ids or tenant ids.
 *
 * The single sanctioned escape: reactivating a SUSPENDED organization. A
 * suspended org blocks all member access, which would otherwise make the
 * organization permanently unrecoverable (chicken-and-egg). The escape is
 * scoped to `org:manage` + the suspended organization's own tenant.
 */
import {
  UnauthorizedError,
  type ActorId,
  type MembershipId,
  type TenantId,
  type UtcInstant,
  userIdOfTenant,
} from "@roamlink/contracts";

import { parseActorPrincipal, type ActorPrincipal } from "./ids.js";
import {
  personalTenantPermissions,
  roleHasPermission,
  type AccountPermission,
  type MembershipRole,
} from "./membership.js";
import type { MembershipRepository, OrganizationRepository } from "./ports.js";

/** Options for the authorization reads. */
export interface AuthorizeOptions {
  /**
   * The sanctioned suspended-organization escape: allow the actor's
   * organization permission check to proceed while the organization is
   * suspended. Used ONLY by the organization reactivation use case and only
   * for the `org:manage` permission.
   */
  readonly allowSuspendedOrganization?: boolean;
}

/** The resolved actor-tenant context for an authorized command. */
export interface ActorTenantResolution {
  readonly tenantId: TenantId;
  readonly scope: "user" | "organization";
  readonly principal: ActorPrincipal;
  /** Instant of the authorization decision. */
  readonly resolvedAt: UtcInstant;
  /** Present when scope is organization (the active membership used). */
  readonly membershipId?: MembershipId;
  readonly role?: MembershipRole;
}

/**
 * The boundary authorization service. Depends ONLY on tenant-scoped ports
 * (plus the single sanctioned listByUser resolution read).
 */
export class AuthorizationService {
  private readonly memberships: MembershipRepository;
  private readonly organizations: OrganizationRepository;

  constructor(
    memberships: MembershipRepository,
    organizations: OrganizationRepository,
  ) {
    this.memberships = memberships;
    this.organizations = organizations;
  }

  /**
   * Resolves the actor in the target tenant: personal tenants resolve the
   * actor's own user principal; organization tenants resolve the actor's
   * ACTIVE membership. Service principals fail closed (no grants exist in
   * RL-004; grant modeling is a later wave).
   */
  async resolveActorTenant(
    actorId: ActorId,
    tenantId: TenantId,
    at: UtcInstant,
    options?: AuthorizeOptions,
  ): Promise<ActorTenantResolution> {
    let principal: ActorPrincipal;
    try {
      principal = parseActorPrincipal(actorId);
    } catch {
      throw new UnauthorizedError("actor principal is not a RoamLink boundary principal", {
        reason: "ACTOR_INVALID",
      });
    }
    if (principal.kind === "service") {
      throw new UnauthorizedError(
        "service principals hold no account permissions in this wave; user principals only",
        { reason: "ACTOR_UNAUTHORIZED" },
      );
    }

    const tenantUserId = userIdOfTenant(tenantId);
    if (tenantUserId !== undefined) {
      if (tenantUserId !== principal.userId) {
        throw new UnauthorizedError(
          "a personal tenant may only be accessed by its owning user principal",
          { reason: "TENANT_ACTOR_MISMATCH" },
        );
      }
      return { tenantId, scope: "user", principal, resolvedAt: at };
    }

    // Organization tenant: resolve the actor's membership (sanctioned read).
    const memberships = await this.memberships.listByUser(principal.userId);
    const membership = memberships.find((m) => m.tenantId === tenantId && m.status === "active");
    if (membership === undefined) {
      throw new UnauthorizedError(
        "the actor has no active membership in the target organization tenant",
        { reason: "ACTOR_NOT_A_MEMBER" },
      );
    }
    const organization = await this.organizations.findById(tenantId, membership.organizationId);
    if (organization === undefined) {
      throw new UnauthorizedError(
        "the actor has no active membership in the target organization tenant",
        { reason: "ACTOR_NOT_A_MEMBER" },
      );
    }
    if (organization.status === "suspended" && options?.allowSuspendedOrganization !== true) {
      throw new UnauthorizedError(
        "the organization tenant is suspended; access is blocked (reactivation is the only sanctioned path)",
        { reason: "ORGANIZATION_SUSPENDED" },
      );
    }

    return {
      tenantId,
      scope: "organization",
      principal,
      resolvedAt: at,
      membershipId: membership.membershipId,
      role: membership.role,
    };
  }

  /**
   * Authorizes `permission` for the actor in the tenant. Fail-closed: any
   * resolution failure or missing grant throws UnauthorizedError; success
   * returns the resolution.
   */
  async authorize(
    actorId: ActorId,
    tenantId: TenantId,
    permission: AccountPermission,
    at: UtcInstant,
    options?: AuthorizeOptions,
  ): Promise<ActorTenantResolution> {
    const resolution = await this.resolveActorTenant(actorId, tenantId, at, options);
    if (resolution.scope === "user") {
      if (!personalTenantPermissions().includes(permission)) {
        throw new UnauthorizedError(
          "the permission is not granted in a personal tenant (organization membership required)",
          { reason: "PERMISSION_DENIED" },
        );
      }
      return resolution;
    }
    const role = resolution.role;
    if (role === undefined || !roleHasPermission(role, permission)) {
      throw new UnauthorizedError("the actor's role does not grant the requested permission", {
        reason: "PERMISSION_DENIED",
      });
    }
    if (options?.allowSuspendedOrganization === true && permission !== "org:manage") {
      // The suspended-organization escape is scoped to reactivation only.
      throw new UnauthorizedError(
        "the suspended-organization escape is scoped to the org:manage permission",
        { reason: "PERMISSION_DENIED" },
      );
    }
    return resolution;
  }
}
