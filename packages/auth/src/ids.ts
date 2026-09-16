/**
 * Auth-domain identifiers and actor principals (RL-004).
 *
 * RoamLink identity is DISTINCT from ADCOS identity (RL-LOCK-003): this
 * package owns the RoamLink account model (users, organizations, memberships,
 * sessions) and never models ADCOS NodeIDs, ADCOS credentials or ADCOS
 * sessions. No ADCOS-typed field appears anywhere in these records.
 *
 * Actor principals are the Wave-0 `ActorId` values issued at the RoamLink
 * boundary: `usr:<UserId UUID>` for human users and `svc:<label>` for
 * RoamLink-internal service principals. The Wave-0 foreign-reference charset
 * accepts both shapes, so principals round-trip through
 * {@link @roamlink/contracts!parseActorId} unchanged.
 */
import {
  ValidationError,
  parseCanonicalUuidAs,
  parseForeignRefAs,
  parseUserId,
  type ActorId,
  type Branded,
  type UserId,
} from "@roamlink/contracts";

/** RoamLink auth-session identifier (canonical UUID, opaque). */
export type AuthSessionId = Branded<"AuthSessionId">;

export function parseAuthSessionId(value: unknown): AuthSessionId {
  return parseCanonicalUuidAs<AuthSessionId>(value, "AuthSessionId");
}

export function isAuthSessionId(value: unknown): value is AuthSessionId {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

const USER_PRINCIPAL_PREFIX = "usr:";
const SERVICE_PRINCIPAL_PREFIX = "svc:";
const SERVICE_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A parsed actor principal: a human user or a RoamLink service. */
export type ActorPrincipal =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "service"; readonly label: string };

function principalInvalid(issue: string): never {
  throw new ValidationError(
    `ActorPrincipal must be 'usr:<canonical uuid>' or 'svc:<service label>': ${issue}`,
    {
      reason: "ACTOR_PRINCIPAL_INVALID",
      details: [{ path: "ActorPrincipal", issue }],
    },
  );
}

/**
 * Parses an actor principal from a Wave-0 ActorId (or unknown value).
 *
 * Fail-closed and never echoing the offending value (RL-LOCK-016): the error
 * names the expected forms only.
 */
export function parseActorPrincipal(value: unknown): ActorPrincipal {
  if (typeof value !== "string") {
    principalInvalid("value is not a string");
  }
  if (value.startsWith(USER_PRINCIPAL_PREFIX)) {
    try {
      const userId = parseUserId(value.slice(USER_PRINCIPAL_PREFIX.length));
      return { kind: "user", userId };
    } catch {
      principalInvalid("the 'usr:' principal must embed a canonical lowercase UUID");
    }
  }
  if (value.startsWith(SERVICE_PRINCIPAL_PREFIX)) {
    const label = value.slice(SERVICE_PRINCIPAL_PREFIX.length);
    if (!SERVICE_LABEL_PATTERN.test(label)) {
      principalInvalid(
        "the 'svc:' label must be 1-32 chars, starting with a lowercase letter or digit, then lowercase letters, digits or hyphens only",
      );
    }
    return { kind: "service", label };
  }
  principalInvalid("missing 'usr:' or 'svc:' prefix");
}

/** Builds the Wave-0 ActorId string for a user principal. */
export function actorIdForUser(userId: string): ActorId {
  return parseForeignRefAs<ActorId>(`${USER_PRINCIPAL_PREFIX}${userId}`, "ActorId");
}

/** Builds the Wave-0 ActorId string for a service principal. */
export function actorIdForService(label: string): ActorId {
  return parseForeignRefAs<ActorId>(`${SERVICE_PRINCIPAL_PREFIX}${label}`, "ActorId");
}
