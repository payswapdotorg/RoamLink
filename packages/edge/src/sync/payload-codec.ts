/**
 * The encrypted-payload codec for the offline outbox (RL-042, RL-LOCK-015/
 * 016, building on the RL-040 `EdgeOutboxCiphertextEnvelope` shape).
 *
 *  - {@link EdgePayloadCipher} is the PORT: encrypt a plaintext string under
 *    a rotation-aware KEY REFERENCE, decrypt it back. Plaintext exists only
 *    transiently inside `encrypt`/`decrypt` call frames - it is never
 *    returned alongside records, never persisted, never logged;
 *  - {@link createAesGcmEdgePayloadCipher} is the reference implementation:
 *    AES-256-GCM via node:crypto, 12-byte random nonce + 16-byte auth tag
 *    PREFIXED to the ciphertext and base64url-encoded together (the frozen
 *    RL-040 envelope has no nonce field, so the nonce rides inside the
 *    ciphertext blob - the envelope shape is untouched);
 *  - key material enters ONLY through the {@link EdgeSyncKeyProvider}
 *    function - the duck-typed seam the RL-050 secrets boundary implements
 *    (`createSecretBytesKeyProvider`). This package never imports the
 *    secrets package: the dependency direction of spec/dependency-graph.md
 *    (RL-002 -> RL-040 -> RL-042, secrets independent) stays intact.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DomainError, ValidationError } from "@roamlink/contracts";

/** The algorithm identifier written into ciphertext envelopes. */
export const EDGE_PAYLOAD_CIPHER_ALGORITHM = "aes-256-gcm";

/** Required key length for AES-256 (bytes). */
export const EDGE_PAYLOAD_KEY_LENGTH_BYTES = 32;

/** nonce (12) + auth tag (16) prefix length. */
const GCM_PREFIX_LENGTH = 12 + 16;

/**
 * Key-material seam: resolves a key REFERENCE to raw key bytes. Production
 * wiring implements this over the RL-050 secrets boundary
 * (`createSecretBytesKeyProvider`) so values never appear outside it.
 */
export type EdgeSyncKeyProvider = (keyId: string) => Promise<Uint8Array>;

/** The encrypt/decrypt port used by the offline outbox engine. */
export interface EdgePayloadCipher {
  /** Algorithm identifier for {@link import("./outbox.js").EdgeOutboxCiphertextEnvelope}. */
  readonly algorithm: string;
  /** Encrypts `plaintext` under `keyId`; returns base64url(nonce||tag||ciphertext). */
  encrypt(keyId: string, plaintext: string): Promise<string>;
  /** Decrypts a base64url envelope produced by `encrypt`; fail-closed on tamper. */
  decrypt(keyId: string, ciphertext: string): Promise<string>;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

async function requireKeyBytes(keyProvider: EdgeSyncKeyProvider, keyId: string): Promise<Uint8Array> {
  if (typeof keyId !== "string" || keyId.length === 0 || keyId.length > 64) {
    throw new ValidationError("keyId must be a bounded non-empty key reference", {
      reason: "EDGE_PAYLOAD_KEY_INVALID",
      details: [{ path: "keyId", issue: "not a bounded key reference" }],
    });
  }
  const bytes = await keyProvider(keyId);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== EDGE_PAYLOAD_KEY_LENGTH_BYTES) {
    throw new ValidationError(
      `the key provider must return exactly ${EDGE_PAYLOAD_KEY_LENGTH_BYTES} bytes for AES-256 (key material itself is never included here)`,
      {
        reason: "EDGE_PAYLOAD_KEY_INVALID",
        details: [{ path: "keyProvider", issue: "wrong key length" }],
      },
    );
  }
  return bytes;
}

/**
 * Reference AES-256-GCM cipher. Decryption failures (tampered ciphertext,
 * wrong key, truncated blob) throw a typed DomainError with a SUPPRESSED
 * detail - never the plaintext or key material (RL-LOCK-016).
 */
export function createAesGcmEdgePayloadCipher(keyProvider: EdgeSyncKeyProvider): EdgePayloadCipher {
  return {
    algorithm: EDGE_PAYLOAD_CIPHER_ALGORITHM,
    encrypt: async (keyId: string, plaintext: string): Promise<string> => {
      if (typeof plaintext !== "string" || plaintext.length === 0 || plaintext.length > 16_384) {
        throw new ValidationError("plaintext must be a non-empty string of at most 16384 chars", {
          reason: "EDGE_PAYLOAD_PLAINTEXT_INVALID",
          details: [{ path: "plaintext", issue: "out of bounds" }],
        });
      }
      const key = await requireKeyBytes(keyProvider, keyId);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return toBase64Url(new Uint8Array(Buffer.concat([nonce, tag, ciphertext])));
    },
    decrypt: async (keyId: string, ciphertext: string): Promise<string> => {
      const blob = fromBase64Url(ciphertext);
      if (blob.byteLength < GCM_PREFIX_LENGTH) {
        throw new DomainError("ciphertext blob is too short to be a valid envelope", {
          reason: "EDGE_PAYLOAD_DECRYPT_FAILED",
        });
      }
      const key = await requireKeyBytes(keyProvider, keyId);
      const nonce = blob.subarray(0, 12);
      const tag = blob.subarray(12, GCM_PREFIX_LENGTH);
      const body = blob.subarray(GCM_PREFIX_LENGTH);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        throw new DomainError(
          "payload decryption failed (tampered ciphertext or wrong key; details suppressed)",
          { reason: "EDGE_PAYLOAD_DECRYPT_FAILED" },
        );
      }
    },
  };
}
