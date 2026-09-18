/**
 * The in-memory Upstash REST protocol stand-in (RL-096 test harness).
 *
 * A fetch handler speaking the pinned wire contract (POST + JSON command
 * array + Bearer auth + result/error envelope) over the SAME engine core
 * the in-memory fake uses. It exists so the contract battery can exercise
 * the REAL client path (wire encoding, auth, envelope parsing, error
 * mapping) with zero network.
 *
 * Scope note (honest): this stand-in implements exactly the pinned
 * command set the client uses (GET/SET/DEL/PTTL/PING + the ONE pinned
 * EVAL script); it is not a general Redis server.
 */
import type { UtcInstant } from "@roamlink/contracts";
import { InMemoryRedisEngine, FIXED_WINDOW_INCREMENT_LUA } from "../src/index.js";

export interface RestProtocolOptions {
  readonly clock: { now(): UtcInstant };
  readonly token: string;
  /** Fail the next N requests with a network-level abort (failure injection). */
  readonly failNext?: { count: number };
  /** Serve non-JSON bodies for the next N requests (envelope corruption). */
  readonly corruptNext?: { count: number };
}

export type RequestLogEntry = {
  readonly authorization: string;
  readonly command: readonly string[];
};

export function createUpstashRestProtocol(options: RestProtocolOptions): {
  fetchLike: typeof fetch;
  requests: RequestLogEntry[];
} {
  const engine = new InMemoryRedisEngine(options.clock);
  const requests: RequestLogEntry[] = [];
  const failNext = options.failNext ?? { count: 0 };
  const corruptNext = options.corruptNext ?? { count: 0 };

  const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL) && !(input instanceof Request)) {
      throw new TypeError("unsupported input");
    }
    if (failNext.count > 0) {
      failNext.count -= 1;
      throw new TypeError("simulated network failure");
    }
    const auth = headerOf(init, "authorization");
    if (auth !== `Bearer ${options.token}`) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    if (corruptNext.count > 0) {
      corruptNext.count -= 1;
      return new Response("<not json>", { status: 200 });
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { error: "the request body must be a JSON command array" });
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((c) => typeof c !== "string")) {
      return jsonResponse(400, { error: "the request body must be a JSON command array of strings" });
    }
    const command = parsed as string[];
    if (
      command[0]?.toUpperCase() === "EVAL" &&
      command[1] !== FIXED_WINDOW_INCREMENT_LUA
    ) {
      return jsonResponse(400, { error: "ERR unsupported script" });
    }
    requests.push({ authorization: auth, command });
    try {
      const result = engine.exec(command);
      return jsonResponse(200, { result });
    } catch (error) {
      return jsonResponse(400, { error: error instanceof Error ? error.message : "ERR internal" });
    }
  }) as unknown as typeof fetch;

  return { fetchLike, requests };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
