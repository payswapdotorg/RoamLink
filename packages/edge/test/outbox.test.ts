import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";
import {
  EDGE_OUTBOX_RECORD_STATES,
  makeEdgeOutboxRetryPolicy,
  parseEdgeOutboxCiphertextEnvelope,
  parseEdgeOutboxRecord,
  parseEdgeOutboxRecordState,
} from "../src/index.js";
import { freshnessFixture } from "./helpers.js";

const DEFAULT_POLICY = {
  maxAttempts: 5,
  initialBackoffMs: 1_000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
};

function recordInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    outboxRecordId: "00000000-0000-4000-8000-0000000000e1",
    contractVersion: "0.1",
    deviceRef: "device-enrollment-ref-1",
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    actionDedupeKey: "action-dedupe-1",
    commandIdempotencyKey: "idem-1",
    commandId: "00000000-0000-4000-8000-0000000000c1",
    correlationId: "corr-1",
    ciphertextEnvelope: {
      algorithm: "aes-256-gcm",
      keyId: "edge-outbox-key-2026-01",
      ciphertext: "c29tZWNpcGhlcnRleHQ", // base64url("someciphertext")
    },
    state: "pending",
    retryPolicy: { ...DEFAULT_POLICY },
    attempts: 0,
    lastAttemptAt: null,
    createdAt: fixtureUtcInstant(),
    lastKnownFreshness: freshnessFixture(),
    ...overrides,
  };
}

describe("closed outbox state vocabulary", () => {
  it("is exactly pending / in-flight / synced / dead-lettered", () => {
    expect([...EDGE_OUTBOX_RECORD_STATES]).toEqual([
      "pending",
      "in-flight",
      "synced",
      "dead-lettered",
    ]);
    for (const state of EDGE_OUTBOX_RECORD_STATES) {
      expect(parseEdgeOutboxRecordState(state)).toBe(state);
    }
    for (const bad of ["delivered", "failed", "", 3, null]) {
      expect(() => parseEdgeOutboxRecordState(bad)).toThrowError(/outbox state vocabulary/);
    }
  });
});

describe("ciphertext envelope (RL-LOCK-015/016)", () => {
  it("parses a valid envelope: algorithm id + key REFERENCE + base64url ciphertext", () => {
    const envelope = parseEdgeOutboxCiphertextEnvelope({
      algorithm: "aes-256-gcm",
      keyId: "edge-outbox-key-2026-01",
      ciphertext: "c29tZWNpcGhlcnRleHQ",
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(envelope.keyId).toBe("edge-outbox-key-2026-01");
  });

  it("rejects non-base64url ciphertext, unsafe labels and unknown fields", () => {
    expect(() =>
      parseEdgeOutboxCiphertextEnvelope({
        algorithm: "aes-256-gcm",
        keyId: "k1",
        ciphertext: "not base64!!",
      }),
    ).toThrowError(/base64url/);
    expect(() =>
      parseEdgeOutboxCiphertextEnvelope({
        algorithm: "aes 256",
        keyId: "k1",
        ciphertext: "c29tZQ",
      }),
    ).toThrowError(/algorithm/);
    expect(() =>
      parseEdgeOutboxCiphertextEnvelope({
        algorithm: "aes-256-gcm",
        keyId: "key with spaces",
        ciphertext: "c29tZQ",
      }),
    ).toThrowError(/keyId/);
    expect(() =>
      parseEdgeOutboxCiphertextEnvelope({
        algorithm: "aes-256-gcm",
        keyId: "k1",
        ciphertext: "c29tZQ",
        plaintext: "SELECT *", // smuggled plaintext field
      }),
    ).toThrowError(/unknown field/);
    expect(() =>
      parseEdgeOutboxCiphertextEnvelope({
        algorithm: "aes-256-gcm",
        keyId: "k1",
        ciphertext: "x".repeat(8193),
      }),
    ).toThrowError(/8192/);
  });
});

describe("retry policy", () => {
  it("accepts a bounded policy and freezes it", () => {
    const policy = makeEdgeOutboxRetryPolicy({ ...DEFAULT_POLICY });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.maxAttempts).toBe(5);
  });

  it("rejects out-of-bounds values", () => {
    expect(() =>
      makeEdgeOutboxRetryPolicy({ ...DEFAULT_POLICY, maxAttempts: 0 }),
    ).toThrowError(/maxAttempts/);
    expect(() =>
      makeEdgeOutboxRetryPolicy({ ...DEFAULT_POLICY, backoffMultiplier: 0.5 }),
    ).toThrowError(/backoffMultiplier/);
    expect(() =>
      makeEdgeOutboxRetryPolicy({ ...DEFAULT_POLICY, maxBackoffMs: 500 }),
    ).toThrowError(/maxBackoffMs/); // below initialBackoffMs
    expect(() =>
      makeEdgeOutboxRetryPolicy({ ...DEFAULT_POLICY, initialBackoffMs: 0 }),
    ).toThrowError(/initialBackoffMs/);
  });
});

describe("parseEdgeOutboxRecord", () => {
  it("parses a valid pending record and freezes it", () => {
    const record = parseEdgeOutboxRecord(recordInput());
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.state).toBe("pending");
    expect(record.attempts).toBe(0);
    expect(record.lastAttemptAt).toBeNull();
    expect(record.actionDedupeKey).toBe("action-dedupe-1");
    expect(record.commandIdempotencyKey).toBe("idem-1");
    expect(record.lastKnownFreshness.freshnessState).toBe("FRESH");
  });

  it("round-trips through JSON", () => {
    const record = parseEdgeOutboxRecord(recordInput());
    const restored = parseEdgeOutboxRecord(JSON.parse(JSON.stringify(record)));
    expect(restored).toEqual(record);
  });

  it("rejects a plaintext command envelope field - the payload is ciphertext-only", () => {
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ command: { commandId: "00000000-0000-4000-8000-0000000000c1" } })),
    ).toThrowError(/unknown field/);
    expect(() => parseEdgeOutboxRecord(recordInput({ parameters: { ssid: "Guest" } }))).toThrowError(
      /unknown field/,
    );
  });

  it("rejects attempts beyond the retry policy maximum", () => {
    expect(() => parseEdgeOutboxRecord(recordInput({ attempts: 6 }))).toThrowError(
      /between 0 and the retry policy's maxAttempts/,
    );
  });

  it("enforces state invariants across the lifecycle", () => {
    const attemptTime = fixtureUtcInstant(1_000);
    // pending with prior attempts must carry a lastAttemptAt
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ attempts: 2, lastAttemptAt: null })),
    ).toThrowError(/must carry a lastAttemptAt/);
    // pending with zero attempts must NOT carry one
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ attempts: 0, lastAttemptAt: attemptTime })),
    ).toThrowError(/must not carry a lastAttemptAt/);
    // in-flight requires >= 1 started attempt
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ state: "in-flight", attempts: 0, lastAttemptAt: null })),
    ).toThrowError(/in-flight record must have at least one started attempt/);
    // synced requires at least one attempt
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ state: "synced", attempts: 0, lastAttemptAt: null })),
    ).toThrowError(/synced record must have at least one attempt/);
    // valid in-flight
    expect(
      parseEdgeOutboxRecord(
        recordInput({ state: "in-flight", attempts: 1, lastAttemptAt: attemptTime }),
      ).state,
    ).toBe("in-flight");
    // valid synced
    expect(
      parseEdgeOutboxRecord(
        recordInput({ state: "synced", attempts: 1, lastAttemptAt: attemptTime }),
      ).state,
    ).toBe("synced");
  });

  it("dead-lettering is ONLY allowed after the retry policy is exhausted", () => {
    const attemptTime = fixtureUtcInstant(9_000);
    // attempts below max: rejected
    expect(() =>
      parseEdgeOutboxRecord(
        recordInput({ state: "dead-lettered", attempts: 3, lastAttemptAt: attemptTime }),
      ),
    ).toThrowError(/must have exhausted the retry policy/);
    // exhausted: accepted
    const deadLetter = parseEdgeOutboxRecord(
      recordInput({ state: "dead-lettered", attempts: 5, lastAttemptAt: attemptTime }),
    );
    expect(deadLetter.state).toBe("dead-lettered");
    expect(deadLetter.attempts).toBe(deadLetter.retryPolicy.maxAttempts);
  });

  it("validates ids, dedupe keys, versions and freshness", () => {
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ outboxRecordId: "nope" })),
    ).toThrowError(/outboxRecordId/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ commandId: "nope" })),
    ).toThrowError(/commandId/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ actionDedupeKey: "bad key" })),
    ).toThrowError(/actionDedupeKey/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ correlationId: "bad key" })),
    ).toThrowError(/correlationId/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ contractVersion: "0.2" })),
    ).toThrowError(/contractVersion/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ lastKnownFreshness: { nope: 1 } })),
    ).toThrowError(/lastKnownFreshness/);
    expect(() =>
      parseEdgeOutboxRecord(recordInput({ createdAt: "yesterday" })),
    ).toThrowError(/createdAt/);
  });

  it("rejects a broken ciphertext envelope (no plaintext fallback exists)", () => {
    expect(() =>
      parseEdgeOutboxRecord(
        recordInput({ ciphertextEnvelope: { algorithm: "aes-256-gcm", keyId: "k1", ciphertext: "!!" } }),
      ),
    ).toThrowError(/ciphertextEnvelope/);
  });
});
