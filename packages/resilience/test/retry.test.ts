/**
 * RL-053 tests: retry policies - schedule math, deterministic jitter, attempt
 * + wall-clock budgets, taxonomy-based retryability, explicit outcomes.
 */
import { describe, expect, it } from "vitest";

import {
  computeBackoffDelay,
  createDeterministicFullJitter,
  makeRetryPolicy,
  noJitter,
  retryWithPolicy,
} from "../src/index.js";
import { DeterministicClock, fixtureUtcInstant } from "@roamlink/testkit";
import { DomainError, UnavailableError, ValidationError } from "@roamlink/contracts";

const POLICY = makeRetryPolicy({
  maxAttempts: 4,
  initialDelayMs: 100,
  multiplier: 2,
  maxDelayMs: 1_000,
});

describe("policy + schedule math", () => {
  it("validates the policy bounds", () => {
    expect(() => makeRetryPolicy({ maxAttempts: 0, initialDelayMs: 1, multiplier: 1, maxDelayMs: 1 })).toThrow(
      /maxAttempts/,
    );
    expect(() =>
      makeRetryPolicy({ maxAttempts: 1, initialDelayMs: 0, multiplier: 1, maxDelayMs: 1 }),
    ).toThrow(/initialDelayMs/);
    expect(() =>
      makeRetryPolicy({ maxAttempts: 1, initialDelayMs: 1, multiplier: 0.5, maxDelayMs: 1 }),
    ).toThrow(/multiplier/);
    expect(() =>
      makeRetryPolicy({ maxAttempts: 1, initialDelayMs: 10, multiplier: 1, maxDelayMs: 5 }),
    ).toThrow(/maxDelayMs/);
    expect(Object.isFrozen(POLICY)).toBe(true);
  });

  it("computes exponential backoff clamped to maxDelayMs", () => {
    expect(computeBackoffDelay(POLICY, 1)).toBe(100);
    expect(computeBackoffDelay(POLICY, 2)).toBe(200);
    expect(computeBackoffDelay(POLICY, 3)).toBe(400);
    expect(computeBackoffDelay(POLICY, 10)).toBe(1_000); // clamped
    expect(() => computeBackoffDelay(POLICY, 0)).toThrow(/failedAttempts/);
  });

  it("deterministic full jitter is reproducible and bounded by the base delay", () => {
    const jitterA = createDeterministicFullJitter(42);
    const jitterB = createDeterministicFullJitter(42);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const a = jitterA(500, attempt);
      const b = jitterB(500, attempt);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(500);
    }
    expect(jitterA(500, 1)).not.toBe(jitterA(500, 2)); // attempt-varied
    expect(() => createDeterministicFullJitter(-1)).toThrow(/seed/);
    expect(noJitter()(123, 7)).toBe(123);
  });
});

describe("retryWithPolicy", () => {
  it("succeeds on the first attempt without sleeping", async () => {
    const slept: number[] = [];
    const outcome = await retryWithPolicy(
      async (attempt) => {
        expect(attempt).toBe(1);
        return "ok";
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(outcome).toEqual({ status: "succeeded", value: "ok", attempts: 1 });
    expect(slept).toEqual([]);
  });

  it("retries retryable failures with the computed schedule and succeeds", async () => {
    const slept: number[] = [];
    let calls = 0;
    const outcome = await retryWithPolicy(
      async () => {
        calls += 1;
        if (calls < 3) throw new UnavailableError("dependency down");
        return 42;
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(outcome).toEqual({ status: "succeeded", value: 42, attempts: 3 });
    expect(slept).toEqual([100, 200]);
  });

  it("stops at a non-retryable error immediately (Wave-0 taxonomy)", async () => {
    const slept: number[] = [];
    let calls = 0;
    const outcome = await retryWithPolicy(
      async () => {
        calls += 1;
        throw new ValidationError("bad input");
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(outcome.status).toBe("non-retryable");
    if (outcome.status === "non-retryable") {
      expect(outcome.attempts).toBe(1);
      expect(outcome.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("exhausts the attempt budget and reports the last error", async () => {
    const slept: number[] = [];
    const outcome = await retryWithPolicy(
      async () => {
        throw new UnavailableError("still down");
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(outcome.status).toBe("exhausted");
    if (outcome.status === "exhausted") {
      expect(outcome.attempts).toBe(4);
      expect(outcome.lastError).toBeInstanceOf(UnavailableError);
    }
    expect(slept).toEqual([100, 200, 400]);
  });

  it("respects the wall-clock budget (deadline-exceeded before sleeping past it)", async () => {
    const clock = new DeterministicClock(fixtureUtcInstant());
    const slept: number[] = [];
    const outcome = await retryWithPolicy(
      async () => {
        throw new UnavailableError("slow dependency");
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          slept.push(ms);
          clock.advanceBy(ms);
        },
        now: () => clock.now(),
        timeBudgetMs: 350,
      },
    );
    expect(outcome.status).toBe("deadline-exceeded");
    if (outcome.status === "deadline-exceeded") {
      expect(outcome.attempts).toBeGreaterThanOrEqual(1);
      expect(outcome.lastError).toBeInstanceOf(UnavailableError);
    }
    // attempt 1 fails -> delay 100 (total 100 <= 350, sleep) -> attempt 2 fails
    // -> delay 200 (total 300 <= 350, sleep) -> attempt 3 fails -> delay 400
    // (total 700 > 350) -> deadline exceeded before the third sleep.
    expect(slept).toEqual([100, 200]);
  });

  it("reports each retry to the onRetry observer with the notice", async () => {
    const notices: { failedAttempts: number; delayMs: number }[] = [];
    let calls = 0;
    await retryWithPolicy(
      async () => {
        calls += 1;
        if (calls < 3) throw new DomainError("retryable-by-override");
        return true;
      },
      {
        policy: POLICY,
        classifier: () => true,
        sleep: async () => {},
        onRetry: (notice) => notices.push({ failedAttempts: notice.failedAttempts, delayMs: notice.delayMs }),
      },
    );
    expect(notifies(notices)).toEqual(true);
    expect(notices).toEqual([
      { failedAttempts: 1, delayMs: 100 },
      { failedAttempts: 2, delayMs: 200 },
    ]);
  });

  it("treats non-RoamLink errors as non-retryable by default (fail-closed)", async () => {
    let calls = 0;
    const outcome = await retryWithPolicy(
      async () => {
        calls += 1;
        throw new Error("plain error");
      },
      { policy: POLICY, sleep: async () => {} },
    );
    expect(outcome.status).toBe("non-retryable");
    expect(calls).toBe(1);
  });
});

function notifies(list: unknown[]): boolean {
  return Array.isArray(list) && list.length > 0;
}
