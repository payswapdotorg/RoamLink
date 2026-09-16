/**
 * @roamlink/auth - RoamLink auth/tenant boundary (RL-004).
 *
 * User / Organization / Membership aggregates, the server-side session
 * abstraction (opaque tokens, digest-only storage, bounded lifetime), the
 * password-hashing port, actor->tenant resolution and boundary permission
 * checks, tenant-scoped repository ports with in-memory adapters, and the
 * envelope-gated authentication + account-administration use cases.
 *
 * RoamLink identity is DISTINCT from ADCOS identity (RL-LOCK-003): no ADCOS
 * type or field appears in this package. All mutations run through the
 * Wave-0 command envelope with idempotency (RL-LOCK-014). Secrets never
 * appear in persisted records or errors (RL-LOCK-016).
 */
export * from "./ids.js";
export * from "./contact.js";
export * from "./user.js";
export * from "./organization.js";
export * from "./membership.js";
export * from "./password.js";
export * from "./token.js";
export * from "./session.js";
export * from "./idempotency.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./authorization.js";
export * from "./authentication.js";
export * from "./administration.js";
