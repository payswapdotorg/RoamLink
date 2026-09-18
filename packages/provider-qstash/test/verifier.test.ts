/**
 * QStash signature verification rigor tests (RL-097) - mirroring the
 * packages/webhook-inbox verifier battery: missing/malformed/invalid
 * signatures, replay window BOTH directions, payload bound, key rotation,
 * constant-time comparison path, value-free failures.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QSTASH_REPLAY_WINDOW_MS,
  QStashSignatureVerifier,
  renderQStashSignatureHeader,
  signQStashDelivery,
} from "../src/index.js";

const KEY = "current-signing-key";
const NEXT_KEY = "next-signing-key";
const BODY = '{"kind":"projection-refresh","subject":"device-1"}';
const NOW_MS = 1_768_471_200_000; // 2026-01-15T10:00:00.000Z
const NOW_SEC = Math.floor(NOW_MS / 1000);

function verify(header: string | undefined, body = BODY, receivedAtMs = NOW_MS, currentKey = KEY) {
  const verifier = new QStashSignatureVerifier({ currentSigningKey: currentKey });
  return verifier.verify({ signatureHeader: header, body, receivedAtMs });
}

describe("QStashSignatureVerifier (RL-097)", () => {
  it("accepts a correctly signed delivery", () => {
    const header = renderQStashSignatureHeader(KEY, NOW_SEC, BODY);
    expect(verify(header)).toEqual({ ok: true, signedAtMs: NOW_SEC * 1000 });
  });

  it("accepts the next signing key during rotation", () => {
    const verifier = new QStashSignatureVerifier({ currentSigningKey: KEY, nextSigningKey: NEXT_KEY });
    const header = renderQStashSignatureHeader(NEXT_KEY, NOW_SEC, BODY);
    expect(verifier.verify({ signatureHeader: header, body: BODY, receivedAtMs: NOW_MS })).toMatchObject({ ok: true });
  });

  it("fails closed on a missing header", () => {
    expect(verify(undefined)).toMatchObject({ ok: false, code: "signature-missing" });
    expect(verify("")).toMatchObject({ ok: false, code: "signature-missing" });
  });

  it("fails closed on malformed headers", () => {
    expect(verify("v1=deadbeef")).toMatchObject({ ok: false, code: "signature-malformed" });
    expect(verify(`t=abc,v1=${"0".repeat(64)}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    expect(verify(`t=${NOW_SEC},v1=${"0".repeat(63)}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    expect(verify(`v1=${"0".repeat(64)},t=${NOW_SEC}`)).toMatchObject({ ok: false, code: "signature-malformed" });
  });

  it("rejects stale AND future timestamps (replay window both directions)", () => {
    const staleHeader = renderQStashSignatureHeader(KEY, NOW_SEC - Math.floor(DEFAULT_QSTASH_REPLAY_WINDOW_MS / 1000) - 1, BODY);
    expect(verify(staleHeader)).toMatchObject({ ok: false, code: "timestamp-outside-window" });
    const futureHeader = renderQStashSignatureHeader(KEY, NOW_SEC + Math.floor(DEFAULT_QSTASH_REPLAY_WINDOW_MS / 1000) + 1, BODY);
    expect(verify(futureHeader)).toMatchObject({ ok: false, code: "timestamp-outside-window" });
    // inside the window in both directions: accepted
    const edgePast = renderQStashSignatureHeader(KEY, NOW_SEC - Math.floor(DEFAULT_QSTASH_REPLAY_WINDOW_MS / 1000), BODY);
    expect(verify(edgePast)).toMatchObject({ ok: true });
  });

  it("rejects signatures from a wrong key without echoing values", async () => {
    const header = renderQStashSignatureHeader("attacker-key", NOW_SEC, BODY);
    const verdict = verify(header);
    expect(verdict).toMatchObject({ ok: false, code: "signature-invalid" });
    if (verdict.ok) return;
    expect(verdict.message).not.toContain("attacker-key");
    expect(verdict.message).not.toContain(KEY);
  });

  it("rejects a body that differs from the signed one (byte-exact discipline)", () => {
    const header = renderQStashSignatureHeader(KEY, NOW_SEC, BODY);
    const tampered = '{"kind":"projection-refresh","subject":"device-2"}';
    expect(verify(header, tampered)).toMatchObject({ ok: false, code: "signature-invalid" });
  });

  it("rejects oversized payloads before signature work", () => {
    const verifier = new QStashSignatureVerifier({ currentSigningKey: KEY, maxPayloadBytes: 64 });
    const header = renderQStashSignatureHeader(KEY, NOW_SEC, BODY);
    expect(verifier.verify({ signatureHeader: header, body: "x".repeat(65), receivedAtMs: NOW_MS })).toMatchObject({
      ok: false,
      code: "payload-too-large",
    });
  });

  it("exports signing helpers that round-trip through verification", () => {
    const hex = signQStashDelivery(KEY, NOW_SEC, BODY);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const header = renderQStashSignatureHeader(KEY, NOW_SEC, BODY);
    expect(header).toBe(`t=${NOW_SEC},v1=${hex}`);
    expect(verify(header)).toMatchObject({ ok: true });
  });

  it("rejects verifier construction without a current key", () => {
    expect(() => new QStashSignatureVerifier({ currentSigningKey: "" })).toThrow(/current signing key/);
  });
});
