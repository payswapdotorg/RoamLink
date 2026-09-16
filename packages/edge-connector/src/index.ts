/**
 * @roamlink/edge-connector - the enterprise edge connector contract
 * (RL-044, Wave 3).
 *
 * The typed contract for enterprise edge integration (spec/mobile.md
 * "Enterprise edge"): MDM-managed configuration, system extensions,
 * VPN/network extensions or an enterprise connector WHEN SUPPORTED, with
 * capability negotiation over a closed vocabulary whose guaranteed
 * degradation floor is observation + user-guided actions - the
 * architecture still works when only those are available.
 *
 *  - capability negotiation: granted/denied with typed reasons and explicit
 *    fallbacks, plus the effective operating mode (enterprise / user-guided /
 *    observation-only);
 *  - configuration delivery: versioned, typed, bounded policy sets that are
 *    structurally incapable of carrying secrets (RL-LOCK-016) with explicit
 *    expiry semantics;
 *  - credential isolation: short-lived (bounded TTL), device-bound, narrowly
 *    scoped (closed vocabulary), revocable grants carrying a secret
 *    REFERENCE only - never material (spec/security.md "Credential rules");
 *  - an in-memory fake implementing the contract deterministically for
 *    tests/local dev - no real MDM/VPN platform code.
 *
 * Enterprise integrations may observe and request connectivity but never
 * create a second path/session authority (spec/architecture.md §8).
 * Depends on @roamlink/contracts and @roamlink/edge (device refs).
 */
export * from "./version.js";
export * from "./capability.js";
export * from "./configuration.js";
export * from "./credential.js";
export * from "./connector.js";
export * from "./in-memory-connector.js";
