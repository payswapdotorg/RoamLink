/**
 * The REUSABLE contract-test battery for the durable-jobs delivery port
 * (RL-097 / ADR-0003 migration rule): any transport implementation -
 * the in-memory fake, the Upstash QStash client, or a FUTURE replacement -
 * must pass the same enqueue/idempotency/validation battery.
 *
 * The delivery LOOP (retry/backoff/DLQ/redrive) is simulated by the fake
 * and exercised in the package tests; the transport battery pins the
 * enqueue contract every implementation shares.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@roamlink/contracts";
import type { JobEnqueueReceipt, DurableJobDeliveryPort } from "./port.js";

export interface DurableJobDeliveryContractContext {
  readonly port: DurableJobDeliveryPort;
  /**
   * True when the implementation composes (or is) the durable LEDGER and
   * therefore enforces the (jobId, payload) idempotency/conflict
   * semantics locally (the fake). Pure transports are NOT ledgers: for
   * them idempotency is carried to the provider (dedupe header) and
   * enforced by the composing ledger - those tests are skipped and the
   * wire tests prove the key is carried.
   */
  readonly ledgerBacked: boolean;
  /** Fetches the receipt previously returned for a job id (ledger-backed only). */
  readonly receiptOf: (jobId: string) => Promise<JobEnqueueReceipt | null>;
}

export function defineDurableJobDeliveryContract(
  label: string,
  createContext: () => DurableJobDeliveryContractContext,
): void {
  describe(`DurableJobDeliveryPort contract: ${label}`, () => {
    it("accepts a job and returns a receipt with a messageId", async () => {
      const { port } = createContext();
      const receipt = await port.enqueue({
        jobId: "job-accept-1",
        destination: "https://receiver.example.org/hooks/projection",
        payload: { kind: "projection-refresh", subject: "device-1" },
      });
      expect(receipt.accepted).toBe(true);
      expect(receipt.jobId).toBe("job-accept-1");
      expect(typeof receipt.messageId).toBe("string");
      expect(receipt.messageId.length).toBeGreaterThan(0);
      expect(receipt.duplicate).toBe(false);
    });

    const ledgerIt = (name: string, fn: (ctx: DurableJobDeliveryContractContext) => Promise<void>): void => {
      it(`(ledger-backed) ${name}`, async () => {
        const ctx = createContext();
        if (!ctx.ledgerBacked) {
          // Pure transports carry the idempotency key to the provider
          // (dedupe header) and compose with a durable ledger; the local
          // ledger semantics are the ledger's contract, not transport's.
          return;
        }
        await fn(ctx);
      });
    };

    ledgerIt("is idempotent per jobId: same payload -> the same receipt marked duplicate", async ({ port }) => {
      const request = {
        jobId: "job-idem-1",
        destination: "https://receiver.example.org/hooks/projection",
        payload: { kind: "projection-refresh", subject: "device-2" },
      };
      const first = await port.enqueue(request);
      const second = await port.enqueue(request);
      expect(second.messageId).toBe(first.messageId);
      expect(second.duplicate).toBe(true);
      await expect(port.enqueue({ ...request })).resolves.toMatchObject({ duplicate: true });
    });

    ledgerIt("rejects a jobId reuse with a DIFFERENT payload (typed conflict)", async ({ port }) => {
      await port.enqueue({
        jobId: "job-conflict-1",
        destination: "https://receiver.example.org/hooks/projection",
        payload: { kind: "a" },
      });
      await expect(
        port.enqueue({
          jobId: "job-conflict-1",
          destination: "https://receiver.example.org/hooks/projection",
          payload: { kind: "b" },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("honors deliverAfterMs within the bounded window", async () => {
      const { port } = createContext();
      const receipt = await port.enqueue({
        jobId: "job-delay-1",
        destination: "https://receiver.example.org/hooks/projection",
        payload: { kind: "cleanup" },
        deliverAfterMs: 1_000,
      });
      expect(receipt.deliverNotBeforeMs).toBeGreaterThan(0);
    });

    it("rejects invalid job ids, non-HTTPS destinations, oversized payloads and bad delays", async () => {
      const { port } = createContext();
      await expect(
        port.enqueue({
          jobId: "bad id!",
          destination: "https://receiver.example.org/x",
          payload: { ok: true },
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        port.enqueue({
          jobId: "job-http-1",
          destination: "http://receiver.example.org/x",
          payload: { ok: true },
        }),
      ).rejects.toThrow(/https/i);
      await expect(
        port.enqueue({
          jobId: "job-big-1",
          destination: "https://receiver.example.org/x",
          payload: { blob: "x".repeat(2_048_000) },
        }),
      ).rejects.toThrow(/payload/);
      await expect(
        port.enqueue({
          jobId: "job-neg-1",
          destination: "https://receiver.example.org/x",
          payload: { ok: true },
          deliverAfterMs: -1,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
}
