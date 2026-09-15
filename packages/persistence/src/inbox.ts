/**
 * Durable inbox primitives (RL-003).
 *
 * An inbox durably admits inbound external events (e.g. ADCOS webhooks,
 * RL-033) with dedupe semantics. The inbox is an append-only admission log:
 * every arrival produces a record whose admission state says what happened,
 * while the dedupe key admits exactly ONE ADMITTED record - duplicates are
 * visible as DUPLICATE audit rows but never produce a second admission
 * effect (RL-LOCK-009: webhooks are signals; admission is not truth).
 *
 * Admission states (closed):
 *  - ADMITTED:  durably admitted; the dedupe key is occupied by this record;
 *  - DUPLICATE: a later arrival whose dedupe key was already admitted
 *               (audit row; `admitted(dedupeKey)` still returns the original);
 *  - REJECTED: an arrival that failed admission checks (audit row; it does
 *               NOT occupy the dedupe key - a corrected retry may admit).
 *
 * Sequence numbers are assigned at commit time in commit order, so sequences
 * observed inside an open unit of work are provisional (see
 * {@link ./in-memory.js}).
 */
import {
  ValidationError,
  isForeignRefShaped,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

export const INBOX_ADMISSION_STATES = ["ADMITTED", "DUPLICATE", "REJECTED"] as const;

export type InboxAdmissionState = (typeof INBOX_ADMISSION_STATES)[number];

export function isInboxAdmissionState(value: unknown): value is InboxAdmissionState {
  return (
    typeof value === "string" && (INBOX_ADMISSION_STATES as readonly string[]).includes(value)
  );
}

/** Parses an admission state; anything outside the closed set is rejected. */
export function parseInboxAdmissionState(value: unknown): InboxAdmissionState {
  if (!isInboxAdmissionState(value)) {
    throw new ValidationError(
      "InboxAdmissionState must be one of: ADMITTED, DUPLICATE, REJECTED",
      {
        reason: "INBOX_STATE_INVALID",
        details: [{ path: "InboxAdmissionState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Lowercase slug identifying the external source system, e.g. "adcos". */
const INBOX_SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A durably admitted (or audited) inbound arrival.
 *
 * Sequence is the 1-based arrival order inside the inbox (the ordering
 * signal); dedupeKey is the unique-admission key (for ADCOS webhooks this is
 * the event id).
 */
export interface InboxRecord {
  readonly sequence: number;
  readonly source: string;
  readonly externalEventId: string;
  readonly receivedAt: UtcInstant;
  readonly dedupeKey: string;
  readonly admissionState: InboxAdmissionState;
}

/** Input accepted by {@link InboxWriteRepository.admit}. */
export interface InboxAdmitInput {
  readonly source: string;
  readonly externalEventId: string;
  readonly receivedAt: string;
  readonly dedupeKey: string;
}

export type InboxAdmitResult =
  | { readonly outcome: "ADMITTED"; readonly record: InboxRecord }
  | {
      readonly outcome: "DUPLICATE";
      readonly record: InboxRecord;
      readonly original: InboxRecord;
    };

/** Validates the shared arrival fields and returns them parsed. */
function parseArrival(input: InboxAdmitInput): {
  source: string;
  externalEventId: string;
  receivedAt: UtcInstant;
  dedupeKey: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("InboxAdmitInput must be an object", {
      reason: "INBOX_INPUT_INVALID",
      details: [{ path: "InboxAdmitInput", issue: "not an object" }],
    });
  }
  if (typeof input.source !== "string" || !INBOX_SOURCE_PATTERN.test(input.source)) {
    throw new ValidationError(
      "InboxAdmitInput.source must be a lowercase slug (letter, then letters/digits/hyphens, max 64 chars)",
      {
        reason: "INBOX_INPUT_INVALID",
        details: [{ path: "InboxAdmitInput.source", issue: "not a lowercase source slug" }],
      },
    );
  }
  if (typeof input.externalEventId !== "string" || !isForeignRefShaped(input.externalEventId)) {
    throw new ValidationError(
      "InboxAdmitInput.externalEventId must match the safe foreign-reference charset",
      {
        reason: "INBOX_INPUT_INVALID",
        details: [
          { path: "InboxAdmitInput.externalEventId", issue: "not a safe reference string" },
        ],
      },
    );
  }
  if (typeof input.dedupeKey !== "string" || !isForeignRefShaped(input.dedupeKey)) {
    throw new ValidationError(
      "InboxAdmitInput.dedupeKey must match the safe foreign-reference charset",
      {
        reason: "INBOX_INPUT_INVALID",
        details: [{ path: "InboxAdmitInput.dedupeKey", issue: "not a safe reference string" }],
      },
    );
  }
  return {
    source: input.source,
    externalEventId: input.externalEventId,
    receivedAt: parseUtcInstant(input.receivedAt),
    dedupeKey: input.dedupeKey,
  };
}

/** Transactional inbox writes - available only through a UnitOfWork. */
export interface InboxWriteRepository {
  /**
   * Durably admits an arrival. When the dedupe key is already admitted the
   * arrival is recorded as a DUPLICATE audit row and the ORIGINAL admitted
   * record is returned alongside - there is never a second ADMITTED record
   * for one dedupe key.
   */
  admit(input: InboxAdmitInput): Promise<InboxAdmitResult>;
  /**
   * Records an arrival that failed admission checks (e.g. signature
   * verification) as a REJECTED audit row. Rejected arrivals do NOT occupy
   * the dedupe key.
   */
  recordRejection(input: InboxAdmitInput): Promise<InboxRecord>;
}

/** Read-only view over committed inbox records. */
export interface InboxReadRepository {
  get(sequence: number): Promise<InboxRecord | null>;
  /** The single ADMITTED record for a dedupe key, if any. */
  admitted(dedupeKey: string): Promise<InboxRecord | null>;
  list(admissionState?: InboxAdmissionState): Promise<readonly InboxRecord[]>;
  count(admissionState?: InboxAdmissionState): Promise<number>;
}

/**
 * Transactional inbox view: writes plus read-your-own-writes reads over the
 * unit-of-work state. Available only through a UnitOfWork.
 */
export interface InboxRepository extends InboxWriteRepository, InboxReadRepository {}

/** Builds a frozen inbox record with validated fields. */
export function buildInboxRecord(
  input: InboxAdmitInput,
  sequence: number,
  admissionState: InboxAdmissionState,
): InboxRecord {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ValidationError("inbox sequence must be an integer >= 1", {
      reason: "INBOX_INPUT_INVALID",
      details: [{ path: "InboxRecord.sequence", issue: "not a positive integer" }],
    });
  }
  const arrival = parseArrival(input);
  return Object.freeze({
    sequence,
    source: arrival.source,
    externalEventId: arrival.externalEventId,
    receivedAt: arrival.receivedAt,
    dedupeKey: arrival.dedupeKey,
    admissionState: parseInboxAdmissionState(admissionState),
  });
}
