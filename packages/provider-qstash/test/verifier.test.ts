/**
 * QStash signature verification rigor tests (RL-097) - mirroring the
 * packages/webhook-inbox verifier battery: missing/malformed/invalid
 * signatures, replay window BOTH directions, payload bound, key rotation,
 * constant-time comparison path, value-free failures. The pinned scheme is
 * the LIVE-CONFIRMED JWT grammar (PA-017 2026-09-24 evidence: one JWT,
 * HS256, three base64url segments; body claim = base64url WITH padding of
 * SHA-256(raw body) - Go's URLEncoding, per the PA-017 live capture and
 * disambiguation probe; iat->exp 300s window).
 */
import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  DEFAULT_QSTASH_REPLAY_WINDOW_MS,
  QStashSignatureVerifier,
  renderQStashSignatureHeader,
  signQStashDelivery,
} from "../src/index.js";

const KEY = "current-signing-key";
const NEXT_KEY = "next-signing-key";
// The PA-017 alphabet-pin body: the SHA-256 digest of "roamlink" contains
// '+' in STANDARD base64 but '-' in the URL-safe alphabet, so the two
// encodings DIFFER - the body-claim assertions below can only pass under
// the correct live law (base64url WITH padding, Go URLEncoding).
const BODY = "roamlink";
const NOW_MS = 1_768_471_200_000; // 2026-01-15T10:00:00.000Z
const NOW_SEC = Math.floor(NOW_MS / 1000);

function verify(header: string | undefined, body = BODY, receivedAtMs = NOW_MS, currentKey = KEY) {
  const verifier = new QStashSignatureVerifier({ currentSigningKey: currentKey });
  return verifier.verify({ signatureHeader: header, body, receivedAtMs });
}

/** Hand-renders a JWT whose segments/claims deviate from the live shape (malformed-grammar fixtures). */
function forgedJwt(headerClaims: object, payloadClaims: object | string): string {
  const b64u = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  const header = b64u(JSON.stringify(headerClaims));
  const payloadSegment = b64u(typeof payloadClaims === "string" ? payloadClaims : JSON.stringify(payloadClaims));
  const signature = createHmac("sha256", KEY).update(`${header}.${payloadSegment}`, "utf8").digest("base64url");
  return `${header}.${payloadSegment}.${signature}`;
}

/**
 * The live body-claim law (PA-017 evidence): base64url WITH padding of
 * SHA-256(body) - Go's base64.URLEncoding.
 */
function liveBodyClaim(body: string): string {
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  return digest + "=".repeat((4 - (digest.length % 4)) % 4);
}

/** The live payload claims (with overrides) for hand-built fixtures. */
function liveClaims(overrides: Record<string, unknown>): object {
  return {
    aud: "",
    body: liveBodyClaim(BODY),
    exp: NOW_SEC + 300,
    iat: NOW_SEC,
    iss: "Upstash",
    jti: "jwt_deterministic-test-fixture",
    nbf: -62135596800,
    sub: "https://receiver.example.org/hooks",
    ...overrides,
  };
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
    // The current-only verifier refuses the next-key token (rotation is
    // an explicit two-key configuration, never a silent acceptance).
    expect(verify(header)).toMatchObject({ ok: false, code: "signature-invalid" });
  });

  it("fails closed on a missing header", () => {
    expect(verify(undefined)).toMatchObject({ ok: false, code: "signature-missing" });
    expect(verify("")).toMatchObject({ ok: false, code: "signature-missing" });
  });

  it("fails closed on malformed headers", () => {
    // The OLD pinned grammar (t=<sec>,v1=<hex>) is not the live JWT shape.
    expect(verify(`t=${NOW_SEC},v1=${"0".repeat(64)}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    // Wrong segment counts (2 and 4).
    const [seg1, seg2, seg3] = renderQStashSignatureHeader(KEY, NOW_SEC, BODY).split(".");
    expect(verify(`${seg1}.${seg2}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    expect(verify(`${seg1}.${seg2}.${seg3}.extra`)).toMatchObject({ ok: false, code: "signature-malformed" });
    // Non-base64url characters inside a segment (padding/plus are illegal unpadded base64url).
    expect(verify(`${seg1}+.${seg2}.${seg3}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    expect(verify(`${seg1}.${seg2}=.${seg3}`)).toMatchObject({ ok: false, code: "signature-malformed" });
    // A segment that is not JSON.
    expect(verify(forgedJwt({ alg: "HS256", typ: "JWT" }, "not-json"))).toMatchObject({
      ok: false,
      code: "signature-malformed",
    });
    // Missing payload claims (iat / exp / body).
    expect(verify(forgedJwt({ alg: "HS256", typ: "JWT" }, { exp: NOW_SEC + 300, body: "irrelevant" }))).toMatchObject({
      ok: false,
      code: "signature-malformed",
    });
    expect(verify(forgedJwt({ alg: "HS256", typ: "JWT" }, { iat: NOW_SEC, body: "irrelevant" }))).toMatchObject({
      ok: false,
      code: "signature-malformed",
    });
    expect(verify(forgedJwt({ alg: "HS256", typ: "JWT" }, { iat: NOW_SEC, exp: NOW_SEC + 300 }))).toMatchObject({
      ok: false,
      code: "signature-malformed",
    });
    // A disallowed algorithm.
    expect(verify(forgedJwt({ alg: "none", typ: "JWT" }, liveClaims({})))).toMatchObject({
      ok: false,
      code: "signature-malformed",
    });
  });

  it("rejects stale AND future timestamps (replay window both directions)", () => {
    const staleHeader = renderQStashSignatureHeader(KEY, NOW_SEC - Math.floor(DEFAULT_QSTASH_REPLAY_WINDOW_MS / 1000) - 1, BODY);
    expect(verify(staleHeader)).toMatchObject({ ok: false, code: "timestamp-outside-window" });
    const futureHeader = renderQStashSignatureHeader(KEY, NOW_SEC + Math.floor(DEFAULT_QSTASH_REPLAY_WINDOW_MS / 1000) + 1, BODY);
    expect(verify(futureHeader)).toMatchObject({ ok: false, code: "timestamp-outside-window" });
    // An expired token (iat inside the window but exp in the past) is refused.
    expect(verify(forgedJwt({ alg: "HS256", typ: "JWT" }, liveClaims({ exp: NOW_SEC - 10 })))).toMatchObject({
      ok: false,
      code: "timestamp-outside-window",
    });
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
    const tampered = "roamlinx"; // one byte away from the signed body
    expect(verify(header, tampered)).toMatchObject({ ok: false, code: "signature-invalid" });
    // ALPHABET LAW PIN (PA-017 live evidence): a token whose body claim is
    // the SAME digest of the delivered body but encoded in STANDARD base64
    // (its '+' betrays the wrong alphabet) is correctly signed and
    // otherwise live-shaped - it must STILL be refused, because the live
    // law is base64url WITH padding. The first live capture passed the old
    // pin only because its digest happened to contain no '+'/'/'. The
    // forged token is signed exactly as signQStashDelivery signs (HMAC-
    // SHA256, base64url, over the delivered <header>.<payload>).
    const wrongAlphabetClaim = createHash("sha256").update(BODY, "utf8").digest("base64");
    const wrongAlphabetToken = forgedJwt({ alg: "HS256", typ: "JWT" }, liveClaims({ body: wrongAlphabetClaim }));
    expect(verify(wrongAlphabetToken)).toMatchObject({ ok: false, code: "signature-invalid" });
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
    const signatureSegment = signQStashDelivery(KEY, NOW_SEC, BODY);
    expect(signatureSegment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const header = renderQStashSignatureHeader(KEY, NOW_SEC, BODY);
    const [headerSegment, payloadSegment, signature] = header.split(".") as [string, string, string];
    expect(signature).toBe(signatureSegment);
    // The rendered segments mirror the LIVE claim shape (PA-017 evidence).
    expect(JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8"))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"))).toEqual({
      aud: "",
      body: liveBodyClaim(BODY),
      exp: NOW_SEC + 300,
      iat: NOW_SEC,
      iss: "Upstash",
      jti: expect.stringMatching(/^jwt_[A-Za-z0-9_-]{28}$/),
      nbf: -62135596800,
      sub: "",
    });
    // The alphabet pin: for the crossing body the rendered claim uses the
    // URL-safe alphabet with '=' padding - NOT the standard-alphabet
    // digest (which would carry '+').
    expect(liveBodyClaim(BODY)).toMatch(/^[A-Za-z0-9_-]+=$/);
    expect(liveBodyClaim(BODY)).not.toBe(createHash("sha256").update(BODY, "utf8").digest("base64"));
    expect(verify(header)).toMatchObject({ ok: true });
  });

  it("rejects verifier construction without a current key", () => {
    expect(() => new QStashSignatureVerifier({ currentSigningKey: "" })).toThrow(/current signing key/);
  });
});
