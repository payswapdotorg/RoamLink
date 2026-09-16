/**
 * Idempotency ledger port for the notifications domain (RL-014,
 * RL-LOCK-014).
 *
 * A LOCAL MIRROR of the Wave-0 envelope discipline (sibling domain
 * packages may not import each other - RL-LOCK-019; the composition layer
 * may bind ONE durable implementation to every domain ledger port).
 */
import {
  ConflictError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type Digest,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

/** A recorded, committed notifications-command outcome. */
export interface NotificationsIdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly envelopeDigest: Digest;
  readonly outcome: CanonicalJsonValue;
  readonly recordedAt: UtcInstant;
}

/** Result of admitting a notifications command. */
export type NotificationsIdempotencyAdmission =
  | { readonly status: "new" }
  | { readonly status: "replay"; readonly outcome: CanonicalJsonValue };

/** The notifications idempotency ledger port. */
export interface NotificationsIdempotencyLedger {
  admit(key: IdempotencyKey, envelopeDigest: Digest): Promise<NotificationsIdempotencyAdmission>;
  commit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
    outcome: CanonicalJsonValue,
    recordedAt: UtcInstant,
  ): Promise<void>;
}

/** Admits a command envelope (key + canonical digest). */
export async function admitNotificationsCommand(
  ledger: NotificationsIdempotencyLedger,
  envelope: CommandEnvelope,
): Promise<NotificationsIdempotencyAdmission> {
  return ledger.admit(envelope.idempotencyKey, envelope.digest());
}

/** Records the committed outcome of a command envelope. */
export async function commitNotificationsCommand(
  ledger: NotificationsIdempotencyLedger,
  envelope: CommandEnvelope,
  outcome: CanonicalJsonValue,
  recordedAt: UtcInstant,
): Promise<void> {
  return ledger.commit(envelope.idempotencyKey, envelope.digest(), outcome, recordedAt);
}

/** In-memory notifications ledger for tests and local development. */
export class InMemoryNotificationsIdempotencyLedger implements NotificationsIdempotencyLedger {
  readonly #records = new Map<IdempotencyKey, NotificationsIdempotencyRecord>();

  async admit(
    key: IdempotencyKey,
    envelopeDigest: Digest,
  ): Promise<NotificationsIdempotencyAdmission> {
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
