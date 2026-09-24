/**
 * The in-memory fake implementation of the {@link EphemeralCoordinationPort}
 * (RL-096): deterministic (explicit clock, no ambient timers), bounded
 * (TTL required on every write, per-value size bound, key-count capacity),
 * and used for tests and local development ONLY - never durable state.
 */
import type { Clock } from "@roamlink/testkit";
import { UnavailableError, ValidationError } from "@roamlink/contracts";
import { FIXED_WINDOW_INCREMENT_LUA, InMemoryRedisEngine } from "./engine.js";
import {
  type EphemeralCoordinationPort,
  type IncrementOutcome,
  parseEphemeralBounds,
  type SetOutcome,
  type SetWithTtlOptions,
  validateKey,
  validateTtl,
  validateValue,
} from "./port.js";

export interface InMemoryEphemeralCoordinationOptions {
  /** REQUIRED: deterministic behavior needs an explicit clock. */
  readonly clock: Clock;
  readonly bounds?: { readonly maxValueBytes?: number; readonly maxTtlMs?: number };
  /** Maximum simultaneously-live keys (capacity bound, default 1024). */
  readonly maxLiveKeys?: number;
}

const DEFAULT_MAX_LIVE_KEYS = 1024;

export class InMemoryEphemeralCoordination implements EphemeralCoordinationPort {
  readonly #engine: InMemoryRedisEngine;
  readonly #bounds: ReturnType<typeof parseEphemeralBounds>;
  readonly #maxLiveKeys: number;

  constructor(options: InMemoryEphemeralCoordinationOptions) {
    this.#engine = new InMemoryRedisEngine(options.clock);
    this.#bounds = parseEphemeralBounds(options.bounds);
    if (
      options.maxLiveKeys !== undefined &&
      (!Number.isInteger(options.maxLiveKeys) || options.maxLiveKeys < 1 || options.maxLiveKeys > 1_048_576)
    ) {
      throw new UnavailableError(
        "maxLiveKeys must be an integer between 1 and 1048576 (bounded fake capacity)",
        { reason: "EPHEMERAL_CAPACITY_INVALID" },
      );
    }
    this.#maxLiveKeys = options.maxLiveKeys ?? DEFAULT_MAX_LIVE_KEYS;
  }

  async get(key: string): Promise<string | null> {
    validateKey(key);
    return this.#engine.exec(["GET", key]) as string | null;
  }

  async setWithTtl(
    key: string,
    value: string,
    ttlMs: number,
    options?: SetWithTtlOptions,
  ): Promise<SetOutcome> {
    validateKey(key);
    validateValue(value, this.#bounds.maxValueBytes);
    validateTtl(ttlMs, this.#bounds.maxTtlMs);
    this.#assertCapacity(key);
    const args = ["SET", key, value, "PX", String(ttlMs)];
    if (options?.onlyIfAbsent === true) args.push("NX");
    const result = this.#engine.exec(args);
    return { stored: result === "OK" };
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key);
    return this.#engine.exec(["DEL", key]) === 1;
  }

  async incrementWithTtl(key: string, ttlMs: number, amount = 1): Promise<IncrementOutcome> {
    validateKey(key);
    validateTtl(ttlMs, this.#bounds.maxTtlMs);
    if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
      throw new ValidationError("increment amount must be an integer between 1 and 1000000", {
        reason: "EPHEMERAL_AMOUNT_INVALID",
        details: [{ path: "amount", issue: "out of bounds" }],
      });
    }
    this.#assertCapacity(key);
    // The REAL EVAL wire shape (numkeys before the key list — see
    // engine.evalFixedWindowIncrement; live-confirmed by PA-013): the fake
    // and the REST client send byte-identical command arrays.
    const count = this.#engine.exec([
      "EVAL",
      FIXED_WINDOW_INCREMENT_LUA,
      "1",
      key,
      String(amount),
      String(ttlMs),
    ]) as number;
    return { count, firstIncrement: count === amount };
  }

  async timeToLiveMs(key: string): Promise<number | null> {
    validateKey(key);
    const pttl = this.#engine.exec(["PTTL", key]) as number;
    return pttl === -2 ? null : pttl;
  }

  async ping(): Promise<boolean> {
    return this.#engine.exec(["PING"]) === "PONG";
  }

  /** Live-key snapshot (tests/telemetry). */
  get liveKeyCount(): number {
    return this.#engine.liveCount;
  }

  #assertCapacity(key: string): void {
    if (this.#engine.liveCount >= this.#maxLiveKeys && this.#engine.get(key) === null) {
      throw new UnavailableError(
        "the in-memory coordination fake is at its live-key capacity (bounded accelerator)",
        { reason: "EPHEMERAL_CAPACITY_EXCEEDED", retryable: true },
      );
    }
  }
}
