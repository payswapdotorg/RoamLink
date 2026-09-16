/**
 * Secret material wrapper (RL-050, RL-LOCK-016 - extends the env-schema /
 * redacting-logger conventions from @roamlink/contracts and
 * @roamlink/observability).
 *
 * {@link SecretMaterial} is the ONLY shape a resolved secret VALUE ever takes.
 * The raw value lives in a true private class field and is unreachable through
 * any serialization path: `JSON.stringify`, `String()`, template literals,
 * `util.inspect` and property enumeration all yield only "[REDACTED]". The
 * single legitimate read is the {@link SecretMaterial.value} accessor (and
 * {@link SecretMaterial.asUtf8Bytes}), used by the consuming boundary (e.g.
 * the RL-042 sync cipher) - never by domain logic and never by logging.
 */
import { inspect } from "node:util";
import { DomainError, ValidationError, parseRevision } from "@roamlink/contracts";

import { parseSecretName, type SecretName, type SecretVersion } from "./secret-ref.js";

/** The placeholder every serialization of secret material yields. */
export const REDACTED_SECRET_PLACEHOLDER = "[REDACTED]";

const MAX_SECRET_LENGTH = 8192;

/** A resolved secret value that can never serialize its raw content. */
export class SecretMaterial {
  readonly #value: string;

  constructor(raw: string) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SECRET_LENGTH) {
      throw new ValidationError(
        `SecretMaterial wraps a non-empty string of at most ${MAX_SECRET_LENGTH} chars`,
        {
          reason: "SECRET_MATERIAL_INVALID",
          details: [{ path: "SecretMaterial", issue: "not a bounded non-empty string" }],
        },
      );
    }
    this.#value = raw;
  }

  /**
   * The ONLY legitimate read of the secret value. Callers are boundary
   * consumers (crypto, transport headers) - never domain code, never logging.
   */
  get value(): string {
    return this.#value;
  }

  /** The value as UTF-8 bytes (e.g. for symmetric cipher keys). */
  asUtf8Bytes(): Uint8Array {
    return new TextEncoder().encode(this.#value);
  }

  toString(): string {
    return REDACTED_SECRET_PLACEHOLDER;
  }

  toJSON(): string {
    return REDACTED_SECRET_PLACEHOLDER;
  }

  [inspect.custom](): string {
    return "SecretMaterial([REDACTED])";
  }
}

/** A successfully resolved secret: reference metadata + redacted material. */
export interface ResolvedSecret {
  /** The name that was resolved. */
  readonly name: SecretName;
  /** The concrete version the material came from (never null here). */
  readonly version: SecretVersion;
  /** The wrapped value; serializes to "[REDACTED]" everywhere. */
  readonly material: SecretMaterial;
}

/** Builds a frozen resolved-secret record (used by resolver implementations). */
export function makeResolvedSecret(input: {
  readonly name: string;
  readonly version: number;
  readonly material: SecretMaterial;
}): ResolvedSecret {
  if (input === null || typeof input !== "object") {
    throw new DomainError("resolved secret records require name, version and wrapped material", {
      reason: "SECRET_RESOLUTION_INVALID",
    });
  }
  return Object.freeze({
    name: parseSecretName(input.name),
    version: parseRevision(input.version),
    material: input.material,
  });
}
