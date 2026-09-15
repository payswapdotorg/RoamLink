/**
 * Tenant boundary type (RL-002, spec/data-model.md "Multi-tenancy").
 *
 * Every tenant-scoped aggregate carries an organization/customer boundary.
 * `TenantId` encodes that boundary explicitly and auditably:
 *
 *   - organization tenant: `org:<OrganizationId UUID>`
 *   - individual customer tenant: `usr:<UserId UUID>`
 *
 * Cross-tenant references are prohibited unless an explicit federation
 * contract permits them; tenant checks should compare TenantId values.
 */
import type { Branded } from "../brand.js";
import { ValidationError } from "../errors/errors.js";
import {
  CANONICAL_UUID_PATTERN,
  parseCanonicalUuidAs,
  parseForeignRefAs,
} from "./id-shapes.js";
import type { OrganizationId, UserId } from "./roamlink-ids.js";

export type TenantId = Branded<"TenantId">;

export type TenantScope = "organization" | "user";

const ORG_PREFIX = "org:";
const USER_PREFIX = "usr:";

export function tenantIdFromOrganization(organizationId: OrganizationId): TenantId {
  return `${ORG_PREFIX}${organizationId}` as TenantId;
}

export function tenantIdFromUser(userId: UserId): TenantId {
  return `${USER_PREFIX}${userId}` as TenantId;
}

export function parseTenantId(value: unknown): TenantId {
  if (typeof value !== "string") {
    throw new ValidationError("TenantId must be a string of the form 'org:<uuid>' or 'usr:<uuid>'", {
      reason: "ID_INVALID",
      details: [{ path: "TenantId", issue: "value is not a string" }],
    });
  }
  const scope = value.startsWith(ORG_PREFIX)
    ? ORG_PREFIX
    : value.startsWith(USER_PREFIX)
      ? USER_PREFIX
      : undefined;
  if (scope === undefined) {
    throw new ValidationError("TenantId must start with 'org:' or 'usr:' followed by a canonical UUID", {
      reason: "ID_INVALID",
      details: [{ path: "TenantId", issue: "missing organization/user scope prefix" }],
    });
  }
  // validate the embedded UUID; the full scoped value is the tenant id
  parseCanonicalUuidAs<Branded<string>>(
    value.slice(scope.length),
    scope === ORG_PREFIX ? "TenantId.organization" : "TenantId.user",
  );
  return value as TenantId;
}

export function isTenantId(value: unknown): value is TenantId {
  try {
    parseTenantId(value);
    return true;
  } catch {
    return false;
  }
}

/** Discriminates the tenant scope without exposing the raw id. */
export function tenantScopeOf(tenantId: TenantId): TenantScope {
  return tenantId.startsWith(ORG_PREFIX) ? "organization" : "user";
}

/** Extracts the OrganizationId when the tenant is an organization. */
export function organizationIdOfTenant(tenantId: TenantId): OrganizationId | undefined {
  return tenantId.startsWith(ORG_PREFIX)
    ? (tenantId.slice(ORG_PREFIX.length) as OrganizationId)
    : undefined;
}

/** Extracts the UserId when the tenant is an individual customer. */
export function userIdOfTenant(tenantId: TenantId): UserId | undefined {
  return tenantId.startsWith(USER_PREFIX)
    ? (tenantId.slice(USER_PREFIX.length) as UserId)
    : undefined;
}

/**
 * Parses an ActorId: the authenticated principal (user or service) issuing a
 * command. Actors are opaque; principal resolution belongs to the auth
 * boundary work (RL-004), not to contracts.
 */
export type ActorId = Branded<"ActorId">;

export function parseActorId(value: unknown): ActorId {
  return parseForeignRefAs<ActorId>(value, "ActorId");
}

export function isActorId(value: unknown): value is ActorId {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value);
}

/** Exposed for tests and diagnostics; the tenant grammar is part of the contract. */
export const TENANT_UUID_PATTERN = CANONICAL_UUID_PATTERN;
