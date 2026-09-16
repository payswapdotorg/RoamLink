/**
 * Idempotency ledger port for the commerce domain (RL-020/RL-021,
 * RL-LOCK-014).
 *
 * Same discipline as the experience and auth packages' ledgers (local
 * mirrors of the Wave-0 envelope discipline; sibling domain packages may not
 * import each other - RL-LOCK-019). The composition layer may bind ONE
 * durable implementation (RL-003 persistence dedupe log) to every domain
 * ledger port.
 *
 * CAVEAT (same as the experience domain's): the in-memory ledger commits
 * OUTSIDE the commerce unit of work. A durable binding must join the ledger
 * commit into the same database transaction as the business writes; the
 * port contract below is the seam where that happens.
 */
import {
  ConflictError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type Digest,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

/** A recorded, committed commerce command outcome. */
export interface CommerceIdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly envelopeDigest: Digest;
  readonly outcome: CanonicalJsonValue;
  readonly recordedAt: UtcInstant;
}

/** Result of admitting a commerce command. */
export type CommerceIdempotencyAdmission =
  | { readonly status: "new" }
  | { readonly status: "replay"; readonly outcome: CanonicalJsonValue };

/** The commerce idempotency ledger port (durable implementations bind later). */
export interface CommerceIdempotencyLedger {
  admit(key: IdempotencyKey, envelopeDigest: Digest): Promise<CommerceIdempotencyAdmission>;
  commit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
    outcome: CanonicalJsonValue,
    recordedAt: UtcInstant,
  ): Promise<void>;
}

/** Admits a command envelope (key + canonical digest). */
export async function admitCommerceCommand(
  ledger: CommerceIdempotencyLedger,
  envelope: CommandEnvelope,
): Promise<CommerceIdempotencyAdmission> {
  return ledger.admit(envelope.idempotencyKey, envelope.digest());
}

/** Records the committed outcome of a command envelope. */
export async function commitCommerceCommand(
  ledger: CommerceIdempotencyLedger,
  envelope: CommandEnvelope,
  outcome: CanonicalJsonValue,
  recordedAt: UtcInstant,
): Promise<void> {
  return ledger.commit(envelope.idempotencyKey, envelope.digest(), outcome, recordedAt);
}

/** In-memory commerce ledger for tests and local development. */
export class InMemoryCommerceIdempotencyLedger implements CommerceIdempotencyLedger {
  readonly #records = new Map<IdempotencyKey, CommerceIdempotencyRecord>();

  async admit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
  ): Promise<CommerceIdempotencyAdmission> {
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
