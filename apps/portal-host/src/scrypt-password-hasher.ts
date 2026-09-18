/**
 * The hosted runtime's production password KDF binding (RL-089).
 *
 * The @roamlink/auth `PasswordHasher` port is deliberately implementation-
 * free ("production deployments bind a real KDF in the composition layer");
 * this file IS that binding for the hosted runtime: Node's scrypt via
 * node:crypto, keyed per user by a random salt, with the derivation
 * parameters carried INSIDE the stored digest so strengthening the defaults
 * later cannot break existing credentials.
 *
 * Hygiene (RL-LOCK-016): the secret never persists anywhere; the stored
 * digest carries only the algorithm parameters + salt + derived key. The
 * algorithm label is the auditable "scrypt" (the loud "insecure-test-sha256"
 * test double can therefore never pass for a production credential).
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import {
  parsePasswordHash,
  type PasswordHash,
  type PasswordHasher,
  type PasswordSecret,
} from "@roamlink/auth";

/** scrypt cost parameters (OWASP-recommended interactive-login class). */
const N = 16384; // CPU/memory cost
const R = 8; // block size
const P = 1; // parallelization
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const ALGORITHM = "scrypt";
const DIGEST_PREFIX = `scrypt$${N}$${R}$${P}$`;

/** The bounded stored digest shape: `scrypt$N$r$p$<salthex>$<dkhex>`. */
const DIGEST_PATTERN = /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

function derive(password: PasswordSecret, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: PasswordSecret): Promise<PasswordHash> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await derive(password, salt);
    return parsePasswordHash({
      algorithm: ALGORITHM,
      digest: `${DIGEST_PREFIX}${salt.toString("hex")}$${derived.toString("hex")}`,
    });
  }

  async verify(password: PasswordSecret, hash: PasswordHash): Promise<boolean> {
    // Only THIS algorithm's credentials verify here; anything else (including
    // the test double's label) is a rejected credential, never a crash.
    if (hash.algorithm !== ALGORITHM || !DIGEST_PATTERN.test(hash.digest)) {
      return false;
    }
    const [saltHex, derivedHex] = hash.digest.slice(DIGEST_PREFIX.length).split("$");
    if (saltHex === undefined || derivedHex === undefined) return false;
    const derived = await derive(password, Buffer.from(saltHex, "hex"));
    const stored = Buffer.from(derivedHex, "hex");
    return stored.length === derived.length && timingSafeEqual(stored, derived);
  }
}
