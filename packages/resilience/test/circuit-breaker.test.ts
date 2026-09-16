/**
 * RL-053 tests: circuit breaker state machine - closed/open/half-open
 * transitions, rolling-window trip, cooldown, half-open probing (bounded,
 * success closes, failure re-opens, saturation rejects).
 */
import { describe, expect, it } from "vitest";

import {
  CIRCUIT_BREAKER_STATES,
  CIRCUIT_BREAKER_TRANSITIONS,
  CircuitBreaker,
  canTransitionCircuitBreaker,
} from "../src/index.js";
import { fixtureUtcInstant } from "@roamlink/testkit";
import { DomainError } from "@roamlink/contracts";

const T0 = fixtureUtcInstant();

function breaker(overrides?: Partial<ConstructorParameters<typeof CircuitBreaker>[0]>) {
  return new CircuitBreaker({
    failureThreshold: 3,
    failureWindowMs: 10_000,
    openCooldownMs: 30_000,
    halfOpenMaxProbes: 2,
    ...overrides,
  });
}

describe("transition table", () => {
  it("is closed and exhaustive over the state vocabulary", () => {
    expect(CIRCUIT_BREAKER_STATES).toEqual(["closed", "open", "half-open"]);
    expect(CIRCUIT_BREAKER_TRANSITIONS.closed).toEqual(["open"]);
    expect(CIRCUIT_BREAKER_TRANSITIONS.open).toEqual(["half-open"]);
    expect(CIRCUIT_BREAKER_TRANSITIONS["half-open"]).toEqual(["closed", "open"]);
    expect(canTransitionCircuitBreaker("closed", "open")).toBe(true);
    expect(canTransitionCircuitBreaker("closed", "half-open")).toBe(false);
    expect(canTransitionCircuitBreaker("open", "closed")).toBe(false);
    expect(canTransitionCircuitBreaker("half-open", "closed")).toBe(true);
    expect(canTransitionCircuitBreaker("half-open", "open")).toBe(true);
  });
});

describe("closed -> open (rolling window trip)", () => {
  it("opens after failureThreshold failures inside the window", () => {
    const cb = breaker();
    expect(cb.stateAt(T0)).toBe("closed");
    cb.recordFailure(T0);
    cb.recordFailure(fixtureUtcInstant(100));
    expect(cb.stateAt(fixtureUtcInstant(200))).toBe("closed");
    cb.recordFailure(fixtureUtcInstant(200));
    expect(cb.stateAt(fixtureUtcInstant(201))).toBe("open");
  });

  it("does NOT trip when failures age out of the window (decay)", () => {
    const cb = breaker({ failureWindowMs: 1_000 });
    cb.recordFailure(fixtureUtcInstant(0));
    cb.recordFailure(fixtureUtcInstant(500));
    // both previous failures are outside (at-1000ms, at] now
    cb.recordFailure(fixtureUtcInstant(2_000));
    expect(cb.stateAt(fixtureUtcInstant(2_001))).toBe("closed");
  });

  it("rejects execution while open with the remaining cooldown", () => {
    const cb = breaker({ openCooldownMs: 30_000 });
    cb.recordFailure(T0);
    cb.recordFailure(T0);
    cb.recordFailure(fixtureUtcInstant(1_000)); // trips here
    const decision = cb.canExecute(fixtureUtcInstant(2_000));
    expect(decision).toEqual({ allowed: false, state: "open", retryAfterMs: 29_000 });
  });

  it("validates configuration bounds", () => {
    expect(() => breaker({ failureThreshold: 0 })).toThrow(/failureThreshold/);
    expect(() => breaker({ openCooldownMs: 0 })).toThrow(/openCooldownMs/);
    expect(() => breaker({ halfOpenMaxProbes: 0 })).toThrow(/halfOpenMaxProbes/);
  });
});

describe("open -> half-open (cooldown) and probing", () => {
  function tripped(): CircuitBreaker {
    const cb = breaker({ openCooldownMs: 10_000 });
    cb.recordFailure(fixtureUtcInstant(0));
    cb.recordFailure(fixtureUtcInstant(1_000));
    cb.recordFailure(fixtureUtcInstant(2_000));
    expect(cb.stateAt(fixtureUtcInstant(2_500))).toBe("open");
    return cb;
  }

  it("moves to half-open once the cooldown elapsed", () => {
    const cb = tripped();
    expect(cb.stateAt(fixtureUtcInstant(12_000))).toBe("half-open");
  });

  it("admits up to halfOpenMaxProbes concurrent probes, then rejects", () => {
    const cb = tripped();
    const at = fixtureUtcInstant(12_000);
    expect(cb.canExecute(at)).toMatchObject({ allowed: true, state: "half-open" });
    expect(cb.canExecute(at)).toMatchObject({ allowed: true, state: "half-open" });
    expect(cb.probesInFlight()).toBe(2);
    const saturated = cb.canExecute(at);
    expect(saturated).toMatchObject({ allowed: false, state: "half-open", retryAfterMs: null });
  });

  it("a probe success closes the breaker (threshold 1 by default)", () => {
    const cb = tripped();
    cb.canExecute(fixtureUtcInstant(12_000));
    expect(cb.recordSuccess(fixtureUtcInstant(12_050))).toBe("closed");
    expect(cb.probesInFlight()).toBe(0);
    expect(cb.stateAt(fixtureUtcInstant(13_000))).toBe("closed");
  });

  it("halfOpenSuccessThreshold > 1 requires consecutive probe successes", () => {
    const cb = breaker({ openCooldownMs: 10_000, halfOpenSuccessThreshold: 2 });
    cb.recordFailure(fixtureUtcInstant(0));
    cb.recordFailure(fixtureUtcInstant(1_000));
    cb.recordFailure(fixtureUtcInstant(2_000));
    const at = fixtureUtcInstant(12_000);
    expect(cb.canExecute(at)).toMatchObject({ allowed: true });
    expect(cb.recordSuccess(fixtureUtcInstant(12_010))).toBe("half-open");
    expect(cb.canExecute(at)).toMatchObject({ allowed: true });
    expect(cb.recordSuccess(fixtureUtcInstant(12_020))).toBe("closed");
  });

  it("a probe failure re-opens immediately with a fresh cooldown", () => {
    const cb = tripped();
    cb.canExecute(fixtureUtcInstant(12_000));
    expect(cb.recordFailure(fixtureUtcInstant(12_010))).toBe("open");
    // fresh cooldown from the probe failure instant (12_010 + 10_000)
    expect(cb.canExecute(fixtureUtcInstant(13_000))).toMatchObject({
      allowed: false,
      state: "open",
      retryAfterMs: 9_010,
    });
    // probes were reset - after the new cooldown a probe is admitted again
    expect(cb.canExecute(fixtureUtcInstant(22_011))).toMatchObject({
      allowed: true,
      state: "half-open",
    });
  });

  it("recordSuccess while open is an invalid transition (fail-closed)", () => {
    const cb = breaker();
    cb.recordFailure(T0);
    cb.recordFailure(T0);
    cb.recordFailure(T0);
    expect(cb.stateAt(T0)).toBe("open");
    expect(() => cb.recordSuccess(T0)).toThrow(DomainError);
  });

  it("failuresInWindow reports the pruned rolling count", () => {
    const cb = breaker({ failureWindowMs: 1_000 });
    cb.recordFailure(fixtureUtcInstant(0));
    cb.recordFailure(fixtureUtcInstant(500));
    expect(cb.failuresInWindow(fixtureUtcInstant(600))).toBe(2);
    // the failure at t=500 is inside (499, 1499] but slides out at t=1500
    expect(cb.failuresInWindow(fixtureUtcInstant(1_499))).toBe(1);
    expect(cb.failuresInWindow(fixtureUtcInstant(1_500))).toBe(0);
  });
});

describe("execute wrapper", () => {
  it("captures success and failure without re-throwing", async () => {
    const cb = breaker();
    const ok = await cb.execute(T0, async () => "value");
    expect(ok).toEqual({ executed: true, succeeded: true, state: "closed", value: "value" });

    const failing = breaker({ failureThreshold: 1 });
    const boom = await failing.execute<string>(T0, async () => {
      throw new Error("dependency exploded");
    });
    expect(boom.executed).toBe(true);
    if (boom.executed && !boom.succeeded) {
      expect(boom.error).toBeInstanceOf(Error);
      expect(boom.state).toBe("open");
    }
    expect(failing.stateAt(T0)).toBe("open");
  });

  it("rejects without running fn while open", async () => {
    const cb = breaker({ failureThreshold: 1, openCooldownMs: 60_000 });
    await cb.execute(T0, async () => {
      throw new Error("trip");
    });
    let ran = false;
    const outcome = await cb.execute(fixtureUtcInstant(1_000), async () => {
      ran = true;
      return "never";
    });
    expect(outcome).toMatchObject({ executed: false, state: "open" });
    expect(ran).toBe(false);
  });

  it("uses the injected clock for completion instants (deterministic)", async () => {
    const clock = { now: () => fixtureUtcInstant(5_000) };
    const cb = breaker({ failureThreshold: 1, failureWindowMs: 10_000, now: clock.now });
    // failure recorded at the clock's instant (T0+5s), not the admission instant
    await cb.execute(T0, async () => {
      throw new Error("boom");
    });
    expect(cb.failuresInWindow(fixtureUtcInstant(5_001))).toBe(1);
    expect(cb.failuresInWindow(fixtureUtcInstant(15_001))).toBe(0);
  });
});
