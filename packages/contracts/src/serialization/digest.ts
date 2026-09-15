/**
 * SHA-256 digest helper over canonical JSON (RL-002).
 *
 * Determinism: `canonicalJsonDigest(v)` = `sha256Hex(canonicalizeJson(v))`,
 * so the same value always yields the same digest. The Wave-2 intent compiler
 * (intent digests) and the projection engine (payload_digest) both build on
 * this. Callers needing domain separation hash their own prefixed canonical
 * string with {@link sha256Hex}.
 *
 * Uses node:crypto (synchronous, server-side). Edge/browser runtimes that
 * cannot import node:crypto need an async WebCrypto variant - that would be an
 * additive contract extension, not a change to this module.
 */
import { createHash } from "node:crypto";
import type { Branded } from "../brand.js";
import { ValidationError } from "../errors/errors.js";
import { canonicalizeJson } from "./canonical-json.js";

/** Lowercase 64-char hex SHA-256 digest. */
export type Digest = Branded<"Digest">;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Hex(text: string): Digest {
  return createHash("sha256").update(text, "utf8").digest("hex") as Digest;
}

export function canonicalJsonDigest(value: unknown): Digest {
  return sha256Hex(canonicalizeJson(value));
}

export function parseDigest(value: unknown): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new ValidationError("Digest must be a lowercase 64-character hex SHA-256 string", {
      reason: "DIGEST_INVALID",
      details: [{ path: "Digest", issue: "not a lowercase 64-char hex string" }],
    });
  }
  return value as Digest;
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}
