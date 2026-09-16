/**
 * Byte-key provider adapter (RL-050 <-> RL-042 wiring seam).
 *
 * The RL-042 encrypted offline outbox needs raw key BYTES for its cipher, but
 * key/secret material may only enter through THIS boundary (RL-050). To keep
 * the package dependency graph exactly as specified
 * (spec/dependency-graph.md: edge does not depend on secrets), the adapter
 * produces a plain async FUNCTION `(keyId: string) => Promise<Uint8Array>`
 * that is structurally compatible with the edge cipher's key-provider port -
 * no edge types are imported here (duck typing across the boundary).
 *
 * The returned function resolves the ACTIVE version of the mapped secret and
 * returns its material as UTF-8 bytes. Key ids map 1:1 to secret names (both
 * safe labels); an unmapped key id fails with the boundary's typed
 * SECRET_UNKNOWN error - never a raw value.
 */
import type { SecretsResolver } from "./resolver.js";
import type { SecretName, SecretRef } from "./secret-ref.js";
import { isSecretName } from "./secret-ref.js";

/** The duck-typed key-provider function the RL-042 edge cipher accepts. */
export type SecretBytesKeyProvider = (keyId: string) => Promise<Uint8Array>;

/** Maps a key id (safe label) to the secret reference holding its material. */
export function keyRef(keyId: string): SecretRef {
  if (!isSecretName(keyId)) {
    // Fail closed without echoing the value; key ids are safe labels by
    // contract, so naming the grammar is enough.
    throw new TypeError("key ids must be safe labels (1-64 chars, [A-Za-z0-9._:@-])");
  }
  return Object.freeze({ name: keyId as SecretName, version: null });
}

/**
 * Builds a key provider over a resolver: `keyId` is the secret NAME and the
 * ACTIVE version's material is returned as UTF-8 bytes (rotation-aware - a
 * rotation changes which bytes future encryptions use, while ciphertext
 * envelopes keep the `keyId` they were encrypted under resolvable through
 * pinned versions until retired).
 */
export function createSecretBytesKeyProvider(
  resolver: SecretsResolver,
): SecretBytesKeyProvider {
  return async (keyId: string): Promise<Uint8Array> => {
    const resolved = await resolver.resolve(keyRef(keyId));
    return resolved.material.asUtf8Bytes();
  };
}
