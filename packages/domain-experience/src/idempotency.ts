/**
 * Idempotency ledger port for the experience domain (RL-010/RL-011,
 * RL-LOCK-014).
 *
 * Same discipline as the auth package's ledger (both are local mirrors of
 * the Wave-0 envelope discipline; the packages are siblings and may not
 * import each other - RL-LOCK-019). The composition layer may bind ONE
 * durable implementation (RL-003 persistence dedupe log) to both ports.
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
  readonly envelopeDigest: Digest;
  readonly outcome: CanonicalJsonValue;
  readonly recordedAt: UtcInstant;
}

/** Result of admitting a command. */
export type IdempotencyAdmission =
  | { readonly status: "new" }
  | { readonly status: "replay"; readonly outcome: CanonicalJsonValue };

/** The idempotency ledger port (durable implementations bind later). */
export interface IdempotencyLedger {
  admit(key: IdempotencyKey, envelopeDigest: Digest): Promise<IdempotencyAdmission>;
  commit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
    outcome: CanonicalJsonValue,
    recordedAt: UtcInstant,
  ): Promise<void>;
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
      Object.freeze({ idempotencyKey: key, envelopeDigest, outcome, recordedAt }),
    );
  }
}
