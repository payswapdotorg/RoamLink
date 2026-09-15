/**
 * Deterministic clock primitives (RL-040 platform scaffolding).
 *
 * Reuses the Wave-0 {@link @roamlink/contracts!UtcInstant} type everywhere -
 * testkit never invents a parallel time representation. Inject explicit
 * instants via {@link DeterministicClock} so every time-dependent RoamLink
 * contract (freshness, gating staleness, health `checkedAt`, log `at`) is
 * reproducible in tests (spec/definition-of-done.md "Deterministic test
 * data").
 */
import {
  ConflictError,
  ValidationError,
  addMilliseconds,
  compareUtcInstants,
  nowUtc,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

/** Injectable time source returning Wave-0 UTC instants. */
export interface Clock {
  now(): UtcInstant;
}

/** The real system clock. Non-deterministic by nature; production default. */
export class SystemClock implements Clock {
  now(): UtcInstant {
    return nowUtc();
  }
}

/**
 * Deterministic, strictly monotonic clock with injectable instants.
 *
 * - `now()` is stable between advances;
 * - time never flows on its own and never moves backwards
 *   (a backwards {@link DeterministicClock.advanceTo} is a `ConflictError`);
 * - every mutation returns `this` so tests can chain advances.
 */
export class DeterministicClock implements Clock {
  #current: UtcInstant;

  constructor(start: UtcInstant | string) {
    this.#current = parseUtcInstant(start);
  }

  now(): UtcInstant {
    return this.#current;
  }

  /** Jumps forward to an explicit instant; refuses to move backwards. */
  advanceTo(instant: UtcInstant | string): this {
    const target = parseUtcInstant(instant);
    if (compareUtcInstants(target, this.#current) < 0) {
      throw new ConflictError("DeterministicClock cannot move backwards (monotonic time)", {
        reason: "CLOCK_NOT_MONOTONIC",
        details: [{ path: "DeterministicClock.advanceTo", issue: "target instant is before the current instant" }],
      });
    }
    this.#current = target;
    return this;
  }

  /** Advances by whole milliseconds (>= 0; 0 is a no-op). */
  advanceBy(milliseconds: number): this {
    if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new ValidationError(
        "DeterministicClock.advanceBy requires a non-negative integer number of milliseconds",
        {
          reason: "CLOCK_ADVANCE_INVALID",
          details: [{ path: "DeterministicClock.advanceBy", issue: "must be a non-negative integer" }],
        },
      );
    }
    this.#current = addMilliseconds(this.#current, milliseconds);
    return this;
  }
}
