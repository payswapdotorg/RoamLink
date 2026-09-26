/**
 * PA-025 — the recurring-delivery (schedule) surface: the hosted client's
 * pinned wire behavior (route, Bearer auth, body field, receipt parsing,
 * failure mapping, secret hygiene) and the deterministic fake's contract
 * parity, including the signed-delivery fire the fake's schedules produce
 * (receivers under test verify REAL signatures).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";

import {
  InMemoryJobDeliveryQueue,
  QStashProviderError,
  QStashSignatureVerifier,
  UpstashQStashClient,
  validateCronExpression,
} from "../src/index.js";
import { createQStashPublishProtocol } from "./qstash-publish-protocol.js";

const TOKEN = "qstash-schedule-token-ascii_01";
const DESTINATION = "https://worker.example.test/api/worker/tick";
const CRON = "*/5 * * * *";
const BODY = "{\"kind\":\"worker.tick\"}";

function makeClient(overrides?: Partial<Parameters<typeof createQStashPublishProtocol>[0]>) {
  const protocol = createQStashPublishProtocol({ token: TOKEN, ...overrides });
  const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
  return { protocol, client };
}

describe("UpstashQStashClient schedule wire behavior (PA-025)", () => {
  it("creates the recurring delivery on the pinned route with the cron and the byte-exact body", async () => {
    const { client, protocol } = makeClient();
    const schedule = await client.createSchedule({ destination: DESTINATION, cron: CRON, body: BODY });
    expect(typeof schedule.scheduleId).toBe("string");
    expect(schedule.scheduleId.length).toBeGreaterThan(0);
    expect(protocol.scheduleCreates).toHaveLength(1);
    const create = protocol.scheduleCreates.at(0);
    expect(create?.destination).toBe(DESTINATION); // the scheme LITERAL in the path
    expect(create ? JSON.parse(create.body) : undefined).toEqual({ cron: CRON, body: BODY });
  });

  it("creates without a body when none is configured (the cron alone rides the wire)", async () => {
    const { client, protocol } = makeClient();
    await client.createSchedule({ destination: DESTINATION, cron: CRON });
    const create = protocol.scheduleCreates.at(0);
    expect(create ? JSON.parse(create.body) : undefined).toEqual({ cron: CRON });
  });

  it("lists the existing schedules over the read route (the idempotent-setup read)", async () => {
    const { client, protocol } = makeClient();
    await client.createSchedule({ destination: DESTINATION, cron: CRON, body: BODY });
    const listings = await client.listSchedules();
    expect(protocol.scheduleListRequests).toBe(1);
    expect(listings).toHaveLength(1);
    expect(listings.at(0)?.destination).toBe(DESTINATION);
    expect(listings.at(0)?.cron).toBe(CRON);
  });

  it("parses list entries defensively (missing auxiliary fields never fail the read)", async () => {
    const protocol = createQStashPublishProtocol({
      token: TOKEN,
      scheduleListings: [{ scheduleId: "sch_x" }, { scheduleId: "sch_y", destination: DESTINATION, cron: CRON }],
    });
    const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    const listings = await client.listSchedules();
    expect(listings).toEqual([
      { scheduleId: "sch_x", destination: null, cron: null },
      { scheduleId: "sch_y", destination: DESTINATION, cron: CRON },
    ]);
  });

  it("maps network failure and non-2xx to the typed provider errors with suppressed text", async () => {
    const failed = makeClient({ failNext: { count: 1 } });
    const networkError = await failed.client
      .createSchedule({ destination: DESTINATION, cron: CRON })
      .catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(QStashProviderError);
    expect((networkError as QStashProviderError).phase).toBe("request-not-sent");

    const rejected = makeClient({ rejectNext: { count: 1, status: 429 } });
    const providerError = await rejected.client
      .createSchedule({ destination: DESTINATION, cron: CRON })
      .catch((e: unknown) => e);
    expect(providerError).toBeInstanceOf(QStashProviderError);
    expect((providerError as QStashProviderError).phase).toBe("provider-error");
    expect((providerError as QStashProviderError).status).toBe(429);
    expect((providerError as QStashProviderError).message).not.toContain("simulated");

    const corrupted = makeClient({ corruptNext: { count: 1 } });
    const unusableError = await corrupted.client
      .createSchedule({ destination: DESTINATION, cron: CRON })
      .catch((e: unknown) => e);
    expect(unusableError).toBeInstanceOf(QStashProviderError);
    expect((unusableError as QStashProviderError).phase).toBe("response-unusable");
  });

  it("fails closed on invalid destinations, cron expressions and oversized bodies", async () => {
    const { client } = makeClient();
    await expect(client.createSchedule({ destination: "http://insecure.example.test/x", cron: CRON })).rejects.toThrow(
      /https/i,
    );
    await expect(client.createSchedule({ destination: DESTINATION, cron: "every five minutes" })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      client.createSchedule({ destination: DESTINATION, cron: CRON, body: "x".repeat(2_048_000) }),
    ).rejects.toThrow(/bytes/);
  });

  it("validates the cron grammar bound (5 fields; the provider owns the rest)", () => {
    expect(validateCronExpression(CRON)).toBe(CRON);
    expect(() => validateCronExpression("* * * *")).toThrow(ValidationError);
    expect(() => validateCronExpression("")).toThrow(ValidationError);
  });
});

describe("InMemoryJobDeliveryQueue schedule parity (PA-025)", () => {
  const SIGNING_KEY = "schedule-fake-signing-key";

  function makeFake() {
    return new InMemoryJobDeliveryQueue({
      clock: new DeterministicClock("2026-10-01T00:00:00.000Z"),
      signingKey: SIGNING_KEY,
    });
  }

  it("creates and lists schedules deterministically with the same validation law", async () => {
    const fake = makeFake();
    const first = await fake.createSchedule({ destination: DESTINATION, cron: CRON, body: BODY });
    expect(first.scheduleId).toBe("sch-001");
    await expect(fake.createSchedule({ destination: DESTINATION, cron: "nope" })).rejects.toThrow(ValidationError);
    const listings = await fake.listSchedules();
    expect(listings).toEqual([{ scheduleId: "sch-001", destination: DESTINATION, cron: CRON }]);
  });

  it("fires schedules as SIGNED deliveries that verify under the REAL verifier", async () => {
    const fake = makeFake();
    await fake.createSchedule({ destination: DESTINATION, cron: CRON, body: BODY });

    const received: { payload: string; signatureHeader: string; sentAtMs: number }[] = [];
    const attempts = await fake.runDueSchedules(async (delivery) => {
      received.push({
        payload: delivery.payload,
        signatureHeader: delivery.signatureHeader,
        sentAtMs: delivery.sentAtMs,
      });
      return 200;
    });
    expect(attempts).toBe(1);
    expect(received).toHaveLength(1);

    // The receiver-side rigor: the schedule fire verifies for REAL.
    const verifier = new QStashSignatureVerifier({ currentSigningKey: SIGNING_KEY });
    const verification = verifier.verify({
      signatureHeader: received.at(0)?.signatureHeader,
      body: received.at(0)?.payload ?? "",
      receivedAtMs: received.at(0)?.sentAtMs ?? 0,
    });
    expect(verification.ok).toBe(true);
    expect((received.at(0)?.payload ?? "")).toBe(BODY); // the configured body, byte-exact
  });
});

describe("the runtime-clean subpath (PA-025)", () => {
  it("exposes the identical runtime surface WITHOUT the vitest-dependent contract battery", async () => {
    const runtime = await import("../src/runtime.js");
    // The runtime modules deployable hosts need (the worker-tick endpoint,
    // the setup script, the workers host):
    expect(typeof runtime.UpstashQStashClient).toBe("function");
    expect(typeof runtime.QStashSignatureVerifier).toBe("function");
    expect(typeof runtime.renderQStashSignatureHeader).toBe("function");
    expect(typeof runtime.signQStashDelivery).toBe("function");
    expect(typeof runtime.tryParseQStashEnv).toBe("function");
    expect(typeof runtime.InMemoryJobDeliveryQueue).toBe("function");
    // The TEST-plane battery stays on the ROOT export only (ADR-0003's
    // replacement-rule surface for tests) — the runtime subpath must never
    // carry it (it imports vitest and cannot load outside a test run).
    expect((runtime as Record<string, unknown>)["defineDurableJobDeliveryContract"]).toBeUndefined();
    const root = await import("../src/index.js");
    expect(typeof (root as Record<string, unknown>)["defineDurableJobDeliveryContract"]).toBe("function");
  });
});
