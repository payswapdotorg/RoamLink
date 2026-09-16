/**
 * Retry policies with jittered backoff and budgets (RL-053).
 *
 * PURE/typed policy objects + a dependency-light executor:
 *
 *  - {@link makeRetryPolicy} validates a bounded exponential policy
 *    (maxAttempts, initialDelayMs, multiplier, maxDelayMs);
 *  - backoff delays are computed PURELY by {@link computeBackoffDelay};
 *    jitter is an injectable function - {@link noJitter} for deterministic
 *    pipelines, {@link createDeterministicFullJitter} for reproducible
 *    randomized tests, or any production RNG adapter;
 *  - the executor respects BOTH the attempt budget and an optional wall-clock
 *    budget (measured through an injectable clock - deterministic under the
 *    testkit clock) and classifies retryability through the Wave-0 error
 *    taxonomy (`RoamLinkError.retryable` via `normalizeUnknownError`) - no
 *    parallel ad-hoc error kinds;
 *  - every terminal state is explicit (succeeded / exhausted /
 *    non-retryable / deadline-exceeded) - never a silent partial retry.
 */
import {
  ValidationError,
  normalizeUnknownError,
  nowUtc,
  epochMsOf,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

/** Options accepted by {@link makeRetryPolicy}. */
export interface RetryPolicyOptions {
  /** Total attempts including the first (integer 1..100). */
  readonly maxAttempts: number;
  /** Backoff before the first retry, whole ms (1..3_600_000). */
  readonly initialDelayMs: number;
  /** Exponential factor per failed attempt (>= 1, <= 100). */
  readonly multiplier: number;
  /** Upper bound on the computed base delay (>= initialDelayMs, <= 86_400_000). */
  readonly maxDelayMs: number;
}

/** A validated, frozen retry policy. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
}

export function makeRetryPolicy(options: RetryPolicyOptions): RetryPolicy {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("RetryPolicy must be an object", {
      reason: "RETRY_POLICY_INVALID",
      details: [{ path: "RetryPolicy", issue: "not an object" }],
    });
  }
  const { maxAttempts, initialDelayMs, multiplier, maxDelayMs } = options;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new ValidationError("maxAttempts must be an integer between 1 and 100", {
      reason: "RETRY_POLICY_INVALID",
      details: [{ path: "maxAttempts", issue: "out of bounds" }],
    });
  }
  if (
    typeof initialDelayMs !== "number" ||
    !Number.isInteger(initialDelayMs) ||
    initialDelayMs < 1 ||
    initialDelayMs > 3_600_000
  ) {
    throw new ValidationError("initialDelayMs must be an integer between 1 and 3600000", {
      reason: "RETRY_POLICY_INVALID",
      details: [{ path: "initialDelayMs", issue: "out of bounds" }],
    });
  }
  if (
    typeof multiplier !== "number" ||
    !Number.isFinite(multiplier) ||
    multiplier < 1 ||
    multiplier > 100
  ) {
    throw new ValidationError("multiplier must be a finite number between 1 and 100", {
      reason: "RETRY_POLICY_INVALID",
      details: [{ path: "multiplier", issue: "out of bounds" }],
    });
  }
  if (
    typeof maxDelayMs !== "number" ||
    !Number.isInteger(maxDelayMs) ||
    maxDelayMs < initialDelayMs ||
    maxDelayMs > 86_400_000
  ) {
    throw new ValidationError(
      "maxDelayMs must be an integer between initialDelayMs and 86400000",
      {
        reason: "RETRY_POLICY_INVALID",
        details: [{ path: "maxDelayMs", issue: "out of bounds or below the initial delay" }],
      },
    );
  }
  return Object.freeze({ maxAttempts, initialDelayMs, multiplier, maxDelayMs });
}

/** Jitter transforms a computed base delay into the actual delay. */
export type RetryJitter = (baseDelayMs: number, nextAttempt: number) => number;

/** Identity jitter: deterministic pipelines and exact schedule tests. */
export function noJitter(): RetryJitter {
  return (baseDelayMs) => baseDelayMs;
}

/**
 * Deterministic "full jitter": a uniform value in [0, baseDelayMs) derived
 * purely from (seed, attempt, baseDelayMs) - the same inputs always yield
 * the same delay, so tests are reproducible without sharing mutable state.
 * Uses a 32-bit mulberry32 PRNG.
 */
export function createDeterministicFullJitter(seed: number): RetryJitter {
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new ValidationError("jitter seed must be an integer between 0 and 4294967295", {
      reason: "RETRY_JITTER_INVALID",
      details: [{ path: "seed", issue: "out of bounds" }],
    });
  }
  return (baseDelayMs: number, nextAttempt: number): number => {
    let t = (seed + nextAttempt * 0x9e3779b9) >>> 0;
    t = (t + 0x6d2b79f5) >>> 0;
    let mixed = t;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    const uniform = ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    return Math.floor(uniform * baseDelayMs);
  };
}

/**
 * Pure backoff computation: the base delay for the retry AFTER
 * `failedAttempts` failures is `initialDelayMs * multiplier^(failedAttempts-1)`
 * clamped to `maxDelayMs`, then passed through `jitter` (default: no jitter).
 */
export function computeBackoffDelay(
  policy: RetryPolicy,
  failedAttempts: number,
  jitter: RetryJitter = noJitter(),
): number {
  if (typeof failedAttempts !== "number" || !Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new ValidationError("failedAttempts must be a positive integer", {
      reason: "RETRY_SCHEDULE_INVALID",
      details: [{ path: "failedAttempts", issue: "not a positive integer" }],
    });
  }
  const exponent = Math.min(failedAttempts - 1, 62); // avoid overflow; clamped anyway
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, exponent);
  const base = Math.min(Math.max(1, Math.round(raw)), policy.maxDelayMs);
  const jittered = jitter(base, failedAttempts + 1);
  if (typeof jittered !== "number" || !Number.isFinite(jittered) || jittered < 0) {
    throw new ValidationError("jitter must return a non-negative finite delay", {
      reason: "RETRY_SCHEDULE_INVALID",
      details: [{ path: "jitter", issue: "invalid jittered delay" }],
    });
  }
  return Math.round(jittered);
}

/** Decides whether a thrown error is retryable (Wave-0 taxonomy by default). */
export type RetryClassifier = (error: unknown) => boolean;

/** Default classifier: retry exactly what the Wave-0 taxonomy marks retryable. */
export const taxonomyRetryClassifier: RetryClassifier = (error) => normalizeUnknownError(error).retryable;

/** Info passed to the onRetry observer before each retry sleep. */
export interface RetryNotice {
  readonly failedAttempts: number;
  readonly nextAttempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

/** Options for {@link retryWithPolicy}. */
export interface RetryExecutorOptions {
  readonly policy: RetryPolicy;
  /** Injectable jitter (default: none - deterministic). */
  readonly jitter?: RetryJitter;
  /** Injectable retryability classifier (default: Wave-0 taxonomy). */
  readonly classifier?: RetryClassifier;
  /** Injectable clock for the wall-clock budget (default: system). */
  readonly now?: () => UtcInstant;
  /** Injectable sleep (default: real setTimeout). Tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional wall-clock budget in ms for the WHOLE retry sequence. */
  readonly timeBudgetMs?: number | null;
  /** Observer fired before each retry sleep. */
  readonly onRetry?: (notice: RetryNotice) => void;
}

/** The explicit terminal states of a retry sequence. */
export type RetryOutcome<T> =
  | { readonly status: "succeeded"; readonly value: T; readonly attempts: number }
  | { readonly status: "exhausted"; readonly attempts: number; readonly lastError: unknown }
  | { readonly status: "non-retryable"; readonly attempts: number; readonly error: unknown }
  | { readonly status: "deadline-exceeded"; readonly attempts: number; readonly lastError: unknown };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes `fn` under the policy. The attempt budget, the retryability
 * classification and the optional wall-clock budget are all explicit; the
 * outcome is a closed result object (never a thrown wrapper). `fn` receives
 * the 1-based attempt number.
 */
export async function retryWithPolicy<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryExecutorOptions,
): Promise<RetryOutcome<T>> {
  const policy = options.policy;
  const classifier = options.classifier ?? taxonomyRetryClassifier;
  const now = options.now ?? nowUtc;
  const sleep = options.sleep ?? defaultSleep;
  const startedAtMs = epochMsOf(parseUtcInstant(now()));
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { status: "succeeded", value, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts) {
        return { status: "exhausted", attempts: attempt, lastError };
      }
      if (!classifier(error)) {
        return { status: "non-retryable", attempts: attempt, error };
      }
      const delayMs = computeBackoffDelay(policy, attempt, options.jitter);
      if (options.timeBudgetMs !== null && options.timeBudgetMs !== undefined) {
        const elapsed = epochMsOf(parseUtcInstant(now())) - startedAtMs;
        if (elapsed + delayMs > options.timeBudgetMs) {
          return { status: "deadline-exceeded", attempts: attempt, lastError };
        }
      }
      options.onRetry?.({ failedAttempts: attempt, nextAttempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
      if (options.timeBudgetMs !== null && options.timeBudgetMs !== undefined) {
        const elapsedAfterSleep = epochMsOf(parseUtcInstant(now())) - startedAtMs;
        if (elapsedAfterSleep > options.timeBudgetMs) {
          return { status: "deadline-exceeded", attempts: attempt, lastError };
        }
      }
    }
  }
  // Unreachable: the loop returns on its last iteration.
  return { status: "exhausted", attempts: policy.maxAttempts, lastError };
}
