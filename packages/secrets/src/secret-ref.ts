/**
 * Typed secret references (RL-050, RL-LOCK-016).
 *
 * A {@link SecretRef} is the ONLY handle domain code may hold for a secret:
 * a safe-label NAME plus an optional PINNED VERSION (null = resolve the
 * currently active version). The reference is deliberately incapable of
 * carrying secret VALUES - it is an opaque, log-safe identifier, mirroring the
 * Wave-0 env-schema convention where secrets live behind accessors and are
 * redacted from every serialization.
 *
 * References are branded types: a raw string is not assignable where a
 * `SecretName` is expected; values always enter through
 * {@link parseSecretRef} / {@link parseSecretName} (fail-closed validation).
 */
import {
  ValidationError,
  parseRevision,
  type Branded,
  type Revision,
} from "@roamlink/contracts";

/** Safe-label charset for secret names (mirrors the env KEY grammar). */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** Opaque, log-safe name of a secret (e.g. `ADCOS_CLIENT_SECRET`). */
export type SecretName = Branded<"SecretName">;

/** Monotonic version of a secret's material (rotation bumps it by 1). */
export type SecretVersion = Revision;

/**
 * A typed reference to a secret. `version: null` resolves the ACTIVE version
 * (rotation-aware); a pinned version resolves exactly that version and fails
 * typed when it has been retired.
 */
export interface SecretRef {
  readonly name: SecretName;
  /** Pinned version, or null for the currently active version. */
  readonly version: SecretVersion | null;
}

/** Input accepted by {@link parseSecretRef}. */
export interface SecretRefInput {
  readonly name: string;
  /** Positive integer version, or null/undefined for the active version. */
  readonly version?: number | null;
}

export function isSecretName(value: unknown): value is SecretName {
  return typeof value === "string" && SECRET_NAME_PATTERN.test(value);
}

/** Parses a safe-label secret name; offending values are never echoed. */
export function parseSecretName(value: unknown): SecretName {
  if (!isSecretName(value)) {
    throw new ValidationError(
      "SecretName must be a safe label (1-64 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only)",
      {
        reason: "SECRET_REF_INVALID",
        details: [{ path: "SecretName", issue: "not a safe label" }],
      },
    );
  }
  return value;
}

/** Parses and freezes a secret reference (fail-closed). */
export function parseSecretRef(input: SecretRefInput | SecretRef | unknown): SecretRef {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("SecretRef must be an object with name and version", {
      reason: "SECRET_REF_INVALID",
      details: [{ path: "SecretRef", issue: "not an object" }],
    });
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "name" && key !== "version") {
      throw new ValidationError(`SecretRef rejected unknown field '${key}'`, {
        reason: "SECRET_REF_INVALID",
        details: [{ path: `SecretRef.${key}`, issue: "unknown field" }],
      });
    }
  }
  const name = parseSecretName(record["name"]);
  if (record["version"] === null || record["version"] === undefined) {
    return Object.freeze({ name, version: null });
  }
  let version: SecretVersion;
  try {
    version = parseRevision(record["version"]);
  } catch {
    throw new ValidationError("SecretRef.version must be null or a positive integer", {
      reason: "SECRET_REF_INVALID",
      details: [{ path: "SecretRef.version", issue: "not null or a positive integer" }],
    });
  }
  return Object.freeze({ name, version });
}

/**
 * Canonical string form of a reference for CONFIG/LOG use:
 * `<name>@active` or `<name>@v<version>`. Contains no secret material.
 */
export function describeSecretRef(ref: SecretRef): string {
  return ref.version === null ? `${ref.name}@active` : `${ref.name}@v${ref.version}`;
}
