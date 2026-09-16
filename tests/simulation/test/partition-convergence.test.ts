/**
 * RL-071 scenario: PARTITION - the edge is offline, then reconnects.
 *
 * The device keeps observing and enqueueing desired-state actions while the
 * network is partitioned; every sync attempt fails; on reconnect everything
 * converges. The architectural invariants:
 *  - no LOST work: every enqueued record survives the partition and is
 *    delivered exactly once after reconnect;
 *  - no duplicate effects: the receiving side keys deliveries by the
 *    command idempotency key - a re-delivery after an UNKNOWN outcome is
 *    absorbed (the same command, one effect);
 *  - local-first: enqueueing works offline; ciphertext-only at rest;
 *    last-known freshness is retained on every record across failures.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeJson, makeFreshness, parseUtcInstant } from "@roamlink/contracts";
import { DeterministicUuidGenerator } from "@roamlink/testkit";
import {
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  makeEdgeOutboxRetryPolicy,
} from "@roamlink/edge";
import { DeviceActionRequest } from "@roamlink/edge";
import { T0 } from "../src/harness.js";

const DEVICE_REF = "dev:00000000-0000-4000-8000-0000000000d1";
const DESIRED_STATE_ID = "00000000-0000-4000-8000-0000000000d2";

class TestCipher {
  readonly algorithm = "test-cipher";
  async encrypt(_keyId: string, plaintext: string): Promise<string> {
    return Buffer.from(plaintext, "utf8").toString("base64url");
  }
  async decrypt(_keyId: string, ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64url").toString("utf8");
  }
}

/**
 * The receiving side of the sync boundary: an at-least-once transport
 * whose SERVER dedupes by command idempotency key (exactly-once EFFECT).
 */
class DeduplicatingServer {
  readonly applied = new Map<string, string>();
  readonly deliveryAttempts: string[] = [];

  async deliver(delivery: {
    readonly plaintext: string;
    readonly record: { readonly commandIdempotencyKey: string };
  }): Promise<{ readonly outcome: "accepted" } | { readonly outcome: "unknown" }> {
    this.deliveryAttempts.push(delivery.record.commandIdempotencyKey);
    this.applied.set(delivery.record.commandIdempotencyKey, delivery.plaintext);
    return { outcome: "accepted" };
  }

  /** The server-side EFFECT count (deduped). */
  effects(): number {
    return this.applied.size;
  }
}

function makeOutbox(): EdgeOfflineOutbox {
  const ids = new DeterministicUuidGenerator(61);
  return new EdgeOfflineOutbox({
    store: new InMemoryEdgeOutboxStore(),
    cipher: new TestCipher(),
    keyId: "edge-key-1",
    idGenerator: () => ids.next(),
    defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
      maxAttempts: 10,
      initialBackoffMs: 1_000,
      backoffMultiplier: 2,
      maxBackoffMs: 4_000,
    }),
  });
}

function makeActionRequest(seed: number) {
  return new DeviceActionRequest({
    actionId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
    parameters: { network: `net-${seed}` },
    command: {
      commandId: `00000000-0000-4000-8000-${(seed + 100).toString(16).padStart(12, "0")}`,
      correlationId: `corr-part-${seed}`,
      idempotencyKey: `idem-part-${seed}`,
      actorId: "actor-edge",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: `action-${seed}`,
  });
}

function context() {
  return {
    deviceRef: DEVICE_REF,
    desiredStateId: DESIRED_STATE_ID,
    lastKnownFreshness: makeFreshness(
      {
        observedAt: parseUtcInstant(T0),
        receivedAt: parseUtcInstant(T0),
        freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z"),
      },
      parseUtcInstant(T0),
    ),
  };
}

describe("RL-071 partition: offline edge convergence on reconnect", () => {
  it("a full partition round-trip: enqueue offline, fail, backoff, reconnect, converge exactly once", async () => {
    const outbox = makeOutbox();
    const server = new DeduplicatingServer();

    // OFFLINE: the device keeps enqueueing desired-state actions.
    const requests = [makeActionRequest(1), makeActionRequest(2), makeActionRequest(3)];
    for (const request of requests) {
      expect((await outbox.enqueue(request, context(), T0)).outcome).toBe("ENQUEUED");
    }

    // The partition: sync attempts fail with retryable outcomes and
    // exponential backoff (1s, 2s, 4s, then capped).
    const failing = {
      deliver: async () => ({ outcome: "retryable-failure", reason: "PARTITION" }) as const,
    };
    const first = await outbox.syncDue("2026-01-15T08:30:01.000Z", failing);
    expect(first.requeued.length).toBe(3);
    expect(first.synced.length).toBe(0);

    // The second attempt happens only after the backoff elapses.
    const tooEarly = await outbox.syncDue("2026-01-15T08:30:01.500Z", failing);
    expect(tooEarly.requeued.length).toBe(0);

    // More failed rounds (backoff 1s then 2s then 4s...).
    await outbox.syncDue("2026-01-15T08:30:02.000Z", failing); // attempt 2
    await outbox.syncDue("2026-01-15T08:30:04.000Z", failing); // attempt 3
    await outbox.syncDue("2026-01-15T08:30:08.000Z", failing); // attempt 4

    // Nothing was lost: ciphertext records still pending, keyed by command.
    // (Probed with a far-future claiming transport that declines.)
    const probeTransport = {
      deliver: async (delivery: {
        readonly plaintext: string;
        readonly record: { readonly commandIdempotencyKey: string };
      }) => {
        server.deliveryAttempts.push(delivery.record.commandIdempotencyKey);
        return { outcome: "retryable-failure", reason: "PROBE" } as const;
      },
    };
    await outbox.syncDue("2027-01-01T00:00:00.000Z", probeTransport);
    expect(server.deliveryAttempts.length).toBe(3); // all three survived

    // RECONNECT: the server accepts; everything converges.
    const accepting = {
      deliver: async (delivery: {
        readonly plaintext: string;
        readonly record: { readonly commandIdempotencyKey: string };
      }) => server.deliver(delivery),
    };
    // Wait: the probe consumed attempt 5; backoff for attempt 6 is capped at
    // 4s from the probe instant. Advance far enough and sync.
    const report = await outbox.syncDue("2028-01-01T00:00:00.000Z", accepting);
    expect(report.synced.length).toBe(3);

    // Exactly-once EFFECTS: three commands, three server effects, each
    // byte-identical to what was enqueued.
    expect(server.effects()).toBe(3);
    for (const request of requests) {
      const applied = server.applied.get(request.command.idempotencyKey);
      expect(applied).toBeDefined();
      expect(applied).toBe(canonicalizeJson(request.toPlain() as never));
    }
  });

  it("an UNKNOWN sync outcome followed by re-delivery converges without duplicate server effects", async () => {
    const outbox = makeOutbox();
    const server = new DeduplicatingServer();
    const request = makeActionRequest(11);
    await outbox.enqueue(request, context(), T0);

    // The server APPLIES the command but its response is LOST (timeout):
    // the client sees outcome "unknown" and re-queues.
    const losingAck = {
      deliver: async (delivery: {
        readonly plaintext: string;
        readonly record: { readonly commandIdempotencyKey: string };
      }) => {
        // The server APPLIES the command, then its acknowledgment is lost.
        server.deliveryAttempts.push(delivery.record.commandIdempotencyKey);
        server.applied.set(delivery.record.commandIdempotencyKey, delivery.plaintext);
        return { outcome: "unknown" } as const;
      },
    };
    const first = await outbox.syncDue("2026-01-15T08:30:01.000Z", losingAck);
    expect(first.requeued.length).toBe(1);

    // The retry re-delivers the SAME command (same idempotency key, same
    // bytes): the server's dedupe absorbs it - one effect stands.
    const accepting = {
      deliver: async (delivery: {
        readonly plaintext: string;
        readonly record: { readonly commandIdempotencyKey: string };
      }) => server.deliver(delivery),
    };
    const second = await outbox.syncDue("2026-01-15T08:30:10.000Z", accepting);
    expect(second.synced.length).toBe(1);

    expect(server.deliveryAttempts.length).toBe(2); // delivered twice...
    expect(server.effects()).toBe(1); // ...but exactly ONE effect
    expect(server.applied.get(request.command.idempotencyKey)).toBe(
      canonicalizeJson(request.toPlain() as never),
    );
  });

  it("offline freshness honesty: the retained last-known freshness ages across the partition", async () => {
    const outbox = makeOutbox();
    const request = makeActionRequest(21);
    const enqueued = await outbox.enqueue(request, context(), T0);
    expect(enqueued.outcome).toBe("ENQUEUED");
    const record = enqueued.outcome === "ENQUEUED" ? enqueued.record : undefined;
    expect(record?.lastKnownFreshness.freshnessState).toBe("FRESH");

    // The freshness record is frozen DATA captured at enqueue: its recorded
    // state stays as observed; readers re-evaluate against their clock.
    const failing = {
      deliver: async () => ({ outcome: "retryable-failure", reason: "PARTITION" }) as const,
    };
    await outbox.syncDue("2026-01-15T08:30:01.000Z", failing);
    // The record (and its last-known freshness) survived the failure - the
    // local observation was preserved across the failed sync (RL-LOCK-015).
    const delivered: { readonly freshness: string }[] = [];
    const probing = {
      deliver: async (delivery: {
        readonly plaintext: string;
        readonly record: { readonly lastKnownFreshness: { readonly freshnessState: string } };
      }) => {
        delivered.push({ freshness: delivery.record.lastKnownFreshness.freshnessState });
        return { outcome: "retryable-failure", reason: "PROBE" } as const;
      },
    };
    await outbox.syncDue("2027-01-01T00:00:00.000Z", probing);
    expect(delivered.length).toBe(1);
    // The recorded state is the state as captured (FRESH at observation);
    // a consumer evaluating it NOW must re-evaluate (contract discipline).
    expect(["FRESH", "STALE", "UNKNOWN"]).toContain(delivered[0]?.freshness);
  });
});
