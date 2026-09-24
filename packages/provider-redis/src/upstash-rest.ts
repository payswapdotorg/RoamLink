/**
 * The Upstash Redis REST client (RL-096) - the hosted implementation of
 * the {@link EphemeralCoordinationPort}.
 *
 * Wire contract (Upstash REST API, single-site pin):
 *  - `POST {baseUrl}` with a JSON command ARRAY body and
 *    `Authorization: Bearer <token>`;
 *  - success envelope: `{ "result": <value> }`; failure envelope:
 *    `{ "error": "<text>" }` (HTTP status may still be 200 for some
 *    server-side errors - the envelope is authoritative);
 *  - the client sends EXACTLY ONE pinned script (EVAL with the exported
 *    FIXED_WINDOW_INCREMENT_LUA) for the bounded increment - single
 *    command, atomic under Redis execution.
 *
 * Failure semantics (deployment.md §7: Redis is optional for
 * correctness): wire failures surface as the typed
 * {@link RedisProviderError} (kind `unavailable`, retryable) with a
 * SUPPRESSED reason - provider error text may echo command arguments
 * (RL-LOCK-016). Consumers degrade to their non-accelerated path.
 *
 * Secret hygiene: the bearer token lives in a private field, is redacted
 * from toString/inspect/JSON, and never appears in thrown errors.
 */
import { ValidationError } from "@roamlink/contracts";
import { FIXED_WINDOW_INCREMENT_LUA } from "./engine.js";
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

export interface UpstashRedisRestClientOptions {
  /** REST endpoint, e.g. `https://example.upstash.io` (HTTPS enforced). */
  readonly baseUrl: string;
  /** Bearer token (secret; stored redacted). */
  readonly token: string;
  /** Injectable fetch for tests; defaults to global fetch (Node >= 22). */
  readonly fetchLike?: typeof fetch;
  readonly bounds?: { readonly maxValueBytes?: number; readonly maxTtlMs?: number };
  /** Request timeout in ms (default 5000). */
  readonly timeoutMs?: number;
}

export type FetchLike = typeof fetch;

/** Typed provider failure (kind `unavailable`, retryable), detail-suppressed. */
export class RedisProviderError extends Error {
  readonly status: number | null;
  readonly phase: "request-not-sent" | "response-unusable" | "provider-error";

  constructor(
    phase: "request-not-sent" | "response-unusable" | "provider-error",
    status: number | null,
    message: string,
  ) {
    super(message);
    this.phase = phase;
    this.status = status;
    this.name = "RedisProviderError";
    Object.freeze(this);
  }
}

interface UpstashEnvelope {
  result?: unknown;
  error?: unknown;
}

export class UpstashRedisRestClient implements EphemeralCoordinationPort {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #doFetch: FetchLike;
  readonly #bounds: ReturnType<typeof parseEphemeralBounds>;
  readonly #timeoutMs: number;

  constructor(options: UpstashRedisRestClientOptions) {
    if (typeof options?.baseUrl !== "string" || options.baseUrl.length === 0) {
      throw new ValidationError("UpstashRedisRestClient baseUrl must be a non-empty string", {
        reason: "REDIS_CLIENT_CONFIG_INVALID",
        details: [{ path: "baseUrl", issue: "empty" }],
      });
    }
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new ValidationError("UpstashRedisRestClient baseUrl must be an absolute URL", {
        reason: "REDIS_CLIENT_CONFIG_INVALID",
        details: [{ path: "baseUrl", issue: "not an absolute URL" }],
      });
    }
    if (url.protocol !== "https:") {
      throw new ValidationError("UpstashRedisRestClient baseUrl must be HTTPS (credentials on the wire)", {
        reason: "REDIS_CLIENT_CONFIG_INVALID",
        details: [{ path: "baseUrl", issue: "not https" }],
      });
    }
    if (typeof options.token !== "string" || !/^[\x21-\x7e]+$/.test(options.token) || options.token.length > 512) {
      throw new ValidationError("UpstashRedisRestClient token must be printable non-whitespace ASCII (max 512 chars)", {
        reason: "REDIS_CLIENT_CONFIG_INVALID",
        details: [{ path: "token", issue: "invalid shape" }],
      });
    }
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#doFetch = options.fetchLike ?? fetch;
    this.#bounds = parseEphemeralBounds(options.bounds);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new ValidationError("timeoutMs must be an integer between 1 and 60000", {
        reason: "REDIS_CLIENT_CONFIG_INVALID",
        details: [{ path: "timeoutMs", issue: "out of bounds" }],
      });
    }
  }

  async get(key: string): Promise<string | null> {
    validateKey(key);
    const result = await this.#request(["GET", key]);
    return typeof result === "string" ? result : result === null ? null : this.#unusable("GET");
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
    const command = ["SET", key, value, "PX", String(ttlMs)];
    if (options?.onlyIfAbsent === true) command.push("NX");
    const result = await this.#request(command);
    if (result === "OK") return { stored: true };
    if (result === null) return { stored: false };
    return this.#unusable("SET");
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key);
    const result = await this.#request(["DEL", key]);
    return typeof result === "number" ? result > 0 : this.#unusable("DEL");
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
    // The REAL EVAL wire shape (live-confirmed by PA-013 against the
    // operator's Upstash account): EVAL script numkeys key [key...] arg
    // [arg...] — the numkeys count is REQUIRED before the key list; the
    // live service rejects the command with HTTP 400 when it is absent.
    const result = await this.#request([
      "EVAL",
      FIXED_WINDOW_INCREMENT_LUA,
      "1",
      key,
      String(amount),
      String(ttlMs),
    ]);
    if (typeof result !== "number") return this.#unusable("EVAL");
    return { count: result, firstIncrement: result === amount };
  }

  async timeToLiveMs(key: string): Promise<number | null> {
    validateKey(key);
    const result = await this.#request(["PTTL", key]);
    if (typeof result !== "number") return this.#unusable("PTTL");
    return result === -2 ? null : result;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.#request(["PING"]);
      return result === "PONG";
    } catch {
      return false;
    }
  }

  /** Log-safe identity (token never included - RL-LOCK-016). */
  toString(): string {
    return `UpstashRedisRestClient(${this.#baseUrl})`;
  }

  #unusable(command: string): never {
    throw new RedisProviderError(
      "response-unusable",
      null,
      `the Upstash REST response for ${command} did not satisfy the pinned envelope contract (value suppressed)`,
    );
  }

  async #request(command: readonly string[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#doFetch(this.#baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([...command]),
        signal: this.#timeoutSignal(),
      });
    } catch {
      throw new RedisProviderError(
        "request-not-sent",
        null,
        "the Upstash REST request did not complete (connection/timeout); outcome unknown (details suppressed)",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RedisProviderError(
        "response-unusable",
        response.status,
        "the Upstash REST response body is not JSON (details suppressed)",
      );
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new RedisProviderError(
        "response-unusable",
        response.status,
        "the Upstash REST response is not a result/error envelope (details suppressed)",
      );
    }
    const envelope = body as UpstashEnvelope;
    if (typeof envelope.error === "string" && envelope.error.length > 0) {
      throw new RedisProviderError(
        "provider-error",
        response.status,
        "the Upstash REST API rejected the command (provider error text suppressed)",
      );
    }
    if (!("result" in envelope)) {
      throw new RedisProviderError(
        "response-unusable",
        response.status,
        "the Upstash REST response envelope carries neither result nor error (failing closed)",
      );
    }
    return envelope.result;
  }

  #timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.#timeoutMs);
  }
}
