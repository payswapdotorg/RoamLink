/**
 * RoamLink error taxonomy.
 *
 * A typed error hierarchy with a stable machine-readable `reason` code and a
 * `retryable` classification, shared by every RoamLink package. The taxonomy
 * is closed: kinds are the nine listed in ERROR_KINDS (RL-017 contracts are
 * additive-change tolerant, so new kinds may only be appended via a contract
 * version bump).
 *
 * Secret hygiene (RL-LOCK-016): error messages produced by this package and by
 * the contract parsers that throw these errors must never embed values - only
 * field/key names and expected shapes. `normalizeUnknownError` deliberately
 * does not propagate third-party error messages because they may contain
 * credentials or connection strings.
 */

export const ERROR_KINDS = [
  "domain",
  "validation",
  "conflict",
  "not-found",
  "unauthorized",
  "rate-limited",
  "unavailable",
  "stale-state",
  "unknown-state",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * Default retryability per kind:
 *  - rate-limited / unavailable: transient, retry with backoff;
 *  - stale-state: retry only after refreshing the underlying state;
 *  - unknown-state: safe to re-issue because every cross-boundary command is
 *    idempotent (RL-LOCK-014), but the outcome of the previous attempt is
 *    unknown;
 *  - everything else: deterministic failure, retrying the same command fails
 *    the same way.
 */
export const RETRYABLE_BY_KIND: Readonly<Record<ErrorKind, boolean>> = {
  domain: false,
  validation: false,
  conflict: false,
  "not-found": false,
  unauthorized: false,
  "rate-limited": true,
  unavailable: true,
  "stale-state": true,
  "unknown-state": true,
};

const DEFAULT_REASON_BY_KIND: Readonly<Record<ErrorKind, string>> = {
  domain: "DOMAIN_ERROR",
  validation: "VALIDATION_FAILED",
  conflict: "STATE_CONFLICT",
  "not-found": "NOT_FOUND",
  unauthorized: "UNAUTHORIZED",
  "rate-limited": "RATE_LIMITED",
  unavailable: "UNAVAILABLE",
  "stale-state": "STALE_STATE",
  "unknown-state": "UNKNOWN_STATE",
};

/**
 * Stable machine-readable reason codes: UPPER_SNAKE_CASE, 3-64 chars.
 */
export const ERROR_REASON_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

export function isValidErrorReason(value: unknown): value is string {
  return typeof value === "string" && ERROR_REASON_PATTERN.test(value);
}

/** A safe, value-free problem report attached to an error. */
export interface ErrorDetail {
  /** Dotted path or environment/field KEY NAME (never a value). */
  readonly path?: string;
  readonly issue: string;
}

export interface RoamLinkErrorOptions {
  /** Overrides the kind's default reason code (must be UPPER_SNAKE_CASE). */
  readonly reason?: string;
  /** Overrides the kind's default retryability classification. */
  readonly retryable?: boolean;
  /** Suggested minimum backoff before a retry (rate-limited/unavailable). */
  readonly retryAfterMs?: number;
  readonly details?: readonly ErrorDetail[];
  /** Original underlying error; never serialized by {@link RoamLinkError.toJSON}. */
  readonly cause?: unknown;
}

/** Log-safe structured form of a RoamLink error. */
export interface SerializedRoamLinkError {
  readonly name: string;
  readonly kind: ErrorKind;
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly message: string;
  readonly details: readonly ErrorDetail[];
}

function pascalCaseKind(kind: ErrorKind): string {
  return kind
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export class RoamLinkError extends Error {
  readonly kind: ErrorKind;
  readonly reason: string;
  readonly retryable: boolean;
  /** Optional own property - only present when explicitly set (declare keeps the field from being defined as undefined). */
  declare readonly retryAfterMs?: number;
  readonly details: readonly ErrorDetail[];

  constructor(kind: ErrorKind, message: string, options: RoamLinkErrorOptions = {}) {
    super(message);
    if (!isErrorKind(kind)) {
      throw new TypeError(`RoamLinkError: unknown error kind '${String(kind)}'`);
    }
    this.kind = kind;
    const reason = options.reason ?? DEFAULT_REASON_BY_KIND[kind];
    if (!isValidErrorReason(reason)) {
      throw new TypeError(
        `RoamLinkError: reason code must match ${ERROR_REASON_PATTERN.source}`,
      );
    }
    this.reason = reason;
    this.retryable = options.retryable ?? RETRYABLE_BY_KIND[kind];
    if (options.retryAfterMs !== undefined) {
      if (!Number.isInteger(options.retryAfterMs) || options.retryAfterMs < 1) {
        throw new TypeError("RoamLinkError: retryAfterMs must be a positive integer (ms)");
      }
      this.retryAfterMs = options.retryAfterMs;
    }
    this.details = Object.freeze([...(options.details ?? [])].map((d) => Object.freeze({ ...d })));
    this.name = `RoamLink${pascalCaseKind(kind)}Error`;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Object.freeze(this);
  }

  /**
   * Structured, log-safe representation. Never includes `cause` (the cause may
   * be an arbitrary third-party error carrying secrets).
   */
  toJSON(): SerializedRoamLinkError {
    const json: SerializedRoamLinkError = {
      name: this.name,
      kind: this.kind,
      reason: this.reason,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
    };
    if (this.retryAfterMs !== undefined) {
      return { ...json, retryAfterMs: this.retryAfterMs };
    }
    return json;
  }
}

/** A domain/business rule was violated. Deterministic failure; not retryable. */
export class DomainError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("domain", message, options);
  }
}

/** Input failed shape/contract validation. Deterministic failure; not retryable. */
export class ValidationError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("validation", message, options);
  }
}

/** Optimistic-concurrency / state conflict. Not retryable as-is. */
export class ConflictError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("conflict", message, options);
  }
}

/** Target resource does not exist. Not retryable. */
export class NotFoundError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("not-found", message, options);
  }
}

/** Actor is not authorized for the command. Not retryable. */
export class UnauthorizedError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("unauthorized", message, options);
  }
}

/** Rate limit exceeded. Retryable with backoff (see retryAfterMs). */
export class RateLimitedError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("rate-limited", message, options);
  }
}

/** A dependency is temporarily unavailable. Retryable. */
export class UnavailableError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("unavailable", message, options);
  }
}

/** Observed state is stale; refresh then retry. */
export class StaleStateError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("stale-state", message, options);
  }
}

/** True state could not be determined (never a false success). */
export class UnknownStateError extends RoamLinkError {
  constructor(message: string, options: RoamLinkErrorOptions = {}) {
    super("unknown-state", message, options);
  }
}

export function isRoamLinkError(error: unknown): error is RoamLinkError {
  return error instanceof RoamLinkError;
}

/**
 * Wraps an unknown thrown value into a RoamLinkError without propagating
 * third-party messages (they may contain credentials / connection strings -
 * RL-LOCK-016). The original is preserved as `cause` for local debugging and
 * is never included in `toJSON()`.
 */
export function normalizeUnknownError(error: unknown): RoamLinkError {
  if (isRoamLinkError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new DomainError(
      `Unexpected non-RoamLink error of type '${error.name}' (details retained as cause only)`,
      { reason: "UNKNOWN_ERROR", cause: error },
    );
  }
  return new DomainError(
    `Unexpected non-error value thrown (typeof '${typeof error}')`,
    { reason: "UNKNOWN_ERROR" },
  );
}
