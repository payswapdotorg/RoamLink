/**
 * The REUSABLE contract-test battery for the {@link ObjectStoragePort}
 * (RL-098 / ADR-0003 migration rule): the in-memory fake, the
 * S3-compatible R2 client (over a SigV4-validating in-memory server), and
 * any FUTURE replacement provider must all pass this same battery.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import type { ObjectStoragePort } from "./port.js";

export interface ObjectStorageContractContext {
  readonly port: ObjectStoragePort;
  /** The implementation's object-size admission bound (oversize test uses it). */
  readonly maxObjectBytes: number;
}

export function defineObjectStorageContract(
  label: string,
  createContext: () => ObjectStorageContractContext,
): void {
  describe(`ObjectStoragePort contract: ${label}`, () => {
    it("puts, gets and deletes a round-trip (bytes preserved, etag stable)", async () => {
      const { port } = createContext();
      const body = Buffer.from("diagnostic export payload", "utf8");
      const put = await port.put({
        key: "exports/org-1/2026/01/abcdef0123456789-export.json",
        body,
        contentType: "application/json",
      });
      expect(put.sizeBytes).toBe(body.byteLength);
      expect(put.etag).toMatch(/^[0-9a-f]{64}$/);
      const fetched = await port.get("exports/org-1/2026/01/abcdef0123456789-export.json");
      expect(fetched).not.toBeNull();
      expect(Buffer.from(fetched?.body ?? new Uint8Array()).toString("utf8")).toBe("diagnostic export payload");
      expect(fetched?.contentType).toBe("application/json");
      expect(fetched?.etag).toBe(put.etag);
      await expect(port.delete("exports/org-1/2026/01/abcdef0123456789-export.json")).resolves.toBe(true);
      await expect(port.get("exports/org-1/2026/01/abcdef0123456789-export.json")).resolves.toBeNull();
      await expect(port.delete("exports/org-1/2026/01/abcdef0123456789-export.json")).resolves.toBe(false);
    });

    it("answers get() of an absent object with null (absence is a state)", async () => {
      const { port } = createContext();
      await expect(port.get("exports/org-1/2026/01/0000000000000000-absent.json")).resolves.toBeNull();
    });

    it("re-uploading identical content overwrites idempotently (content addressing)", async () => {
      const { port } = createContext();
      const key = "attachments/org-1/2026/01/1111111111111111-report.pdf";
      const first = await port.put({ key, body: "v1" });
      const second = await port.put({ key, body: "v1" });
      expect(second.etag).toBe(first.etag);
      const replaced = await port.put({ key, body: "v2" });
      expect(replaced.etag).not.toBe(first.etag);
      const fetched = await port.get(key);
      expect(Buffer.from(fetched?.body ?? new Uint8Array()).toString("utf8")).toBe("v2");
    });

    it("lists with prefix and bounded pages", async () => {
      const { port } = createContext();
      const prefix = "exports/org-9/2026/02/";
      const keys = [0, 1, 2].map((i) => `${prefix}aaaaaaaaaaaaaaaa000${i}-part.json`).sort();
      for (const key of keys) {
        await port.put({ key, body: `content-${key.slice(-6)}` });
      }
      await port.put({ key: "attachments/org-9/2026/02/bbbbbbbbbbbbbbbb-other.json", body: "other" });
      const page1 = await port.list({ prefix, maxKeys: 2 });
      expect(page1.keys.map((entry) => entry.key)).toEqual(keys.slice(0, 2));
      expect(page1.truncated).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await port.list({ prefix, maxKeys: 2, ...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}) });
      expect(page2.keys.map((entry) => entry.key)).toEqual([keys[2]]);
      expect(page2.truncated).toBe(false);
      // prefix isolation: the attachment namespace never leaks in
      expect(page1.keys.every((entry) => entry.key.startsWith(prefix))).toBe(true);
    });

    it("presigns bounded-time URLs for get and put", async () => {
      const { port } = createContext();
      for (const operation of ["get", "put"] as const) {
        const url = await port.presign({
          key: "exports/org-1/2026/01/2222222222222222-report.pdf",
          operation,
          expiresInMs: 60_000,
        });
        expect(url.protocol).toBe("https:");
        expect(url.searchParams.get("X-Amz-Expires") ?? url.searchParams.get("expiresIn")).not.toBeNull();
      }
      await expect(
        port.presign({
          key: "exports/org-1/2026/01/2222222222222222-report.pdf",
          operation: "get",
          expiresInMs: 0,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid keys (convention + traversal) and oversized bodies", async () => {
      const { port, maxObjectBytes } = createContext();
      await expect(port.put({ key: "Not-Conventional", body: "x" })).rejects.toThrow(ValidationError);
      await expect(port.put({ key: "exports/../secret.txt", body: "x" })).rejects.toThrow(ValidationError);
      await expect(port.get("bad key")).rejects.toThrow(ValidationError);
      await expect(
        port.put({ key: "exports/org-1/2026/01/3333333333333333-huge.bin", body: "x".repeat(maxObjectBytes + 1) }),
      ).rejects.toThrow(/admitted only/);
    });

    it("rejects secret-shaped metadata (RL-LOCK-016)", async () => {
      const { port } = createContext();
      await expect(
        port.put({
          key: "exports/org-1/2026/01/4444444444444444-meta.json",
          body: "x",
          metadata: { "Authorization": "Bearer something" },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
}
