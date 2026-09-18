/**
 * Content-addressed key namespacing conventions (RL-098).
 *
 * R2 holds LARGE, largely-immutable artifacts; keys are
 * content-addressed (sha-256 prefix) so re-uploads of the same content
 * are naturally idempotent, and namespaced by artifact class so lifecycle
 * and credential scoping stay simple:
 *
 *   attachments/<orgId>/<yyyy>/<mm>/<sha256[:16]>-<filename>
 *   exports/<orgId>/<yyyy>/<mm>/<sha256[:16]>-<filename>
 *   backups/<yyyy>/<mm>/<dd>/<sha256[:16]>-<filename>
 *
 * Filenames are SANITIZED (lowercase [a-z0-9._-]); the date comes from
 * the caller's EXPLICIT instant (deterministic in tests). Backups must be
 * application-level encrypted BEFORE upload (spec/security.md) - the
 * helper refuses an unencrypted-looking plaintext marker only in the
 * sense that it never adds one; encryption is the caller's duty and is
 * documented in the runbook.
 */
import { ValidationError, epochMsOf, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";

/** Closed artifact-class vocabulary (key namespace roots). */
export const OBJECT_NAMESPACES = ["attachments", "exports", "backups"] as const;

export type ObjectNamespace = (typeof OBJECT_NAMESPACES)[number];

export interface ContentAddressedKeyRequest {
  readonly namespace: ObjectNamespace;
  /** Tenant scope (required for attachments/exports; ignored for backups). */
  readonly orgId?: string;
  /** sha-256 hex digest of the content (64 hex chars). */
  readonly contentSha256: string;
  readonly filename: string;
  /** The caller's explicit instant (drives the yyyy/mm/dd path). */
  readonly at: UtcInstant | string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Sanitizes a filename into the safe [a-z0-9._-] vocabulary. */
export function sanitizeObjectFilename(filename: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new ValidationError("filenames must be non-empty strings", {
      reason: "OBJECT_FILENAME_INVALID",
      details: [{ path: "filename", issue: "empty" }],
    });
  }
  const sanitized = filename
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, 128);
  if (sanitized.length === 0) {
    throw new ValidationError(
      "the filename reduces to nothing under the key convention (values are never echoed)",
      {
        reason: "OBJECT_FILENAME_INVALID",
        details: [{ path: "filename", issue: "no safe characters" }],
      },
    );
  }
  return sanitized;
}

/**
 * Builds a deterministic content-addressed key. The same inputs always
 * yield the same key; different content lands at a different key even on
 * the same day (sha prefix), and re-upload of identical content is an
 * idempotent overwrite of the same object.
 */
export function buildContentAddressedKey(request: ContentAddressedKeyRequest): string {
  if (!(OBJECT_NAMESPACES as readonly string[]).includes(request.namespace)) {
    throw new ValidationError("the namespace must be one of the closed artifact classes", {
      reason: "OBJECT_NAMESPACE_INVALID",
      details: [{ path: "namespace", issue: "outside the closed vocabulary" }],
    });
  }
  if (typeof request.contentSha256 !== "string" || !SHA256_HEX_PATTERN.test(request.contentSha256)) {
    throw new ValidationError("contentSha256 must be a lowercase 64-char sha-256 hex digest", {
      reason: "OBJECT_KEY_INPUT_INVALID",
      details: [{ path: "contentSha256", issue: "not a sha-256 hex digest" }],
    });
  }
  const instant = parseUtcInstant(request.at);
  const ms = epochMsOf(instant);
  const date = new Date(ms);
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const shortHash = request.contentSha256.slice(0, 16);
  const filename = sanitizeObjectFilename(request.filename);

  if (request.namespace === "backups") {
    return `backups/${yyyy}/${mm}/${dd}/${shortHash}-${filename}`;
  }
  const orgId = request.orgId;
  if (typeof orgId !== "string" || !ORG_ID_PATTERN.test(orgId)) {
    throw new ValidationError(
      `${request.namespace} keys require an orgId (lowercase safe label, 1-64 chars) for tenant scoping`,
      {
        reason: "OBJECT_KEY_INPUT_INVALID",
        details: [{ path: "orgId", issue: "required for tenant-scoped namespaces" }],
      },
    );
  }
  return `${request.namespace}/${orgId}/${yyyy}/${mm}/${shortHash}-${filename}`;
}
