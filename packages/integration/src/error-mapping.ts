/**
 * The closed ADCOS-to-RoamLink failure adaptation (RL-031/RL-032).
 *
 * The @roamlink/adcos boundary deliberately does NOT map its errors to
 * RoamLink error kinds (see packages/adcos/src/errors.ts) - that adaptation
 * belongs HERE, in the intent/offer adapters. This module is the single,
 * closed mapping table:
 *
 *  - every one of the 18 pinned ADCOS error codes maps onto exactly one
 *    RoamLink error kind with a stable `ADCOS_*` reason code;
 *  - the pinned retryable flag of each ADCOS code is PRESERVED by the mapped
 *    error (retryable codes map to retryable kinds and vice versa);
 *  - transport failures map by outcome: `not-sent` -> unavailable (retry),
 *    `unknown` -> unknown-state (safe to re-issue ONLY because every
 *    cross-boundary command is idempotency-keyed, RL-LOCK-014);
 *  - environment mismatches map to a deterministic domain failure.
 *
 * No parallel error kinds are invented anywhere in this package
 * (spec/adcos-integration.md error discipline; RL-LOCK-017 closed taxonomies).
 */
import {
  DomainError,
  NotFoundError,
  RateLimitedError,
  RoamLinkError,
  UnauthorizedError,
  UnavailableError,
  UnknownStateError,
  ValidationError,
  ConflictError,
  type ErrorKind,
} from "@roamlink/contracts";
import { AdcosApiError, type AdcosErrorCode } from "@roamlink/adcos";
import { AdcosTransportError } from "./transport.js";

/** The closed mapping of each ADCOS error code onto a RoamLink error. */
export const ADCOS_FAILURE_ADAPTATION: Readonly<
  Record<AdcosErrorCode, { readonly kind: ErrorKind; readonly reason: string; readonly retryable: boolean }>
> = Object.freeze({
  "invalid-input": { kind: "validation", reason: "ADCOS_INVALID_INPUT", retryable: false },
  "route-unknown": { kind: "domain", reason: "ADCOS_ROUTE_UNKNOWN", retryable: false },
  "authentication-invalid": { kind: "unauthorized", reason: "ADCOS_AUTHENTICATION_INVALID", retryable: false },
  "authentication-expired": { kind: "unauthorized", reason: "ADCOS_AUTHENTICATION_EXPIRED", retryable: false },
  "environment-mismatch": { kind: "domain", reason: "ADCOS_ENVIRONMENT_MISMATCH", retryable: false },
  "capability-denied": { kind: "unauthorized", reason: "ADCOS_CAPABILITY_DENIED", retryable: false },
  "version-unsupported": { kind: "domain", reason: "ADCOS_VERSION_UNSUPPORTED", retryable: false },
  "rate-limited": { kind: "rate-limited", reason: "ADCOS_RATE_LIMITED", retryable: true },
  "idempotency-key-required": { kind: "validation", reason: "ADCOS_IDEMPOTENCY_KEY_REQUIRED", retryable: false },
  "idempotency-conflict": { kind: "conflict", reason: "ADCOS_IDEMPOTENCY_CONFLICT", retryable: false },
  "pagination-invalid": { kind: "validation", reason: "ADCOS_PAGINATION_INVALID", retryable: false },
  "filter-invalid": { kind: "validation", reason: "ADCOS_FILTER_INVALID", retryable: false },
  "resource-unknown": { kind: "not-found", reason: "ADCOS_RESOURCE_UNKNOWN", retryable: false },
  "webhook-signature-invalid": { kind: "unauthorized", reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID", retryable: false },
  "webhook-timestamp-stale": { kind: "domain", reason: "ADCOS_WEBHOOK_TIMESTAMP_STALE", retryable: false },
  "webhook-delivery-unknown": { kind: "not-found", reason: "ADCOS_WEBHOOK_DELIVERY_UNKNOWN", retryable: false },
  "store-failed": { kind: "unavailable", reason: "ADCOS_STORE_FAILED", retryable: true },
  "journal-corrupt": { kind: "domain", reason: "ADCOS_JOURNAL_CORRUPT", retryable: false },
});

function adapt(code: AdcosErrorCode, message: string, retryAfterMs?: number): RoamLinkError {
  const entry = ADCOS_FAILURE_ADAPTATION[code];
  const options: { reason: string; retryable: boolean; retryAfterMs?: number } = {
    reason: entry.reason,
    retryable: entry.retryable,
  };
  if (retryAfterMs !== undefined && Number.isInteger(retryAfterMs) && retryAfterMs >= 1) {
    options.retryAfterMs = retryAfterMs;
  }
  switch (entry.kind) {
    case "validation":
      return new ValidationError(message, options);
    case "domain":
      return new DomainError(message, options);
    case "conflict":
      return new ConflictError(message, options);
    case "not-found":
      return new NotFoundError(message, options);
    case "unauthorized":
      return new UnauthorizedError(message, options);
    case "rate-limited":
      return new RateLimitedError(message, options);
    case "unavailable":
      return new UnavailableError(message, options);
    case "stale-state":
      return new DomainError(message, options);
    case "unknown-state":
      return new UnknownStateError(message, options);
  }
}

/**
 * Adapts an ADCOS boundary failure (AdcosApiError, transport error or
 * environment mismatch) onto the closed RoamLink error taxonomy. RoamLink
 * errors pass through unchanged; anything else is normalized without
 * propagating third-party messages (RL-LOCK-016).
 */
export function mapAdcosFailure(error: unknown): RoamLinkError {
  if (error instanceof AdcosApiError) {
    return adapt(error.code, error.message);
  }
  if (error instanceof AdcosTransportError) {
    if (error.outcome === "unknown") {
      return new UnknownStateError(
        "ADCOS request timed out after dispatch: the command outcome is UNKNOWN; re-issuing is safe because the command is idempotency-keyed (RL-LOCK-014), but the previous attempt may already have applied",
        { reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN", retryable: true },
      );
    }
    return new UnavailableError(
      "ADCOS endpoint unreachable before the request was sent (connection loss); the mutation was not applied by this attempt; retry with the same idempotency key",
      { reason: "ADCOS_TRANSPORT_UNAVAILABLE", retryable: true },
    );
  }
  if (error instanceof Error && error.name === "AdcosEnvironmentMismatchError") {
    return new DomainError(
      "ADCOS environment mismatch observed at the integration boundary; failing closed (values are never echoed, RL-LOCK-016)",
      { reason: "ADCOS_ENVIRONMENT_MISMATCH", retryable: false },
    );
  }
  if (error instanceof RoamLinkError) {
    return error;
  }
  return new DomainError(
    `Unexpected non-RoamLink error of type '${error instanceof Error ? error.name : typeof error}' at the ADCOS boundary (details retained as cause only)`,
    { reason: "ADCOS_BOUNDARY_UNEXPECTED_ERROR", cause: error },
  );
}

/**
 * The RoamLink kind a transport outcome maps onto (exposed for tests and for
 * the retry classification the outbox/worker layer consumes).
 */
export function transportOutcomeKind(outcome: "not-sent" | "unknown"): ErrorKind {
  return outcome === "unknown" ? "unknown-state" : "unavailable";
}
