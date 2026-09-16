/**
 * The encrypted offline outbox and sync engine (RL-042, spec/mobile.md
 * "Offline", RL-LOCK-014/015/016; builds on the RL-040 outbox record shape).
 *
 * CIPHERTEXT-ONLY AT REST: the payload (a serialized `DeviceActionRequest`)
 * exists as plaintext only inside transient encrypt/decrypt call frames.
 * The store holds validated {@link EdgeOutboxRecord}s whose payload field is
 * exclusively the {@link import("./outbox.js").EdgeOutboxCiphertextEnvelope}
 * - a plaintext field is not even parseable (the RL-040 parser rejects
 * unknown fields). Key material enters only through the cipher's key
 * provider (the RL-050 boundary).
 *
 * DEDUPE METADATA IN THE CLEAR: command id, idempotency key, the physical
 * action dedupe key and correlation id stay unencrypted so retries can be
 * deduplicated WITHOUT decrypting anything (RL-LOCK-014).
 *
 * SYNC: `syncDue` claims due PENDING records (bounded batch), decrypts,
 * delivers through the {@link EdgeSyncTransport} port and applies the
 * outcome: accepted -> synced; retryable failure / unknown outcome ->
 * re-queued with exponential backoff until the per-record retry policy is
 * exhausted (dead-letter); conflict -> the EXPLICIT conflict policy
 * (server-wins discharges the obligation, local-wins re-delivers later,
 * require-manual parks the record for `resolveConflict`). A THROWING
 * transport is a retryable failure with a suppressed reason (third-party
 * error text may carry secrets - RL-LOCK-016).
 *
 * REPLAY-SAFE REDELIVERY: `recoverInFlight` re-queues records left in-flight
 * by a crash/restart; redelivery is at-least-once and safe because every
 * carried command is idempotency-keyed (RL-LOCK-014).
 *
 * HONEST BOUNDARY STATES: `boundaryState` reports synced / pending /
 * conflict / degraded per record - dead-lettered records are `degraded`
 * (never a silent success), unresolved manual conflicts are `conflict`.
 */
import {
  ConflictError,
  DomainError,
  ValidationError,
  addMilliseconds,
  canonicalizeJson,
  epochMsOf,
  parseUtcInstant,
  type Freshness,
  type UtcInstant,
} from "@roamlink/contracts";

import type { DeviceActionRequest } from "../action/device-action.js";
import {
  makeEdgeOutboxRetryPolicy,
  parseEdgeOutboxRecord,
  type EdgeOutboxRecord,
  type EdgeOutboxRetryPolicy,
  type EdgeOutboxRetryPolicyInput,
} from "./outbox.js";
import type { EdgePayloadCipher } from "./payload-codec.js";
import { EDGE_CONTRACT_VERSION } from "../version.js";
import {
  parseEdgeDesiredStateId,
  parseEdgeDeviceRef,
  parseEdgeOutboxRecordId,
  type EdgeDesiredStateId,
  type EdgeDeviceRef,
  type EdgeOutboxRecordId,
} from "../ids.js";

// ---------------------------------------------------------------------------
// Retry scheduling (pure)
// ---------------------------------------------------------------------------

/**
 * The backoff after `attempts` started attempts failed:
 * `initialBackoffMs * multiplier^(attempts - 1)`, clamped to `maxBackoffMs`.
 */
export function edgeOutboxRetryDelayMs(policy: EdgeOutboxRetryPolicy, attempts: number): number {
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) {
    throw new ValidationError("attempts must be a positive integer", {
      reason: "EDGE_OUTBOX_SCHEDULE_INVALID",
      details: [{ path: "attempts", issue: "not a positive integer" }],
    });
  }
  const exponent = Math.min(attempts - 1, 62);
  const raw = policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, exponent);
  return Math.min(Math.max(1, Math.round(raw)), policy.maxBackoffMs);
}

/** The instant a PENDING record next becomes due (null when terminal). */
export function edgeOutboxNextDueAt(record: EdgeOutboxRecord): UtcInstant | null {
  if (record.state === "synced" || record.state === "dead-lettered") {
    return null;
  }
  if (record.lastAttemptAt === null) {
    return record.createdAt;
  }
  return addMilliseconds(record.lastAttemptAt, edgeOutboxRetryDelayMs(record.retryPolicy, record.attempts));
}

// ---------------------------------------------------------------------------
// Store port + in-memory implementation
// ---------------------------------------------------------------------------

/** Durable storage for ciphertext-only outbox records (device DB adapter later). */
export interface EdgeOutboxStore {
  /** Inserts or replaces the record under its id (engine owns identity). */
  save(record: EdgeOutboxRecord): Promise<void>;
  get(outboxRecordId: string): Promise<EdgeOutboxRecord | null>;
  list(state?: EdgeOutboxRecord["state"]): Promise<readonly EdgeOutboxRecord[]>;
  findByCommandIdempotencyKey(key: string): Promise<EdgeOutboxRecord | null>;
  findByActionDedupeKey(key: string): Promise<EdgeOutboxRecord | null>;
}

/** Deterministic in-memory store (tests, local dev, examples). */
export class InMemoryEdgeOutboxStore implements EdgeOutboxStore {
  readonly #byId = new Map<EdgeOutboxRecordId, EdgeOutboxRecord>();

  async save(record: EdgeOutboxRecord): Promise<void> {
    this.#byId.set(record.outboxRecordId, record);
  }

  async get(outboxRecordId: string): Promise<EdgeOutboxRecord | null> {
    const id = parseEdgeOutboxRecordId(outboxRecordId);
    return this.#byId.get(id) ?? null;
  }

  async list(state?: EdgeOutboxRecord["state"]): Promise<readonly EdgeOutboxRecord[]> {
    const all = [...this.#byId.values()];
    const filtered = state === undefined ? all : all.filter((record) => record.state === state);
    return Object.freeze(filtered.sort((a, b) => epochMsOf(a.createdAt) - epochMsOf(b.createdAt)));
  }

  async findByCommandIdempotencyKey(key: string): Promise<EdgeOutboxRecord | null> {
    return (
      [...this.#byId.values()].find((record) => record.commandIdempotencyKey === key) ?? null
    );
  }

  async findByActionDedupeKey(key: string): Promise<EdgeOutboxRecord | null> {
    return [...this.#byId.values()].find((record) => record.actionDedupeKey === key) ?? null;
  }

  /** Frozen snapshot of everything persisted (ciphertext-only by contract). */
  contents(): readonly EdgeOutboxRecord[] {
    return Object.freeze([...this.#byId.values()]);
  }
}

// ---------------------------------------------------------------------------
// Transport port + sync vocabulary
// ---------------------------------------------------------------------------

/** What the receiving side reported for one delivered payload. */
export type EdgeSyncDeliveryOutcome =
  | { readonly outcome: "accepted" }
  /** Transient failure: re-queue with backoff. */
  | { readonly outcome: "retryable-failure"; readonly reason?: string }
  /** The server holds divergent state: apply the conflict policy. */
  | { readonly outcome: "conflict"; readonly detail?: string }
  /** Timeout/unknown: re-queue (at-least-once; the command is idempotent). */
  | { readonly outcome: "unknown" };

/** One decrypted delivery handed to the transport (plaintext is transient). */
export interface EdgeSyncDelivery {
  readonly record: EdgeOutboxRecord;
  /** The decrypted payload - NEVER persisted, only passed to the transport. */
  readonly plaintext: string;
}

/** The sync transport port (the server-side ingestion seam). */
export interface EdgeSyncTransport {
  deliver(delivery: EdgeSyncDelivery): Promise<EdgeSyncDeliveryOutcome>;
}

/** The closed conflict-policy vocabulary. */
export const EDGE_SYNC_CONFLICT_POLICIES = ["server-wins", "local-wins", "require-manual"] as const;

export type EdgeSyncConflictPolicy = (typeof EDGE_SYNC_CONFLICT_POLICIES)[number];

export function parseEdgeSyncConflictPolicy(value: unknown): EdgeSyncConflictPolicy {
  if (
    typeof value !== "string" ||
    !(EDGE_SYNC_CONFLICT_POLICIES as readonly string[]).includes(value)
  ) {
    throw new ValidationError(
      "conflict policy must be one of server-wins, local-wins, require-manual",
      {
        reason: "EDGE_SYNC_CONFLICT_POLICY_INVALID",
        details: [{ path: "conflictPolicy", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value as EdgeSyncConflictPolicy;
}

/** The honest per-record boundary states surfaced to UX. */
export const EDGE_SYNC_BOUNDARY_STATES = ["synced", "pending", "conflict", "degraded"] as const;

export type EdgeSyncBoundaryState = (typeof EDGE_SYNC_BOUNDARY_STATES)[number];

/** Engine-side conflict marker (the RL-040 record shape stays untouched). */
interface ConflictMarker {
  readonly detail: string | null;
  readonly recordedAt: UtcInstant;
  resolvedAs: "server" | "local" | "manual-server" | "manual-local" | null;
}

/** Manual conflict resolutions. */
export const EDGE_SYNC_CONFLICT_RESOLUTIONS = ["accept-server", "force-local"] as const;

export type EdgeSyncConflictResolution = (typeof EDGE_SYNC_CONFLICT_RESOLUTIONS)[number];

/** Options for {@link EdgeOfflineOutbox.syncDue}. */
export interface SyncDueOptions {
  /** Maximum records claimed per run (default 10). */
  readonly limit?: number;
  /** Conflict policy applied to `conflict` outcomes (default require-manual). */
  readonly conflictPolicy?: EdgeSyncConflictPolicy;
}

/** The report of one sync run. */
export interface EdgeSyncRunReport {
  readonly claimed: number;
  readonly synced: readonly EdgeOutboxRecordId[];
  readonly requeued: readonly EdgeOutboxRecordId[];
  readonly deadLettered: readonly EdgeOutboxRecordId[];
  readonly conflicts: readonly { readonly recordId: EdgeOutboxRecordId; readonly policy: EdgeSyncConflictPolicy }[];
}

/** Outcome of an enqueue. */
export type EdgeOutboxEnqueueOutcome =
  | { readonly outcome: "ENQUEUED"; readonly record: EdgeOutboxRecord }
  | { readonly outcome: "ALREADY_ENQUEUED"; readonly record: EdgeOutboxRecord };

/** Context needed to enqueue a request into the offline outbox. */
export interface EdgeOutboxEnqueueContext {
  readonly deviceRef: string;
  readonly desiredStateId: string;
  readonly lastKnownFreshness: Freshness;
}

/** Options for {@link EdgeOfflineOutbox}. */
export interface EdgeOfflineOutboxOptions {
  readonly store: EdgeOutboxStore;
  readonly cipher: EdgePayloadCipher;
  /** Key REFERENCE used for new encryptions (rotation-aware via the provider). */
  readonly keyId: string;
  /** Outbox-record id source; inject a deterministic generator in tests. */
  readonly idGenerator: () => string;
  /** Default per-record retry policy. */
  readonly defaultRetryPolicy: EdgeOutboxRetryPolicyInput;
}

// ---------------------------------------------------------------------------
// Pure state-machine transitions (persisted by the engine through the parser)
// ---------------------------------------------------------------------------

function rebuild(record: EdgeOutboxRecord, changes: Partial<Record<string, unknown>>): EdgeOutboxRecord {
  return parseEdgeOutboxRecord({
    ...record,
    ...changes,
    retryPolicy: {
      maxAttempts: record.retryPolicy.maxAttempts,
      initialBackoffMs: record.retryPolicy.initialBackoffMs,
      backoffMultiplier: record.retryPolicy.backoffMultiplier,
      maxBackoffMs: record.retryPolicy.maxBackoffMs,
    },
  });
}

/** PENDING -> IN-FLIGHT: counts the attempt and stamps `at`. */
export function claimEdgeOutboxRecord(record: EdgeOutboxRecord, at: UtcInstant): EdgeOutboxRecord {
  if (record.state !== "pending") {
    throw new ConflictError(`cannot claim an outbox record in state ${record.state}`, {
      reason: "EDGE_OUTBOX_TRANSITION_INVALID",
    });
  }
  const dueAt = edgeOutboxNextDueAt(record);
  if (dueAt === null || epochMsOf(dueAt) > epochMsOf(at)) {
    throw new ConflictError("the outbox record is not due at the given instant", {
      reason: "EDGE_OUTBOX_NOT_DUE",
    });
  }
  return rebuild(record, { state: "in-flight", attempts: record.attempts + 1, lastAttemptAt: at });
}

/** IN-FLIGHT -> SYNCED (terminal). */
export function completeEdgeOutboxRecord(record: EdgeOutboxRecord): EdgeOutboxRecord {
  if (record.state !== "in-flight") {
    throw new ConflictError(`cannot complete an outbox record in state ${record.state}`, {
      reason: "EDGE_OUTBOX_TRANSITION_INVALID",
    });
  }
  return rebuild(record, { state: "synced" });
}

/**
 * IN-FLIGHT -> PENDING (retry scheduled) or IN-FLIGHT -> DEAD-LETTERED when
 * the per-record retry policy is exhausted.
 */
export function failEdgeOutboxAttempt(
  record: EdgeOutboxRecord,
  at: UtcInstant,
  reason?: string,
): EdgeOutboxRecord {
  if (record.state !== "in-flight") {
    throw new ConflictError(`cannot fail an outbox record in state ${record.state}`, {
      reason: "EDGE_OUTBOX_TRANSITION_INVALID",
    });
  }
  if (reason !== undefined && !/^[A-Z][A-Z0-9_]{2,63}$/.test(reason)) {
    throw new ValidationError("failure reasons must be UPPER_SNAKE_CASE reason codes", {
      reason: "EDGE_OUTBOX_REASON_INVALID",
      details: [{ path: "reason", issue: "not a reason code" }],
    });
  }
  if (record.attempts >= record.retryPolicy.maxAttempts) {
    return rebuild(record, { state: "dead-lettered" });
  }
  return rebuild(record, { state: "pending" });
}

/** IN-FLIGHT -> PENDING without a new attempt (crash recovery redelivery). */
export function recoverEdgeOutboxRecord(record: EdgeOutboxRecord): EdgeOutboxRecord {
  if (record.state !== "in-flight") {
    throw new ConflictError(`cannot recover an outbox record in state ${record.state}`, {
      reason: "EDGE_OUTBOX_TRANSITION_INVALID",
    });
  }
  return rebuild(record, { state: "pending" });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * The edge-side offline queue. All operations take EXPLICIT UTC instants
 * (deterministic under the testkit clock); payload plaintext exists only
 * inside encrypt/decrypt frames and transport calls.
 */
export class EdgeOfflineOutbox {
  readonly #store: EdgeOutboxStore;
  readonly #cipher: EdgePayloadCipher;
  readonly #keyId: string;
  readonly #idGenerator: () => string;
  readonly #defaultRetryPolicy: EdgeOutboxRetryPolicy;
  readonly #conflicts = new Map<EdgeOutboxRecordId, ConflictMarker>();

  constructor(options: EdgeOfflineOutboxOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("EdgeOfflineOutboxOptions must be an object", {
        reason: "EDGE_OFFLINE_OUTBOX_INVALID",
        details: [{ path: "EdgeOfflineOutboxOptions", issue: "not an object" }],
      });
    }
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#keyId = options.keyId;
    this.#idGenerator = options.idGenerator;
    this.#defaultRetryPolicy = makeEdgeOutboxRetryPolicy(options.defaultRetryPolicy);
  }

  /**
   * Encrypts the action request and enqueues it as a PENDING record. Duplicate
   * command idempotency keys are idempotent (ALREADY_ENQUEUED for the same
   * ciphertext digest, a typed conflict for a different payload); a physical
   * action dedupe key may back at most ONE record.
   */
  async enqueue(
    request: DeviceActionRequest,
    context: EdgeOutboxEnqueueContext,
    at: UtcInstant | string,
  ): Promise<EdgeOutboxEnqueueOutcome> {
    const instant = parseUtcInstant(at);
    const deviceRef: EdgeDeviceRef = parseEdgeDeviceRef(context.deviceRef);
    const desiredStateId: EdgeDesiredStateId = parseEdgeDesiredStateId(context.desiredStateId);
    if (context.lastKnownFreshness === null || typeof context.lastKnownFreshness !== "object") {
      throw new ValidationError("lastKnownFreshness must be a Wave-0 freshness record", {
        reason: "EDGE_OUTBOX_ENQUEUE_INVALID",
        details: [{ path: "lastKnownFreshness", issue: "not a freshness record" }],
      });
    }

    const existingByKey = await this.#store.findByCommandIdempotencyKey(request.command.idempotencyKey);
    if (existingByKey !== null) {
      // Same command re-enqueued: idempotent (the stored ciphertext is the
      // same command's; comparing command ids is sufficient because the
      // idempotency key -> command mapping is 1:1 in the envelope contract).
      if (existingByKey.commandId === request.command.commandId) {
        return { outcome: "ALREADY_ENQUEUED", record: existingByKey };
      }
      throw new ConflictError(
        "a different command is already enqueued under this idempotency key (idempotency keys map to exactly one command - RL-LOCK-014)",
        { reason: "EDGE_OUTBOX_IDEMPOTENCY_CONFLICT" },
      );
    }
    const existingByAction = await this.#store.findByActionDedupeKey(request.dedupeKey);
    if (existingByAction !== null) {
      throw new ConflictError(
        "a record already exists for this physical action dedupe key (a device action must not be queued twice - RL-LOCK-014)",
        { reason: "EDGE_OUTBOX_ACTION_DEDUPE_CONFLICT" },
      );
    }

    // Transient plaintext: serialized, encrypted, dropped.
    const plaintext = canonicalizeJson(request.toPlain());
    const ciphertext = await this.#cipher.encrypt(this.#keyId, plaintext);
    const record = parseEdgeOutboxRecord({
      outboxRecordId: this.#idGenerator(),
      contractVersion: EDGE_CONTRACT_VERSION,
      deviceRef,
      desiredStateId,
      actionDedupeKey: request.dedupeKey,
      commandIdempotencyKey: request.command.idempotencyKey,
      commandId: request.command.commandId,
      correlationId: request.command.correlationId,
      ciphertextEnvelope: {
        algorithm: this.#cipher.algorithm,
        keyId: this.#keyId,
        ciphertext,
      },
      state: "pending",
      retryPolicy: {
        maxAttempts: this.#defaultRetryPolicy.maxAttempts,
        initialBackoffMs: this.#defaultRetryPolicy.initialBackoffMs,
        backoffMultiplier: this.#defaultRetryPolicy.backoffMultiplier,
        maxBackoffMs: this.#defaultRetryPolicy.maxBackoffMs,
      },
      attempts: 0,
      lastAttemptAt: null,
      createdAt: instant,
      lastKnownFreshness: context.lastKnownFreshness,
    });
    await this.#store.save(record);
    return { outcome: "ENQUEUED", record };
  }

  /**
   * Claims due PENDING records (bounded by `limit`), decrypts and delivers
   * them sequentially, and applies the transport outcome per record.
   */
  async syncDue(
    at: UtcInstant | string,
    transport: EdgeSyncTransport,
    options?: SyncDueOptions,
  ): Promise<EdgeSyncRunReport> {
    const instant = parseUtcInstant(at);
    const limit = options?.limit ?? 10;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit must be an integer between 1 and 100", {
        reason: "EDGE_SYNC_RUN_INVALID",
        details: [{ path: "limit", issue: "out of bounds" }],
      });
    }
    const conflictPolicy = parseEdgeSyncConflictPolicy(options?.conflictPolicy ?? "require-manual");

    const pending = (await this.#store.list("pending")).filter((record) => {
      // Records parked by an unresolved manual conflict are NOT claimable.
      const marker = this.#conflicts.get(record.outboxRecordId);
      if (marker !== undefined && marker.resolvedAs === null) return false;
      const dueAt = edgeOutboxNextDueAt(record);
      return dueAt !== null && epochMsOf(dueAt) <= epochMsOf(instant);
    });
    const batch = pending.slice(0, limit);

    const synced: EdgeOutboxRecordId[] = [];
    const requeued: EdgeOutboxRecordId[] = [];
    const deadLettered: EdgeOutboxRecordId[] = [];
    const conflicts: { recordId: EdgeOutboxRecordId; policy: EdgeSyncConflictPolicy }[] = [];

    for (const pendingRecord of batch) {
      const claimed = claimEdgeOutboxRecord(pendingRecord, instant);
      await this.#store.save(claimed);
      const plaintext = await this.#cipher.decrypt(this.#keyId, claimed.ciphertextEnvelope.ciphertext);
      let outcome: EdgeSyncDeliveryOutcome;
      try {
        outcome = await transport.deliver({ record: claimed, plaintext });
      } catch {
        // Third-party transport errors are suppressed (RL-LOCK-016).
        outcome = { outcome: "retryable-failure", reason: "TRANSPORT_ERROR" };
      }
      switch (outcome.outcome) {
        case "accepted": {
          const completed = completeEdgeOutboxRecord(claimed);
          await this.#store.save(completed);
          synced.push(claimed.outboxRecordId);
          break;
        }
        case "retryable-failure":
        case "unknown": {
          const next = failEdgeOutboxAttempt(
            claimed,
            instant,
            outcome.outcome === "unknown" ? "OUTCOME_UNKNOWN" : outcome.reason,
          );
          await this.#store.save(next);
          if (next.state === "dead-lettered") {
            deadLettered.push(claimed.outboxRecordId);
          } else {
            requeued.push(claimed.outboxRecordId);
          }
          break;
        }
        case "conflict": {
          conflicts.push({ recordId: claimed.outboxRecordId, policy: conflictPolicy });
          const marker: ConflictMarker = {
            detail: outcome.detail ?? null,
            recordedAt: instant,
            resolvedAs: null,
          };
          this.#conflicts.set(claimed.outboxRecordId, marker);
          if (conflictPolicy === "server-wins") {
            // The server's state prevails: the delivery obligation is
            // discharged; the conflict marker records the divergence.
            const completed = completeEdgeOutboxRecord(claimed);
            await this.#store.save(completed);
            marker.resolvedAs = "server";
            synced.push(claimed.outboxRecordId);
          } else if (conflictPolicy === "local-wins") {
            // The local state prevails: re-deliver later with backoff.
            const next = failEdgeOutboxAttempt(claimed, instant, "SYNC_CONFLICT_LOCAL_WINS");
            await this.#store.save(next);
            marker.resolvedAs = "local";
            if (next.state === "dead-lettered") {
              deadLettered.push(claimed.outboxRecordId);
            } else {
              requeued.push(claimed.outboxRecordId);
            }
          } else {
            // require-manual: park the record with an UNRESOLVED marker. The
            // record itself stays in a contract-legal state (pending while
            // budget remains, dead-lettered once exhausted) but the ENGINE
            // refuses to claim it until `resolveConflict` - the boundary
            // state honestly reports `conflict`.
            const parked = failEdgeOutboxAttempt(claimed, instant, "SYNC_CONFLICT_MANUAL");
            await this.#store.save(parked);
          }
          break;
        }
      }
    }
    return Object.freeze({
      claimed: batch.length,
      synced: Object.freeze(synced),
      requeued: Object.freeze(requeued),
      deadLettered: Object.freeze(deadLettered),
      conflicts: Object.freeze(conflicts),
    });
  }

  /**
   * Re-queues records left IN-FLIGHT by a crash/restart (at-least-once
   * redelivery; safe because every command is idempotency-keyed).
   */
  async recoverInFlight(at: UtcInstant | string): Promise<readonly EdgeOutboxRecord[]> {
    parseUtcInstant(at); // validate the instant explicitly
    const inFlight = await this.#store.list("in-flight");
    for (const record of inFlight) {
      await this.#store.save(recoverEdgeOutboxRecord(record));
    }
    return Object.freeze(inFlight);
  }

  /**
   * Resolves a record parked by the `require-manual` conflict policy.
   * `accept-server` marks it synced; `force-local` re-queues it with a FRESH
   * retry budget (a human decided to redeliver).
   */
  async resolveConflict(
    outboxRecordId: string,
    resolution: EdgeSyncConflictResolution,
    at: UtcInstant | string,
  ): Promise<EdgeOutboxRecord> {
    if (
      typeof resolution !== "string" ||
      !(EDGE_SYNC_CONFLICT_RESOLUTIONS as readonly string[]).includes(resolution)
    ) {
      throw new ValidationError("resolution must be accept-server or force-local", {
        reason: "EDGE_SYNC_RESOLUTION_INVALID",
        details: [{ path: "resolution", issue: "outside the closed vocabulary" }],
      });
    }
    const instant = parseUtcInstant(at);
    const id = parseEdgeOutboxRecordId(outboxRecordId);
    const record = await this.#store.get(id);
    if (record === null) {
      throw new ConflictError("no outbox record exists under this id", {
        reason: "EDGE_OUTBOX_NOT_FOUND",
      });
    }
    const marker = this.#conflicts.get(id);
    if (marker === undefined) {
      throw new ConflictError("the record carries no conflict to resolve", {
        reason: "EDGE_SYNC_NO_CONFLICT",
      });
    }
    if (marker.resolvedAs !== null) {
      throw new ConflictError("the record's conflict is already resolved", {
        reason: "EDGE_SYNC_CONFLICT_ALREADY_RESOLVED",
      });
    }
    if (resolution === "accept-server") {
      marker.resolvedAs = "manual-server";
      // The delivery obligation is discharged manually. The record was
      // claimed at least once before the conflict (attempts >= 1 with a
      // lastAttemptAt), so the synced-state invariants hold.
      const completed = rebuild(record, { state: "synced" });
      await this.#store.save(completed);
      return completed;
    }
    marker.resolvedAs = "manual-local";
    const redelivered = parseEdgeOutboxRecord({
      ...record,
      state: "pending",
      attempts: 0,
      lastAttemptAt: null,
      createdAt: instant,
      retryPolicy: {
        maxAttempts: record.retryPolicy.maxAttempts,
        initialBackoffMs: record.retryPolicy.initialBackoffMs,
        backoffMultiplier: record.retryPolicy.backoffMultiplier,
        maxBackoffMs: record.retryPolicy.maxBackoffMs,
      },
    });
    await this.#store.save(redelivered);
    return redelivered;
  }

  /** The honest boundary state of a record (see module doc). */
  async boundaryState(outboxRecordId: string): Promise<EdgeSyncBoundaryState | null> {
    const id = parseEdgeOutboxRecordId(outboxRecordId);
    const record = await this.#store.get(id);
    if (record === null) return null;
    const marker = this.#conflicts.get(id);
    if (marker !== undefined && marker.resolvedAs === null) {
      // An unresolved manual conflict is a `conflict`, whatever the parked
      // record's underlying retry state happens to be.
      return "conflict";
    }
    switch (record.state) {
      case "synced":
        return "synced";
      case "dead-lettered":
        return "degraded";
      default:
        return "pending";
    }
  }

  /** Refreshes a record's last-known freshness (redelivery metadata). */
  async refreshFreshness(
    outboxRecordId: string,
    freshness: Freshness,
  ): Promise<EdgeOutboxRecord> {
    const id = parseEdgeOutboxRecordId(outboxRecordId);
    const record = await this.#store.get(id);
    if (record === null) {
      throw new ConflictError("no outbox record exists under this id", {
        reason: "EDGE_OUTBOX_NOT_FOUND",
      });
    }
    if (record.state === "synced" || record.state === "dead-lettered") {
      throw new DomainError("terminal outbox records are immutable history", {
        reason: "EDGE_OUTBOX_TERMINAL",
      });
    }
    const next = rebuild(record, { lastKnownFreshness: freshness });
    await this.#store.save(next);
    return next;
  }

  /** The recorded conflict detail for a record (value-free observability). */
  conflictDetail(outboxRecordId: string): { readonly detail: string | null; readonly resolvedAs: string | null } | null {
    const marker = this.#conflicts.get(parseEdgeOutboxRecordId(outboxRecordId));
    return marker === undefined
      ? null
      : Object.freeze({ detail: marker.detail, resolvedAs: marker.resolvedAs });
  }
}
