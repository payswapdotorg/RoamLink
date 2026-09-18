/**
 * Deterministic in-memory Redis command engine (RL-096).
 *
 * Implements the PINNED command subset (GET / SET / DEL / INCR / PEXPIRE /
 * PTTL / PING) with clock-driven TTL expiry over explicit UTC instants -
 * no ambient timers. It is the shared semantic core for:
 *  - the in-memory {@link InMemoryEphemeralCoordination} fake (tests +
 *    local development), and
 *  - the in-memory Upstash REST protocol stand-in that exercises the REST
 *    client in contract tests (no network).
 *
 * Engine-level failures speak Redis-shaped error strings ("ERR ..."); the
 * port-level admission bounds are enforced OUTSIDE this engine by the
 * port implementations.
 */
import type { UtcInstant } from "@roamlink/contracts";
import { epochMsOf, parseUtcInstant } from "@roamlink/contracts";

interface Entry {
  value: string;
  /** Absolute expiry in epoch ms; null = no expiry (engine allows it; the PORT forbids it). */
  expiresAtMs: number | null;
}

export class InMemoryRedisEngine {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: { now(): UtcInstant };

  constructor(clock: { now(): UtcInstant }) {
    this.#clock = clock;
  }

  /** Executes one command array; returns the Redis-shaped reply. */
  exec(command: readonly string[]): unknown {
    const name = (command[0] ?? "").toUpperCase();
    switch (name) {
      case "PING":
        return "PONG";
      case "GET":
        return this.get(this.arg(command, 1));
      case "SET":
        return this.set(command);
      case "DEL":
        return this.del(this.arg(command, 1));
      case "INCR":
        return this.incr(this.arg(command, 1));
      case "PEXPIRE":
        return this.pexpire(command);
      case "PTTL":
        return this.pttl(this.arg(command, 1));
      case "EVAL":
        return this.evalFixedWindowIncrement(command);
      default:
        throw new Error("ERR unknown command");
    }
  }

  get(key: string): string | null {
    const entry = this.live(key);
    return entry === null ? null : entry.value;
  }

  private set(command: readonly string[]): string | null {
    const key = this.arg(command, 1);
    const value = this.arg(command, 2);
    let ttlMs: number | null = null;
    let onlyIfAbsent = false;
    for (let i = 3; i < command.length; i += 1) {
      const option = (command[i] ?? "").toUpperCase();
      if (option === "PX") {
        const raw = this.arg(command, i + 1, "ERR syntax error");
        ttlMs = Number(raw);
        if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("ERR invalid expire time");
        i += 1;
      } else if (option === "NX") {
        onlyIfAbsent = true;
      } else {
        throw new Error("ERR syntax error");
      }
    }
    const existing = this.live(key);
    if (onlyIfAbsent && existing !== null) return null;
    const nowMs = this.nowMs();
    this.#entries.set(key, {
      value,
      expiresAtMs: ttlMs === null ? null : nowMs + ttlMs,
    });
    return "OK";
  }

  private del(key: string): number {
    return this.#entries.delete(key) ? 1 : 0;
  }

  private incr(key: string): number {
    return this.incrBy(key, 1);
  }

  private incrBy(key: string, amount: number): number {
    const entry = this.live(key);
    if (entry !== null && !/^-?\d+$/.test(entry.value)) {
      throw new Error("ERR value is not an integer or out of range");
    }
    const next = (entry === null ? 0 : Number(entry.value)) + amount;
    // INCRBY preserves an existing TTL and never sets one (Redis semantics).
    this.#entries.set(key, { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
    return next;
  }

  private pexpire(command: readonly string[]): number {
    const key = this.arg(command, 1);
    const rawMs = this.arg(command, 2, "ERR syntax error");
    const ttlMs = Number(rawMs);
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("ERR invalid expire time");
    let mode = "";
    if (command.length > 3) mode = (command[3] ?? "").toUpperCase();
    const entry = this.live(key);
    if (entry === null) return 0;
    if (mode === "NX" && entry.expiresAtMs !== null) return 0;
    this.#entries.set(key, { value: entry.value, expiresAtMs: this.nowMs() + ttlMs });
    return 1;
  }

  private pttl(key: string): number {
    const entry = this.live(key);
    if (entry === null) return -2;
    if (entry.expiresAtMs === null) return -1;
    return Math.max(0, entry.expiresAtMs - this.nowMs());
  }

  /**
   * The pinned fixed-window increment script (single EVAL = atomic under
   * Redis's single-threaded execution):
   *   INCRBY key amount; if the key has no expiry, PEXPIRE it; return the
   *   count. The stand-in and the production Upstash path execute the
   *   same script text, exported as FIXED_WINDOW_INCREMENT_LUA.
   */
  private evalFixedWindowIncrement(command: readonly string[]): number {
    const script = this.arg(command, 1);
    if (script !== FIXED_WINDOW_INCREMENT_LUA) {
      throw new Error("ERR unsupported script (this package pins exactly one)");
    }
    const key = this.arg(command, 2, "ERR wrong number of arguments");
    const amount = Number(this.arg(command, 3, "ERR wrong number of arguments"));
    if (!Number.isInteger(amount) || amount < 1) throw new Error("ERR invalid increment amount");
    const count = this.incrBy(key, amount);
    const entry = this.live(key);
    if (entry !== null && entry.expiresAtMs === null) {
      const ttlMs = Number(this.arg(command, 4, "ERR wrong number of arguments"));
      if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("ERR invalid expire time");
      this.#entries.set(key, { value: entry.value, expiresAtMs: this.nowMs() + ttlMs });
    }
    return count;
  }

  private arg(command: readonly string[], index: number, message = "ERR wrong number of arguments"): string {
    const value = command[index];
    if (value === undefined) throw new Error(message);
    return value;
  }

  private live(key: string): Entry | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.nowMs()) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  private nowMs(): number {
    return epochMsOf(parseUtcInstant(this.#clock.now()));
  }

  /** Test/telemetry snapshot: number of live entries. */
  get liveCount(): number {
    let count = 0;
    for (const key of this.#entries.keys()) {
      if (this.live(key) !== null) count += 1;
    }
    return count;
  }
}

/**
 * The single pinned Lua script for the bounded fixed-window increment
 * (RL-096). ONE site decides the script text; both the client (which sends
 * it) and the protocol stand-in (which recognizes it) reference this
 * constant, so parity is structural.
 */
export const FIXED_WINDOW_INCREMENT_LUA =
  'local c = redis.call("INCRBY", KEYS[1], ARGV[1]) if redis.call("PTTL", KEYS[1]) < 0 then redis.call("PEXPIRE", KEYS[1], ARGV[2]) end return c';
