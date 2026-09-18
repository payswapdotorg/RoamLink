/**
 * The REUSABLE contract-test battery for the {@link EphemeralCoordinationPort}
 * (RL-096 / ADR-0003 migration rule: "A later provider replacement must
 * preserve the same contract tests").
 *
 * Any implementation - the in-memory fake, the Upstash REST client, or a
 * FUTURE replacement provider adapter - must pass the same battery. It is
 * exported from the public surface so replacement work reuses it instead
 * of writing a weaker one.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import type { EphemeralCoordinationPort } from "./port.js";

export interface EphemeralCoordinationContractContext {
  readonly port: EphemeralCoordinationPort;
  /** Advances the injected clock and reports the new instant (ISO string). */
  readonly advance: (ms: number) => void;
}

/** The full behavioral battery. Call inside a vitest `describe`. */
export function defineEphemeralCoordinationContract(
  label: string,
  createContext: () => EphemeralCoordinationContractContext,
): void {
  describe(`EphemeralCoordinationPort contract: ${label}`, () => {
    it("stores, reads and deletes a bounded value round-trip", async () => {
      const { port } = createContext();
      await expect(port.get("cache:obj-1")).resolves.toBeNull();
      await expect(port.setWithTtl("cache:obj-1", "v1", 10_000)).resolves.toEqual({ stored: true });
      await expect(port.get("cache:obj-1")).resolves.toBe("v1");
      await expect(port.delete("cache:obj-1")).resolves.toBe(true);
      await expect(port.get("cache:obj-1")).resolves.toBeNull();
      await expect(port.delete("cache:obj-1")).resolves.toBe(false);
    });

    it("expires values exactly at their TTL (clock-driven, no ambient timers)", async () => {
      const { port, advance } = createContext();
      await port.setWithTtl("cache:obj-2", "v2", 5_000);
      advance(4_999);
      await expect(port.get("cache:obj-2")).resolves.toBe("v2");
      advance(1);
      await expect(port.get("cache:obj-2")).resolves.toBeNull();
    });

    it("reports remaining TTL and null for absent keys", async () => {
      const { port, advance } = createContext();
      await expect(port.timeToLiveMs("cache:absent")).resolves.toBeNull();
      await port.setWithTtl("cache:tll", "v", 10_000);
      advance(2_500);
      await expect(port.timeToLiveMs("cache:tll")).resolves.toBeGreaterThan(0);
      await expect(port.timeToLiveMs("cache:tll")).resolves.toBeLessThanOrEqual(7_500);
      advance(7_500);
      await expect(port.timeToLiveMs("cache:tll")).resolves.toBeNull();
    });

    it("honors onlyIfAbsent (SET NX) semantics", async () => {
      const { port } = createContext();
      await expect(
        port.setWithTtl("coord:lock-1", "holder-1", 5_000, { onlyIfAbsent: true }),
      ).resolves.toEqual({ stored: true });
      await expect(
        port.setWithTtl("coord:lock-1", "holder-2", 5_000, { onlyIfAbsent: true }),
      ).resolves.toEqual({ stored: false });
      await expect(port.get("coord:lock-1")).resolves.toBe("holder-1");
    });

    it("expires coordination locks so the next holder wins", async () => {
      const { port, advance } = createContext();
      await port.setWithTtl("coord:lock-2", "holder-1", 1_000, { onlyIfAbsent: true });
      advance(1_000);
      await expect(
        port.setWithTtl("coord:lock-2", "holder-2", 1_000, { onlyIfAbsent: true }),
      ).resolves.toEqual({ stored: true });
    });

    it("increments atomically with a guaranteed TTL (bounded fixed window)", async () => {
      const { port } = createContext();
      await expect(port.incrementWithTtl("ratelimit:org-1:window", 60_000)).resolves.toEqual({
        count: 1,
        firstIncrement: true,
      });
      for (let i = 2; i <= 5; i += 1) {
        await expect(port.incrementWithTtl("ratelimit:org-1:window", 60_000)).resolves.toEqual({
          count: i,
          firstIncrement: false,
        });
      }
      // bounded: the counter carries a TTL
      const ttl = await port.timeToLiveMs("ratelimit:org-1:window");
      expect(ttl).not.toBeNull();
      expect(ttl).toBeGreaterThan(0);
    });

    it("re-bounds counters that lost their TTL (boundedness invariant)", async () => {
      const { port, advance } = createContext();
      await port.incrementWithTtl("ratelimit:org-2:window", 60_000);
      advance(60_000);
      // the expired key is gone; a new increment starts a fresh bounded window
      await expect(port.incrementWithTtl("ratelimit:org-2:window", 60_000)).resolves.toEqual({
        count: 1,
        firstIncrement: true,
      });
    });

    it("rejects invalid keys, values and TTLs (value-free errors)", async () => {
      const { port } = createContext();
      await expect(port.get("bad key!")).rejects.toThrow(ValidationError);
      await expect(port.setWithTtl("cache:k", "v", 10_000)).resolves.toEqual({ stored: true });
      await expect(port.setWithTtl("cache:k", "v", 0)).rejects.toThrow(ValidationError);
      await expect(port.incrementWithTtl("cache:k", -5)).rejects.toThrow(ValidationError);
    });

    it("answers PING true", async () => {
      const { port } = createContext();
      await expect(port.ping()).resolves.toBe(true);
    });
  });
}
