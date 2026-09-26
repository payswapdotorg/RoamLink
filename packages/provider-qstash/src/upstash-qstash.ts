/**
 * The Upstash QStash REST client (RL-097) - the hosted implementation of
 * the {@link DurableJobDeliveryPort}.
 *
 * Wire contract (QStash publish API, single-site pin; LIVE-CONFIRMED by
 * the PA-017 2026-09-24 evidence):
 *  - `POST {baseUrl}/v2/publish/{destination}` with
 *    `Authorization: Bearer <token>` and the JSON payload body - the
 *    destination is carried with its scheme LITERAL in the path (the
 *    fully-percent-encoded form is refused 400 by the live service), and
 *    the live service pre-flight DNS-validates the destination's host at
 *    publish time (an unresolvable host is refused with a typed 400
 *    before anything is enqueued). The OLD pinned route
 *    `POST /v2/messages/{destination}` answers 405 text/plain on the
 *    live service - corrected here;
 *  - `Upstash-Deduplication-Id: <jobId>` carries the caller's idempotency
 *    key (RL-LOCK-014) - QStash dedupes windowed duplicates;
 *  - `Upstash-Delay: <seconds>` carries a bounded deliver-after hint;
 *  - success: 201 + `{ "messageId": "<id>" }` (single field); failure:
 *    typed {@link QStashProviderError} with the provider text SUPPRESSED
 *    (RL-LOCK-016).
 *
 * Retry semantics are the QStash server's responsibility (it retries
 * non-2xx receivers with backoff and parks exhausted jobs in its DLQ);
 * this client is deliberately transport-only. Receiver endpoints MUST
 * verify the Upstash-Signature header before acting (see the verifier).
 *
 * Wire note (AR-009, retired by the PA-017 live evidence): the
 * route/headers above are confirmed against a real QStash account;
 * everything is single-sited here so any future drift is a contained fix.
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
import {
  type RecurringDeliverySchedule,
  type RecurringDeliveryScheduleListing,
  type RecurringDeliveryScheduleRequest,
  type DurableJobSchedulePort,
  validateCronExpression,
} from "./schedule.js";
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

/** The schedule route's success receipt (the pinned wire shape). */
interface ScheduleResponse {
  scheduleId?: unknown;
}

/**
 * Encodes a destination for the LIVE publish path: the route carries the
 * destination's scheme LITERALLY (`/v2/publish/https://host/path` - the
 * fully-percent-encoded form is refused 400 by the live service), so ONLY
 * the characters that would break the outer URL structure are
 * percent-encoded (`?` -> %3F, `#` -> %23); scheme, slashes, colons and
 * the rest stay literal (the live service parses - and pre-flight
 * DNS-validates - the host from the literal form).
 */
function encodePublishDestination(destination: string): string {
  return destination.replaceAll("?", "%3F").replaceAll("#", "%23");
}

export class UpstashQStashClient implements DurableJobDeliveryPort, TransportProbePort, DurableJobSchedulePort {
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

  /**
   * Publishes over the LIVE route `POST /v2/publish/{destination}` (201 +
   * `{"messageId"}`; pre-flight DNS validation on the destination's
   * host - see the wire contract above for the corrected-law details).
   */
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

    const url = `${this.#baseUrl}/v2/publish/${encodePublishDestination(request.destination)}`;
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
   * The READ-ONLY transport probe (RL-100): `GET {baseUrl}/v2/events`
   * with the publish credential (LIVE-CONFIRMED by the PA-017 2026-09-24
   * evidence: the events route answers 200; the OLD pinned route
   * `GET /v2/messages?count=1` answers 405 on the live service).
   * Reachability is the ONLY claim: any 2xx resolves (the body is
   * intentionally not parsed - the probe reads nothing it acts on);
   * non-2xx and connection/timeout failures reject with the provider
   * text SUPPRESSED (RL-LOCK-016). No message is created, no provider
   * state is mutated. The route lives ONLY here so drift is a contained
   * fix.
   */
  async probe(): Promise<void> {
    const url = `${this.#baseUrl}/v2/events`;
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

  // --------------------------------------------------------------------------
  // The recurring-delivery schedule surface (PA-025; see schedule.ts for the
  // pinned wire contract). Schedules are transport cadence, never correctness.
  // --------------------------------------------------------------------------

  /**
   * Publishes the recurring delivery over the pinned route
   * `POST /v2/schedules/{destination}` (Bearer auth; JSON `{cron, body?}`;
   * `{"scheduleId"}` on success). The destination rides the path with its
   * scheme LITERAL — the same law as the publish route.
   */
  async createSchedule(request: RecurringDeliveryScheduleRequest): Promise<RecurringDeliverySchedule> {
    if (request === null || typeof request !== "object") {
      throw new ValidationError("RecurringDeliveryScheduleRequest must be an object", {
        reason: "SCHEDULE_REQUEST_INVALID",
        details: [{ path: "request", issue: "not an object" }],
      });
    }
    validateDestination(request.destination);
    validateCronExpression(request.cron);
    if (request.body !== undefined && (typeof request.body !== "string" || Buffer.byteLength(request.body, "utf8") > this.#maxPayloadBytes)) {
      throw new ValidationError(
        `schedule bodies are admitted only up to ${this.#maxPayloadBytes} bytes (transport budget discipline)`,
        {
          reason: "SCHEDULE_BODY_INVALID",
          details: [{ path: "body", issue: "not a bounded string" }],
        },
      );
    }

    const url = `${this.#baseUrl}/v2/schedules/${encodePublishDestination(request.destination)}`;
    const payload = canonicalJson({
      cron: request.cron,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });

    let response: Response;
    try {
      response = await this.#doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new QStashProviderError(
        "request-not-sent",
        null,
        "the QStash schedule request did not complete (connection/timeout); outcome unknown - the setup step may be retried (details suppressed)",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new QStashProviderError("response-unusable", response.status, "the QStash schedule response body is not JSON (details suppressed)");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new QStashProviderError("provider-error", response.status, "the QStash schedule API rejected the request (provider text suppressed)");
    }
    if (body === null || typeof body !== "object" || typeof (body as ScheduleResponse).scheduleId !== "string") {
      throw new QStashProviderError("response-unusable", response.status, "the QStash schedule response did not carry a scheduleId (failing closed)");
    }
    const scheduleId = (body as ScheduleResponse).scheduleId as string;
    return { scheduleId };
  }

  /**
   * Lists the existing schedules over the pinned read route
   * `GET /v2/schedules` (Bearer auth; a JSON array on success). Entries are
   * parsed DEFENSIVELY (scheduleId required; destination/topic and cron
   * optional) — see schedule.ts for the honest live-shape caveat.
   */
  async listSchedules(): Promise<readonly RecurringDeliveryScheduleListing[]> {
    const url = `${this.#baseUrl}/v2/schedules`;
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
        "the QStash schedule list request did not complete (connection/timeout; details suppressed)",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new QStashProviderError("response-unusable", response.status, "the QStash schedule list response body is not JSON (details suppressed)");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new QStashProviderError("provider-error", response.status, "the QStash schedule list request was rejected (provider text suppressed)");
    }
    if (!Array.isArray(body)) {
      throw new QStashProviderError("response-unusable", response.status, "the QStash schedule list response is not an array (failing closed)");
    }
    const listings: RecurringDeliveryScheduleListing[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const scheduleId = record["scheduleId"];
      if (typeof scheduleId !== "string" || scheduleId.length === 0) continue;
      const destination = record["destination"] ?? record["topic"];
      const cron = record["cron"];
      listings.push({
        scheduleId,
        destination: typeof destination === "string" ? destination : null,
        cron: typeof cron === "string" ? cron : null,
      });
    }
    return listings;
  }

  /** Log-safe identity (token never included - RL-LOCK-016). */
  toString(): string {
    return `UpstashQStashClient(${this.#baseUrl})`;
  }
}
