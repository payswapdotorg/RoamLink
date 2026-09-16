/**
 * Circuit breaker with half-open probing (RL-053).
 *
 * A pure, typed, in-memory state machine over explicit UTC instants:
 *
 *   closed --(failureThreshold failures within failureWindowMs)--> open
 *   open   --(openCooldownMs elapsed + a request wants in)------> half-open
 *   half-open --(halfOpenSuccessThreshold probe successes)------> closed
 *   half-open --(any probe failure OR probe slots exhausted)----> open
 *
 *  - CLOSED: requests flow; failures are counted inside a rolling window;
 *  - OPEN: requests are rejected with the remaining cooldown;
 *  - HALF-OPEN: up to `halfOpenMaxProbes` concurrent probes are admitted;
 *    exceeding probes are REJECTED (fail-closed); a probe failure re-opens
 *    immediately with a fresh cooldown.
 *
 * The closed transition table is exported and tested like every other
 * RoamLink state machine (RL-LOCK-018). Admission and completion use
 * explicit instants (an injectable clock defaults completion to "now"), so
 * behavior is deterministic under the testkit clock. Single-process,
 * in-memory only - distributed breakers are later work.
 */
import { DomainError, ValidationError, epochMsOf, nowUtc, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";

export const CIRCUIT_BREAKER_STATES = ["closed", "open", "half-open"] as const;

export type CircuitBreakerState = (typeof CIRCUIT_BREAKER_STATES)[number];

/**
 * The closed legal-transition table. Terminals do not exist - this machine
 * always recovers eventually (open cools down to half-open).
 */
export const CIRCUIT_BREAKER_TRANSITIONS: Readonly<
  Record<CircuitBreakerState, readonly CircuitBreakerState[]>
> = Object.freeze<Record<CircuitBreakerState, readonly CircuitBreakerState[]>>({
  closed: ["open"],
  open: ["half-open"],
  "half-open": ["closed", "open"],
});

export function canTransitionCircuitBreaker(from: CircuitBreakerState, to: CircuitBreakerState): boolean {
  const legal = CIRCUIT_BREAKER_TRANSITIONS[from];
  return legal !== undefined && legal.includes(to);
}

/** Options for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Failures within `failureWindowMs` that trip the breaker (>= 1). */
  readonly failureThreshold: number;
  /** Rolling failure-counting window in ms (>= 1). */
  readonly failureWindowMs: number;
  /** Cooldown before an open breaker admits probes (>= 1). */
  readonly openCooldownMs: number;
  /** Concurrent probe requests admitted while half-open (>= 1). */
  readonly halfOpenMaxProbes: number;
  /** Consecutive probe successes that close the breaker (>= 1, default 1). */
  readonly halfOpenSuccessThreshold?: number;
  /** Injectable completion clock (deterministic tests; default: system). */
  readonly now?: () => UtcInstant;
}

interface BreakerInternals {
  state: CircuitBreakerState;
  failures: number[]; // epoch ms of failures inside the rolling window
  openedAtMs: number | null;
  probesInFlight: number;
  halfOpenSuccesses: number;
}

/** The admission decision returned by {@link CircuitBreaker.canExecute}. */
export type CircuitBreakerAdmission =
  | { readonly allowed: true; readonly state: CircuitBreakerState }
  | {
      readonly allowed: false;
      readonly state: CircuitBreakerState;
      /** Ms after `at` until admission may be retried; null when unknown. */
      readonly retryAfterMs: number | null;
    };

/** The outcome of {@link CircuitBreaker.execute}. */
export type CircuitBreakerExecution<T> =
  | {
      readonly executed: true;
      readonly succeeded: boolean;
      readonly state: CircuitBreakerState;
      readonly value?: T;
      readonly error?: unknown;
    }
  | {
      readonly executed: false;
      readonly state: CircuitBreakerState;
      readonly retryAfterMs: number | null;
    };

function positiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${label} must be an integer between 1 and ${max}`, {
      reason: "CIRCUIT_BREAKER_CONFIG_INVALID",
      details: [{ path: label, issue: "out of bounds" }],
    });
  }
  return value;
}

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #failureWindowMs: number;
  readonly #openCooldownMs: number;
  readonly #halfOpenMaxProbes: number;
  readonly #halfOpenSuccessThreshold: number;
  readonly #now: () => UtcInstant;
  readonly #internals: BreakerInternals = {
    state: "closed",
    failures: [],
    openedAtMs: null,
    probesInFlight: 0,
    halfOpenSuccesses: 0,
  };

  constructor(options: CircuitBreakerOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("CircuitBreakerOptions must be an object", {
        reason: "CIRCUIT_BREAKER_CONFIG_INVALID",
        details: [{ path: "CircuitBreakerOptions", issue: "not an object" }],
      });
    }
    this.#failureThreshold = positiveInt(options.failureThreshold, "failureThreshold", 1_000_000);
    this.#failureWindowMs = positiveInt(options.failureWindowMs, "failureWindowMs", 2_147_483_647);
    this.#openCooldownMs = positiveInt(options.openCooldownMs, "openCooldownMs", 2_147_483_647);
    this.#halfOpenMaxProbes = positiveInt(options.halfOpenMaxProbes, "halfOpenMaxProbes", 1_000_000);
    this.#halfOpenSuccessThreshold = positiveInt(
      options.halfOpenSuccessThreshold ?? 1,
      "halfOpenSuccessThreshold",
      1_000_000,
    );
    this.#now = options.now ?? nowUtc;
  }

  /** Current state, applying the open -> half-open cooldown transition lazily. */
  stateAt(at: UtcInstant | string): CircuitBreakerState {
    const nowMs = epochMsOf(parseUtcInstant(at));
    if (
      this.#internals.state === "open" &&
      this.#internals.openedAtMs !== null &&
      nowMs >= this.#internals.openedAtMs + this.#openCooldownMs
    ) {
      this.#internals.state = "half-open";
      this.#internals.probesInFlight = 0;
      this.#internals.halfOpenSuccesses = 0;
    }
    return this.#internals.state;
  }

  /** Whether a request may execute as of `at`; consumes a probe slot when half-open. */
  canExecute(at: UtcInstant | string): CircuitBreakerAdmission {
    const nowMs = epochMsOf(parseUtcInstant(at));
    const state = this.stateAt(at);
    if (state === "closed") {
      return { allowed: true, state };
    }
    if (state === "half-open") {
      if (this.#internals.probesInFlight >= this.#halfOpenMaxProbes) {
        return {
          allowed: false,
          state,
          retryAfterMs: null, // saturated: wait for an in-flight probe to finish
        };
      }
      this.#internals.probesInFlight += 1;
      return { allowed: true, state };
    }
    const openedAt = this.#internals.openedAtMs;
    const retryAfterMs =
      openedAt === null ? null : Math.max(1, openedAt + this.#openCooldownMs - nowMs);
    return { allowed: false, state: "open", retryAfterMs };
  }

  /** Records a success (completion of an admitted request). */
  recordSuccess(at: UtcInstant | string): CircuitBreakerState {
    const state = this.stateAt(at);
    if (state === "open") {
      throw new DomainError(
        "a circuit breaker cannot record success while open (no request was admitted)",
        { reason: "CIRCUIT_BREAKER_TRANSITION_INVALID" },
      );
    }
    if (state === "half-open") {
      this.#internals.probesInFlight = Math.max(0, this.#internals.probesInFlight - 1);
      this.#internals.halfOpenSuccesses += 1;
      if (this.#internals.halfOpenSuccesses >= this.#halfOpenSuccessThreshold) {
        this.#transition("closed", at);
        this.#internals.failures = [];
        this.#internals.openedAtMs = null;
        this.#internals.probesInFlight = 0;
        this.#internals.halfOpenSuccesses = 0;
        return "closed";
      }
      return "half-open";
    }
    return "closed"; // closed success: the rolling window decays on its own
  }

  /** Records a failure (completion of an admitted request). */
  recordFailure(at: UtcInstant | string): CircuitBreakerState {
    const nowMs = epochMsOf(parseUtcInstant(at));
    const state = this.stateAt(at);
    if (state === "open") {
      return "open"; // already open: an in-flight straggler failure is a no-op
    }
    if (state === "half-open") {
      this.#internals.probesInFlight = Math.max(0, this.#internals.probesInFlight - 1);
      this.#transition("open", at);
      this.#internals.openedAtMs = nowMs;
      this.#internals.probesInFlight = 0;
      this.#internals.halfOpenSuccesses = 0;
      return "open";
    }
    const windowStart = nowMs - this.#failureWindowMs;
    this.#internals.failures = this.#internals.failures.filter((t) => t > windowStart);
    this.#internals.failures.push(nowMs);
    if (this.#internals.failures.length >= this.#failureThreshold) {
      this.#transition("open", at);
      this.#internals.openedAtMs = nowMs;
    }
    return this.#internals.state;
  }

  /** In-flight probe count (tests/telemetry). */
  probesInFlight(): number {
    return this.#internals.probesInFlight;
  }

  /** Failures currently counted inside the rolling window (tests/telemetry). */
  failuresInWindow(at: UtcInstant | string): number {
    const nowMs = epochMsOf(parseUtcInstant(at));
    const windowStart = nowMs - this.#failureWindowMs;
    return this.#internals.failures.filter((t) => t > windowStart).length;
  }

  /**
   * Wraps `fn`: admission at `at`, completion recorded through the injected
   * clock. Returns the execution outcome; `fn`'s rejection is CAPTURED (never
   * re-thrown) - the breaker's job is the state machine, not error plumbing.
   */
  async execute<T>(at: UtcInstant | string, fn: () => Promise<T>): Promise<CircuitBreakerExecution<T>> {
    const admission = this.canExecute(at);
    if (!admission.allowed) {
      return {
        executed: false,
        state: admission.state,
        retryAfterMs: admission.retryAfterMs,
      };
    }
    try {
      const value = await fn();
      const state = this.recordSuccess(this.#now());
      return { executed: true, succeeded: true, state, value };
    } catch (error) {
      const state = this.recordFailure(this.#now());
      return { executed: true, succeeded: false, state, error };
    }
  }

  #transition(to: CircuitBreakerState, at: UtcInstant | string): void {
    const from = this.#internals.state;
    if (!canTransitionCircuitBreaker(from, to)) {
      throw new DomainError(
        `illegal circuit breaker transition ${from} -> ${to} at ${String(at)}`,
        { reason: "CIRCUIT_BREAKER_TRANSITION_INVALID" },
      );
    }
    this.#internals.state = to;
  }
}
