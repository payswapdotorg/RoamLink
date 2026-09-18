/**
 * Delivery-loop tests (RL-097): the fake models QStash's push loop
 * deterministically - delay windows, retry with exponential backoff,
 * dead-letter after the attempt budget, redrive - and deliveries are
 * SIGNED so the receiver-side verification runs for real.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { InMemoryJobDeliveryQueue } from "../src/index.js";
import { QStashSignatureVerifier } from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";
const SIGNING_KEY = "qstash-signing-key-test";
const DEST = "https://receiver.example.org/hooks/projection";

function makeQueue(maxAttempts = 3, initialBackoffMs = 1_000) {
  const clock = new DeterministicClock(START);
  const queue = new InMemoryJobDeliveryQueue({
    clock,
    signingKey: SIGNING_KEY,
    maxAttempts,
    initialBackoffMs,
  });
  return { clock, queue };
}

describe("InMemoryJobDeliveryQueue delivery loop (RL-097)", () => {
  it("delivers due jobs to the receiver with signed deliveries", async () => {
    const { queue } = makeQueue();
    await queue.enqueue({ jobId: "job-ok-1", destination: DEST, payload: { kind: "projection-refresh" } });
    const statuses: number[] = [];
    const attempts = await queue.runDueDeliveries(async (delivery) => {
      expect(delivery.destination).toBe(DEST);
      expect(delivery.attempt).toBe(1);
      expect(JSON.parse(delivery.payload)).toEqual({ kind: "projection-refresh" });
      statuses.push(200);
      return 200;
    });
    expect(attempts).toBe(1);
    expect(statuses).toEqual([200]);
    await expect(queue.job("job-ok-1")).resolves.toMatchObject({ state: "delivered", attempts: 1 });
  });

  it("holds deliveries until the deliverAfterMs window elapses", async () => {
    const { clock, queue } = makeQueue();
    await queue.enqueue({ jobId: "job-late-1", destination: DEST, payload: {}, deliverAfterMs: 5_000 });
    expect(await queue.runDueDeliveries(async () => 200)).toBe(0);
    await expect(queue.job("job-late-1")).resolves.toMatchObject({ state: "pending", attempts: 0 });
    clock.advanceBy(5_000);
    expect(await queue.runDueDeliveries(async () => 200)).toBe(1);
  });

  it("retries non-2xx receivers with exponential backoff until delivered", async () => {
    const { clock, queue } = makeQueue(3, 1_000);
    await queue.enqueue({ jobId: "job-retry-1", destination: DEST, payload: {} });
    const seenAttempts: number[] = [];
    expect(await queue.runDueDeliveries(async (d) => (seenAttempts.push(d.attempt), 500))).toBe(1);
    await expect(queue.job("job-retry-1")).resolves.toMatchObject({ state: "retrying", attempts: 1 });
    // backoff: 1000ms after attempt 1
    clock.advanceBy(999);
    expect(await queue.runDueDeliveries(async () => 200)).toBe(0);
    clock.advanceBy(1);
    expect(await queue.runDueDeliveries(async (d) => (seenAttempts.push(d.attempt), 200))).toBe(1);
    expect(seenAttempts).toEqual([1, 2]);
    await expect(queue.job("job-retry-1")).resolves.toMatchObject({ state: "delivered", attempts: 2 });
  });

  it("dead-letters after the attempt budget with the failure phase recorded", async () => {
    const { clock, queue } = makeQueue(3, 1_000);
    await queue.enqueue({ jobId: "job-dlq-1", destination: DEST, payload: {} });
    for (let i = 0; i < 3; i += 1) {
      await queue.runDueDeliveries(async () => 500);
      clock.advanceBy(10_000);
    }
    const record = await queue.job("job-dlq-1");
    expect(record).toMatchObject({ state: "dead-lettered", attempts: 3, lastErrorPhase: "receiver-status", lastReceiverStatus: 500 });
    expect(queue.deadLetters()).toHaveLength(1);
  });

  it("treats receiver exceptions as receiver-unreachable and retries", async () => {
    const { queue, clock } = makeQueue(2, 1_000);
    await queue.enqueue({ jobId: "job-unreach-1", destination: DEST, payload: {} });
    await queue.runDueDeliveries(async () => {
      throw new TypeError("ECONNREFUSED (simulated)");
    });
    await expect(queue.job("job-unreach-1")).resolves.toMatchObject({
      state: "retrying",
      attempts: 1,
      lastErrorPhase: "receiver-unreachable",
    });
    clock.advanceBy(1_000);
    await queue.runDueDeliveries(async () => 200);
    await expect(queue.job("job-unreach-1")).resolves.toMatchObject({ state: "delivered" });
  });

  it("redrives dead-lettered jobs with the attempt budget reset", async () => {
    const { clock, queue } = makeQueue(1, 1_000);
    await queue.enqueue({ jobId: "job-redrive-1", destination: DEST, payload: { kind: "notify" } });
    await queue.runDueDeliveries(async () => 503);
    await expect(queue.job("job-redrive-1")).resolves.toMatchObject({ state: "dead-lettered" });
    const receipt = await queue.redrive("job-redrive-1");
    expect(receipt.accepted).toBe(true);
    await expect(queue.job("job-redrive-1")).resolves.toMatchObject({ state: "pending", attempts: 0 });
    clock.advanceBy(1);
    await queue.runDueDeliveries(async () => 200);
    await expect(queue.job("job-redrive-1")).resolves.toMatchObject({ state: "delivered" });
    expect(queue.deadLetters()).toHaveLength(0);
  });

  it("keeps the full flow verifiable: receivers verify signatures BEFORE acting", async () => {
    const { clock, queue } = makeQueue();
    await queue.enqueue({
      jobId: "job-verify-1",
      destination: DEST,
      payload: { kind: "webhook-reconcile", eventId: "evt-1" },
    });
    const verifier = new QStashSignatureVerifier({ currentSigningKey: SIGNING_KEY });
    const verifiedBodies: string[] = [];
    await queue.runDueDeliveries(async (delivery) => {
      const verdict = verifier.verify({
        signatureHeader: delivery.signatureHeader,
        body: delivery.payload,
        receivedAtMs: delivery.sentAtMs,
      });
      if (!verdict.ok) return 401; // receiver refuses unverified jobs
      verifiedBodies.push(delivery.payload);
      return 200;
    });
    expect(verifiedBodies).toHaveLength(1);
    expect(JSON.parse(verifiedBodies[0] ?? "")).toEqual({ kind: "webhook-reconcile", eventId: "evt-1" });
    clock.advanceBy(0);
    await expect(queue.job("job-verify-1")).resolves.toMatchObject({ state: "delivered" });
  });

  it("duplicate enqueues of a live job return the same receipt without re-queuing", async () => {
    const { queue } = makeQueue();
    const first = await queue.enqueue({ jobId: "job-dup-1", destination: DEST, payload: { n: 1 } });
    const second = await queue.enqueue({ jobId: "job-dup-1", destination: DEST, payload: { n: 1 } });
    expect(second).toMatchObject({ duplicate: true, messageId: first.messageId });
    expect(await queue.runDueDeliveries(async () => 200)).toBe(1);
    // exactly one delivery attempt happened for the duplicated job
    await expect(queue.job("job-dup-1")).resolves.toMatchObject({ state: "delivered", attempts: 1 });
  });
});
