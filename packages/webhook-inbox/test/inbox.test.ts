import { describe, expect, it } from "vitest";
import { DomainError, ValidationError, canonicalizeJson, parseUtcInstant } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { DeterministicClock } from "@roamlink/testkit";
import {
  ADCOS_WEBHOOK_INBOX_REPOSITORY,
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
  applyProcessingTransition,
  parseAdmittedWebhookRecord,
  type AdcosWebhookProjector,
  type AdmittedWebhookEventView,
  type AdmittedWebhookRecord,
} from "../src/index.js";
import { Recorder } from "@roamlink/testkit";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeEventPayload,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "./fake-adcos-webhooks.js";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");
const T1 = parseUtcInstant("2026-01-15T08:31:00.000Z");

function spec(n: number, overrides?: Partial<FakeWebhookEventSpec>): FakeWebhookEventSpec {
  return {
    eventId: `evt-${n}`,
    eventType: "connectivity_contract.state_changed",
    resourceId: "contract-77",
    resourceKind: "connectivity_contract",
    resourceVersion: n,
    occurredAt: T0,
    correlationId: `corr-${n}`,
    ...overrides,
  };
}

function makeService(projector?: AdcosWebhookProjector) {
  const persistence = createInMemoryPersistence();
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({ [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET }),
  });
  const clock = new DeterministicClock(T0);
  const service = new AdcosWebhookInboxService({
    verifier,
    persistence,
    reader: persistence,
    clock,
    ...(projector !== undefined ? { projector } : {}),
  });
  return { persistence, service, clock };
}

function deliveryFor(n: number, sequence: number) {
  return fakeWebhookDelivery({
    spec: spec(n),
    deliveryId: `dlv-${n}`,
    sequence,
    receivedAt: T0,
  });
}

/** A recording projector with a programmable outcome per event id. */
class RecordingProjector implements AdcosWebhookProjector {
  readonly calls = new Recorder<AdmittedWebhookEventView>();
  #outcomeFor: (view: AdmittedWebhookEventView) => Promise<{ outcome: "APPLIED" } | { outcome: "SKIPPED"; reason: string } | { outcome: "FAILED"; reason: string }> =
    async () => ({ outcome: "APPLIED" });

  answerWith(
    handler: (view: AdmittedWebhookEventView) => Promise<{ outcome: "APPLIED" } | { outcome: "SKIPPED"; reason: string } | { outcome: "FAILED"; reason: string }>,
  ): this {
    this.#outcomeFor = handler;
    return this;
  }

  async project(admission: AdmittedWebhookEventView) {
    this.calls.record(admission);
    return this.#outcomeFor(admission);
  }
}

describe("webhook admission (RL-033 §6: receive -> authenticate -> replay check -> persist -> ack)", () => {
  it("admits a verified delivery and persists the immutable §6 record", async () => {
    const { persistence, service } = makeService();
    const result = await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    expect(result.outcome).toBe("ADMITTED");
    if (result.outcome !== "ADMITTED") return;
    expect(result.sequence).toBe(1);
    expect(result.eventId).toBe("evt-1");
    // every §6 retention field is present on the durable record
    const record: AdmittedWebhookRecord = result.record;
    expect(record.schema_version).toBe("2.0");
    expect(record.source).toBe("adcos");
    expect(record.event_id).toBe("evt-1");
    expect(record.occurred_at).toBe(T0);
    expect(record.received_at).toBe(T0);
    expect(record.delivery.key_id).toBe(TEST_SIGNING_KEY_ID);
    expect(record.delivery.algorithm).toBe("hmac-sha256");
    expect(record.delivery.sequence).toBe(1);
    expect(record.raw_payload).toBe(fakeEventPayload(spec(1)));
    expect(record.processing).toEqual({ status: "PENDING", attempts: 0 });
    // the HMAC secret never appears anywhere in the persisted record
    expect(canonicalizeJson(record as never)).not.toContain(TEST_SIGNING_SECRET);
    // committed admission log + extended record both exist
    await expect(persistence.inbox.admitted("evt-1")).resolves.toMatchObject({
      admissionState: "ADMITTED",
      sequence: 1,
    });
    const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1");
    expect(stored).not.toBeNull();
    expect(parseAdmittedWebhookRecord(stored?.value)).toMatchObject({ event_id: "evt-1" });
  });

  it("admits are acknowledged only after the durable commit", async () => {
    const { persistence, service } = makeService();
    const result = await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    expect(result.outcome).toBe("ADMITTED");
    // the reader (committed state only) already sees both writes:
    expect(await persistence.inbox.count("ADMITTED")).toBe(1);
    expect(await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).count()).toBe(1);
  });

  it("duplicate event ids are admitted ONCE (replay defense, RL-LOCK-009)", async () => {
    const { persistence, service } = makeService();
    const first = await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    const second = await service.admitDelivery({
      headers: deliveryFor(1, 2).headers, // a NEW delivery attempt of the SAME event
      payload: fakeEventPayload(spec(1)),
      receivedAt: T1,
    });
    expect(first.outcome).toBe("ADMITTED");
    expect(second.outcome).toBe("DUPLICATE");
    if (second.outcome !== "DUPLICATE") return;
    expect(second.eventId).toBe("evt-1");
    expect(second.originalSequence).toBe(1);
    // exactly ONE admitted record; the duplicate is an audit row only
    expect(await persistence.inbox.count("ADMITTED")).toBe(1);
    expect(await persistence.inbox.count("DUPLICATE")).toBe(1);
    expect(await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).count()).toBe(1);
  });

  it("rejected deliveries do NOT occupy the dedupe key (a corrected retry admits)", async () => {
    const { persistence, service } = makeService();
    // first arrival: tampered signature
    const tampered = fakeWebhookDelivery({
      spec: spec(1),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
      overrides: { tamperSignature: true },
    });
    const rejected = await service.admitDelivery({
      headers: tampered.headers,
      payload: tampered.payload,
      receivedAt: T0,
    });
    expect(rejected.outcome).toBe("REJECTED");
    if (rejected.outcome !== "REJECTED") return;
    expect(rejected.code).toBe("webhook-signature-invalid");
    expect(await persistence.inbox.count("ADMITTED")).toBe(0);
    expect(await persistence.inbox.count("REJECTED")).toBe(1);
    // the corrected retry of the SAME event id admits
    const corrected = await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    expect(corrected.outcome).toBe("ADMITTED");
    expect(await persistence.inbox.count("ADMITTED")).toBe(1);
    expect(await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).count()).toBe(1);
  });

  it("rejections are recorded with deterministic synthetic identities for garbage deliveries", async () => {
    const { persistence, service } = makeService();
    const result = await service.admitDelivery({
      headers: {},
      payload: "complete garbage",
      receivedAt: T0,
    });
    expect(result.outcome).toBe("REJECTED");
    expect(await persistence.inbox.count("REJECTED")).toBe(1);
    // deterministic: same garbage -> same synthetic id, no second audit row effect
    await service.admitDelivery({ headers: {}, payload: "complete garbage", receivedAt: T0 });
    expect(await persistence.inbox.count("REJECTED")).toBe(2); // audit rows accumulate
  });

  it("environment/version failures produce typed rejections", async () => {
    const { service } = makeService();
    const productionDelivery = fakeWebhookDelivery({
      spec: spec(1, { environment: "production" }),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const envResult = await service.admitDelivery({
      headers: productionDelivery.headers,
      payload: productionDelivery.payload,
      receivedAt: T0,
    });
    expect(envResult).toMatchObject({ outcome: "REJECTED", code: "environment-mismatch" });

    const v3Delivery = fakeWebhookDelivery({
      spec: spec(2, { apiVersion: "3.0" }),
      deliveryId: "dlv-2",
      sequence: 2,
      receivedAt: T0,
    });
    const versionResult = await service.admitDelivery({
      headers: v3Delivery.headers,
      payload: v3Delivery.payload,
      receivedAt: T0,
    });
    expect(versionResult).toMatchObject({ outcome: "REJECTED", code: "version-unsupported" });
  });

  it("stale deliveries are rejected with the replay-window code", async () => {
    const { service } = makeService();
    const stale = fakeWebhookDelivery({
      spec: spec(1),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
      overrides: { staleTimestamp: "2026-01-15T08:00:00.000Z" },
    });
    const result = await service.admitDelivery({
      headers: stale.headers,
      payload: stale.payload,
      receivedAt: T0,
    });
    expect(result).toMatchObject({ outcome: "REJECTED", code: "webhook-timestamp-stale" });
  });
});

describe("async projection (RL-033 §6: async project, deterministic + idempotent)", () => {
  it("processes admitted events in admission order and marks them PROJECTED", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    for (const n of [1, 2, 3]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    const report = await service.processPending();
    expect(report).toEqual({
      considered: 3,
      alreadyProjected: 0,
      applied: 3,
      skipped: 0,
      failed: 0,
      conflicts: 0,
    });
    expect(projector.calls.events().map((view) => view.event.event_id)).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
    expect(projector.calls.events().map((view) => view.sequence)).toEqual([1, 2, 3]);
  });

  it("reprocessing is idempotent: PROJECTED records are no-ops", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    await service.processPending();
    const second = await service.processPending();
    expect(second).toEqual({
      considered: 1,
      alreadyProjected: 1,
      applied: 0,
      skipped: 0,
      failed: 0,
      conflicts: 0,
    });
    expect(projector.calls.size()).toBe(1); // the projector ran exactly once
  });

  it("the projector sees the raw payload, its digest and the parsed event", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    await service.processPending();
    const view = projector.calls.events()[0];
    expect(view?.rawPayload).toBe(fakeEventPayload(spec(1)));
    expect(view?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(view?.event.resource_version).toBe(1);
  });

  it("projector failures mark the record FAILED and retries are counted deterministically", async () => {
    const projector = new RecordingProjector();
    const { service, persistence } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    projector.answerWith(async () => ({ outcome: "FAILED", reason: "PROJECTION_TIMEOUT" }));
    const first = await service.processPending();
    expect(first.failed).toBe(1);
    const second = await service.processPending();
    expect(second.failed).toBe(1); // retried, failed again
    expect(projector.calls.size()).toBe(2);
    // the failure is recorded with attempts + reason, never a false success
    const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1");
    const record = parseAdmittedWebhookRecord(stored?.value);
    expect(record.processing.status).toBe("FAILED");
    expect(record.processing.attempts).toBe(2);
    expect(record.processing.last_reason).toBe("FAILED_PROJECTION_TIMEOUT");
  });

  it("a FAILED record recovers on a later successful attempt", async () => {
    const projector = new RecordingProjector();
    const { service, persistence } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    projector.answerWith(async () => ({ outcome: "FAILED", reason: "TRANSIENT" }));
    await service.processPending();
    projector.answerWith(async () => ({ outcome: "APPLIED" }));
    const report = await service.processPending();
    expect(report.applied).toBe(1);
    const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1");
    const record = parseAdmittedWebhookRecord(stored?.value);
    expect(record.processing.status).toBe("PROJECTED");
    expect(record.processing.attempts).toBe(2);
  });

  it("SKIPPED outcomes are terminal PROJECTED with the skip reason retained", async () => {
    const projector = new RecordingProjector();
    const { service, persistence } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    projector.answerWith(async () => ({ outcome: "SKIPPED", reason: "OUTDATED_VERSION" }));
    const report = await service.processPending();
    expect(report.skipped).toBe(1);
    const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1");
    const record = parseAdmittedWebhookRecord(stored?.value);
    expect(record.processing.status).toBe("PROJECTED");
    expect(record.processing.last_reason).toBe("SKIPPED_OUTDATED_VERSION");
  });

  it("processPending without a projector fails loudly (never silently drops)", async () => {
    const { service } = makeService();
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    await expect(service.processPending()).rejects.toMatchObject({
      reason: "WEBHOOK_INBOX_PROJECTOR_MISSING",
    });
  });

  it("out-of-order DELIVERIES are admitted in arrival order (sequence is the ordering signal)", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    // deliver v3 first, then v1, then v2 (reordered webhook stream)
    for (const n of [3, 1, 2]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    await service.processPending();
    // the projector receives them in ADMISSION order (arrival order), with
    // the resource_version available for consumer-side ordering decisions
    expect(projector.calls.events().map((view) => view.event.resource_version)).toEqual([3, 1, 2]);
  });

  it("processing honors the limit", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    for (const n of [1, 2, 3]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    const report = await service.processPending(2);
    expect(report.considered).toBe(2);
    expect(projector.calls.size()).toBe(2);
  });
});

describe("batch progression across a backlog larger than the limit (AR-008 / RL-094)", () => {
  it("a backlog of N > limit drains to completion across ceil(N/limit) bounded calls", async () => {
    const projector = new RecordingProjector();
    const { service, persistence } = makeService(projector);
    const N = 7;
    for (let n = 1; n <= N; n += 1) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    const limit = 3;
    const calls: number[] = [];
    for (let call = 0; call < Math.ceil(N / limit); call += 1) {
      const report = await service.processPending(limit);
      calls.push(report.applied);
    }
    // 3 + 3 + 1: the drain ADVANCES every call - no record is re-considered
    // forever, no record beyond index `limit` is starved.
    expect(calls).toEqual([3, 3, 1]);
    expect(projector.calls.size()).toBe(N);
    // Every admitted record reached its terminal PROJECTED state, in
    // admission order.
    expect(projector.calls.events().map((view) => view.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let n = 1; n <= N; n += 1) {
      const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get(`evt-${n}`);
      expect(parseAdmittedWebhookRecord(stored?.value).processing.status).toBe("PROJECTED");
    }
  });

  it("terminal records do not consume batch slots: the drain advances past a processed prefix", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    for (const n of [1, 2, 3]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    await service.processPending(); // all three PROJECTED
    projector.calls.clear();
    // Two NEW arrivals join the backlog BEHIND a fully-processed prefix.
    for (const n of [4, 5]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T1,
      });
    }
    // A bounded drain processes exactly the two non-terminal records: the
    // three terminal ones are skipped (counted, not re-projected) and do
    // NOT consume the batch slots.
    const report = await service.processPending(2);
    expect(report).toEqual({
      considered: 5,
      alreadyProjected: 3,
      applied: 2,
      skipped: 0,
      failed: 0,
      conflicts: 0,
    });
    expect(projector.calls.events().map((view) => view.event.event_id)).toEqual(["evt-4", "evt-5"]);
    // Nothing left: a further bounded drain is a pure no-op.
    const idle = await service.processPending(2);
    expect(idle.applied).toBe(0);
    expect(idle.alreadyProjected).toBe(5);
    expect(projector.calls.size()).toBe(2);
  });

  it("a retried FAILED record consumes a slot (an attempt is an attempt) but does not starve later records", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    for (const n of [1, 2, 3, 4]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    // evt-1 is transiently failing; everything else applies.
    projector.answerWith(async (view) =>
      view.event.event_id === "evt-1"
        ? { outcome: "FAILED", reason: "TRANSIENT" }
        : { outcome: "APPLIED" },
    );
    const first = await service.processPending(2);
    expect(first.failed).toBe(1); // evt-1 retried
    expect(first.applied).toBe(1); // evt-2 still progressed
    const second = await service.processPending(2);
    expect(second.failed).toBe(1); // evt-1 retried again
    expect(second.applied).toBe(1); // evt-3 progressed
    // The head record never blocks the batch from advancing: after two
    // bounded calls evt-2 AND evt-3 both reached the projector.
    expect(projector.calls.filter((view) => view.event.event_id !== "evt-1").map((view) => view.event.event_id)).toEqual([
      "evt-2",
      "evt-3",
    ]);
  });

  it("admission order is preserved across batches (the ordering signal survives batch boundaries)", async () => {
    const projector = new RecordingProjector();
    const { service } = makeService(projector);
    for (const n of [1, 2, 3, 4, 5]) {
      await service.admitDelivery({
        headers: deliveryFor(n, n).headers,
        payload: fakeEventPayload(spec(n)),
        receivedAt: T0,
      });
    }
    await service.processPending(2);
    await service.processPending(2);
    await service.processPending(2);
    expect(projector.calls.events().map((view) => view.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("immutability of admitted records (RL-033)", () => {
  it("only the processing sub-object may change (applyProcessingTransition guard)", () => {
    const { service } = makeService();
    void service;
    const record: AdmittedWebhookRecord = {
      schema_version: "2.0",
      source: "adcos",
      event_id: "evt-1",
      event_type: "connectivity_contract.state_changed",
      resource_id: "contract-77",
      resource_kind: "connectivity_contract",
      resource_version: 4,
      occurred_at: T0,
      correlation_id: "corr-1",
      environment: "sandbox",
      received_at: T0,
      delivery: {
        key_id: "whk-1",
        algorithm: "hmac-sha256",
        timestamp: T0,
        delivery_id: "dlv-1",
        sequence: 1,
        signature_digest: "0".repeat(64) as never,
      },
      raw_payload: "{}",
      payload_digest: "0".repeat(64) as never,
      processing: { status: "PENDING", attempts: 0 },
    };
    const projected = applyProcessingTransition(record, {
      status: "PROJECTED",
      attempts: 1,
      projected_at: T0,
      last_reason: "APPLIED",
    });
    // admitted content is byte-identical; only processing changed
    const { processing: _p1, ...before } = record;
    const { processing: _p2, ...after } = projected;
    expect(canonicalizeJson(after)).toBe(canonicalizeJson(before));

    // PROJECTED is terminal
    expect(() =>
      applyProcessingTransition(projected, { status: "FAILED", attempts: 2 }),
    ).toThrow(DomainError);
    // illegal jump
    expect(() =>
      applyProcessingTransition(record, { status: "PROJECTED", attempts: 5 }),
    ).not.toThrow();
    expect(() =>
      applyProcessingTransition({ ...record, processing: { status: "FAILED", attempts: 3 } }, {
        status: "PENDING",
        attempts: 3,
      }),
    ).not.toThrow();
  });

  it("admitted fields never change across the full lifecycle", async () => {
    const projector = new RecordingProjector();
    const { service, persistence } = makeService(projector);
    await service.admitDelivery({
      headers: deliveryFor(1, 1).headers,
      payload: fakeEventPayload(spec(1)),
      receivedAt: T0,
    });
    const before = parseAdmittedWebhookRecord(
      (await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1"))?.value,
    );
    projector.answerWith(async () => ({ outcome: "FAILED", reason: "X" }));
    await service.processPending();
    projector.answerWith(async () => ({ outcome: "APPLIED" }));
    await service.processPending();
    const after = parseAdmittedWebhookRecord(
      (await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-1"))?.value,
    );
    const { processing: _p1, ...beforeImmutable } = before;
    const { processing: _p2, ...afterImmutable } = after;
    expect(canonicalizeJson(afterImmutable)).toBe(canonicalizeJson(beforeImmutable));
  });

  it("parseAdmittedWebhookRecord rejects unknown fields and bad processing states", () => {
    expect(() => parseAdmittedWebhookRecord({ invented: true })).toThrow(ValidationError);
    expect(() =>
      parseAdmittedWebhookRecord({
        schema_version: "2.0",
        source: "adcos",
        event_id: "evt-1",
        event_type: "connectivity_intent.created",
        resource_id: "intent-1",
        resource_kind: "connectivity_intent",
        resource_version: 1,
        occurred_at: T0,
        correlation_id: "corr-1",
        environment: "sandbox",
        received_at: T0,
        delivery: {
          key_id: "whk-1",
          algorithm: "hmac-sha256",
          timestamp: T0,
          delivery_id: "dlv-1",
          sequence: 1,
          signature_digest: "0".repeat(64),
        },
        raw_payload: "{}",
        payload_digest: "0".repeat(64),
        processing: { status: "EXPLODED", attempts: 0 },
      }),
    ).toThrow(ValidationError);
  });
});
