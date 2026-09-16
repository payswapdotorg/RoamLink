/**
 * Wire error resource + the client-side error type (spec/api.md; the RoamLink
 * error taxonomy from @roamlink/contracts mirrored at the API boundary).
 *
 * The server serializes a RoamLinkError through this shape (kind/reason/
 * message/retryable/details). The client parses it fail-closed: an error
 * body outside the taxonomy is a contract violation and surfaces as a typed
 * unknown-state error - never as a raw third-party string that might carry
 * credentials (RL-LOCK-016).
 */
import {
  isErrorKind,
  isValidErrorReason,
  ValidationError,
  type ErrorDetail,
  type ErrorKind,
} from "@roamlink/contracts";

export interface ApiErrorResource {
  readonly kind: ErrorKind;
  readonly reason: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details: readonly ErrorDetail[];
}

const ALLOWED_FIELDS = new Set([
  "kind",
  "reason",
  "message",
  "retryable",
  "retryAfterMs",
  "details",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ApiErrorResource rejected: ${label} - ${issue}`, {
    reason: "API_ERROR_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Fail-closed parser for the wire error resource. */
export function parseApiErrorResource(value: unknown): ApiErrorResource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the error resource carries exactly its contract fields)");
    }
  }
  if (!isErrorKind(record["kind"])) {
    field("kind", "must be a member of the RoamLink error taxonomy");
  }
  if (!isValidErrorReason(record["reason"])) {
    field("reason", "must be an UPPER_SNAKE_CASE reason code");
  }
  if (typeof record["message"] !== "string" || record["message"].length === 0) {
    field("message", "must be a non-empty string");
  }
  if (typeof record["retryable"] !== "boolean") {
    field("retryable", "must be a boolean");
  }
  const retryAfterMs = record["retryAfterMs"];
  if (
    retryAfterMs !== undefined &&
    (typeof retryAfterMs !== "number" || !Number.isInteger(retryAfterMs) || retryAfterMs < 1)
  ) {
    field("retryAfterMs", "must be a positive integer when present");
  }
  const rawDetails = record["details"];
  let details: readonly ErrorDetail[] = [];
  if (rawDetails !== undefined) {
    if (!Array.isArray(rawDetails)) {
      field("details", "must be an array when present");
    }
    details = Object.freeze(
      (rawDetails as unknown[]).map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          field("details[]", "each detail must be an object");
        }
        const detail = entry as Record<string, unknown>;
        for (const key of Object.keys(detail)) {
          if (!["path", "issue"].includes(key)) {
            field(`details[].${key}`, "unknown field");
          }
        }
        if (detail["path"] !== undefined && typeof detail["path"] !== "string") {
          field("details[].path", "must be a string when present");
        }
        if (typeof detail["issue"] !== "string" || detail["issue"].length === 0) {
          field("details[].issue", "must be a non-empty string");
        }
        return Object.freeze({
          ...(detail["path"] !== undefined ? { path: detail["path"] } : {}),
          issue: detail["issue"],
        }) as ErrorDetail;
      }),
    );
  }
  return Object.freeze({
    kind: record["kind"],
    reason: record["reason"],
    message: record["message"],
    retryable: record["retryable"],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    details,
  });
}

/**
 * The typed client-side error: either a parsed server error resource or a
 * transport-level failure. `status` is 0 for transport failures (no response
 * existed). Message text is contract-borne and safe to render; underlying
 * third-party causes are never propagated (RL-LOCK-016).
 */
export class ApiClientError extends Error {
  readonly kind: ErrorKind;
  readonly reason: string;
  readonly retryable: boolean;
  declare readonly retryAfterMs?: number;
  readonly details: readonly ErrorDetail[];
  readonly status: number;

  constructor(input: {
    readonly kind: ErrorKind;
    readonly reason: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly details?: readonly ErrorDetail[];
    readonly status: number;
  }) {
    super(input.message);
    this.kind = input.kind;
    this.reason = input.reason;
    this.retryable = input.retryable;
    if (input.retryAfterMs !== undefined) {
      this.retryAfterMs = input.retryAfterMs;
    }
    this.details = Object.freeze([...(input.details ?? [])]);
    this.status = input.status;
    this.name = "ApiClientError";
    Object.freeze(this);
  }

  static fromResource(resource: ApiErrorResource, status: number): ApiClientError {
    return new ApiClientError({
      kind: resource.kind,
      reason: resource.reason,
      message: resource.message,
      retryable: resource.retryable,
      ...(resource.retryAfterMs !== undefined ? { retryAfterMs: resource.retryAfterMs } : {}),
      details: resource.details,
      status,
    });
  }

  /** The fail-closed fallback for unusable error bodies / thrown transports. */
  static transportFailure(detail: string): ApiClientError {
    return new ApiClientError({
      kind: "unavailable",
      reason: "TRANSPORT_ERROR",
      message: detail,
      retryable: true,
      status: 0,
    });
  }

  /** The fail-closed fallback for an unparseable error body. */
  static unparseableErrorBody(status: number): ApiClientError {
    return new ApiClientError({
      kind: "unknown-state",
      reason: "ERROR_BODY_UNPARSEABLE",
      message:
        "the server returned an error body that does not match the API error contract (details suppressed)",
      retryable: true,
      status,
    });
  }

  toJSON(): ApiErrorResource {
    return Object.freeze({
      kind: this.kind,
      reason: this.reason,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      details: this.details,
    });
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}
