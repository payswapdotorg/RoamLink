import { describe, expect, it } from "vitest";
import { canonicalizeJson, parseIdempotencyKey } from "@roamlink/contracts";
import { AdcosApiError, ADCOS_REQUEST_HEADER_NAMES } from "@roamlink/adcos";
import {
  AdcosTransportError,
  createAdcosClient,
  createAdcosHttpTransport,
  parseAdcosErrorBody,
  type AdcosTransportRequest,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";

/** A recording stub transport: returns queued responses / throws queued errors. */
class StubTransport {
  readonly requests: AdcosTransportRequest[] = [];
  private queue: { status: number; body: unknown }[] = [];

  respond(status: number, body: unknown): this {
    this.queue.push({ status, body });
    return this;
  }

  async request(request: AdcosTransportRequest): Promise<{ status: number; body: unknown }> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("stub transport: no queued response");
    }
    return next;
  }
}

const INTENT_REQUEST = {
  requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "x" } }],
  validity: { start: T0, end: "2026-01-16T08:30:00.000Z" },
  termination: { actor: "customer", on_expiry: "release" },
  recorded_at: T0,
};

describe("the AdcosClient implementation over a transport (RL-031/032)", () => {
  it("createIntent posts canonical bytes to the pinned route with the mutation headers", async () => {
    const stub = new StubTransport().respond(200, { id: "intent-1" });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await client.createIntent(INTENT_REQUEST as never, { idempotencyKey: parseIdempotencyKey("idem-1") });
    expect(stub.requests.length).toBe(1);
    const request = stub.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("intents");
    expect(request?.mutation).toBe(true);
    expect(request?.idempotencyKey).toBe("idem-1");
    // canonical JSON bytes: sorted keys, deterministic
    expect(request?.body).toBe(canonicalizeJson(INTENT_REQUEST));
  });

  it("rejects a mutation without an idempotency key before any I/O (RL-LOCK-014)", async () => {
    const stub = new StubTransport();
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(
      client.createIntent(INTENT_REQUEST as never, undefined as never),
    ).rejects.toMatchObject({ code: "idempotency-key-required" });
    expect(stub.requests.length).toBe(0);
  });

  it("reads hit the pinned routes without a mutation flag", async () => {
    const stub = new StubTransport()
      .respond(200, { id: "intent-1" })
      .respond(200, { intent_id: "intent-1", state: "INTENT" })
      .respond(200, { next_cursor: null, items: [{ id: "intent-1" }] });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await client.getIntent("intent-1" as never);
    await client.getIntentLifecycle("intent-1" as never);
    await client.listIntents();
    expect(stub.requests.map((r) => r.path)).toEqual([
      "intents/intent-1",
      "intents/intent-1/lifecycle",
      "intents",
    ]);
    expect(stub.requests.every((r) => r.method === "GET" && r.mutation === false)).toBe(true);
  });

  it("list queries flatten limit/cursor into wire query params", async () => {
    const stub = new StubTransport().respond(200, { next_cursor: null, items: [] });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await client.listIntents({ limit: 50, cursor: "abc" });
    expect(stub.requests[0]?.query).toEqual({ limit: "50", cursor: "abc" });
  });

  it("error responses map onto AdcosApiError with the closed code", async () => {
    const stub = new StubTransport().respond(404, { code: "resource-unknown", message: "nope" });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(client.getIntent("intent-1" as never)).rejects.toMatchObject({
      code: "resource-unknown",
    });
  });

  it("an error code OUTSIDE the closed taxonomy fails closed as version-unsupported", async () => {
    const stub = new StubTransport().respond(400, { code: "some-new-code", message: "?" });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(client.getIntent("intent-1" as never)).rejects.toMatchObject({
      code: "version-unsupported",
    });
  });

  it("a non-object document response fails closed as version-unsupported", async () => {
    const stub = new StubTransport().respond(200, "not-an-object");
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(client.getIntent("intent-1" as never)).rejects.toMatchObject({
      code: "version-unsupported",
    });
  });

  it("a malformed page envelope fails closed as version-unsupported", async () => {
    const stub = new StubTransport().respond(200, { items: "not-a-list" });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(client.listIntents()).rejects.toMatchObject({ code: "version-unsupported" });

    const stub2 = new StubTransport().respond(200, { next_cursor: 5, items: [] });
    const client2 = createAdcosClient({ transport: stub2, environment: "sandbox" });
    await expect(client2.listIntents()).rejects.toMatchObject({ code: "version-unsupported" });

    const stub3 = new StubTransport().respond(200, { next_cursor: null, items: [{}, "string-item"] });
    const client3 = createAdcosClient({ transport: stub3, environment: "sandbox" });
    await expect(client3.listIntents()).rejects.toMatchObject({ code: "version-unsupported" });
  });

  it("an unknown page envelope member fails closed (pinned facts only)", async () => {
    const stub = new StubTransport().respond(200, { next_cursor: null, items: [], total: 12 });
    const client = createAdcosClient({ transport: stub, environment: "sandbox" });
    await expect(client.listIntents()).rejects.toMatchObject({ code: "version-unsupported" });
  });

  it("the client pins the environment and API version", () => {
    const client = createAdcosClient({ transport: new StubTransport(), environment: "production" });
    expect(client.environment).toBe("production");
    expect(client.apiVersion).toBe("2.0");
  });
});

describe("the fetch-based HTTP transport (RL-031)", () => {
  function capturingFetch(capture: { url?: string; init?: RequestInit | undefined }) {
    return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capture.url = typeof url === "string" ? url : url.toString();
      capture.init = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
  }

  it("sends the four pinned headers (credential never logged, only transmitted)", async () => {
    const capture: { url?: string; init?: RequestInit | undefined } = {};
    const transport = createAdcosHttpTransport({
      environment: "sandbox",
      baseUrl: "https://adcos.example/v2",
      application: "roamlink-app",
      credential: "server-side-secret",
      fetchLike: capturingFetch(capture) as unknown as typeof fetch,
    });
    await transport.request({
      method: "POST",
      path: "intents",
      body: "{}",
      mutation: true,
      idempotencyKey: parseIdempotencyKey("idem-1"),
    });
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers[ADCOS_REQUEST_HEADER_NAMES.apiVersion]).toBe("2.0");
    expect(headers[ADCOS_REQUEST_HEADER_NAMES.application]).toBe("roamlink-app");
    expect(headers[ADCOS_REQUEST_HEADER_NAMES.credential]).toBe("server-side-secret");
    expect(headers[ADCOS_REQUEST_HEADER_NAMES.idempotencyKey]).toBe("idem-1");
    expect(capture.url).toBe("https://adcos.example/v2/intents");
  });

  it("refuses unkeyed mutations before any network I/O", async () => {
    const transport = createAdcosHttpTransport({
      environment: "sandbox",
      baseUrl: "https://adcos.example/v2",
      application: "roamlink-app",
      credential: "server-side-secret",
      fetchLike: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    await expect(
      transport.request({ method: "POST", path: "intents", mutation: true }),
    ).rejects.toMatchObject({ code: "idempotency-key-required" });
  });

  it("a timeout surfaces as a transport failure with UNKNOWN outcome", async () => {
    const transport = createAdcosHttpTransport({
      environment: "sandbox",
      baseUrl: "https://adcos.example/v2",
      application: "roamlink-app",
      credential: "server-side-secret",
      timeoutMs: 50,
      fetchLike: (async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }) as unknown as typeof fetch,
    });
    const failure = await transport
      .request({ method: "GET", path: "application", mutation: false })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AdcosTransportError);
    expect((failure as AdcosTransportError).outcome).toBe("unknown");
  });

  it("a network failure surfaces as not-sent and never echoes URLs", async () => {
    const transport = createAdcosHttpTransport({
      environment: "sandbox",
      baseUrl: "https://adcos.example/v2",
      application: "roamlink-app",
      credential: "server-side-secret",
      fetchLike: (async () => {
        throw new TypeError("fetch failed while resolving adcos.example");
      }) as unknown as typeof fetch,
    });
    const failure = await transport
      .request({ method: "GET", path: "application", mutation: false })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AdcosTransportError);
    expect((failure as AdcosTransportError).outcome).toBe("not-sent");
    expect((failure as Error).message).not.toContain("adcos.example");
  });

  it("a non-JSON success body fails closed as version-unsupported", async () => {
    const transport = createAdcosHttpTransport({
      environment: "sandbox",
      baseUrl: "https://adcos.example/v2",
      application: "roamlink-app",
      credential: "server-side-secret",
      fetchLike: (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      transport.request({ method: "GET", path: "application", mutation: false }),
    ).rejects.toMatchObject({ code: "version-unsupported" });
  });
});

describe("parseAdcosErrorBody (closed taxonomy enforcement)", () => {
  it("parses a documented code with its message", () => {
    const error = parseAdcosErrorBody(429, { code: "rate-limited", message: "slow down" });
    expect(error).toBeInstanceOf(AdcosApiError);
    expect(error.code).toBe("rate-limited");
    expect(error.message).toBe("slow down");
  });

  it("rejects non-object bodies and unknown members with version-unsupported", () => {
    expect(parseAdcosErrorBody(500, null).code).toBe("version-unsupported");
    expect(parseAdcosErrorBody(500, "nope").code).toBe("version-unsupported");
    expect(parseAdcosErrorBody(500, { code: "rate-limited", extra: true }).code).toBe("version-unsupported");
    expect(parseAdcosErrorBody(500, { code: "mystery" }).code).toBe("version-unsupported");
    expect(parseAdcosErrorBody(500, {}).code).toBe("version-unsupported");
  });
});
