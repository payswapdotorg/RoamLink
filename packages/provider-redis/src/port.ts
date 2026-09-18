/**
 * The bounded ephemeral-coordination PORT (RL-096).
 *
 * spec/deployment.md §2/§8: Upstash Redis is a bounded EPHEMERAL
 * accelerator - rate limiting, hot cache, short-TTL coordination, abuse
 * protection. It is NEVER the durable source of truth for orders,
 * payments, intents, projections, audit, outbox or inbox (ADR-0003). The
 * port shape enforces that by construction:
 *
 *  - EVERY write carries an explicit TTL (there is no unbounded set);
 *  - values are admitted only under a configurable size bound;
 *  - keys are safe labels with the same discipline as
 *    @roamlink/resilience limiter keys;
 *  - nothing here exposes persistence semantics (no streams, no lists, no
 *    durable queues - durable work belongs to the durable-jobs port and
 *    the PostgreSQL-backed ledger).
 *
 * The system MUST stay correct without Redis: consumers treat the port as
 * an accelerator and degrade to their non-accelerated path on failure
 * (deployment.md §7 "Redis is optional for correctness").
 */
import { ValidationError, type ErrorDetail } from "@roamlink/contracts";

/** Safe-label key discipline (mirrors the resilience limiter keys). */
export const REDIS_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** Default per-value admission bound (bytes, UTF-8). */
export const DEFAULT_MAX_VALUE_BYTES = 65_536;

/** Default upper bound for any admitted TTL (24h). */
export const DEFAULT_MAX_TTL_MS = 86_400_000;

export interface EphemeralBounds {
  readonly maxValueBytes: number;
  readonly maxTtlMs: number;
}

export const DEFAULT_EPHEMERAL_BOUNDS: Readonly<EphemeralBounds> = Object.freeze({
  maxValueBytes: DEFAULT_MAX_VALUE_BYTES,
  maxTtlMs: DEFAULT_MAX_TTL_MS,
});

export interface SetWithTtlOptions {
  /** Store only when the key does NOT already exist (SET NX). */
  readonly onlyIfAbsent?: boolean;
}

/** Result of a bounded write: whether the value was stored. */
export type SetOutcome = { readonly stored: true } | { readonly stored: false };

/** Result of a bounded fixed-window increment. */
export interface IncrementOutcome {
  /** The counter value AFTER the increment. */
  readonly count: number;
  /** True when this call created/first-incremented the counter. */
  readonly firstIncrement: boolean;
}

/**
 * The bounded ephemeral-coordination port. Implementations: the
 * deterministic in-memory fake (tests/local) and the Upstash REST client
 * (hosted) - contract tests in this package prove port-parity.
 */
export interface EphemeralCoordinationPort {
  /** Reads a value; null when absent or expired. */
  get(key: string): Promise<string | null>;

  /** Writes a value with a REQUIRED TTL (bounded). Never stores unbounded. */
  setWithTtl(
    key: string,
    value: string,
    ttlMs: number,
    options?: SetWithTtlOptions,
  ): Promise<SetOutcome>;

  /** Deletes a key; true when something was removed. */
  delete(key: string): Promise<boolean>;

  /**
   * Increments a counter by `amount` (default 1), guaranteeing the counter
   * carries a TTL (created keys get `ttlMs`; keys without an expiry get
   * one set). This is the bounded fixed-window primitive for distributed
   * rate limiting.
   */
  incrementWithTtl(key: string, ttlMs: number, amount?: number): Promise<IncrementOutcome>;

  /**
   * Remaining TTL in ms; null when the key is absent/expired; -1 when the
   * key exists WITHOUT an expiry (a boundedness bug on any write path -
   * callers must treat it as a defect, never rely on it).
   */
  timeToLiveMs(key: string): Promise<number | null>;

  /** Liveness probe for the accelerator. */
  ping(): Promise<boolean>;
}

export function validateKey(key: string): string {
  if (typeof key !== "string" || !REDIS_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "ephemeral-coordination keys must be safe labels (1-128 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only)",
      {
        reason: "EPHEMERAL_KEY_INVALID",
        details: [{ path: "key", issue: "not a safe label" }],
      },
    );
  }
  return key;
}

export function validateValue(value: string, maxValueBytes: number): string {
  if (typeof value !== "string") {
    throw new ValidationError("ephemeral values must be strings", {
      reason: "EPHEMERAL_VALUE_INVALID",
      details: [{ path: "value", issue: "not a string" }],
    });
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxValueBytes) {
    throw new ValidationError(
      `ephemeral values are admitted only up to ${maxValueBytes} bytes (bounded accelerator discipline)`,
      {
        reason: "EPHEMERAL_VALUE_TOO_LARGE",
        details: [{ path: "value", issue: "exceeds the admission bound" }],
      },
    );
  }
  return value;
}

export function validateTtl(ttlMs: number, maxTtlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs) {
    throw new ValidationError(
      `ephemeral TTLs must be integers between 1 and ${maxTtlMs}ms (every write is bounded)`,
      {
        reason: "EPHEMERAL_TTL_INVALID",
        details: [{ path: "ttlMs", issue: "out of bounds" }],
      },
    );
  }
  return ttlMs;
}

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

/** Validates a bounds object for constructors. */
export function parseEphemeralBounds(input?: Partial<EphemeralBounds>): EphemeralBounds {
  const bounds: EphemeralBounds = { ...DEFAULT_EPHEMERAL_BOUNDS, ...input };
  if (!Number.isInteger(bounds.maxValueBytes) || bounds.maxValueBytes < 1 || bounds.maxValueBytes > 1_048_576) {
    throw new ValidationError("maxValueBytes must be an integer between 1 and 1048576", {
      reason: "EPHEMERAL_BOUNDS_INVALID",
      details: [issue("maxValueBytes", "out of bounds")],
    });
  }
  if (!Number.isInteger(bounds.maxTtlMs) || bounds.maxTtlMs < 1 || bounds.maxTtlMs > 86_400_000) {
    throw new ValidationError("maxTtlMs must be an integer between 1 and 86400000", {
      reason: "EPHEMERAL_BOUNDS_INVALID",
      details: [issue("maxTtlMs", "out of bounds")],
    });
  }
  return Object.freeze({ ...bounds });
}
