/**
 * The Upstash QStash REST client (RL-097) - the hosted implementation of
 * the {@link DurableJobDeliveryPort}.
 *
 * Wire contract (QStash publish API, single-site pin):
 *  - `POST {baseUrl}/v2/messages/{destination}` with
 *    `Authorization: Bearer <token>` and the JSON payload body;
 *  - `Upstash-Deduplication-Id: <jobId>` carries the caller's idempotency
 *    key (RL-LOCK-014) - QStash dedupes windowed duplicates;
 *  - `Upstash-Delay: <seconds>` carries a bounded deliver-after hint;
 *  - success: `{ "messageId": "<id>" }`; failure: typed
 *    {@link QStashProviderError} with the provider text SUPPRESSED
 *    (RL-LOCK-016).
 *
 * Retry semantics are the QStash server's responsibility (it retries
 * non-2xx receivers with backoff and parks exhausted jobs in its DLQ);
 * this client is deliberately transport-only. Receiver endpoints MUST
 * verify the Upstash-Signature header before acting (see the verifier).
 *
 * Honest wire note (AR-009): exact route/headers must be confirmed
 * against a real QStash account at RL-100+; everything is single-sited
 * here so drift is a contained fix.
 */
import { ValidationError } from "@roamlink/contracts";
import {
  type JobEnqueueReceipt,
  type JobEnqueueRequest,
  type DurableJobDeliveryPort,
  type TransportProbePort,
  DEFAULT_MAX_PAYLOAD_BYTES,
  validateDestination,
  validateJobId,
} from "./port.js";
import { canonicalJson } from "./fake.js";

export const QSTASH_DEFAULT_BASE_URL = "https://qstash.upstash.io";

export type FetchLike = typeof fetch;

export interface UpstashQStashClientOptions {
  /** Bearer token (secret; stored redacted). */
  readonly token: string;
  readonly baseUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch (Node >= 22). */
  readonly fetchLike?: typeof fetch;
  /** Payload admission bound (default 1 MiB, the documented free-tier limit). */
  readonly maxPayloadBytes?: number;
  /** Request timeout in ms (default 10000). */
  readonly timeoutMs?: number;
}

export class QStashProviderError extends Error {
  readonly status: number | null;
  readonly phase: "request-not-sent" | "response-unusable" | "provider-error";

  constructor(phase: "request-not-sent" | "response-unusable" | "provider-error", status: number | null, message: string) {
    super(message);
    this.phase = phase;
    this.status = status;
    this.name = "QStashProviderError";
    Object.freeze(this);
  }
}

interface PublishResponse {
  messageId?: unknown;
}

export class UpstashQStashClient implements DurableJobDeliveryPort, TransportProbePort {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #doFetch: FetchLike;
  readonly #maxPayloadBytes: number;
  readonly #timeoutMs: number;

  constructor(options: UpstashQStashClientOptions) {
    if (typeof options?.token !== "string" || !/^[\x21-\x7e]+$/.test(options.token) || options.token.length > 512) {
      throw new ValidationError("UpstashQStashClient token must be printable non-whitespace ASCII (max 512 chars)", {
        reason: "QSTASH_CLIENT_CONFIG_INVALID",
        details: [{ path: "token", issue: "invalid shape" }],
      });
    }
    const baseUrl = options.baseUrl ?? QSTASH_DEFAULT_BASE_URL;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new ValidationError("UpstashQStashClient baseUrl must be an absolute URL", {
        reason: "QSTASH_CLIENT_CONFIG_INVALID",
        details: [{ path: "baseUrl", issue: "not an absolute URL" }],
      });
    }
    if (url.protocol !== "https:") {
      throw new ValidationError("UpstashQStashClient baseUrl must be HTTPS", {
        reason: "QSTASH_CLIENT_CONFIG_INVALID",
        details: [{ path: "baseUrl", issue: "not https" }],
      });
    }
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#doFetch = options.fetchLike ?? fetch;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1 || this.#maxPayloadBytes > 16_777_216) {
      throw new ValidationError("maxPayloadBytes must be an integer between 1 and 16777216", {
        reason: "QSTASH_CLIENT_CONFIG_INVALID",
        details: [{ path: "maxPayloadBytes", issue: "out of bounds" }],
      });
    }
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new ValidationError("timeoutMs must be an integer between 1 and 60000", {
        reason: "QSTASH_CLIENT_CONFIG_INVALID",
        details: [{ path: "timeoutMs", issue: "out of bounds" }],
      });
    }
  }

  async enqueue(request: JobEnqueueRequest): Promise<JobEnqueueReceipt> {
    if (request === null || typeof request !== "object") {
      throw new ValidationError("JobEnqueueRequest must be an object", {
        reason: "JOB_REQUEST_INVALID",
        details: [{ path: "request", issue: "not an object" }],
      });
    }
    validateJobId(request.jobId);
    validateDestination(request.destination);
    const payload = canonicalJson(request.payload);
    if (Buffer.byteLength(payload, "utf8") > this.#maxPayloadBytes) {
      throw new ValidationError(
        `job payloads are admitted only up to ${this.#maxPayloadBytes} bytes (transport budget discipline)`,
        {
          reason: "JOB_PAYLOAD_TOO_LARGE",
          details: [{ path: "payload", issue: "exceeds the admission bound" }],
        },
      );
    }
    const deliverAfterMs = request.deliverAfterMs ?? 0;
    if (!Number.isInteger(deliverAfterMs) || deliverAfterMs < 0 || deliverAfterMs > 86_400_000) {
      throw new ValidationError("deliverAfterMs must be an integer between 0 and 86400000", {
        reason: "JOB_DELAY_INVALID",
        details: [{ path: "deliverAfterMs", issue: "out of bounds" }],
      });
    }

    const url = `${this.#baseUrl}/v2/messages/${encodeURIComponent(request.destination)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
      // The caller's durable id IS the idempotency key (RL-LOCK-014).
      "upstash-deduplication-id": request.jobId,
    };
    if (deliverAfterMs > 0) {
      headers["upstash-delay"] = `${Math.ceil(deliverAfterMs / 1000)}s`;
    }

    let response: Response;
    try {
      response = await this.#doFetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new QStashProviderError(
        "request-not-sent",
        null,
        "the QStash publish request did not complete (connection/timeout); outcome unknown - dedupe on the jobId makes retrying safe (details suppressed)",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new QStashProviderError("response-unusable", response.status, "the QStash response body is not JSON (details suppressed)");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new QStashProviderError("provider-error", response.status, "the QStash publish API rejected the job (provider text suppressed)");
    }
    if (body === null || typeof body !== "object" || typeof (body as PublishResponse).messageId !== "string") {
      throw new QStashProviderError("response-unusable", response.status, "the QStash response did not carry a messageId (failing closed)");
    }
    const messageId = (body as PublishResponse).messageId as string;
    return {
      jobId: request.jobId,
      messageId,
      accepted: true,
      deliverNotBeforeMs: Date.now() + deliverAfterMs,
      duplicate: false,
    };
  }

  /**
   * The READ-ONLY transport probe (RL-100): `GET {baseUrl}/v2/messages?count=1`
   * with the publish credential. Reachability is the ONLY claim: any 2xx
   * resolves (the body is intentionally not parsed - the probe reads
   * nothing it acts on); non-2xx and connection/timeout failures reject
   * with the provider text SUPPRESSED (RL-LOCK-016). No message is
   * created, no provider state is mutated.
   *
   * AR-009 honest wire note: the exact read route must be confirmed
   * against a real QStash account at the operator phase (RL-118); the
   * route lives ONLY here so drift is a contained fix.
   */
  async probe(): Promise<void> {
    const url = `${this.#baseUrl}/v2/messages?count=1`;
    let response: Response;
    try {
      response = await this.#doFetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new QStashProviderError(
        "request-not-sent",
        null,
        "the QStash probe request did not complete (connection/timeout; details suppressed)",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new QStashProviderError(
        "provider-error",
        response.status,
        "the QStash probe request was rejected (provider text suppressed)",
      );
    }
  }

  /** Log-safe identity (token never included - RL-LOCK-016). */
  toString(): string {
    return `UpstashQStashClient(${this.#baseUrl})`;
  }
}
