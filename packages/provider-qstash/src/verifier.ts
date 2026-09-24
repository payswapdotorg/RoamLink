/**
 * QStash delivery signature verification (RL-097) - receiver-side rigor
 * mirroring packages/webhook-inbox's verifier discipline:
 *
 *  1. the signature header MUST parse (single-site pinned scheme,
 *     LIVE-CONFIRMED by the PA-017 2026-09-24 evidence: ONE JWT - exactly
 *     3 dot-separated base64url segments `<header>.<payload>.<signature>`;
 *     constant `QSTASH_SIGNATURE_HEADER`); the header segment must carry
 *     `alg: "HS256"` (typ and other fields are tolerated/ignored), the
 *     payload must carry numeric `iat`/`exp` and a string `body` claim;
 *  2. the signature is base64url(HMAC-SHA256(`<header>.<payload>`, the
 *     signing key)), compared in CONSTANT time against the current signing
 *     key, then (for rotation) the next signing key;
 *  3. the `body` claim is base64url WITH padding of SHA-256(raw body) -
 *     Go's base64.URLEncoding (URL-safe alphabet A-Za-z0-9_- plus '='
 *     padding), the LIVE-CONFIRMED shape (PA-017: the observed 44-char
 *     claim carries '_' and ends with '='; the first capture's digest
 *     happened to contain no '+'/'/', which hid the difference from
 *     standard base64) - compared in CONSTANT time against the delivered
 *     body (byte-exact discipline);
 *  4. the timestamp falls within the replay window in BOTH directions (a
 *     future-stamped delivery is as suspect as a stale one) and the token
 *     must not be expired (`receivedAtMs > exp*1000` refuses); `nbf` is
 *     IGNORED - the live wire emits Go's zero-time sentinel -62135596800,
 *     never a real not-before bound;
 *  5. the body size is admitted only under the payload bound;
 *  6. EVERY failure is closed, typed (closed code vocabulary), and
 *     value-free - signing keys and body content never appear in errors
 *     (RL-LOCK-016).
 *
 * The scheme is LIVE-CONFIRMED (PA-017, 2026-09-24 evidence: a real
 * captured delivery against the operator's QStash account verified under
 * exactly this model) and pinned in ONE place
 * (`buildQStashSignatureMessage`) so any drift is a one-line, fully-tested
 * correction; receivers depend only on this module's verifier.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { ValidationError } from "@roamlink/contracts";

/** The pinned signature-header name. */
export const QSTASH_SIGNATURE_HEADER = "upstash-signature";

/** Default replay window (both directions) - mirrors the live token's own 300s iat-to-exp window. */
export const DEFAULT_QSTASH_REPLAY_WINDOW_MS = 300_000;

/** The closed verification failure vocabulary. */
export const QSTASH_VERIFICATION_FAILURE_CODES = [
  "signature-missing",
  "signature-malformed",
  "timestamp-outside-window",
  "signature-invalid",
  "payload-too-large",
] as const;

export type QStashVerificationFailureCode = (typeof QSTASH_VERIFICATION_FAILURE_CODES)[number];

export type QStashVerification =
  | { readonly ok: true; readonly signedAtMs: number }
  | { readonly ok: false; readonly code: QStashVerificationFailureCode; readonly message: string };

export interface QStashSignatureVerifierOptions {
  /** Current signing key (secret; stored privately, never logged). */
  readonly currentSigningKey: string;
  /** Rotation: the next signing key is ALSO accepted during rollover. */
  readonly nextSigningKey?: string;
  /** Replay window in ms (both directions); default 300s. */
  readonly replayWindowMs?: number;
  /** Payload admission bound in bytes; default 1 MiB. */
  readonly maxPayloadBytes?: number;
}

/** The live token's iat-to-exp lifetime (seconds). */
const QSTASH_TOKEN_LIFETIME_SECONDS = 300;

/** Go's zero-time sentinel (unix seconds) - the live wire's nbf value; never a real bound. */
const GO_ZERO_TIME_UNIX_SECONDS = -62_135_596_800;

/** The pinned JWT header claims (exactly the observed live shape). */
const JWT_HEADER_CLAIMS = { alg: "HS256", typ: "JWT" } as const;

/** Optional claims the signing helpers mirror from the live token. */
export interface QStashSignatureExtra {
  /** The `sub` claim: the delivery's destination URL (live shape). */
  readonly sub?: string;
  /** The `jti` claim; defaults to a deterministic per-(iat, body) id. */
  readonly jti?: string;
}

/** base64url (unpadded) of a UTF-8 string. */
function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * The live body claim: base64url WITH padding of SHA-256(raw body) -
 * Go's base64.URLEncoding (URL-safe alphabet A-Za-z0-9_- plus '='
 * padding), per the PA-017 live evidence. The first capture's digest
 * contained no '+'/'/' characters, so the standard-alphabet encoding
 * looked identical; live digests that cross the alphabets proved the
 * URL-safe law.
 */
function bodyClaimOf(body: string): string {
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  return digest + "=".repeat((4 - (digest.length % 4)) % 4);
}

/**
 * The deterministic default `jti`: `jwt_` + a base64url slice of
 * SHA-256(`<timestampSeconds>.<body>`) - the fake transport stays
 * reproducible while mirroring the live `jwt_<random>` shape.
 */
export function deterministicQStashJti(timestampSeconds: number, body: string): string {
  return `jwt_${createHash("sha256").update(`${timestampSeconds}.${body}`, "utf8").digest("base64url").slice(0, 28)}`;
}

/** Renders the payload claims exactly in the observed live shape (alphabetical key order). */
function renderClaims(timestampSeconds: number, body: string, extra?: QStashSignatureExtra): string {
  return JSON.stringify({
    aud: "",
    body: bodyClaimOf(body),
    exp: timestampSeconds + QSTASH_TOKEN_LIFETIME_SECONDS,
    iat: timestampSeconds,
    iss: "Upstash",
    jti: extra?.jti ?? deterministicQStashJti(timestampSeconds, body),
    nbf: GO_ZERO_TIME_UNIX_SECONDS,
    sub: extra?.sub ?? "",
  });
}

/**
 * Builds the signed message (the ONE canonicalization site): the JWT
 * signing input `<b64uHeader>.<b64uPayload>` over the live claim shape.
 */
export function buildQStashSignatureMessage(timestampSeconds: number, body: string, extra?: QStashSignatureExtra): string {
  return `${toBase64Url(JSON.stringify(JWT_HEADER_CLAIMS))}.${toBase64Url(renderClaims(timestampSeconds, body, extra))}`;
}

/**
 * Computes the signature segment: base64url(HMAC-SHA256 over the
 * canonical signing input) - 43 chars, unpadded (the live shape).
 */
export function signQStashDelivery(secret: string, timestampSeconds: number, body: string, extra?: QStashSignatureExtra): string {
  return createHmac("sha256", secret)
    .update(buildQStashSignatureMessage(timestampSeconds, body, extra), "utf8")
    .digest("base64url");
}

/**
 * Renders the pinned header value (tests + the fake transport): the full
 * JWT `<header>.<payload>.<signature>`.
 */
export function renderQStashSignatureHeader(
  secret: string,
  timestampSeconds: number,
  body: string,
  extra?: QStashSignatureExtra,
): string {
  return `${buildQStashSignatureMessage(timestampSeconds, body, extra)}.${signQStashDelivery(secret, timestampSeconds, body, extra)}`;
}

/** Constant-time equality of two ASCII claim/signature strings. */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** The value-free grammar rejection message (names the pinned grammar). */
const MALFORMED_MESSAGE =
  "the signature header does not satisfy the pinned grammar (a single JWT: HS256, three base64url segments <header>.<payload>.<signature>)";

/** A base64url (unpadded) JWT segment. */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** base64url-decodes a segment to a parsed JSON object (or null). */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  return decoded as Record<string, unknown>;
}

function fail(code: QStashVerificationFailureCode, message: string): QStashVerification {
  return { ok: false, code, message };
}

export class QStashSignatureVerifier {
  readonly #currentSigningKey: string;
  readonly #nextSigningKey: string | null;
  readonly #replayWindowMs: number;
  readonly #maxPayloadBytes: number;

  constructor(options: QStashSignatureVerifierOptions) {
    if (typeof options?.currentSigningKey !== "string" || options.currentSigningKey.length === 0) {
      throw new ValidationError("QStashSignatureVerifier requires a current signing key", {
        reason: "QSTASH_VERIFIER_CONFIG_INVALID",
        details: [{ path: "currentSigningKey", issue: "missing" }],
      });
    }
    if (
      options.nextSigningKey !== undefined &&
      (typeof options.nextSigningKey !== "string" || options.nextSigningKey.length === 0)
    ) {
      throw new ValidationError("the next signing key must be a non-empty string", {
        reason: "QSTASH_VERIFIER_CONFIG_INVALID",
        details: [{ path: "nextSigningKey", issue: "invalid" }],
      });
    }
    this.#currentSigningKey = options.currentSigningKey;
    this.#nextSigningKey = options.nextSigningKey ?? null;
    this.#replayWindowMs = options.replayWindowMs ?? DEFAULT_QSTASH_REPLAY_WINDOW_MS;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
    if (!Number.isInteger(this.#replayWindowMs) || this.#replayWindowMs < 1) {
      throw new ValidationError("replayWindowMs must be a positive integer", {
        reason: "QSTASH_VERIFIER_CONFIG_INVALID",
        details: [{ path: "replayWindowMs", issue: "invalid" }],
      });
    }
    if (!Number.isInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1) {
      throw new ValidationError("maxPayloadBytes must be a positive integer", {
        reason: "QSTASH_VERIFIER_CONFIG_INVALID",
        details: [{ path: "maxPayloadBytes", issue: "invalid" }],
      });
    }
  }

  /**
   * Verifies a delivery. NEVER throws: failures return the typed closed
   * code (receivers persist rejection audit rows and answer non-2xx so the
   * transport retries/requeues).
   */
  verify(input: {
    readonly signatureHeader: string | undefined;
    /** The BYTE-EXACT raw body string. */
    readonly body: string;
    /** The receiving instant (explicit; deterministic in tests). */
    readonly receivedAtMs: number;
  }): QStashVerification {
    if (typeof input.body !== "string") {
      return fail("signature-malformed", "the delivery body must be the byte-exact payload string");
    }
    if (Buffer.byteLength(input.body, "utf8") > this.#maxPayloadBytes) {
      return fail(
        "payload-too-large",
        `the delivered payload exceeds the admission limit of ${this.#maxPayloadBytes} bytes`,
      );
    }
    const header = input.signatureHeader;
    if (typeof header !== "string" || header.length === 0) {
      return fail("signature-missing", "the delivery carries no signature header; failing closed");
    }

    // Pinned header grammar (LIVE-CONFIRMED): ONE JWT - exactly three
    // non-empty dot-separated base64url segments.
    const segments = header.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0 || !BASE64URL_SEGMENT.test(segment))) {
      return fail("signature-malformed", MALFORMED_MESSAGE);
    }
    const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

    const headerClaims = decodeJsonSegment(headerSegment);
    if (headerClaims === null || headerClaims.alg !== "HS256") {
      return fail("signature-malformed", MALFORMED_MESSAGE);
    }
    const payloadClaims = decodeJsonSegment(payloadSegment);
    if (payloadClaims === null) {
      return fail("signature-malformed", MALFORMED_MESSAGE);
    }
    const { iat, exp } = payloadClaims;
    const bodyClaim = payloadClaims.body;
    if (
      typeof iat !== "number" ||
      !Number.isFinite(iat) ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      typeof bodyClaim !== "string"
    ) {
      return fail("signature-malformed", MALFORMED_MESSAGE);
    }

    // Timestamp law (both directions suspect; the live token's own
    // iat-to-exp window is 300s). nbf is deliberately IGNORED: the live
    // wire emits Go's zero-time sentinel, never a real not-before bound.
    const signedAtMs = iat * 1000;
    const skewMs = Math.abs(signedAtMs - input.receivedAtMs);
    if (skewMs > this.#replayWindowMs || input.receivedAtMs > exp * 1000) {
      return fail(
        "timestamp-outside-window",
        `the delivery timestamp falls outside the ${this.#replayWindowMs}ms replay window (both directions are suspect; expired tokens are refused)`,
      );
    }

    // Body-integrity law: the live body claim is base64url WITH padding
    // (Go URLEncoding) of SHA-256(raw body), compared in constant time
    // (byte-exact discipline).
    if (!signaturesMatch(bodyClaimOf(input.body), bodyClaim)) {
      return fail(
        "signature-invalid",
        "the delivered body does not match the token's signed body claim (SHA-256, base64url with padding)",
      );
    }

    // Signature law: base64url HMAC-SHA256 over `<header>.<payload>` with
    // the current key, then the rotation key - constant time.
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const candidates: readonly string[] =
      this.#nextSigningKey === null
        ? [this.#currentSigningKey]
        : [this.#currentSigningKey, this.#nextSigningKey];
    const verified = candidates.some((candidateKey) =>
      signaturesMatch(createHmac("sha256", candidateKey).update(signingInput, "utf8").digest("base64url"), signatureSegment),
    );
    if (!verified) {
      return fail(
        "signature-invalid",
        "the delivery signature does not verify against the canonical signing input (HMAC-SHA256, base64url)",
      );
    }
    return { ok: true, signedAtMs };
  }
}
