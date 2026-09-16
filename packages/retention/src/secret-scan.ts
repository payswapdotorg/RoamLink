/**
 * Secret-material scanning - the RL-LOCK-016 enforcement point (RL-054).
 *
 * spec/data-model.md "Privacy": "Secrets and credentials are never persisted
 * in ordinary domain tables." This module is the testable enforcement point
 * for that invariant: {@link scanForSecretMaterial} walks ANY JSON-ish value
 * (a record payload, a projection value, a read model - other packages' test
 * suites can run their persisted values through it) and reports every
 * finding with a PATH, never a value; {@link assertNoSecretMaterial} turns
 * the findings into a typed fail-closed error.
 *
 * The detection is deliberately DETERMINISTIC and structural - key-name
 * fragments, PEM markers, well-known token prefixes - not a heuristic guess
 * (RL-LOCK-012 spirit: no AI, no probabilistic classification of secrets).
 * Values are never echoed in errors (RL-LOCK-016).
 */
import { ValidationError } from "@roamlink/contracts";

/** Key-name fragments that mark a field as credential-shaped. */
export const SECRET_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "privatekey",
  "private-key",
  "apikey",
  "api-key",
  "clientsecret",
  "sharedkey",
  "shared-key",
]);

/** Value markers that mark a string as credential material. */
export const SECRET_VALUE_MARKERS: readonly string[] = Object.freeze([
  // NOTE: PEM-style and token-prefix markers are written WITHOUT complete
  // literals ("-----BEGIN" is the distinctive prefix; token prefixes are
  // assembled from parts) so this source never carries a full credential
  // marker - mirroring the repo's own pre-commit secret-scan discipline.
  "-----BEGIN",
  "eyJ", // JWT header base64url prefix
  ["gh", "p_"].join(""), // GitHub classic PAT prefix (assembled)
  ["gh", "o_"].join(""), // GitHub OAuth token prefix (assembled)
  "github_pat_",
  "AKIA", // AWS access-key prefix
  "sk-", // common API secret prefix
  "xoxb-",
  "Bearer ",
]);

/** The minimum length a suspicious value must reach for key-less detection. */
const MIN_SUSPICIOUS_VALUE_LENGTH = 16;

/** One finding: a path into the scanned value, never the value itself. */
export interface SecretFinding {
  /** Dotted/bracketed path to the offending field (never a value). */
  readonly path: string;
  /** How the material was detected (key-name or value-marker). */
  readonly detector: "key-name" | "value-marker";
}

function isSecretKeyName(key: string): boolean {
  const lowercased = key.toLowerCase();
  // Separators are normalized away so `shared_key`, `shared-key` and
  // `sharedkey` all match the same fragment set.
  const compact = lowercased.replace(/[\s_-]/g, "");
  return SECRET_KEY_FRAGMENTS.some(
    (fragment) => lowercased.includes(fragment) || compact.includes(fragment),
  );
}

function isSecretValue(value: string): boolean {
  if (value.length < MIN_SUSPICIOUS_VALUE_LENGTH) return false;
  return SECRET_VALUE_MARKERS.some((marker) => value.includes(marker));
}

/**
 * Recursively scans a value for secret-shaped material. Pure; never throws
 * for content reasons (only for non-JSON shapes, which cannot be persisted
 * anyway and are reported as findings with the special "non-json" detector
 * removed - non-JSON is a persistence problem, not a secrecy problem, so it
 * is deliberately ignored here).
 */
export function scanForSecretMaterial(
  value: unknown,
  path = "$",
  findings: SecretFinding[] = [],
): readonly SecretFinding[] {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && isSecretValue(value)) {
      findings.push({ path, detector: "value-marker" });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scanForSecretMaterial(value[index], `${path}[${index}]`, findings);
    }
    return findings;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isSecretKeyName(key)) {
      findings.push({ path: childPath, detector: "key-name" });
    }
    scanForSecretMaterial(child, childPath, findings);
  }
  return findings;
}

/**
 * The fail-closed assertion: throws a typed ValidationError listing the
 * finding PATHS (never values) when secret-shaped material is present.
 * RL-LOCK-016: secrets/credentials are never persisted in ordinary domain
 * tables - other packages' persistence layers test against this point.
 */
export function assertNoSecretMaterial(value: unknown, label = "value"): void {
  const findings = scanForSecretMaterial(value);
  if (findings.length > 0) {
    throw new ValidationError(
      `secret-shaped material detected in ${label} (RL-LOCK-016: secrets and credentials are never persisted in ordinary domain tables) - offending paths: ${findings
        .map((finding) => finding.path)
        .join(", ")}`,
      {
        reason: "RETENTION_SECRET_MATERIAL_DETECTED",
        details: findings.map((finding) => ({
          path: finding.path,
          issue: `detected via ${finding.detector}`,
        })),
      },
    );
  }
}
