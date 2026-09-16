/**
 * RL-042 tests: the AES-GCM payload codec and the encrypted offline
 * outbox/sync engine - ciphertext-only-at-rest proofs, dedupe, batched sync
 * with all conflict policies, replay-safe redelivery, retry exhaustion and
 * honest boundary states (RL-LOCK-014/015/016).
 */
import { describe, expect, it } from "vitest";

import {
  DeviceActionRequest,
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  createAesGcmEdgePayloadCipher,
  edgeOutboxNextDueAt,
  edgeOutboxRetryDelayMs,
  makeEdgeOutboxRetryPolicy,
  parseEdgeOutboxRecord,
} from "../src/index.js";
import type {
  EdgeSyncDelivery,
  EdgeSyncDeliveryOutcome,
  EdgeSyncTransport,
} from "../src/index.js";
import { fixtureFreshness, fixtureUtcInstant } from "@roamlink/testkit";
import { ConflictError, ValidationError } from "@roamlink/contracts";

const T0 = fixtureUtcInstant();
const KEY_ID = "edge-sync-key";
const KEY = new TextEncoder().encode("0123456789abcdef0123456789abcdef"); // 32 bytes
const PLAINTEXT_MARKER = "wifi-control-action";

function cipher() {
  return createAesGcmEdgePayloadCipher(async () => KEY);
}

function retryPolicy() {
  return makeEdgeOutboxRetryPolicy({
    maxAttempts: 3,
    initialBackoffMs: 100,
    backoffMultiplier: 2,
    maxBackoffMs: 1_000,
  });
}

function request(seed = 1): DeviceActionRequest {
  return DeviceActionRequest.fromPlain({
    actionId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control" },
    parameters: { note: PLAINTEXT_MARKER, network: "home" },
    command: {
      commandId: `00000000-0000-4000-8000-${(seed + 100).toString(16).padStart(12, "0")}`,
      correlationId: `corr-${seed}`,
      idempotencyKey: `idem-${seed}`,
      actorId: `actor-${seed}`,
      tenantId: "org:00000000-0000-4000-8000-000000000001",
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: `action-${seed}`,
  });
}

function outbox(store = new InMemoryEdgeOutboxStore()): EdgeOfflineOutbox {
  let counter = 500;
  return new EdgeOfflineOutbox({
    store,
    cipher: cipher(),
    keyId: KEY_ID,
    idGenerator: () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, "0")}`,
    defaultRetryPolicy: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_000,
    },
  });
}

function recordingTransport(
  outcomes: (index: number, delivery: EdgeSyncDelivery) => EdgeSyncDeliveryOutcome,
): EdgeSyncTransport & { deliveries: EdgeSyncDelivery[] } {
  const deliveries: EdgeSyncDelivery[] = [];
  return {
    deliveries,
    deliver: async (delivery) => {
      const index = deliveries.length;
      deliveries.push(delivery);
      return outcomes(index, delivery);
    },
  };
}

describe("payload codec (AES-256-GCM)", () => {
  it("round-trips plaintext and never echoes it in errors", async () => {
    const codec = cipher();
    const ciphertext = await codec.encrypt(KEY_ID, `{"marker":"${PLAINTEXT_MARKER}"}`);
    expect(ciphertext).not.toContain(PLAINTEXT_MARKER);
    expect(await codec.decrypt(KEY_ID, ciphertext)).toBe(`{"marker":"${PLAINTEXT_MARKER}"}`);
  });

  it("produces unique ciphertexts per encryption (random nonce) and fails closed on tamper", async () => {
    const codec = cipher();
    const first = await codec.encrypt(KEY_ID, "same-plaintext");
    const second = await codec.encrypt(KEY_ID, "same-plaintext");
    expect(first).not.toBe(second);

    const tampered = first.slice(0, -2) + (first.endsWith("A") ? "AA" : "==");
    await expect(codec.decrypt(KEY_ID, tampered)).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_DECRYPT_FAILED",
    });
    await expect(codec.decrypt(KEY_ID, "too-short")).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_DECRYPT_FAILED",
    });
    const wrongKey = createAesGcmEdgePayloadCipher(async () => new Uint8Array(32).fill(7));
    await expect(wrongKey.decrypt(KEY_ID, first)).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_DECRYPT_FAILED",
    });
  });

  it("rejects wrong-length keys and bad plaintext/keyIds at the boundary", async () => {
    const shortKey = createAesGcmEdgePayloadCipher(async () => new Uint8Array(16));
    await expect(shortKey.encrypt(KEY_ID, "x")).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_KEY_INVALID",
    });
    const codec = cipher();
    await expect(codec.encrypt(KEY_ID, "")).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_PLAINTEXT_INVALID",
    });
    await expect(codec.encrypt("", "x")).rejects.toMatchObject({
      reason: "EDGE_PAYLOAD_KEY_INVALID",
    });
  });
});

describe("retry scheduling", () => {
  it("computes exponential backoff clamped to maxBackoffMs", () => {
    const policy = retryPolicy();
    expect(edgeOutboxRetryDelayMs(policy, 1)).toBe(100);
    expect(edgeOutboxRetryDelayMs(policy, 2)).toBe(200);
    expect(edgeOutboxRetryDelayMs(policy, 3)).toBe(400);
    expect(edgeOutboxRetryDelayMs(policy, 20)).toBe(1_000);
    expect(() => edgeOutboxRetryDelayMs(policy, 0)).toThrow(/positive integer/);
  });

  it("derives next-due instants (createdAt first, backoff after attempts)", async () => {
    const store = new InMemoryEdgeOutboxStore();
    const engine = outbox(store);
    const { record } = await engine.enqueue(request(), { deviceRef: "device-1", desiredStateId: "00000000-0000-4000-8000-0000000000d1", lastKnownFreshness: fixtureFreshness() }, T0);
    expect(edgeOutboxNextDueAt(record)).toBe(T0);
    const claimed = parseEdgeOutboxRecord({ ...record, state: "in-flight", attempts: 1, lastAttemptAt: T0 });
    expect(edgeOutboxNextDueAt(claimed)).toBe(fixtureUtcInstant(100));
  });
});

describe("enqueue - ciphertext-only at rest + dedupe metadata", () => {
  it("stores ONLY ciphertext records; the plaintext never appears in persisted state", async () => {
    const store = new InMemoryEdgeOutboxStore();
    const engine = outbox(store);
    const { record } = await engine.enqueue(
      request(),
      {
        deviceRef: "device-1",
        desiredStateId: "00000000-0000-4000-8000-0000000000d1",
        lastKnownFreshness: fixtureFreshness(),
      },
      T0,
    );
    expect(record.state).toBe("pending");
    expect(record.ciphertextEnvelope.algorithm).toBe("aes-256-gcm");
    expect(record.ciphertextEnvelope.keyId).toBe(KEY_ID);
    expect(record.ciphertextEnvelope.ciphertext).not.toContain(PLAINTEXT_MARKER);
    // dedupe metadata stays in the clear (RL-LOCK-014)
    expect(record.commandIdempotencyKey).toBe("idem-1");
    expect(record.actionDedupeKey).toBe("action-1");
    expect(record.correlationId).toBe("corr-1");
    // the whole persisted store serializes without the plaintext
    const persisted = JSON.stringify(store.contents());
    expect(persisted).not.toContain(PLAINTEXT_MARKER);
    expect(persisted).not.toContain("parameters");
    // a plaintext field is not even parseable on the record contract
    expect(() =>
      parseEdgeOutboxRecord({
        ...record,
        plaintext: { anything: true },
      } as never),
    ).toThrow(/unknown field/);
  });

  it("is idempotent per command idempotency key and unique per action dedupe key", async () => {
    const engine = outbox();
    const context = {
      deviceRef: "device-1",
      desiredStateId: "00000000-0000-4000-8000-0000000000d1",
      lastKnownFreshness: fixtureFreshness(),
    };
    const first = await engine.enqueue(request(1), context, T0);
    expect(first.outcome).toBe("ENQUEUED");
    const again = await engine.enqueue(request(1), context, T0);
    expect(again.outcome).toBe("ALREADY_ENQUEUED");
    expect(again.record.outboxRecordId).toBe(first.record.outboxRecordId);

    // same idempotency key, DIFFERENT command -> typed conflict
    const differentCommand = request(2);
    const clash = DeviceActionRequest.fromPlain({
      ...request(1).toPlain(),
      command: { ...differentCommand.command.toPlain(), idempotencyKey: "idem-1" },
    });
    await expect(engine.enqueue(clash, context, T0)).rejects.toMatchObject({
      reason: "EDGE_OUTBOX_IDEMPOTENCY_CONFLICT",
    });

    // same action dedupe key under a different command -> typed conflict
    const sameAction = DeviceActionRequest.fromPlain({
      ...request(2).toPlain(),
      dedupeKey: "action-1",
    });
    await expect(engine.enqueue(sameAction, context, T0)).rejects.toMatchObject({
      reason: "EDGE_OUTBOX_ACTION_DEDUPE_CONFLICT",
    });
  });
});

describe("syncDue - accepted / retryable / unknown outcomes", () => {
  const context = {
    deviceRef: "device-1",
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    lastKnownFreshness: fixtureFreshness(),
  };

  it("delivers decrypted payloads, marks synced and reports boundary synced", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    const transport = recordingTransport(() => ({ outcome: "accepted" }));
    const report = await engine.syncDue(T0, transport, { limit: 10 });
    expect(report).toEqual({
      claimed: 1,
      synced: [record.outboxRecordId],
      requeued: [],
      deadLettered: [],
      conflicts: [],
    });
    // the transport SAW the plaintext (transiently) and it round-tripped
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0]?.plaintext).toContain(PLAINTEXT_MARKER);
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("synced");
  });

  it("re-queues retryable failures with backoff and syncs on a later run", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    let failures = 0;
    const transport = recordingTransport(() =>
      failures++ < 1 ? { outcome: "retryable-failure", reason: "SERVER_BUSY" } : { outcome: "accepted" },
    );
    const first = await engine.syncDue(T0, transport);
    expect(first.requeued).toEqual([record.outboxRecordId]);
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("pending");

    // not due before the backoff elapses
    const tooEarly = await engine.syncDue(fixtureUtcInstant(50), transport);
    expect(tooEarly.claimed).toBe(0);
    const second = await engine.syncDue(fixtureUtcInstant(150), transport);
    expect(second.synced).toEqual([record.outboxRecordId]);
    expect(transport.deliveries).toHaveLength(2);
  });

  it("dead-letters after the retry policy is exhausted (boundary degraded, never a success)", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    const transport = recordingTransport(() => ({ outcome: "retryable-failure", reason: "SERVER_BUSY" }));
    // attempt 1 at T0, attempt 2 at +100, attempt 3 (max) at +300
    await engine.syncDue(T0, transport);
    await engine.syncDue(fixtureUtcInstant(100), transport);
    const last = await engine.syncDue(fixtureUtcInstant(300), transport);
    expect(last.deadLettered).toEqual([record.outboxRecordId]);
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("degraded");
    const afterExhaustion = await engine.syncDue(fixtureUtcInstant(10_000), transport);
    expect(afterExhaustion.claimed).toBe(0); // terminal records are never re-claimed
  });

  it("treats unknown outcomes and throwing transports as retryable (suppressed reasons)", async () => {
    const engine = outbox();
    await engine.enqueue(request(1), context, T0);
    const unknown = recordingTransport(() => ({ outcome: "unknown" }));
    const first = await engine.syncDue(T0, unknown);
    expect(first.requeued).toHaveLength(1);

    const throwing = recordingTransport(() => {
      throw new Error("ECONNRESET with secret-header=do-not-leak");
    });
    const second = await engine.syncDue(fixtureUtcInstant(100), throwing);
    expect(second.requeued).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain("do-not-leak");
  });

  it("batches with a limit and validates options", async () => {
    const engine = outbox();
    for (let seed = 1; seed <= 3; seed += 1) {
      await engine.enqueue(request(seed), context, T0);
    }
    const transport = recordingTransport(() => ({ outcome: "accepted" }));
    const report = await engine.syncDue(T0, transport, { limit: 2 });
    expect(report.claimed).toBe(2);
    expect(transport.deliveries).toHaveLength(2);
    const rest = await engine.syncDue(T0, transport, { limit: 2 });
    expect(rest.claimed).toBe(1);
    await expect(engine.syncDue(T0, transport, { limit: 0 } as never)).rejects.toThrow(/limit/);
    await expect(
      engine.syncDue(T0, transport, { conflictPolicy: "coin-flip" } as never),
    ).rejects.toThrow(/conflict policy/);
  });
});

describe("syncDue - conflict policies", () => {
  const context = {
    deviceRef: "device-1",
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    lastKnownFreshness: fixtureFreshness(),
  };

  it("server-wins discharges the obligation and records the divergence", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    const transport = recordingTransport(() => ({
      outcome: "conflict",
      detail: "desired state superseded server-side",
    }));
    const report = await engine.syncDue(T0, transport, { conflictPolicy: "server-wins" });
    expect(report.conflicts).toEqual([{ recordId: record.outboxRecordId, policy: "server-wins" }]);
    expect(report.synced).toEqual([record.outboxRecordId]);
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("synced");
    expect(engine.conflictDetail(record.outboxRecordId)).toMatchObject({ resolvedAs: "server" });
  });

  it("local-wins re-queues and eventually syncs when the server accepts", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    let conflicts = 0;
    const transport = recordingTransport(() =>
      conflicts++ < 1 ? { outcome: "conflict" } : { outcome: "accepted" },
    );
    const first = await engine.syncDue(T0, transport, { conflictPolicy: "local-wins" });
    expect(first.conflicts).toHaveLength(1);
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("pending");
    const second = await engine.syncDue(fixtureUtcInstant(100), transport, {
      conflictPolicy: "local-wins",
    });
    expect(second.synced).toEqual([record.outboxRecordId]);
    expect(engine.conflictDetail(record.outboxRecordId)).toMatchObject({ resolvedAs: "local" });
  });

  it("require-manual parks the record in the conflict boundary state until resolved", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    const transport = recordingTransport(() => ({ outcome: "conflict" }));
    await engine.syncDue(T0, transport); // default policy: require-manual
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("conflict");
    expect(engine.conflictDetail(record.outboxRecordId)).toMatchObject({ resolvedAs: null });

    // parked records are NOT claimable while the conflict is unresolved
    const parkedRun = await engine.syncDue(fixtureUtcInstant(10_000), transport);
    expect(parkedRun.claimed).toBe(0);

    // accept-server resolves to synced
    const resolved = await engine.resolveConflict(record.outboxRecordId, "accept-server", T0);
    expect(resolved.state).toBe("synced");
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("synced");
    expect(engine.conflictDetail(record.outboxRecordId)).toMatchObject({
      resolvedAs: "manual-server",
    });
    await expect(
      engine.resolveConflict(record.outboxRecordId, "accept-server", T0),
    ).rejects.toMatchObject({ reason: "EDGE_SYNC_CONFLICT_ALREADY_RESOLVED" });
  });

  it("force-local re-queues with a fresh retry budget", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    const conflictTransport = recordingTransport(() => ({ outcome: "conflict" }));
    await engine.syncDue(T0, conflictTransport);
    const redelivered = await engine.resolveConflict(record.outboxRecordId, "force-local", T0);
    expect(redelivered.state).toBe("pending");
    expect(redelivered.attempts).toBe(0);
    expect(redelivered.lastAttemptAt).toBeNull();
    await expect(engine.boundaryState(record.outboxRecordId)).resolves.toBe("pending");
    const accepting = recordingTransport(() => ({ outcome: "accepted" }));
    const report = await engine.syncDue(T0, accepting);
    expect(report.synced).toEqual([record.outboxRecordId]);
    expect(engine.conflictDetail(record.outboxRecordId)).toMatchObject({ resolvedAs: "manual-local" });
  });

  it("rejects resolutions without a conflict and validates the vocabulary", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), context, T0);
    await expect(
      engine.resolveConflict(record.outboxRecordId, "force-local", T0),
    ).rejects.toMatchObject({ reason: "EDGE_SYNC_NO_CONFLICT" });
    await expect(
      engine.resolveConflict("00000000-0000-4000-8000-00000000dead", "force-local", T0),
    ).rejects.toBeInstanceOf(ConflictError);
    const transport = recordingTransport(() => ({ outcome: "conflict" }));
    await engine.syncDue(T0, transport);
    await expect(
      engine.resolveConflict(record.outboxRecordId, "coin-flip" as never, T0),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("replay-safe redelivery (crash recovery)", () => {
  const context = {
    deviceRef: "device-1",
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    lastKnownFreshness: fixtureFreshness(),
  };

  it("recovers in-flight records to pending; redelivery is at-least-once and idempotent", async () => {
    const store = new InMemoryEdgeOutboxStore();
    const engine = outbox(store);
    const { record } = await engine.enqueue(request(1), context, T0);

    // simulate a crash mid-delivery: the transport received the payload but
    // the engine never recorded the outcome (record stays in-flight)
    const crashing = recordingTransport(() => {
      throw new Error("process died");
    });
    // a throwing transport still re-queues... to simulate a TRUE crash we
    // claim manually through the public scheduling seam instead:
    const firstAttempt = await engine.syncDue(T0, crashing);
    expect(firstAttempt.requeued).toEqual([record.outboxRecordId]);

    // force an in-flight record through the pure transition to simulate the
    // crash window (engine had claimed, transport delivered, process died):
    const claimed = parseEdgeOutboxRecord({
      ...record,
      state: "in-flight",
      attempts: 1,
      lastAttemptAt: T0,
    });
    await store.save(claimed);
    const recovered = await engine.recoverInFlight(fixtureUtcInstant(50));
    expect(recovered).toHaveLength(1);
    const afterRecovery = await store.get(record.outboxRecordId);
    expect(afterRecovery?.state).toBe("pending");

    // the redelivered command carries the SAME idempotency key: the server
    // dedupes, and the record syncs exactly once. The crashed attempt left
    // attempts=1 with lastAttemptAt=T0, so redelivery becomes due at +100ms.
    const deliveries: string[] = [];
    const transport: EdgeSyncTransport = {
      deliver: async (delivery) => {
        deliveries.push(delivery.plaintext);
        return { outcome: "accepted" };
      },
    };
    const report = await engine.syncDue(fixtureUtcInstant(150), transport);
    expect(report.synced).toEqual([record.outboxRecordId]);
    expect(deliveries).toHaveLength(1);
    const idempotencyKeys = deliveries.map((plaintext) =>
      (JSON.parse(plaintext) as { command: { idempotencyKey: string } }).command.idempotencyKey,
    );
    expect(idempotencyKeys).toEqual(["idem-1"]);
  });
});

describe("freshness refresh + misc", () => {
  it("refreshes last-known freshness on non-terminal records only", async () => {
    const engine = outbox();
    const { record } = await engine.enqueue(request(1), {
      deviceRef: "device-1",
      desiredStateId: "00000000-0000-4000-8000-0000000000d1",
      lastKnownFreshness: fixtureFreshness(),
    }, T0);
    const refreshed = await engine.refreshFreshness(record.outboxRecordId, fixtureFreshness({ freshUntil: fixtureUtcInstant(120_000) }));
    expect(refreshed.lastKnownFreshness.freshUntil).toBe(fixtureUtcInstant(120_000));

    const transport = recordingTransport(() => ({ outcome: "accepted" }));
    await engine.syncDue(T0, transport);
    await expect(
      engine.refreshFreshness(record.outboxRecordId, fixtureFreshness()),
    ).rejects.toMatchObject({ reason: "EDGE_OUTBOX_TERMINAL" });
    await expect(engine.boundaryState("00000000-0000-4000-8000-00000000dead")).resolves.toBeNull();
  });
});
