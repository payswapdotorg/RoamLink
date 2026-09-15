/**
 * Platform evidence payload for edge capability records (RL-040, RL-LOCK-011).
 *
 * Typed and deliberately MINIMAL: a closed `kind` vocabulary plus a bounded,
 * safe-charset source label and an optional short detail. The payload is
 * structurally incapable of carrying secrets: no free-form objects, no
 * unbounded strings, no binary blobs (RL-LOCK-016). The detail field is a
 * short human-readable note about WHERE the evidence came from - it must
 * never contain credentials, tokens or identifiers beyond platform API names.
 */
import { ValidationError } from "@roamlink/contracts";

export const EDGE_PLATFORM_EVIDENCE_KINDS = [
  "platform-api-probe",
  "os-statement",
  "user-permission-state",
  "none",
] as const;

export type EdgePlatformEvidenceKind = (typeof EDGE_PLATFORM_EVIDENCE_KINDS)[number];

/** Safe-label charset for evidence sources (API/framework/profile names). */
export const EDGE_EVIDENCE_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

const MAX_DETAIL_LENGTH = 128;

export interface EdgePlatformEvidence {
  /** Closed evidence kind. `none` means "no platform evidence at all". */
  readonly kind: EdgePlatformEvidenceKind;
  /** Bounded, non-secret source label (e.g. an OS framework name). Present iff kind !== "none". */
  readonly source?: string;
  /** Optional short, printable, NON-SECRET note. Present only together with a real source. */
  readonly detail?: string;
}

export function isEdgePlatformEvidenceKind(value: unknown): value is EdgePlatformEvidenceKind {
  return (
    typeof value === "string" &&
    (EDGE_PLATFORM_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

export function parseEdgePlatformEvidenceKind(value: unknown): EdgePlatformEvidenceKind {
  if (!isEdgePlatformEvidenceKind(value)) {
    throw new ValidationError(
      "value is not a member of the closed platform-evidence kind vocabulary (platform-api-probe, os-statement, user-permission-state, none)",
      {
        reason: "EDGE_EVIDENCE_INVALID",
        details: [{ path: "EdgePlatformEvidence.kind", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

function isPrintable(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Parses and freezes a platform-evidence payload. `kind: "none"` must carry
 * no source and no detail; any other kind REQUIRES a safe source label.
 * Values are never echoed in errors (RL-LOCK-016).
 */
export function parseEdgePlatformEvidence(value: unknown): EdgePlatformEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("EdgePlatformEvidence must be an object", {
      reason: "EDGE_EVIDENCE_INVALID",
      details: [{ path: "EdgePlatformEvidence", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["kind", "source", "detail"].includes(key)) {
      throw new ValidationError(`EdgePlatformEvidence rejected unknown field '${key}'`, {
        reason: "EDGE_EVIDENCE_INVALID",
        details: [{ path: `EdgePlatformEvidence.${key}`, issue: "unknown field" }],
      });
    }
  }
  const kind = parseEdgePlatformEvidenceKind(record["kind"]);

  if (kind === "none") {
    if (record["source"] !== undefined || record["detail"] !== undefined) {
      throw new ValidationError(
        "EdgePlatformEvidence with kind 'none' must carry no source and no detail",
        {
          reason: "EDGE_EVIDENCE_INVALID",
          details: [{ path: "EdgePlatformEvidence", issue: "'none' evidence carries no payload" }],
        },
      );
    }
    return Object.freeze({ kind });
  }

  const source = record["source"];
  if (typeof source !== "string" || !EDGE_EVIDENCE_SOURCE_PATTERN.test(source)) {
    throw new ValidationError(
      "EdgePlatformEvidence.source must be a safe label (1-64 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only; never a secret)",
      {
        reason: "EDGE_EVIDENCE_INVALID",
        details: [{ path: "EdgePlatformEvidence.source", issue: "not a safe label" }],
      },
    );
  }

  const detail = record["detail"];
  if (detail === undefined) {
    return Object.freeze({ kind, source });
  }
  if (
    typeof detail !== "string" ||
    detail.length === 0 ||
    detail.length > MAX_DETAIL_LENGTH ||
    !isPrintable(detail)
  ) {
    throw new ValidationError(
      "EdgePlatformEvidence.detail must be a printable, non-empty string of at most 128 chars (never a secret)",
      {
        reason: "EDGE_EVIDENCE_INVALID",
        details: [{ path: "EdgePlatformEvidence.detail", issue: "not a bounded printable string" }],
      },
    );
  }
  return Object.freeze({ kind, source, detail });
}
