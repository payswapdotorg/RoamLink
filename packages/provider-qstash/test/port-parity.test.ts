/**
 * Port-parity contract tests (RL-097): the SAME transport battery runs
 * against the in-memory fake and the Upstash QStash client over an
 * in-memory publish-API stand-in (no network).
 */
import { describe } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { InMemoryJobDeliveryQueue, UpstashQStashClient, defineDurableJobDeliveryContract } from "../src/index.js";
import { createQStashPublishProtocol } from "./qstash-publish-protocol.js";

const START = "2026-01-15T10:00:00.000Z";
const TOKEN = "qstash-test-token-ascii_01";

describe("parity harness construction", () => {
  defineDurableJobDeliveryContract("in-memory fake queue (ledger-backed)", () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "sk-test-1" });
    return {
      port: queue,
      ledgerBacked: true,
      receiptOf: async (jobId: string) => {
        const record = await queue.job(jobId);
        return record === null
          ? null
          : {
              jobId: record.jobId,
              messageId: record.messageId,
              accepted: true,
              deliverNotBeforeMs: record.deliverNotBeforeMs,
              duplicate: false,
            };
      },
    };
  });

  defineDurableJobDeliveryContract("UpstashQStashClient over in-memory publish protocol (pure transport)", () => {
    const protocol = createQStashPublishProtocol({ token: TOKEN });
    const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    return {
      port: client,
      // The client is transport-only: (jobId, payload) idempotency is
      // enforced by the composing durable ledger; the client carries the
      // key as the Upstash-Deduplication-Id (proved in the wire tests).
      ledgerBacked: false,
      receiptOf: async () => null,
    };
  });
});
