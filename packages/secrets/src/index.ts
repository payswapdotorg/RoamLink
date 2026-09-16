/**
 * @roamlink/secrets - the secrets/credentials boundary (RL-050).
 *
 * Layer: platform/security. The ONLY way secret values enter a running
 * RoamLink component (spec/security.md "Credential rules"; RL-LOCK-016):
 *
 *  - typed, log-safe {@link SecretRef} handles (name + optional pinned
 *    version) - domain code never holds raw values;
 *  - the {@link SecretsResolver} resolution boundary with a CLOSED failure
 *    taxonomy (unknown name/version, retired version, unavailable backend,
 *    forbidden access, invalid material) reusing the Wave-0 error kinds;
 *  - rotation-aware versioning: `rotate` appends a version and moves the
 *    active pointer; pinned references keep resolving until retired;
 *  - {@link SecretMaterial}: values live behind true private fields and are
 *    redacted from toString/toJSON/util.inspect - they never appear in
 *    errors, logs or serialized state;
 *  - value-free access notifications ({@link withSecretAccessObserver}) as
 *    the seam the RL-051 audit stream taps for `secret-access` events;
 *  - an in-memory fake ({@link InMemorySecrets}) for tests and local dev.
 *
 * Depends ONLY on @roamlink/contracts. No vault/vendor SDK - real backends
 * are additive adapters behind the same port.
 */
export * from "./secret-ref.js";
export * from "./material.js";
export * from "./resolver.js";
export * from "./in-memory.js";
export * from "./key-provider.js";
