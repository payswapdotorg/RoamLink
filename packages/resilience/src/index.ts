/**
 * @roamlink/resilience - rate limits, retries and circuit breakers (RL-053).
 *
 * Layer: platform primitives. PURE, typed, in-memory resilience mechanisms
 * for boundary protection and dependency isolation:
 *
 *  - {@link TokenBucketLimiter} + {@link SlidingWindowLimiter}: admission
 *    decisions as pure functions of an EXPLICIT UTC instant (deterministic
 *    under the @roamlink/testkit clock), keyed by safe labels, closed
 *    decision objects, read-only snapshots;
 *  - {@link makeRetryPolicy} + {@link retryWithPolicy}: bounded exponential
 *    backoff with injectable jitter (deterministic full-jitter included),
 *    attempt AND wall-clock budgets, retryability classified through the
 *    Wave-0 error taxonomy (no parallel ad-hoc error kinds), explicit
 *    terminal outcomes;
 *  - {@link CircuitBreaker}: closed/open/half-open state machine with a
 *    closed transition table, rolling-window failure counting, cooldown,
 *    bounded half-open probing (probe saturation rejects fail-closed).
 *
 * State is single-process in-memory ONLY; persistence-backed and distributed
 * adapters are later work. Depends ONLY on @roamlink/contracts.
 */
export * from "./limiter.js";
export * from "./retry.js";
export * from "./circuit-breaker.js";
