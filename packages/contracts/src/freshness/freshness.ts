/**
 * Freshness primitives (RL-002, RL-LOCK-010 - evidence and freshness are
 * first-class; spec/adcos-integration.md §8 projection contract fields).
 *
 * PRIMITIVES ONLY - projection records themselves belong to RL-034.
 *
 * Semantics:
 *  - `observedAt`: when the source was observed (null = never observed);
 *  - `receivedAt`: when RoamLink received the observation (null = nothing
 *    ever arrived);
 *  - `freshUntil`: the last instant the observation may be treated as FRESH
 *    (null = no freshness guarantee established);
 *  - `freshnessState`: FRESH | STALE | UNKNOWN.
 *
 * A record is FRESH only when an observation was both observed and received
 * AND a freshness guarantee exists AND `at` is within it (inclusive of the
 * boundary instant). Anything less is UNKNOWN - absence of evidence is a
 * valid state, never a guess (spec/security.md "Fail-safe defaults").
 *
 * Timestamp ordering between observedAt/receivedAt/freshUntil is deliberately
 * NOT enforced: remote clocks may skew, and skew is itself evidence.
 */
import { ValidationError } from "../errors/errors.js";
import { compareUtcInstants, nowUtc, parseUtcInstant, type UtcInstant } from "../time/utc-instant.js";

export const FRESHNESS_STATES = ["FRESH", "STALE", "UNKNOWN"] as const;

export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export interface FreshnessInput {
  readonly observedAt?: UtcInstant | null;
  readonly receivedAt?: UtcInstant | null;
  readonly freshUntil?: UtcInstant | null;
}

export interface Freshness {
  readonly observedAt: UtcInstant | null;
  readonly receivedAt: UtcInstant | null;
  readonly freshUntil: UtcInstant | null;
  readonly freshnessState: FreshnessState;
}

export function isFreshnessState(value: unknown): value is FreshnessState {
  return typeof value === "string" && (FRESHNESS_STATES as readonly string[]).includes(value);
}

/**
 * Evaluates the freshness state of an observation as of instant `at`
 * (defaults to now; pass an explicit instant for deterministic evaluation).
 */
export function evaluateFreshnessState(input: FreshnessInput, at: UtcInstant = nowUtc()): FreshnessState {
  const observedAt = input.observedAt ?? null;
  const receivedAt = input.receivedAt ?? null;
  const freshUntil = input.freshUntil ?? null;
  if (observedAt === null || receivedAt === null || freshUntil === null) {
    return "UNKNOWN";
  }
  return compareUtcInstants(at, freshUntil) <= 0 ? "FRESH" : "STALE";
}

/** Builds a frozen freshness record with the state evaluated at `at`. */
export function makeFreshness(input: FreshnessInput, at: UtcInstant = nowUtc()): Freshness {
  const observedAt = input.observedAt ?? null;
  const receivedAt = input.receivedAt ?? null;
  const freshUntil = input.freshUntil ?? null;
  return Object.freeze({
    observedAt,
    receivedAt,
    freshUntil,
    freshnessState: evaluateFreshnessState({ observedAt, receivedAt, freshUntil }, at),
  });
}

function parseNullableInstant(value: unknown, label: string): UtcInstant | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`Freshness.${label} must be a UTC instant string or null`, {
      reason: "FRESHNESS_INVALID",
      details: [{ path: `Freshness.${label}`, issue: "not a string or null" }],
    });
  }
  return parseUtcInstant(value);
}

/**
 * Parses a freshness record from an unknown value. The stored
 * `freshnessState` is trusted as-recorded (it was evaluated at observation
 * time); use {@link refreshFreshnessState} to re-evaluate for "now".
 */
export function parseFreshness(value: unknown): Freshness {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Freshness must be an object", {
      reason: "FRESHNESS_INVALID",
      details: [{ path: "Freshness", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["observedAt", "receivedAt", "freshUntil", "freshnessState"].includes(key)) {
      throw new ValidationError(`Freshness rejected unknown field '${key}'`, {
        reason: "FRESHNESS_INVALID",
        details: [{ path: `Freshness.${key}`, issue: "unknown field" }],
      });
    }
  }
  const stateValue = record["freshnessState"];
  if (!isFreshnessState(stateValue)) {
    throw new ValidationError("Freshness.freshnessState must be FRESH, STALE or UNKNOWN", {
      reason: "FRESHNESS_INVALID",
      details: [{ path: "Freshness.freshnessState", issue: "outside the closed vocabulary" }],
    });
  }
  return Object.freeze({
    observedAt: parseNullableInstant(record["observedAt"], "observedAt"),
    receivedAt: parseNullableInstant(record["receivedAt"], "receivedAt"),
    freshUntil: parseNullableInstant(record["freshUntil"], "freshUntil"),
    freshnessState: stateValue,
  });
}

/**
 * Re-evaluates the state of an existing record as of `at`, preserving its
 * timestamps. For monotonically increasing evaluation instants the
 * degradation is monotone: FRESH may become STALE, STALE never returns to
 * FRESH, and UNKNOWN only clears when a new observation (with a freshness
 * guarantee) is made via makeFreshness.
 */
export function refreshFreshnessState(freshness: Freshness, at: UtcInstant = nowUtc()): Freshness {
  return Object.freeze({
    ...freshness,
    freshnessState: evaluateFreshnessState(freshness, at),
  });
}
