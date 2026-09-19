/**
 * The durable ADCOS webhook inbox (RL-033, spec/adcos-integration.md §6,
 * RL-LOCK-009: webhooks are signals, not truth).
 *
 * Pipeline (exactly §6):
 *
 *   receive -> authenticate (WebhookVerifier) -> replay check (dedupe by
 *   event id) -> persist IMMUTABLE inbox record -> acknowledge -> async
 *   project
 *
 * Durability comes from the @roamlink/persistence primitives:
 *  - the inbox admission log (`inbox.admit`) owns the dedupe key (the ADCOS
 *    event id): exactly ONE admitted record per event id, ever; later
 *    arrivals become DUPLICATE audit rows (visible, never re-effective);
 *  - the immutable extended record (raw payload, signature metadata, schema
 *    version, processing status) is inserted in the SAME unit of work as the
 *    admission, so admission + record are atomic (transactional by
 *    construction);
 *  - acknowledgment happens only after the unit of work COMMITTED (the HTTP
 *    layer maps the admission result to 2xx/4xx);
 *  - async projection runs afterwards via the AdcosWebhookProjector port;
 *    reprocessing is deterministic and idempotent (already-PROJECTED records
 *    are skipped; only the `processing` sub-object ever mutates, guarded by
 *    an immutability check - the admitted content is frozen forever).
 *
 * Rejections (failed verification) are recorded as REJECTED audit rows that
 * do NOT occupy the dedupe key - a corrected retry of the same event id can
 * still admit.
 */
import {
  ConflictError,
  DomainError,
  ValidationError,
  canonicalizeJson,
  sha256Hex,
  type CanonicalJsonValue,
  type Digest,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  parseAdcosWebhookEvent,
  type AdcosErrorCode,
  type AdcosWebhookDelivery,
  type AdcosWebhookEvent,
  type AdcosWebhookVerifyInput,
  type WebhookVerifier,
} from "@roamlink/adcos";
import type {
  PersistenceReader,
  UnitOfWork,
  UnitOfWorkFactory,
} from "@roamlink/persistence";
import type { Clock } from "@roamlink/testkit";

// --------------------------------------------------------------------------------
// The immutable admitted record (§6: exactly the documented retention set)
// --------------------------------------------------------------------------------

/** The closed processing-status vocabulary. */
export const WEBHOOK_PROCESSING_STATUSES = ["PENDING", "PROJECTED", "FAILED"] as const;

export type WebhookProcessingStatus = (typeof WEBHOOK_PROCESSING_STATUSES)[number];

export function isWebhookProcessingStatus(value: unknown): value is WebhookProcessingStatus {
  return (
    typeof value === "string" && (WEBHOOK_PROCESSING_STATUSES as readonly string[]).includes(value)
  );
}

/** The legal processing transitions (PROJECTED is terminal). */
export const WEBHOOK_PROCESSING_TRANSITIONS: Readonly<
  Record<WebhookProcessingStatus, readonly WebhookProcessingStatus[]>
> = Object.freeze({
  PENDING: ["PROJECTED", "FAILED"],
  FAILED: ["PENDING", "FAILED", "PROJECTED"],
  PROJECTED: [],
});

/** The mutable processing sub-object (the ONLY mutable part of the record). */
export interface WebhookProcessingState {
  readonly status: WebhookProcessingStatus;
  /** Projection attempts so far (admission is not an attempt). */
  readonly attempts: number;
  /** UPPER_SNAKE reason of the last projection attempt (applied/skip/fail). */
  readonly last_reason?: string;
  readonly last_attempted_at?: UtcInstant;
  readonly projected_at?: UtcInstant;
}

/**
 * The immutable admitted inbox record: raw contract payload, event id,
 * source, timestamps, signature metadata, schema version and processing
 * status (spec §6). Signature metadata keeps the digest of the signature
 * value (forensics) - never the HMAC secret.
 */
export interface AdmittedWebhookRecord {
  readonly schema_version: string;
  readonly source: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly resource_id: string;
  readonly resource_kind: string;
  readonly resource_version: number;
  readonly occurred_at: UtcInstant;
  readonly correlation_id: string;
  readonly environment: string;
  readonly received_at: UtcInstant;
  readonly delivery: {
    readonly key_id: string;
    readonly algorithm: string;
    readonly timestamp: string;
    readonly delivery_id: string;
    readonly sequence: number;
    readonly signature_digest: Digest;
  };
  readonly raw_payload: string;
  readonly payload_digest: Digest;
  readonly processing: WebhookProcessingState;
}

/** The named persistence repository holding the extended records. */
export const ADCOS_WEBHOOK_INBOX_REPOSITORY = "adcos-webhook-inbox";

/** The inbox source slug (persistence inbox admission log). */
export const ADCOS_WEBHOOK_INBOX_SOURCE = "adcos";

const ADMITTED_RECORD_FIELDS = [
  "schema_version",
  "source",
  "event_id",
  "event_type",
  "resource_id",
  "resource_kind",
  "resource_version",
  "occurred_at",
  "correlation_id",
  "environment",
  "received_at",
  "delivery",
  "raw_payload",
  "payload_digest",
  "processing",
] as const;

function recordField(label: string, issue: string): never {
  throw new ValidationError(`AdmittedWebhookRecord rejected: ${label} - ${issue}`, {
    reason: "WEBHOOK_INBOX_RECORD_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes an admitted record from persistence. */
export function parseAdmittedWebhookRecord(value: unknown): AdmittedWebhookRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    recordField("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ADMITTED_RECORD_FIELDS as readonly string[]).includes(key)) {
      recordField(key, "unknown field (the admitted-record vocabulary is closed)");
    }
  }
  for (const field of ADMITTED_RECORD_FIELDS) {
    if (record[field] === undefined) {
      recordField(field, "is required");
    }
  }
  const processingRaw = record["processing"];
  if (processingRaw === null || typeof processingRaw !== "object" || Array.isArray(processingRaw)) {
    recordField("processing", "must be an object with a closed processing status");
  }
  const processingRecord = processingRaw as Record<string, unknown>;
  if (!isWebhookProcessingStatus(processingRecord["status"])) {
    recordField("processing.status", "must be PENDING, PROJECTED or FAILED");
  }
  if (typeof processingRecord["attempts"] !== "number" || !Number.isInteger(processingRecord["attempts"]) || processingRecord["attempts"] < 0) {
    recordField("processing.attempts", "must be a non-negative integer");
  }
  const deliveryRaw = record["delivery"];
  if (deliveryRaw === null || typeof deliveryRaw !== "object" || Array.isArray(deliveryRaw)) {
    recordField("delivery", "must be the signature metadata object");
  }
  const deliveryRecord = deliveryRaw as Record<string, unknown>;
  for (const field of ["key_id", "algorithm", "timestamp", "delivery_id", "sequence", "signature_digest"]) {
    if (deliveryRecord[field] === undefined) {
      recordField(`delivery.${field}`, "is required signature metadata");
    }
  }
  return Object.freeze({
    schema_version: record["schema_version"] as string,
    source: record["source"] as string,
    event_id: record["event_id"] as string,
    event_type: record["event_type"] as string,
    resource_id: record["resource_id"] as string,
    resource_kind: record["resource_kind"] as string,
    resource_version: record["resource_version"] as number,
    occurred_at: record["occurred_at"] as UtcInstant,
    correlation_id: record["correlation_id"] as string,
    environment: record["environment"] as string,
    received_at: record["received_at"] as UtcInstant,
    delivery: Object.freeze({
      key_id: deliveryRecord["key_id"] as string,
      algorithm: deliveryRecord["algorithm"] as string,
      timestamp: deliveryRecord["timestamp"] as string,
      delivery_id: deliveryRecord["delivery_id"] as string,
      sequence: deliveryRecord["sequence"] as number,
      signature_digest: deliveryRecord["signature_digest"] as Digest,
    }),
    raw_payload: record["raw_payload"] as string,
    payload_digest: record["payload_digest"] as Digest,
    processing: Object.freeze({
      status: processingRecord["status"] as WebhookProcessingStatus,
      attempts: processingRecord["attempts"] as number,
      ...(processingRecord["last_reason"] !== undefined ? { last_reason: processingRecord["last_reason"] as string } : {}),
      ...(processingRecord["last_attempted_at"] !== undefined ? { last_attempted_at: processingRecord["last_attempted_at"] as UtcInstant } : {}),
      ...(processingRecord["projected_at"] !== undefined ? { projected_at: processingRecord["projected_at"] as UtcInstant } : {}),
    }),
  }) as AdmittedWebhookRecord;
}

// --------------------------------------------------------------------------------
// The immutability guard (only `processing` may ever change)
// --------------------------------------------------------------------------------

function withoutProcessing(record: AdmittedWebhookRecord): CanonicalJsonValue {
  const { processing: _processing, ...immutable } = record;
  return immutable as unknown as CanonicalJsonValue;
}

/**
 * Computes the next record with ONLY the processing sub-object changed.
 * Throws a typed DomainError when anything else differs (immutability) or
 * when the transition is not legal.
 */
export function applyProcessingTransition(
  current: AdmittedWebhookRecord,
  nextProcessing: WebhookProcessingState,
): AdmittedWebhookRecord {
  if (canonicalizeJson(withoutProcessing(current)) !== canonicalizeJson(withoutProcessing({ ...current, processing: nextProcessing }))) {
    throw new DomainError(
      "admitted webhook records are immutable except for their processing state; the admitted content can never be rewritten",
      { reason: "WEBHOOK_INBOX_RECORD_IMMUTABLE" },
    );
  }
  const legal = WEBHOOK_PROCESSING_TRANSITIONS[current.processing.status];
  if (legal === undefined || !legal.includes(nextProcessing.status)) {
    throw new DomainError(
      `illegal webhook processing transition ${current.processing.status} -> ${nextProcessing.status} (PROJECTED is terminal)`,
      { reason: "WEBHOOK_PROCESSING_TRANSITION_INVALID" },
    );
  }
  return Object.freeze({ ...current, processing: Object.freeze(nextProcessing) });
}

// --------------------------------------------------------------------------------
// The async projection port
// --------------------------------------------------------------------------------

/** Everything a projector needs to project one admitted event. */
export interface AdmittedWebhookEventView {
  /** The inbox admission order (the ordering signal for consumers). */
  readonly sequence: number;
  readonly event: AdcosWebhookEvent;
  readonly receivedAt: UtcInstant;
  readonly rawPayload: string;
  readonly payloadDigest: Digest;
}

/** The closed projector outcome vocabulary. */
export type AdcosWebhookProjectionOutcome =
  | { readonly outcome: "APPLIED" }
  | { readonly outcome: "SKIPPED"; readonly reason: string }
  | { readonly outcome: "FAILED"; readonly reason: string };

/**
 * The async projection port. Implementations (the RL-034 projection engine,
 * bound by the reconciler/composition layer) MUST be idempotent:
 * reprocessing an event after a crash must converge to the same state.
 */
export interface AdcosWebhookProjector {
  project(admission: AdmittedWebhookEventView): Promise<AdcosWebhookProjectionOutcome>;
}

// --------------------------------------------------------------------------------
// Admission results
// --------------------------------------------------------------------------------

export type WebhookAdmissionResult =
  | {
      readonly outcome: "ADMITTED";
      readonly sequence: number;
      readonly eventId: string;
      readonly record: AdmittedWebhookRecord;
    }
  | {
      readonly outcome: "DUPLICATE";
      readonly eventId: string;
      readonly originalSequence: number;
    }
  | {
      readonly outcome: "REJECTED";
      readonly code: AdcosErrorCode;
      readonly message: string;
    };

// --------------------------------------------------------------------------------
// The inbox service
// --------------------------------------------------------------------------------

export interface AdcosWebhookInboxServiceOptions {
  readonly verifier: WebhookVerifier;
  /** Opens units of work (admission is transactional). */
  readonly persistence: UnitOfWorkFactory;
  /** Committed-state reads for processing. */
  readonly reader: PersistenceReader;
  readonly clock: Clock;
  /** The async projector; admission works without one, processing does not. */
  readonly projector?: AdcosWebhookProjector;
}

/** Summary of one processPending run. */
export interface WebhookProcessingReport {
  readonly considered: number;
  readonly alreadyProjected: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
  readonly conflicts: number;
}

/**
 * The durable webhook inbox. `admitDelivery` is the synchronous admission
 * path (receive -> authenticate -> replay check -> persist -> acknowledge);
 * `processPending` is the async projection path.
 */
export class AdcosWebhookInboxService {
  readonly #verifier: WebhookVerifier;
  readonly #persistence: UnitOfWorkFactory;
  readonly #reader: PersistenceReader;
  readonly #clock: Clock;
  readonly #projector: AdcosWebhookProjector | undefined;

  constructor(options: AdcosWebhookInboxServiceOptions) {
    this.#verifier = options.verifier;
    this.#persistence = options.persistence;
    this.#reader = options.reader;
    this.#clock = options.clock;
    this.#projector = options.projector;
  }

  // --- admission (receive -> authenticate -> replay check -> persist -> ack) ----

  async admitDelivery(input: AdcosWebhookVerifyInput): Promise<WebhookAdmissionResult> {
    const verification = await this.#verifier.verify(input);
    if (!verification.ok) {
      await this.#recordRejection(input, verification.code);
      return { outcome: "REJECTED", code: verification.code, message: verification.message };
    }

    const event = verification.event;
    const unitOfWork = await this.#persistence.begin();
    try {
      const admission = await unitOfWork.inbox.admit({
        source: ADCOS_WEBHOOK_INBOX_SOURCE,
        externalEventId: event.event_id,
        receivedAt: input.receivedAt,
        dedupeKey: verification.dedupeKey,
      });
      if (admission.outcome === "DUPLICATE") {
        await unitOfWork.commit();
        const original = await this.#reader.inbox.admitted(verification.dedupeKey);
        return {
          outcome: "DUPLICATE",
          eventId: event.event_id,
          originalSequence: original?.sequence ?? admission.original.sequence,
        };
      }
      const record = buildAdmittedRecord(event, verification.delivery, input);
      await unitOfWork.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).insert(event.event_id, record as unknown as CanonicalJsonValue);
      await unitOfWork.commit();
      // Acknowledge ONLY after the durable commit: re-read the committed
      // admission so the sequence is authoritative.
      const committed = await this.#reader.inbox.admitted(verification.dedupeKey);
      return {
        outcome: "ADMITTED",
        sequence: committed?.sequence ?? admission.record.sequence,
        eventId: event.event_id,
        record,
      };
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
  }

  async #recordRejection(input: AdcosWebhookVerifyInput, code: AdcosErrorCode): Promise<void> {
    // Best-effort audit row; malformed deliveries get a deterministic
    // synthetic identity from the payload digest (the dedupe key is NOT
    // occupied by rejections - a corrected retry may still admit).
    const eventId = extractHeaderEventId(input) ?? `unverified-${sha256Hex(input.payload ?? "").slice(0, 16)}`;
    const unitOfWork = await this.#persistence.begin();
    try {
      await unitOfWork.inbox.recordRejection({
        source: ADCOS_WEBHOOK_INBOX_SOURCE,
        externalEventId: eventId,
        receivedAt: input.receivedAt,
        dedupeKey: `rejected-${eventId}-${code}`,
      });
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
  }

  // --- async projection ------------------------------------------------------------

  /**
   * Processes admitted events in ADMISSION ORDER (the inbox sequence): the
   * deterministic processing order. Already-PROJECTED records are no-ops
   * (idempotent reprocessing); FAILED records are retried.
   *
   * Batch progression (AR-008 / RL-094): the batch is the first `limit`
   * records whose processing status is NOT already terminal. Terminal
   * (PROJECTED) records are skipped - counted in `alreadyProjected`, never
   * re-projected - and do NOT consume batch slots, so repeated bounded
   * drains ADVANCE through a backlog larger than the limit: every admitted
   * record reaches a terminal state within ceil(N / limit) successful
   * calls. The admission-order guarantee, the immutability of the admitted
   * content and the CAS conflict discipline are unchanged. Returns when the
   * batch is exhausted or the admitted list is fully scanned.
   */
  async processPending(limit = 50): Promise<WebhookProcessingReport> {
    if (this.#projector === undefined) {
      throw new DomainError(
        "processPending requires a registered AdcosWebhookProjector (the async projection step of spec §6)",
        { reason: "WEBHOOK_INBOX_PROJECTOR_MISSING" },
      );
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError("processPending limit must be a positive integer", {
        reason: "WEBHOOK_INBOX_LIMIT_INVALID",
      });
    }
    const admitted = await this.#reader.inbox.list("ADMITTED");
    const report = {
      considered: 0,
      alreadyProjected: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      conflicts: 0,
    };
    // AR-008 batch progression: select the first `limit` non-terminal
    // records in admission order. Terminal (PROJECTED) records are skipped
    // WITHOUT consuming a batch slot - this is what lets repeated bounded
    // drains progress past a processed prefix instead of re-slicing it
    // forever. Non-terminal records (PENDING and retried FAILED) each
    // consume one slot: an attempt is an attempt.
    let batchRemaining = limit;
    for (const inboxRecord of admitted) {
      if (batchRemaining === 0) break;
      report.considered += 1;
      const stored = await this.#reader.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get(inboxRecord.externalEventId);
      if (stored === null) {
        // Admission without its extended record cannot happen through this
        // service (same unit of work); treat as an integrity problem and
        // fail loudly rather than guess.
        throw new DomainError(
          "an admitted inbox record is missing its immutable extended record (integrity violation; nothing is guessed)",
          { reason: "WEBHOOK_INBOX_RECORD_MISSING" },
        );
      }
      const current = parseAdmittedWebhookRecord(stored.value);
      if (current.processing.status === "PROJECTED") {
        report.alreadyProjected += 1;
        continue; // terminal records never block the batch
      }
      batchRemaining -= 1;
      const outcome = await this.#projector.project({
        sequence: inboxRecord.sequence,
        event: parseAdcosWebhookEvent(JSON.parse(current.raw_payload)),
        receivedAt: current.received_at,
        rawPayload: current.raw_payload,
        payloadDigest: current.payload_digest,
      });
      const at = this.#clock.now();
      const attempts = current.processing.attempts + 1;
      let next: WebhookProcessingState;
      switch (outcome.outcome) {
        case "APPLIED":
          next = {
            status: "PROJECTED",
            attempts,
            projected_at: at,
            last_reason: "APPLIED",
          };
          report.applied += 1;
          break;
        case "SKIPPED":
          next = {
            status: "PROJECTED",
            attempts,
            projected_at: at,
            last_reason: `SKIPPED_${outcome.reason}`,
          };
          report.skipped += 1;
          break;
        case "FAILED":
          next = {
            status: "FAILED",
            attempts,
            last_reason: `FAILED_${outcome.reason}`,
            last_attempted_at: at,
          };
          report.failed += 1;
          break;
      }
      const updated = applyProcessingTransition(current, next);
      const unitOfWork: UnitOfWork = await this.#persistence.begin();
      try {
        await unitOfWork
          .records(ADCOS_WEBHOOK_INBOX_REPOSITORY)
          .compareAndSwap(inboxRecord.externalEventId, stored.version, updated as unknown as CanonicalJsonValue);
        await unitOfWork.commit();
      } catch (error) {
        await unitOfWork.rollback();
        if (isConflictError(error)) {
          // A concurrent processor won the race for this record; its result
          // stands (never overwrite silently).
          report.conflicts += 1;
          continue;
        }
        throw error;
      }
    }
    return Object.freeze(report);
  }
}

// --------------------------------------------------------------------------------
// Record construction helpers
// --------------------------------------------------------------------------------

function buildAdmittedRecord(
  event: AdcosWebhookEvent,
  delivery: AdcosWebhookDelivery,
  input: AdcosWebhookVerifyInput,
): AdmittedWebhookRecord {
  return Object.freeze({
    schema_version: event.api_version,
    source: ADCOS_WEBHOOK_INBOX_SOURCE,
    event_id: event.event_id,
    event_type: event.event_type,
    resource_id: event.resource_id,
    resource_kind: event.resource_kind,
    resource_version: event.resource_version,
    occurred_at: event.occurred_at,
    correlation_id: event.correlation_id,
    environment: event.environment,
    received_at: input.receivedAt,
    delivery: Object.freeze({
      key_id: delivery.keyId,
      algorithm: delivery.algorithm,
      timestamp: delivery.timestamp,
      delivery_id: delivery.deliveryId,
      sequence: delivery.sequence,
      // forensic digest of the signature VALUE - the HMAC secret itself is
      // never persisted or logged (RL-LOCK-016)
      signature_digest: sha256Hex(delivery.signature),
    }),
    raw_payload: input.payload,
    payload_digest: sha256Hex(input.payload),
    processing: Object.freeze({ status: "PENDING" as const, attempts: 0 }),
  });
}

function extractHeaderEventId(input: AdcosWebhookVerifyInput): string | null {
  const headers = input.headers ?? {};
  const value = headers["X-ADCOS-Event-Id"];
  if (typeof value === "string" && value.length > 0 && value.length < 255 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    return value;
  }
  return null;
}

function isConflictError(error: unknown): error is ConflictError {
  return error instanceof ConflictError;
}
