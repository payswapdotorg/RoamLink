/**
 * Idempotency ledger port (RL-004, RL-LOCK-014).
 *
 * Every mutating auth use case is gated by the Wave-0 command envelope: the
 * SAME envelope (same idempotency key, same canonical digest) replayed after
 * success must return the RECORDED outcome without re-applying the effect;
 * the same key with a DIFFERENT digest is a conflict, never a silent
 * overwrite. This port is the seam where durable implementations (RL-003
 * persistence dedupe log) plug in; the in-memory adapter is for tests.
 *
 * The ledger is keyed by idempotency key alone: the envelope digest covers
 * tenant and actor, so a key reused across tenants/actors produces a digest
 * mismatch and fails closed.
 */
import {
  ConflictError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type Digest,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

/** A recorded, committed command outcome. */
export interface IdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  /** Canonical digest of the admitted envelope (dedupe identity). */
  readonly envelopeDigest: Digest;
  /** The committed outcome (canonical JSON value; replayed verbatim). */
  readonly outcome: CanonicalJsonValue;
  readonly recordedAt: UtcInstant;
}

/** Result of admitting a command. */
export type IdempotencyAdmission =
  | { readonly status: "new" }
  | { readonly status: "replay"; readonly outcome: CanonicalJsonValue };

/** The idempotency ledger port (durable implementations bind later). */
export interface IdempotencyLedger {
  /**
   * Admits a command by key + digest. `new` reserves nothing (a failed
   * command may be re-attempted); `replay` carries the previously committed
   * outcome. A stored key with a DIFFERENT digest throws ConflictError.
   */
  admit(key: IdempotencyKey, envelopeDigest: Digest): Promise<IdempotencyAdmission>;
  /** Records the committed outcome; no-op when identical, ConflictError on digest mismatch. */
  commit(key: IdempotencyKey, envelopeDigest: Digest, outcome: CanonicalJsonValue, recordedAt: UtcInstant): Promise<void>;
}

/** Admits a command envelope (key + canonical digest). */
export async function admitCommand(
  ledger: IdempotencyLedger,
  envelope: CommandEnvelope,
): Promise<IdempotencyAdmission> {
  return ledger.admit(envelope.idempotencyKey, envelope.digest());
}

/** Records the committed outcome of a command envelope. */
export async function commitCommand(
  ledger: IdempotencyLedger,
  envelope: CommandEnvelope,
  outcome: CanonicalJsonValue,
  recordedAt: UtcInstant,
): Promise<void> {
  return ledger.commit(envelope.idempotencyKey, envelope.digest(), outcome, recordedAt);
}

/** In-memory ledger for tests and local development. */
export class InMemoryIdempotencyLedger implements IdempotencyLedger {
  readonly #records = new Map<IdempotencyKey, IdempotencyRecord>();

  async admit(key: IdempotencyKey, envelopeDigest: Digest): Promise<IdempotencyAdmission> {
    const existing = this.#records.get(key);
    if (existing === undefined) {
      return { status: "new" };
    }
    if (existing.envelopeDigest !== envelopeDigest) {
      throw new ConflictError(
        "idempotency key was already used by a different command (different canonical digest); use a new idempotency key for a new command",
        { reason: "IDEMPOTENCY_KEY_CONFLICT" },
      );
    }
    return { status: "replay", outcome: existing.outcome };
  }

  async commit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
    outcome: CanonicalJsonValue,
    recordedAt: UtcInstant,
  ): Promise<void> {
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.envelopeDigest !== envelopeDigest) {
        throw new ConflictError(
          "idempotency key was already used by a different command (different canonical digest)",
          { reason: "IDEMPOTENCY_KEY_CONFLICT" },
        );
      }
      return;
    }
    this.#records.set(
      key,
      Object.freeze({
        idempotencyKey: key,
        envelopeDigest,
        outcome,
        recordedAt,
      }),
    );
  }
}
