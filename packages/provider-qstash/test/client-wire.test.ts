/**
 * QStash publish-API client wire tests (RL-097): headers, dedupe id,
 * delay header, envelope parsing, failure mapping, secret hygiene.
 */
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { QStashProviderError, UpstashQStashClient, tryParseQStashEnv, QStashEnv } from "../src/index.js";
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
