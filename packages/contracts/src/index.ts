/**
 * @roamlink/contracts - the lowest-level shared contract package (RL-002).
 *
 * Every other workspace package may depend on this one. It contains NO domain
 * logic and NO business authority (RL-LOCK-003/007): only the shared
 * primitives - opaque IDs and foreign references, UTC instants, evidence
 * classes, the error taxonomy, the command envelope, versioning, canonical
 * serialization + digests, freshness primitives and the fail-closed env
 * schema.
 *
 * Compatibility (RL-LOCK-017): this surface is versioned via
 * CONTRACTS_CONTRACT_VERSION and changes additively within a major.
 */
export * from "./brand.js";
export * from "./errors/errors.js";
export * from "./ids/id-shapes.js";
export * from "./ids/roamlink-ids.js";
export * from "./ids/foreign-refs.js";
export * from "./ids/tenant.js";
export * from "./ids/command-ids.js";
export * from "./time/utc-instant.js";
export * from "./evidence/evidence-class.js";
export * from "./versioning/versioning.js";
export * from "./serialization/canonical-json.js";
export * from "./serialization/digest.js";
export * from "./envelope/command-envelope.js";
export * from "./freshness/freshness.js";
export * from "./env/env-schema.js";
