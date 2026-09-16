/**
 * RL-LOCK-015 conformance suite: offline/local-first degradation.
 *
 * Edge operation must preserve local observations and desired state while
 * offline and converge when connectivity returns.
 *
 * GREEN PROOFS (a full deterministic offline round-trip):
 *  - enqueue works while offline (local-first: no transport involved);
 *  - payloads are CIPHERTEXT-ONLY at rest (plaintext never persisted);
 *  - a failing sync requeues with backoff and LOSES NOTHING (the record,
 *    its command identity and its last-known freshness survive);
 *  - after the transport recovers, every record syncs EXACTLY ONCE and the
 *    delivered plaintext equals the enqueued command byte-for-byte
 *    (convergence without duplication or corruption);
 *  - re-enqueuing the same command while offline is idempotent
 *    (ALREADY_ENQUEUED - no duplicate effect);
 *  - last-known freshness is retained on the record (the local view of
 *    observed truth survives the partition).
 *
 * NEGATIVE PROOF (red-on-violation): the toggle flips the convergence
 * expectation - a tree that LOST or DUPLICATED offline work would fail
 * the green proofs and satisfy the toggled assertion.
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
import { Recorder } from "@roamlink/testkit";
import { violationEnabled } from "../src/index.js";

const LOCK = "RL-LOCK-015";
const T0 = "2026-01-15T08:30:00.000Z";
const DEVICE_REF = "dev:00000000-0000-4000-8000-000000000201";
const DESIRED_STATE_ID = "00000000-0000-4000-8000-000000000202";
const KEY_ID = "edge-key-1";

/** Deterministic, INSECURE test cipher: base64url "encryption" (test-only). */
class TestCipher {
  readonly algorithm = "test-cipher";
  async encrypt(_keyId: string, plaintext: string): Promise<string> {
    return Buffer.from(plaintext, "utf8").toString("base64url");
  }
  async decrypt(_keyId: string, ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64url").toString("utf8");
  }
}

function makeOutbox(): EdgeOfflineOutbox {
  const store = new InMemoryEdgeOutboxStore();
  const ids = new DeterministicUuidGenerator(5_000);
  return new EdgeOfflineOutbox({
    store,
    cipher: new TestCipher(),
    keyId: KEY_ID,
    idGenerator: () => ids.next(),
    defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      backoffMultiplier: 2,
      maxBackoffMs: 60_000,
    }),
  });
}

function makeActionRequest(seed: number): DeviceActionRequest {
  return new DeviceActionRequest({
    actionId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
    parameters: { network: `net-${seed}` },
    command: {
      commandId: `00000000-0000-4000-8000-${(seed + 100).toString(16).padStart(12, "0")}`,
      correlationId: `corr-edge-${seed}`,
      idempotencyKey: `idem-edge-${seed}`,
      actorId: "actor-edge",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: `action-${seed}`,
  });
}

function enqueueContext() {
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

describe(`${LOCK}: offline/local-first degradation`, () => {
  it("green: enqueue works offline; ciphertext-only at rest; nothing is lost across a partition", async () => {
    const outbox = makeOutbox();
    const first = await outbox.enqueue(makeActionRequest(1), enqueueContext(), T0);
    expect(first.outcome).toBe("ENQUEUED");

    // Ciphertext-only at rest: the stored record carries a ciphertext
    // envelope whose ciphertext does NOT contain the plaintext payload.
    const record = first.outcome === "ENQUEUED" ? first.record : undefined;
    expect(record).toBeDefined();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('"network":"net-1"');
    expect(record?.ciphertextEnvelope.keyId).toBe(KEY_ID);

    // A failing transport: syncDue requeues with backoff, loses nothing.
    const failing = {
      deliver: async () => ({ outcome: "retryable-failure", reason: "OFFLINE" }) as const,
    };
    const report = await outbox.syncDue("2026-01-15T08:30:01.000Z", failing);
    expect(report.requeued.length).toBe(1);
    expect(report.synced.length).toBe(0);

    // The record survived the failed attempt, still keyed by its command.
    const surviving = await listPending(outbox);
    expect(surviving.length).toBe(1);
    expect(surviving[0]?.commandIdempotencyKey).toBe("idem-edge-1");
    expect(surviving[0]?.lastKnownFreshness.freshnessState).toBe("FRESH");
  });

  it("green: convergence on reconnect - exactly-once delivery, byte-identical plaintext", async () => {
    const outbox = makeOutbox();
    const requests = [makeActionRequest(1), makeActionRequest(2)];
    for (const request of requests) {
      await outbox.enqueue(request, enqueueContext(), T0);
    }

    // Partition: all deliveries fail; backoff pushes the next attempt out.
    const failing = {
      deliver: async () => ({ outcome: "retryable-failure", reason: "OFFLINE" }) as const,
    };
    await outbox.syncDue("2026-01-15T08:30:01.000Z", failing);
    // Still offline, BEFORE the 1s backoff elapses: nothing re-attempted.
    const early = await outbox.syncDue("2026-01-15T08:30:01.500Z", failing);
    expect(early.requeued.length).toBe(0);

    // Reconnect after backoff: the transport accepts; both deliver exactly once.
    const delivered = new Recorder<{ readonly plaintext: string; readonly key: string }>();
    const accepting = {
      deliver: async (delivery: { readonly plaintext: string; readonly record: { readonly commandIdempotencyKey: string } }) => {
        delivered.record({ plaintext: delivery.plaintext, key: delivery.record.commandIdempotencyKey });
        return { outcome: "accepted" } as const;
      },
    };
    const report = await outbox.syncDue("2026-01-15T08:31:02.000Z", accepting);
    expect(report.synced.length).toBe(2);

    // Exactly-once, byte-identical convergence.
    expect(delivered.size()).toBe(2);
    const keys = delivered.events().map((event) => event.key).sort();
    expect(keys).toEqual(["idem-edge-1", "idem-edge-2"]);
    for (const request of requests) {
      const deliveredPlaintext = delivered
        .events()
        .find((event) => event.key === request.command.idempotencyKey)?.plaintext;
      expect(deliveredPlaintext).toBeDefined();
      expect(deliveredPlaintext).toBe(canonicalizeJson(request.toPlain() as never));
    }

    // Nothing remains pending after convergence.
    expect(await listPending(outbox)).toEqual([]);
  });

  it("green: duplicate enqueue of the same command while offline is idempotent", async () => {
    const outbox = makeOutbox();
    const request = makeActionRequest(3);
    const first = await outbox.enqueue(request, enqueueContext(), T0);
    expect(first.outcome).toBe("ENQUEUED");
    const second = await outbox.enqueue(request, enqueueContext(), "2026-01-15T08:30:05.000Z");
    expect(second.outcome).toBe("ALREADY_ENQUEUED");
    expect(await listPending(outbox)).toHaveLength(1);
  });

  it("negative proof: lost offline work is a violation (red when work is lost)", async () => {
    const outbox = makeOutbox();
    const request = makeActionRequest(4);
    const enqueued = await outbox.enqueue(request, enqueueContext(), T0);
    expect(enqueued.outcome).toBe("ENQUEUED");

    const failing = {
      deliver: async () => ({ outcome: "retryable-failure", reason: "OFFLINE" }) as const,
    };
    await outbox.syncDue("2026-01-15T08:30:01.000Z", failing);
    const pending = await listPending(outbox);
    if (violationEnabled(LOCK)) {
      // The violating fixture asserts the work was lost.
      expect(pending.length).toBe(0);
    } else {
      expect(pending.length).toBe(1);
      expect(pending[0]?.commandIdempotencyKey).toBe("idem-edge-4");
    }
  });
});

async function listPending(outbox: EdgeOfflineOutbox): Promise<readonly { readonly commandIdempotencyKey: string; readonly lastKnownFreshness: { readonly freshnessState: string } }[]> {
  // The outbox store is not directly exposed; pending visibility comes
  // through syncDue claims. We probe with an accepting recorder transport.
  const probed: { commandIdempotencyKey: string; lastKnownFreshness: { freshnessState: string } }[] = [];
  const probing = {
    deliver: async (delivery: {
      readonly plaintext: string;
      readonly record: {
        readonly commandIdempotencyKey: string;
        readonly lastKnownFreshness: { readonly freshnessState: string };
      };
    }) => {
      probed.push({
        commandIdempotencyKey: delivery.record.commandIdempotencyKey,
        lastKnownFreshness: delivery.record.lastKnownFreshness,
      });
      // Fail everything so nothing completes: a pure probe.
      return { outcome: "retryable-failure", reason: "PROBE" } as const;
    },
  };
  // Force attempts to be due: claim at a far-future instant (backoff long
  // elapsed) - due records are claimed regardless of backoff then.
  await outbox.syncDue("2027-01-15T08:30:00.000Z", probing);
  return probed;
}
