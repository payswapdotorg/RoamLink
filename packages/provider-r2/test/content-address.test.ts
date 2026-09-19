/**
 * Content-addressed key convention tests (RL-098).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildContentAddressedKey, sanitizeObjectFilename } from "../src/index.js";

const AT = "2026-01-15T10:00:00.000Z";

describe("buildContentAddressedKey (RL-098)", () => {
  const sha = createHash("sha256").update("attachment-content").digest("hex");

  it("builds tenant-scoped, dated, content-addressed keys", () => {
    expect(buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: sha, filename: "Damage Photo.JPG", at: AT })).toBe(
      `attachments/org-1/2026/01/${sha.slice(0, 16)}-damage-photo.jpg`,
    );
    expect(buildContentAddressedKey({ namespace: "exports", orgId: "org-1", contentSha256: sha, filename: "diagnostics.json", at: AT })).toBe(
      `exports/org-1/2026/01/${sha.slice(0, 16)}-diagnostics.json`,
    );
    expect(buildContentAddressedKey({ namespace: "backups", contentSha256: sha, filename: "snapshot.bin", at: AT })).toBe(
      `backups/2026/01/15/${sha.slice(0, 16)}-snapshot.bin`,
    );
  });

  it("is deterministic: same inputs -> same key (idempotent re-upload)", () => {
    const a = buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: sha, filename: "x.bin", at: AT });
    const b = buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: sha, filename: "x.bin", at: AT });
    expect(a).toBe(b);
  });

  it("lands different content at different keys (content addressing)", () => {
    const other = createHash("sha256").update("different").digest("hex");
    expect(buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: other, filename: "x.bin", at: AT })).not.toBe(
      buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: sha, filename: "x.bin", at: AT }),
    );
  });

  it("requires an orgId for tenant-scoped namespaces and rejects unknown namespaces", () => {
    expect(() =>
      buildContentAddressedKey({ namespace: "attachments", contentSha256: sha, filename: "x.bin", at: AT }),
    ).toThrow(/orgId/);
    expect(() =>
      buildContentAddressedKey({ namespace: "uploads" as never, orgId: "org-1", contentSha256: sha, filename: "x.bin", at: AT }),
    ).toThrow(/namespace/);
  });

  it("rejects non-sha256 digests", () => {
    expect(() =>
      buildContentAddressedKey({ namespace: "attachments", orgId: "org-1", contentSha256: "deadbeef", filename: "x.bin", at: AT }),
    ).toThrow(/sha-256/);
  });
});

describe("sanitizeObjectFilename (RL-098)", () => {
  it("reduces to the safe vocabulary deterministically", () => {
    expect(sanitizeObjectFilename("Damage Report (final).PDF")).toBe("damage-report-final.pdf");
    expect(sanitizeObjectFilename("r\u00e9sum\u00e9.txt")).toBe("resume.txt");
    expect(sanitizeObjectFilename("..\\..\\etc\\passwd")).toBe("etc-passwd");
    expect(() => sanitizeObjectFilename("")).toThrow();
    expect(() => sanitizeObjectFilename("///")).toThrow();
  });
});
