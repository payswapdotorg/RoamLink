/**
 * The ADCOS v2 error taxonomy (RL-030).
 *
 * CLOSED enum of the 18 documented error codes with a pinned retryable
 * classification. Adding a code is an additive contract change (RL-LOCK-017)
 * coordinated with the compatibility suite (RL-036).
 *
 * `AdcosApiError` is the typed failure surface of the client seam: it carries
 * the ADCOS error code plus the taxonomy's retryable flag. It deliberately
 * does NOT map to RoamLink error kinds - that adaptation belongs to the
 * intent/offer adapters (RL-031+), not to the boundary contract.
 */
import { ValidationError } from "@roamlink/contracts";

export const ADCOS_ERROR_CODES = [
  "invalid-input",
  "route-unknown",
  "authentication-invalid",
  "authentication-expired",
  "environment-mismatch",
  "capability-denied",
  "version-unsupported",
  "rate-limited",
  "idempotency-key-required",
  "idempotency-conflict",
  "pagination-invalid",
  "filter-invalid",
  "resource-unknown",
  "webhook-signature-invalid",
  "webhook-timestamp-stale",
  "webhook-delivery-unknown",
  "store-failed",
  "journal-corrupt",
] as const;

export type AdcosErrorCode = (typeof ADCOS_ERROR_CODES)[number];

/**
 * Pinned retryability per code:
 *  - `rate-limited`: transient, retry with backoff;
 *  - `store-failed`: transient storage failure, retry;
 *  - everything else: deterministic failure for the SAME request - retrying
 *    the identical request fails the same way (fix the request, refresh
 *    credentials, or repair state first).
 */
export const ADCOS_ERROR_RETRYABLE: Readonly<Record<AdcosErrorCode, boolean>> = Object.freeze({
  "invalid-input": false,
  "route-unknown": false,
  "authentication-invalid": false,
  "authentication-expired": false,
  "environment-mismatch": false,
  "capability-denied": false,
  "version-unsupported": false,
  "rate-limited": true,
  "idempotency-key-required": false,
  "idempotency-conflict": false,
  "pagination-invalid": false,
  "filter-invalid": false,
  "resource-unknown": false,
  "webhook-signature-invalid": false,
  "webhook-timestamp-stale": false,
  "webhook-delivery-unknown": false,
  "store-failed": true,
  "journal-corrupt": false,
});

export function isAdcosErrorCode(value: unknown): value is AdcosErrorCode {
  return typeof value === "string" && (ADCOS_ERROR_CODES as readonly string[]).includes(value);
}

/** Parses an error code; anything outside the closed set is rejected. */
export function parseAdcosErrorCode(value: unknown): AdcosErrorCode {
  if (!isAdcosErrorCode(value)) {
    throw new ValidationError(
      "AdcosErrorCode must be one of the 18 documented ADCOS v2 error codes",
      {
        reason: "ADCOS_ERROR_CODE_INVALID",
        details: [{ path: "AdcosErrorCode", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * A typed ADCOS API failure. `retryable` is pinned by the taxonomy; messages
 * must be log-safe (field names, never values - RL-LOCK-016).
 */
export class AdcosApiError extends Error {
  readonly code: AdcosErrorCode;
  readonly retryable: boolean;

  constructor(code: AdcosErrorCode, message: string) {
    if (!isAdcosErrorCode(code)) {
      throw new TypeError("AdcosApiError requires a member of the closed ADCOS error taxonomy");
    }
    super(message);
    this.code = code;
    this.retryable = ADCOS_ERROR_RETRYABLE[code];
    this.name = "AdcosApiError";
    Object.freeze(this);
  }
}
