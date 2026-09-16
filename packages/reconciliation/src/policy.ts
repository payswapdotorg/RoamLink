/**
 * Reconciliation policy (RL-035).
 *
 * Pure configuration - no clocks, no I/O. Production compositions may wrap
 * the ADCOS client with the RL-053 resilience primitives (retry/backoff/
 * circuit-breaker); the job-level retry below is a BOUNDED, immediate,
 * deterministic retry budget so job outcomes stay reproducible in tests
 * (in-job sleeps would break determinism, so none happen here).
 */
import { ValidationError } from "@roamlink/contracts";

export interface ReconciliationPolicy {
  /**
   * Maximum canonical-read attempts per scanned resource within ONE job
   * (>= 1). Transient failures beyond this budget degrade the projection
   * (STALE/UNKNOWN) instead of blocking the job - the next scheduled job
   * retries (spec §7 "transient ADCOS/API failures").
   */
  readonly maxCanonicalReadAttempts: number;
  /** The webhook-inbox drain batch size (admitted-but-unprojected events). */
  readonly inboxBatchLimit: number;
  /**
   * Proactively refresh FRESH projections whose freshness guarantee expires
   * within this many milliseconds (0 = only degraded records are refreshed).
   */
  readonly refreshMarginMs: number;
  /**
   * Discover canonical resources through the ADCOS list routes so resources
   * RoamLink has never observed (fully dropped first events) are still
   * reconciled (spec §7 "missed webhooks").
   */
  readonly discoveryEnabled: boolean;
}

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = Object.freeze({
  maxCanonicalReadAttempts: 3,
  inboxBatchLimit: 50,
  refreshMarginMs: 0,
  discoveryEnabled: true,
});

/** Validates a policy (all knobs bounded and sane). */
export function parseReconciliationPolicy(value: ReconciliationPolicy): ReconciliationPolicy {
  const fail = (label: string, issue: string): never => {
    throw new ValidationError(`ReconciliationPolicy rejected: ${label} - ${issue}`, {
      reason: "RECONCILIATION_POLICY_INVALID",
      details: [{ path: label, issue }],
    });
  };
  if (
    typeof value.maxCanonicalReadAttempts !== "number" ||
    !Number.isInteger(value.maxCanonicalReadAttempts) ||
    value.maxCanonicalReadAttempts < 1 ||
    value.maxCanonicalReadAttempts > 10
  ) {
    fail("maxCanonicalReadAttempts", "must be an integer between 1 and 10");
  }
  if (
    typeof value.inboxBatchLimit !== "number" ||
    !Number.isInteger(value.inboxBatchLimit) ||
    value.inboxBatchLimit < 1 ||
    value.inboxBatchLimit > 1000
  ) {
    fail("inboxBatchLimit", "must be an integer between 1 and 1000");
  }
  if (
    typeof value.refreshMarginMs !== "number" ||
    !Number.isInteger(value.refreshMarginMs) ||
    value.refreshMarginMs < 0
  ) {
    fail("refreshMarginMs", "must be a non-negative integer");
  }
  if (typeof value.discoveryEnabled !== "boolean") {
    fail("discoveryEnabled", "must be a boolean");
  }
  return Object.freeze({ ...value });
}
