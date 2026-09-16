/**
 * The secrets resolution boundary (RL-050, spec/security.md "Credential
 * rules", RL-LOCK-016).
 *
 * {@link SecretsResolver} is the ONLY way secret values enter a running
 * RoamLink component. Domain code holds typed {@link SecretRef}s and asks the
 * boundary to resolve them; the resolved {@link SecretMaterial} is redacted
 * from every serialization path and never appears in errors or logs.
 *
 * The failure-mode taxonomy is CLOSED (no parallel ad-hoc error kinds - the
 * Wave-0 error taxonomy is reused with pinned reason codes):
 *
 * | reason                    | kind         | retryable | meaning                       |
 * |---------------------------|--------------|-----------|-------------------------------|
 * | SECRET_UNKNOWN            | not-found    | no        | name was never registered     |
 * | SECRET_VERSION_UNKNOWN    | not-found    | no        | version never existed         |
 * | SECRET_VERSION_RETIRED    | stale-state  | refresh   | version retired by rotation   |
 * | SECRET_UNAVAILABLE        | unavailable  | yes       | backend temporarily down      |
 * | SECRET_ACCESS_FORBIDDEN   | unauthorized | no        | caller may not read the secret|
 * | SECRET_MATERIAL_INVALID   | domain       | no        | stored material unusable      |
 *
 * Every message names the NAME/VERSION ONLY - never a value.
 */
import {
  NotFoundError,
  StaleStateError,
  UnauthorizedError,
  UnavailableError,
  nowUtc,
  type UtcInstant,
} from "@roamlink/contracts";

import type { SecretName, SecretRef, SecretVersion } from "./secret-ref.js";
import { describeSecretRef } from "./secret-ref.js";
import type { ResolvedSecret } from "./material.js";

/** The closed set of secret-resolution failure reason codes. */
export const SECRET_FAILURE_REASONS = [
  "SECRET_UNKNOWN",
  "SECRET_VERSION_UNKNOWN",
  "SECRET_VERSION_RETIRED",
  "SECRET_UNAVAILABLE",
  "SECRET_ACCESS_FORBIDDEN",
  "SECRET_MATERIAL_INVALID",
] as const;

export type SecretFailureReason = (typeof SECRET_FAILURE_REASONS)[number];

/** The resolution boundary port. Implementations MUST be fail-closed. */
export interface SecretsResolver {
  /**
   * Resolves a reference to concrete material. Floating (`version: null`)
   * references resolve the currently ACTIVE version; pinned references
   * resolve exactly that version or fail typed.
   */
  resolve(ref: SecretRef): Promise<ResolvedSecret>;
  /** The currently active version of a secret (fails SECRET_UNKNOWN otherwise). */
  activeVersion(name: SecretName): Promise<SecretVersion>;
}

/** Typed failure constructors - the closed taxonomy, nothing else. */
export function secretUnknownError(name: SecretName): NotFoundError {
  return new NotFoundError(
    `secret '${name}' is not known to the secrets boundary (registered names only; values are never included)`,
    { reason: "SECRET_UNKNOWN" },
  );
}

export function secretVersionUnknownError(name: SecretName, version: SecretVersion): NotFoundError {
  return new NotFoundError(
    `secret '${name}' has no version ${version} (versions are monotonic; values are never included)`,
    { reason: "SECRET_VERSION_UNKNOWN" },
  );
}

export function secretVersionRetiredError(ref: SecretRef): StaleStateError {
  return new StaleStateError(
    `secret reference '${describeSecretRef(ref)}' points at a retired version; re-resolve the active version after rotation`,
    { reason: "SECRET_VERSION_RETIRED" },
  );
}

export function secretUnavailableError(name: SecretName): UnavailableError {
  return new UnavailableError(
    `the secrets backend is temporarily unavailable for '${name}' (retry with backoff)`,
    { reason: "SECRET_UNAVAILABLE", retryAfterMs: 1_000 },
  );
}

export function secretAccessForbiddenError(ref: SecretRef): UnauthorizedError {
  return new UnauthorizedError(
    `the caller is not permitted to resolve '${describeSecretRef(ref)}'`,
    { reason: "SECRET_ACCESS_FORBIDDEN" },
  );
}

// ---------------------------------------------------------------------------
// Access observation (value-free) - the seam RL-051 audit taps into
// ---------------------------------------------------------------------------

/** Closed outcome vocabulary for observed resolution attempts. */
export const SECRET_ACCESS_OUTCOMES = [
  "resolved",
  "unknown",
  "version-unknown",
  "retired",
  "unavailable",
  "forbidden",
  "invalid-material",
] as const;

export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];

/**
 * A VALUE-FREE notification about one resolution attempt, for audit/telemetry
 * wiring (RL-051 records these as `secret-access` audit events). Carries the
 * reference, the resolved version (when known) and the outcome - never the
 * material.
 */
export interface SecretAccessNotification {
  readonly ref: SecretRef;
  /** Concrete version when resolution reached one; null when it failed earlier. */
  readonly resolvedVersion: SecretVersion | null;
  readonly outcome: SecretAccessOutcome;
  readonly at: UtcInstant;
}

/** Observer of resolution attempts (audit sink, metrics, tests). */
export type SecretAccessObserver = (notification: SecretAccessNotification) => void;

function outcomeForFailureReason(reason: string): SecretAccessOutcome {
  switch (reason) {
    case "SECRET_UNKNOWN":
      return "unknown";
    case "SECRET_VERSION_UNKNOWN":
      return "version-unknown";
    case "SECRET_VERSION_RETIRED":
      return "retired";
    case "SECRET_UNAVAILABLE":
      return "unavailable";
    case "SECRET_ACCESS_FORBIDDEN":
      return "forbidden";
    default:
      return "invalid-material";
  }
}

/**
 * Decorates a resolver with value-free access observation. Observers see
 * every attempt (success and failure); failures are re-thrown unchanged.
 * The notification instant comes from `now` (inject a deterministic clock in
 * tests; defaults to the system clock).
 */
export function withSecretAccessObserver(
  resolver: SecretsResolver,
  observer: SecretAccessObserver,
  now: () => UtcInstant = nowUtc,
): SecretsResolver {
  const notify = (ref: SecretRef, version: SecretVersion | null, outcome: SecretAccessOutcome) => {
    observer({ ref, resolvedVersion: version, outcome, at: now() });
  };
  return {
    resolve: async (ref: SecretRef) => {
      try {
        const resolved = await resolver.resolve(ref);
        notify(ref, resolved.version, "resolved");
        return resolved;
      } catch (error) {
        const reason =
          typeof error === "object" && error !== null && "reason" in error
            ? String((error as { readonly reason: unknown }).reason)
            : "";
        notify(ref, null, outcomeForFailureReason(reason));
        throw error;
      }
    },
    activeVersion: (name: SecretName) => resolver.activeVersion(name),
  };
}
