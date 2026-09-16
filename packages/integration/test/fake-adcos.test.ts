import { describe, expect, it } from "vitest";
import { AdcosApiError } from "@roamlink/adcos";
import { canonicalizeJson, parseIdempotencyKey, parseUtcInstant } from "@roamlink/contracts";
import { FakeAdcos } from "./fake-adcos.js";

/**
 * The ADCOS fake's own behavior knobs (spec/adcos-integration.md §10):
 * duplicates, reordering, delayed events, dropped events, transient
 * failures and canonical-state changes. No test depends on ADCOS internals -
 * only on the public AdcosClient interface.
 */
const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

let keyCounter = 0;
function makeMutation(): { request: object; mutation: { idempotencyKey: string } } {
  keyCounter += 1;
  return {
    request: {
      requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "fake-test" } }],
      validity: { start: T0, end: parseUtcInstant("2026-01-16T08:30:00.000Z") },
      termination: { actor: "customer", on_expiry: "release" },
      recorded_at: T0,
    },
    mutation: { idempotencyKey: `idem-fake-test-${keyCounter}` },
  };
}

describe("fake ADCOS: idempotency semantics (duplicates)", () => {
  it("replays the ORIGINAL response for the same key + payload", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const { request, mutation } = makeMutation();
    const first = await fake.createIntent(request as never, mutation as never);
    const second = await fake.createIntent(request as never, mutation as never);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(fake.intentCount()).toBe(1);
  });

  it("rejects the same key with a DIFFERENT payload (idempotency-conflict)", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const { request, mutation } = makeMutation();
    await fake.createIntent(request as never, mutation as never);
    const changed = {
      ...request,
      validity: { start: T0, end: parseUtcInstant("2026-01-17T08:30:00.000Z") },
    };
    await expect(fake.createIntent(changed as never, mutation as never)).rejects.toMatchObject({
      code: "idempotency-conflict",
    });
    expect(fake.intentCount()).toBe(1);
  });
});

describe("fake ADCOS: webhook delivery knobs", () => {
  it("duplicateFactor duplicates every delivery", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const { request, mutation } = makeMutation();
    await fake.createIntent(request as never, mutation as never);
    fake.webhookDelivery = { ...fake.webhookDelivery, duplicateFactor: 2 };
    expect(fake.emittedEvents().length).toBe(1);
    expect(fake.deliveries().length).toBe(2);
    expect(fake.deliveries()[0]?.event.event_id).toBe(fake.deliveries()[1]?.event.event_id);
    expect(fake.deliveries()[0]?.deliveryId).not.toBe(fake.deliveries()[1]?.deliveryId);
  });

  it("reorder reverses the delivery order while emission order stays true", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const a = makeMutation();
    const b = makeMutation();
    await fake.createIntent(a.request as never, a.mutation as never);
    await fake.createIntent(b.request as never, b.mutation as never);
    fake.webhookDelivery = { ...fake.webhookDelivery, reorder: "reverse" };
    const emission = fake.emittedEvents().map((e) => e.event.event_id);
    const delivery = fake.deliveries().map((d) => d.event.event_id);
    expect(delivery).toEqual([...emission].reverse());
  });

  it("delayed events are withheld until flushed (delayed deliveries)", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    fake.webhookDelivery = { ...fake.webhookDelivery, delayCount: 1 };
    const a = makeMutation();
    await fake.createIntent(a.request as never, a.mutation as never);
    expect(fake.emittedEvents().length).toBe(1);
    expect(fake.deliveries().length).toBe(0); // withheld
    fake.flushDelayedDeliveries();
    expect(fake.deliveries().length).toBe(1);
  });

  it("dropped events never appear in deliveries (missed webhooks)", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const a = makeMutation();
    const b = makeMutation();
    await fake.createIntent(a.request as never, a.mutation as never);
    await fake.createIntent(b.request as never, b.mutation as never);
    fake.webhookDelivery = { ...fake.webhookDelivery, dropCount: 1 };
    expect(fake.emittedEvents().length).toBe(2);
    expect(fake.deliveries().length).toBe(1);
    expect(fake.deliveries()[0]?.event.event_id).toBe(fake.emittedEvents()[1]?.event.event_id);
  });

  it("mutations emit the documented event types with canonical envelopes", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const a = makeMutation();
    const intent = await fake.createIntent(a.request as never, a.mutation as never);
    const intentId = (intent as Record<string, unknown>)["id"] as string;
    const contract = await fake.acceptOffers(
      intentId,
      { offers: [{ offer: "o" }], recorded_at: T0 },
      { idempotencyKey: parseIdempotencyKey("idem-knobs-offers") },
    );
    const contractId = (contract as Record<string, unknown>)["id"] as string;
    await fake.grantLease(contractId, { granted_at: T0 }, { idempotencyKey: parseIdempotencyKey("idem-knobs-lease") });

    const types = fake.emittedEvents().map((e) => e.event.event_type);
    expect(types).toEqual([
      "connectivity_intent.created",
      "connectivity_contract.offers_selected",
      "connectivity_lease.granted",
    ]);
    for (const record of fake.emittedEvents()) {
      expect(record.event.api_version).toBe("2.0");
      expect(record.event.environment).toBe("sandbox");
      expect(record.payload).toBe(canonicalizeJson(record.event));
    }
  });
});

describe("fake ADCOS: transient failures + canonical-state changes", () => {
  it("pre-phase injected ADCOS errors fail the call without applying", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const { request, mutation } = makeMutation();
    fake.failNext({ kind: "adcos-error", code: "store-failed" });
    await expect(fake.createIntent(request as never, mutation as never)).rejects.toBeInstanceOf(
      AdcosApiError,
    );
    expect(fake.intentCount()).toBe(0);
    // the retry (same key) succeeds and creates exactly one
    const document = await fake.createIntent(request as never, mutation as never);
    expect((document as Record<string, unknown>)["id"]).toMatch(/^intent-/);
    expect(fake.intentCount()).toBe(1);
  });

  it("post-phase transport failures apply the mutation but lose the response", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const { request, mutation } = makeMutation();
    fake.failNext({ kind: "transport", outcome: "unknown" }, { phase: "post" });
    await expect(fake.createIntent(request as never, mutation as never)).rejects.toMatchObject({
      name: "AdcosTransportError",
      outcome: "unknown",
    });
    expect(fake.intentCount()).toBe(1); // applied, response lost
  });

  it("silentStateChange mutates canonical state WITHOUT emitting events", async () => {
    const fake = new FakeAdcos();
    const probe = fake.probeRefs;
    expect(probe).not.toBeNull();
    const eventsBefore = fake.emittedEvents().length;
    const versionBefore = (await fake.getContract(probe?.contractId as string))["resource_version"];
    fake.silentStateChange(probe?.contractId as string, "EXECUTION_ACTIVE");
    const after = await fake.getContract(probe?.contractId as string);
    expect(after["state"]).toBe("EXECUTION_ACTIVE");
    expect(after["resource_version"]).toBe((versionBefore as number) + 1);
    expect(fake.emittedEvents().length).toBe(eventsBefore); // no event emitted
  });

  it("silentStateChange enforces the legal v2 transition table", () => {
    const fake = new FakeAdcos();
    const probe = fake.probeRefs;
    expect(() => fake.silentStateChange(probe?.contractId as string, "SETTLED")).toThrow(AdcosApiError);
  });

  it("disabled routes answer route-unknown (endpoint unavailability)", async () => {
    const fake = new FakeAdcos();
    fake.disableRoute("intent_get");
    await expect(fake.getIntent("intent-1")).rejects.toMatchObject({ code: "route-unknown" });
  });

  it("unknown resources answer resource-unknown", async () => {
    const fake = new FakeAdcos();
    await expect(fake.getIntent("intent-nope")).rejects.toMatchObject({ code: "resource-unknown" });
    await expect(fake.getContract("contract-nope")).rejects.toMatchObject({ code: "resource-unknown" });
    await expect(fake.getLease("lease-nope")).rejects.toMatchObject({ code: "resource-unknown" });
  });

  it("the fake honors the legal contract state machine on mutations", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const a = makeMutation();
    const intent = await fake.createIntent(a.request as never, a.mutation as never);
    const intentId = (intent as Record<string, unknown>)["id"] as string;
    const contract = await fake.acceptOffers(
      intentId,
      { offers: [{ offer: "o" }], recorded_at: T0 },
      { idempotencyKey: parseIdempotencyKey("idem-knobs-2-offers") },
    );
    const contractId = (contract as Record<string, unknown>)["id"] as string;
    await fake.terminateContract(
      contractId,
      { condition: "c", recorded_reason: "r", instant: T0 },
      { idempotencyKey: parseIdempotencyKey("idem-knobs-2-term") },
    );
    // OFFER_SELECTED -> TERMINATED was legal; a second termination is not
    await expect(
      fake.terminateContract(
        contractId,
        { condition: "c", recorded_reason: "r", instant: T0 },
        { idempotencyKey: parseIdempotencyKey("idem-knobs-2-term-2") },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});
