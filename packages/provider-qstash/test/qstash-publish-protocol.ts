/**
 * The in-memory QStash publish-API stand-in (RL-097 test harness).
 *
 * A fetch handler speaking the pinned wire contract (POST
 * /v2/messages/{destination}, Bearer auth, Upstash-Deduplication-Id,
 * JSON {messageId} response) with failure injection - so the REAL client
 * path runs in contract tests with zero network.
 */
import type { FetchLike } from "../src/index.js";

export interface QStashProtocolOptions {
  readonly token: string;
  readonly baseUrl?: string;
  /** Deterministic message ids. */
  readonly messageIdFactory?: () => string;
  /** Fail the next N requests at network level. */
  readonly failNext?: { count: number };
  /** Serve unusable JSON (missing messageId) for the next N requests. */
  readonly corruptNext?: { count: number };
  /** Answer non-2xx for the next N requests. */
  readonly rejectNext?: { count: number; status: number };
}

export interface PublishRecord {
  readonly destination: string;
  readonly body: string;
  readonly deduplicationId: string | null;
  readonly delayHeader: string | null;
}

/** One recorded read-only probe request (RL-100 wire parity). */
export interface ProbeRecord {
  readonly url: string;
  readonly method: string;
  readonly authorized: boolean;
}

export function createQStashPublishProtocol(options: QStashProtocolOptions): {
  fetchLike: FetchLike;
  publishes: PublishRecord[];
  probes: ProbeRecord[];
} {
  const publishes: PublishRecord[] = [];
  const probes: ProbeRecord[] = [];
  const failNext = options.failNext ?? { count: 0 };
  const corruptNext = options.corruptNext ?? { count: 0 };
  const rejectNext = options.rejectNext ?? { count: 0, status: 500 };
  const baseUrl = options.baseUrl ?? "https://qstash.upstash.io";
  let counter = 0;
  const messageIdFactory = options.messageIdFactory ?? (() => `msg_${String(++counter).padStart(3, "0")}`);

  const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (failNext.count > 0) {
      failNext.count -= 1;
      throw new TypeError("simulated network failure");
    }
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${options.token}`) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    // The read-only probe route (RL-100): GET {base}/v2/messages?count=1.
    const probePrefix = `${baseUrl}/v2/messages`;
    if (url.startsWith(probePrefix) && (init?.method ?? "GET") === "GET") {
      probes.push({ url, method: "GET", authorized: true });
      if (rejectNext.count > 0) {
        rejectNext.count -= 1;
        return jsonResponse(rejectNext.status, { error: "rate limited (simulated)" });
      }
      return jsonResponse(200, { messages: [], cursor: null });
    }
    const prefix = `${baseUrl}/v2/messages/`;
    if (!url.startsWith(prefix)) {
      return jsonResponse(404, { error: "not found" });
    }
    if (rejectNext.count > 0) {
      rejectNext.count -= 1;
      return jsonResponse(rejectNext.status, { error: "rate limited (simulated)" });
    }
    if (corruptNext.count > 0) {
      corruptNext.count -= 1;
      return jsonResponse(200, { unexpected: true });
    }
    const destination = decodeURIComponent(url.slice(prefix.length));
    const headers = new Headers(init?.headers);
    publishes.push({
      destination,
      body: typeof init?.body === "string" ? init.body : "",
      deduplicationId: headers.get("upstash-deduplication-id"),
      delayHeader: headers.get("upstash-delay"),
    });
    return jsonResponse(200, { messageId: messageIdFactory() });
  }) as unknown as FetchLike;

  return { fetchLike, publishes, probes };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
