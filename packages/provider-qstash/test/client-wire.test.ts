/**
 * QStash publish-API client wire tests (RL-097): headers, dedupe id,
 * delay header, envelope parsing, failure mapping, secret hygiene.
 *
 * The env-gated LIVE wire legs (PA-013) live at the bottom of this file:
 * with the operator's QStash env surface exported they run against the
 * LIVE publish API (read-only probe + health composition, publish
 * round-trip, the signed receiver round-trip that retires AR-009's
 * standing wire note); with the keys absent they SKIP with named reasons.
 */
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DeterministicClock } from "@roamlink/testkit";
import {
  createQStashHealthCheck,
  QStashProviderError,
  QStashSignatureVerifier,
  UpstashQStashClient,
  tryParseQStashEnv,
  QStashEnv,
} from "../src/index.js";
import { createQStashPublishProtocol } from "./qstash-publish-protocol.js";

const TOKEN = "qstash-test-token-ascii_01";

function makeClient(overrides?: Partial<Parameters<typeof createQStashPublishProtocol>[0]>) {
  const protocol = createQStashPublishProtocol({ token: TOKEN, ...overrides });
  const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
  return { protocol, client };
}

describe("UpstashQStashClient wire behavior (RL-097)", () => {
  it("publishes to the pinned route with the dedupe id and returns the receipt", async () => {
    const { client, protocol } = makeClient();
    const receipt = await client.enqueue({
      jobId: "job-wire-1",
      destination: "https://receiver.example.org/hooks",
      payload: { kind: "notify" },
    });
    expect(receipt).toMatchObject({ jobId: "job-wire-1", accepted: true, duplicate: false });
    expect(protocol.publishes).toHaveLength(1);
    const publish = protocol.publishes.at(0);
    expect(publish?.deduplicationId).toBe("job-wire-1");
    expect(publish?.destination).toBe("https://receiver.example.org/hooks");
    expect(publish ? JSON.parse(publish.body) : undefined).toEqual({ kind: "notify" });
    expect(publish?.delayHeader ?? null).toBeNull();
  });

  it("carries the delay header for bounded deliver-after", async () => {
    const { client, protocol } = makeClient();
    await client.enqueue({
      jobId: "job-wire-2",
      destination: "https://receiver.example.org/hooks",
      payload: {},
      deliverAfterMs: 5_000,
    });
    expect(protocol.publishes.at(0)?.delayHeader).toBe("5s");
  });

  it("maps network failure to request-not-sent", async () => {
    const { client } = makeClient({ failNext: { count: 1 } });
    const error = await client
      .enqueue({ jobId: "job-fail-1", destination: "https://receiver.example.org/x", payload: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QStashProviderError);
    expect((error as QStashProviderError).phase).toBe("request-not-sent");
  });

  it("maps non-2xx to provider-error with suppressed provider text", async () => {
    const { client } = makeClient({ rejectNext: { count: 1, status: 429 } });
    const error = await client
      .enqueue({ jobId: "job-429-1", destination: "https://receiver.example.org/x", payload: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QStashProviderError);
    expect((error as QStashProviderError).phase).toBe("provider-error");
    expect((error as QStashProviderError).status).toBe(429);
    expect((error as QStashProviderError).message).not.toContain("simulated");
  });

  it("fails closed when the response lacks a messageId", async () => {
    const { client } = makeClient({ corruptNext: { count: 1 } });
    const error = await client
      .enqueue({ jobId: "job-corrupt-1", destination: "https://receiver.example.org/x", payload: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QStashProviderError);
    expect((error as QStashProviderError).phase).toBe("response-unusable");
  });

  it("never stringifies the token (RL-LOCK-016)", () => {
    const { client } = makeClient();
    expect(String(client)).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
  });

  it("rejects http base URLs and invalid tokens", () => {
    expect(() => new UpstashQStashClient({ token: TOKEN, baseUrl: "http://qstash.upstash.io" })).toThrow(/https/i);
    expect(() => new UpstashQStashClient({ token: "bad token" })).toThrow(/token/);
  });
});

describe("tryParseQStashEnv (RL-097)", () => {
  it("parses valid credentials into a redacting config (with rotation key)", () => {
    const result = tryParseQStashEnv({
      QSTASH_TOKEN: TOKEN,
      QSTASH_CURRENT_SIGNING_KEY: "sk-current",
      QSTASH_NEXT_SIGNING_KEY: "sk-next",
      QSTASH_URL: "https://qstash.upstash.io",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.token).toBe(TOKEN);
    expect(result.config.nextSigningKey).toBe("sk-next");
    expect(String(result.config)).not.toContain(TOKEN);
    expect(inspect(result.config)).not.toContain("sk-current");
    expect(inspect(result.config)).not.toContain("sk-next");
    expect(JSON.stringify(result.config)).not.toContain(TOKEN);
    expect(result.config).toBeInstanceOf(QStashEnv);
  });

  it("fails naming keys only when token/signing keys are missing", () => {
    const result = tryParseQStashEnv({ QSTASH_TOKEN: TOKEN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("QSTASH_CURRENT_SIGNING_KEY");
    expect(result.error.message).not.toContain("sk-");
  });
});

// --------------------------------------------------------------------------------
// The LIVE QStash wire legs (PA-013): env-gated against the operator's real
// QStash account. With the QStash env surface exported (QSTASH_TOKEN,
// QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY — kept configured so
// rotation never drops deliveries — and optional QSTASH_URL) the legs RUN:
// the READ-ONLY probe + health composition, the publish round-trip (the
// dedupe id and bounded delay headers against the live publish API), and
// the signed receiver round-trip — the AR-009 standing wire-note leg: the
// LIVE signature canonicalization, verified LOCALLY with the pinned
// verifier under the current/next signing keys. With the keys absent they
// SKIP with the NAMED reason below — CI stays green with the deterministic
// legs above (zero silent passes, zero skipped-as-passed lies — the AR-010
// operator-phase discipline).
// --------------------------------------------------------------------------------

const QSTASH_PARSED = tryParseQStashEnv(process.env);
const QSTASH_CONFIG = QSTASH_PARSED.ok ? QSTASH_PARSED.config : undefined;

if (!QSTASH_CONFIG) {
  console.log(
    "[RL-097/PA-013] SKIPPING the live QStash wire legs: the QStash env surface is not configured " +
      "(QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, optional QSTASH_URL). The legs run in " +
      "the operator phase against the live publish API (read-only probe + health composition, publish round-trip " +
      "with the dedupe/delay headers, the signed receiver round-trip that retires AR-009's standing wire note) — " +
      "this skip is named, never a silent pass.",
  );
}

const liveWire = QSTASH_CONFIG ? it : it.skip;
const LIVE_RUN_ID = Date.now().toString(36);

/**
 * The battery's SINK destination: an RFC 2606 `.invalid` hostname can
 * NEVER resolve, so nothing beyond the operator's own QStash account is
 * ever contacted — the publish round-trip legs assert the transport
 * contract (route, headers, receipt), never live delivery. The delay is
 * pinned to the client's maximum (24h) so no delivery is attempted while
 * the battery runs.
 */
const SINK_DESTINATION = "https://receiver.invalid/roamlink-transport-battery";

function liveClient(): UpstashQStashClient {
  const config = QSTASH_CONFIG;
  if (!config) throw new Error("unreachable: the gate above decides these legs");
  return new UpstashQStashClient({
    token: config.token,
    ...(config.baseUrl !== null ? { baseUrl: config.baseUrl } : {}),
  });
}

// The receiver mechanism for the signed round-trip leg (documented here —
// this IS the battery's receiver): the operator provides an HTTPS capture
// endpoint under QSTASH_LIVE_RECEIVER_URL whose captured-request list is
// readable via plain GET answering JSON. Recognized shapes: a top-level
// array, or an array under `.requests` / `.data`; each entry must expose
// the request headers (looked up case-insensitively) and the raw request
// body string (fields `body`, `content` or `data`). The battery delivers
// ONLY a synthetic transport probe (never a business-looking payload) and
// verifies the signature LOCALLY with the pinned verifier before acting.
const RECEIVER_URL = process.env.QSTASH_LIVE_RECEIVER_URL?.trim() || "";

interface CapturedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function captureList(body: unknown): CapturedRequest[] {
  const array = Array.isArray(body)
    ? body
    : body !== null && typeof body === "object"
      ? ((["requests", "data"] as const)
          .map((field) => (body as Record<string, unknown>)[field])
          .find((value): value is unknown[] => Array.isArray(value)) ?? [])
      : [];
  const captured: CapturedRequest[] = [];
  for (const entry of array) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawHeaders = record.headers ?? (record.request as Record<string, unknown> | undefined)?.headers;
    if (rawHeaders === null || typeof rawHeaders !== "object") continue;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers[name.toLowerCase()] = value;
    }
    const rawBody = record.body ?? record.content ?? record.data;
    if (typeof rawBody !== "string") continue;
    captured.push({ headers, body: rawBody });
  }
  return captured;
}

async function pollForCapture(marker: string): Promise<CapturedRequest> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const response = await fetch(RECEIVER_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the capture endpoint answered HTTP ${response.status}`);
    for (const captured of captureList(await response.json())) {
      if (captured.body.includes(marker) && typeof captured.headers["upstash-signature"] === "string") {
        return captured;
      }
    }
    if (Date.now() >= deadline) throw new Error("the capture endpoint never observed the marked delivery (45s budget)");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

describe("the live QStash wire legs (env-gated, PA-013)", () => {
  liveWire(
    "answers the read-only probe against the LIVE service and composes health over it",
    async () => {
      const client = liveClient();
      await expect(client.probe()).resolves.toBeUndefined();
      const clock = new DeterministicClock("2026-01-15T10:00:00.000Z");
      const { HealthRegistry, runHealthChecks } = await import("@roamlink/observability");
      const registry = new HealthRegistry();
      registry.register(createQStashHealthCheck({ probe: client, clock }));
      const report = await runHealthChecks(registry, { now: () => clock.now() });
      expect(report.state).toBe("healthy");
    },
    60_000,
  );

  liveWire(
    "publishes to the LIVE publish API with the dedupe id and bounded delay headers and returns the receipt",
    async () => {
      const config = QSTASH_CONFIG;
      if (!config) throw new Error("unreachable: the gate above decides these legs");
      const client = liveClient();
      const jobId = `pa013-live-wire-${LIVE_RUN_ID}`;
      const payload = { kind: "transport-battery-probe", run: LIVE_RUN_ID };
      // First publish: the pinned route + headers over the live wire.
      const first = await client.enqueue({
        jobId,
        destination: SINK_DESTINATION,
        payload,
        deliverAfterMs: 86_400_000,
      });
      expect(first).toMatchObject({ jobId, accepted: true, duplicate: false });
      expect(typeof first.messageId).toBe("string");
      expect(first.messageId.length).toBeGreaterThan(0);
      // Replay of the SAME logical job (same id, same payload): the dedupe
      // id is carried again; the hosted client models an accepted receipt
      // (QStash's windowed server-side dedupe never surfaces as a client
      // failure — a live drift here is a surfaced real-wire finding).
      const replay = await client.enqueue({
        jobId,
        destination: SINK_DESTINATION,
        payload,
        deliverAfterMs: 86_400_000,
      });
      expect(replay).toMatchObject({ jobId, accepted: true });
      // Secret hygiene over the LIVE credential (boolean-first so a failure
      // never prints the value — RL-LOCK-016).
      const leaked =
        String(client).includes(config.token) ||
        JSON.stringify(client).includes(config.token) ||
        String(QSTASH_CONFIG).includes(config.token);
      expect(leaked).toBe(false);
    },
    60_000,
  );

  liveWire(
    "the signed receiver round-trip: the LIVE signature canonicalization verifies locally (current/next keys) — the AR-009 wire note",
    async () => {
      const config = QSTASH_CONFIG;
      if (!config) throw new Error("unreachable: the gate above decides these legs");
      if (RECEIVER_URL === "") {
        console.log(
          "[RL-097/PA-013] SKIPPING the signed receiver round-trip leg: QSTASH_LIVE_RECEIVER_URL is not configured " +
            "(the battery's documented receiver mechanism — an HTTPS capture endpoint whose captured-request list is " +
            "readable via plain GET; see the mechanism comment in this file). The leg runs when the operator provides " +
            "the receiver; it verifies the live signature canonicalization LOCALLY with the current/next signing keys — " +
            "this skip is named, never a silent pass.",
        );
      }
      expect(RECEIVER_URL).not.toBe("");
      expect(RECEIVER_URL.startsWith("https://")).toBe(true);
      const client = liveClient();
      const marker = `pa013-canonicalization-${LIVE_RUN_ID}`;
      const payload = { kind: "transport-battery-probe", marker };
      const receipt = await client.enqueue({ jobId: marker, destination: RECEIVER_URL, payload });
      expect(receipt.accepted).toBe(true);
      const captured = await pollForCapture(marker);
      const signatureHeader = captured.headers["upstash-signature"];
      // Verify LOCALLY with the pinned verifier — this is the AR-009
      // canonicalization check. The full verifier accepts the current key
      // OR the rotation key; the value-free outcome records WHICH slot
      // verified (current / next) by trying them separately first.
      const underCurrent = new QStashSignatureVerifier({
        currentSigningKey: config.currentSigningKey,
      }).verify({ signatureHeader, body: captured.body, receivedAtMs: Date.now() });
      const underNext =
        config.nextSigningKey !== null
          ? new QStashSignatureVerifier({ currentSigningKey: config.nextSigningKey }).verify({
              signatureHeader,
              body: captured.body,
              receivedAtMs: Date.now(),
            })
          : ({ ok: false, code: "signature-invalid" } as const);
      const verifier = new QStashSignatureVerifier({
        currentSigningKey: config.currentSigningKey,
        ...(config.nextSigningKey !== null ? { nextSigningKey: config.nextSigningKey } : {}),
      });
      const verdict = verifier.verify({ signatureHeader, body: captured.body, receivedAtMs: Date.now() });
      const outcome = underCurrent.ok
        ? "VERIFIED against the pinned scheme (header grammar t=<unix-seconds>,v1=<hex>; HMAC-SHA256-hex over '<t>.<rawBody>') with the CURRENT signing key"
        : underNext.ok
          ? "VERIFIED against the pinned scheme (header grammar t=<unix-seconds>,v1=<hex>; HMAC-SHA256-hex over '<t>.<rawBody>') with the NEXT signing key (rotation window)"
          : `REJECTED by the pinned verifier (code: ${verdict.ok ? "unreachable" : verdict.code}) - a real-wire drift to surface and fix within the owned surface`;
      // The value-free canonicalization outcome (the evidence record).
      console.log(`[RL-097/PA-013] live QStash signature canonicalization: ${outcome}`);
      expect(verdict.ok).toBe(true);
    },
    120_000,
  );
});
