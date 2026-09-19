/**
 * QStash-style delivery signature verification (RL-097) - receiver-side
 * rigor mirroring packages/webhook-inbox's verifier discipline:
 *
 *  1. the signature header MUST parse (single-site pinned scheme:
 *     `t=<unix-seconds>,v1=<hex>`; constant `QSTASH_SIGNATURE_HEADER`);
 *  2. the signature is HMAC-SHA256-hex over `${t}.${rawBody}` (when a
 *     timestamp is present) or over the raw body, compared in CONSTANT
 *     time against the current signing key, then (for rotation) the next
 *     signing key;
 *  3. the timestamp falls within the replay window in BOTH directions (a
 *     future-stamped delivery is as suspect as a stale one);
 *  4. the body size is admitted only under the payload bound;
 *  5. EVERY failure is closed, typed (closed code vocabulary), and
 *     value-free - signing keys and body content never appear in errors
 *     (RL-LOCK-016).
 *
 * Honest wire note (AR-009): the exact signed-message canonicalization of
 * the live QStash product must be confirmed against a real account at
 * RL-100+. The scheme is pinned in ONE place (`buildQStashSignatureMessage`)
 * so any drift is a one-line, fully-tested correction; receivers depend
 * only on this module's verifier.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { ValidationError } from "@roamlink/contracts";

/** The pinned signature-header name. */
export const QSTASH_SIGNATURE_HEADER = "upstash-signature";

/** Default replay window (both directions), mirroring webhook-inbox rigor. */
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

/** Builds the signed message (the ONE canonicalization site). */
export function buildQStashSignatureMessage(timestampSeconds: number | null, body: string): string {
  return timestampSeconds === null ? body : `${timestampSeconds}.${body}`;
}

/** Computes the HMAC-SHA256 hex signature over the canonical message. */
export function signQStashDelivery(secret: string, timestampSeconds: number | null, body: string): string {
  return createHmac("sha256", secret)
    .update(buildQStashSignatureMessage(timestampSeconds, body), "utf8")
    .digest("hex");
}

/** Renders the pinned header value (tests + the fake transport). */
export function renderQStashSignatureHeader(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${signQStashDelivery(secret, timestampSeconds, body)}`;
}

/** Constant-time equality of two hex signatures. */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
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

    // Pinned header grammar: t=<unix-seconds>,v1=<hex>
    const match = /^t=(\d{1,13}),v1=([0-9a-f]{64})$/.exec(header);
    if (match === null) {
      return fail("signature-malformed", "the signature header does not satisfy the pinned grammar (t=<sec>,v1=<hex>)");
    }
    const timestampSeconds = Number(match[1]);
    const provided = match[2] as string;

    const signedAtMs = timestampSeconds * 1000;
    const skewMs = Math.abs(signedAtMs - input.receivedAtMs);
    if (skewMs > this.#replayWindowMs) {
      return fail(
        "timestamp-outside-window",
        `the delivery timestamp falls outside the ${this.#replayWindowMs}ms replay window (both directions are suspect)`,
      );
    }

    const candidates: readonly string[] =
      this.#nextSigningKey === null
        ? [this.#currentSigningKey]
        : [this.#currentSigningKey, this.#nextSigningKey];
    const verified = candidates.some((candidateKey) =>
      signaturesMatch(signQStashDelivery(candidateKey, timestampSeconds, input.body), provided),
    );
    if (!verified) {
      return fail(
        "signature-invalid",
        "the delivery signature does not verify against the canonical signed message (HMAC-SHA256, hex)",
      );
    }
    return { ok: true, signedAtMs };
  }
}
