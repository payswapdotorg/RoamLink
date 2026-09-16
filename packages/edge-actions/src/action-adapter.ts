/**
 * The device action adapter (RL-043, spec/mobile.md "Edge desired-state loop":
 * `local context -> evaluate RoamLink experience policy -> produce desired
 * experience action -> queue command -> server/ADCOS integration -> receive
 * authoritative result -> update local projection`).
 *
 * The adapter is the action-execution half of the RL-040 edge capability
 * contract, composed behind stable seams:
 *
 *  - CAPABILITY GATE (RL-LOCK-011): every action - executed OR queued toward
 *    the server/ADCOS integration - passes `admitDeviceAction` first. Absence
 *    of a capability snapshot is the absent-evidence path: admission fails
 *    closed as `unsupported`/`capability-unknown`. Unsupported
 *    capability/platform combos degrade to typed, diagnosable states - never
 *    best-effort guesses.
 *  - PLATFORM SEAM (RL-LOCK-013): execution crosses only the
 *    {@link PlatformActionExecutor} port; no platform type leaks. A physical
 *    success is declared ONLY from an executor outcome carrying real platform
 *    evidence; a success-without-evidence is converted into a typed `failed`
 *    result, never an executed claim (RL-LOCK-011 evidence discipline).
 *  - OFFLINE QUEUE (RL-LOCK-015/014): admitted commands enqueue into the
 *    RL-042 encrypted offline outbox (dedupe by command idempotency key and
 *    physical action dedupe key); `sync`/`recoverInFlight` replay safely. The
 *    projection honestly reports `synced` as queued-accepted - the server
 *    accepting a command is NOT physical success.
 *  - AUTHORITATIVE RESULTS: `receiveAuthoritativeResult` validates a
 *    server-issued result through the RL-040 honesty rules (an
 *    `executed-observed` claim requires evidence) and updates the local
 *    projection (RL-LOCK-010).
 *
 * The adapter executes RoamLink/edge policy only. It never touches ADCOS
 * directly and never becomes a connectivity authority (RL-LOCK-006): ADCOS
 * results arrive as validated `DeviceActionResult` records through the sync
 * boundary.
 */
import { DomainError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import {
  DeviceActionResult,
  type CapabilityGateDecision,
  type DeviceActionRequest,
  type EdgeCapabilityName,
  type EdgeCapabilitySnapshot,
  type EdgeCapabilitySnapshotPlain,
  type EdgeOfflineOutbox,
  type EdgeOutboxEnqueueContext,
  type EdgeOutboxEnqueueOutcome,
  type EdgeOutboxRecord,
  type EdgeOutboxRecordId,
  type EdgeOutboxStore,
  type EdgeSyncRunReport,
  type EdgeSyncTransport,
  type SyncDueOptions,
} from "@roamlink/edge";

import { admitDeviceAction, type DeviceActionAdmission } from "./admission.js";
import {
  parsePlatformExecutionOutcome,
  type PlatformActionExecutor,
} from "./platform-executor.js";
import type {
  DeviceActionProjectionEntry,
  DeviceActionProjectionStore,
} from "./projection.js";
import { assertDeviceCapabilityVocabularyAlignment } from "./vocabulary-alignment.js";

/** Result descriptor for results about actions this adapter did not itself queue. */
export interface AuthoritativeResultDescriptor {
  readonly capability: EdgeCapabilityName;
  readonly commandId: string;
  readonly correlationId: string;
  readonly actionDedupeKey: string;
  readonly deviceRef?: string | null;
}

/** Options for {@link DeviceActionAdapter}. */
export interface DeviceActionAdapterOptions {
  /**
   * Supplies the CURRENT capability snapshot. Returning null means "no
   * evidence at all" - the absent-evidence path; every admission then fails
   * closed as capability-unknown (RL-LOCK-011).
   */
  readonly capabilitySnapshotProvider: () => EdgeCapabilitySnapshot | EdgeCapabilitySnapshotPlain | null;
  /** The stable platform seam implementation (RL-LOCK-013). */
  readonly executor: PlatformActionExecutor;
  /** The local projection store. */
  readonly projection: DeviceActionProjectionStore;
  /**
   * The RL-042 encrypted offline outbox. When absent, queue/sync/recover fail
   * closed with a typed wiring error (never a silent no-op).
   */
  readonly outbox?: EdgeOfflineOutbox;
  /**
   * The outbox's durable store - used to map sync-run records back to their
   * physical action dedupe keys for projection updates. Required together
   * with `outbox`.
   */
  readonly outboxStore?: EdgeOutboxStore;
}

/** The outcome of a queue attempt. */
export type DeviceActionQueueOutcome =
  | {
      readonly outcome: "BLOCKED";
      readonly admission: DeviceActionAdmission;
      readonly result: DeviceActionResult;
    }
  | {
      readonly outcome: "ENQUEUED" | "ALREADY_ENQUEUED";
      readonly enqueue: EdgeOutboxEnqueueOutcome;
      readonly admission: DeviceActionAdmission & { readonly admission: "ADMITTED" };
    };

const NO_SNAPSHOT_DETAIL =
  "no capability snapshot is available; absence of evidence never assumes availability (RL-LOCK-011)";

/**
 * The adapter. All operations take EXPLICIT UTC instants (deterministic under
 * the testkit clock). Nothing here talks to a platform, provider or ADCOS
 * except through the injected seams.
 */
export class DeviceActionAdapter {
  readonly #options: DeviceActionAdapterOptions;
  readonly #vocabulary: readonly string[];

  constructor(options: DeviceActionAdapterOptions) {
    if (options === null || typeof options !== "object") {
      throw new DomainError("DeviceActionAdapterOptions must be an object", {
        reason: "EDGE_ACTION_ADAPTER_INVALID",
      });
    }
    if (typeof options.capabilitySnapshotProvider !== "function") {
      throw new DomainError("a capability snapshot provider is required", {
        reason: "EDGE_ACTION_ADAPTER_INVALID",
        details: [{ path: "capabilitySnapshotProvider", issue: "not a function" }],
      });
    }
    if (options.executor === null || typeof options.executor !== "object") {
      throw new DomainError("a platform action executor is required", {
        reason: "EDGE_ACTION_ADAPTER_INVALID",
        details: [{ path: "executor", issue: "not the PlatformActionExecutor seam" }],
      });
    }
    if (options.projection === null || typeof options.projection !== "object") {
      throw new DomainError("a projection store is required", {
        reason: "EDGE_ACTION_ADAPTER_INVALID",
        details: [{ path: "projection", issue: "not a DeviceActionProjectionStore" }],
      });
    }
    if (options.outbox !== undefined && options.outboxStore === undefined) {
      throw new DomainError(
        "wiring the offline outbox requires its store (sync-run records must map back to physical action dedupe keys)",
        { reason: "EDGE_ACTION_ADAPTER_INVALID" },
      );
    }
    // Fail closed if the edge and registry capability vocabularies drifted.
    this.#vocabulary = assertDeviceCapabilityVocabularyAlignment();
    this.#options = options;
  }

  /** The DeviceCapabilitySnapshot closed vocabulary the adapter gates against. */
  get capabilityVocabulary(): readonly string[] {
    return this.#vocabulary;
  }

  /**
   * PURE admission of a request as of `at` against the current capability
   * snapshot. The single entry criterion for execute and queue.
   */
  admit(request: DeviceActionRequest, at: UtcInstant | string): DeviceActionAdmission {
    const instant = parseUtcInstant(at);
    const snapshot = this.#options.capabilitySnapshotProvider();
    if (snapshot === null || snapshot === undefined) {
      // The absent-evidence path: honest, typed, diagnosable.
      return this.#absentEvidenceAdmission(request, instant);
    }
    return admitDeviceAction(snapshot, request, instant);
  }

  /**
   * Executes one action through the platform seam. Replay-safe: an action
   * already recorded as `executed-observed` returns its recorded result
   * without touching the platform again (RL-LOCK-014 - a physical action
   * applies once).
   */
  async execute(request: DeviceActionRequest, at: UtcInstant | string): Promise<DeviceActionResult> {
    const instant = parseUtcInstant(at);

    const prior = await this.#options.projection.get(request.actionId);
    if (prior?.latestResult?.status === "executed-observed") {
      // Re-delivery of an already-evidenced execution: the recorded result IS
      // the honest outcome; refresh received freshness only.
      await this.#options.projection.recordResult({
        actionId: request.actionId,
        capability: request.capabilityRequirement.capability,
        actionDedupeKey: request.dedupeKey,
        commandId: request.command.commandId,
        correlationId: request.command.correlationId,
        source: "local-execution",
        result: DeviceActionResult.fromPlain(prior.latestResult),
        at: instant,
      });
      return DeviceActionResult.fromPlain(prior.latestResult);
    }

    const admission = this.admit(request, instant);
    if (admission.admission !== "ADMITTED") {
      await this.#options.projection.recordResult({
        actionId: request.actionId,
        capability: request.capabilityRequirement.capability,
        actionDedupeKey: request.dedupeKey,
        commandId: request.command.commandId,
        correlationId: request.command.correlationId,
        source: "local-execution",
        result: admission.result,
        at: instant,
      });
      return admission.result;
    }

    const outcome = await this.#executorOutcome(request, instant);
    const result = this.#resultFromOutcome(request, outcome, instant);
    await this.#options.projection.recordResult({
      actionId: request.actionId,
      capability: request.capabilityRequirement.capability,
      actionDedupeKey: request.dedupeKey,
      commandId: request.command.commandId,
      correlationId: request.command.correlationId,
      source: "local-execution",
      result,
      at: instant,
    });
    return result;
  }

  /**
   * Admits and enqueues a command toward the server/ADCOS integration into
   * the encrypted offline outbox. Blocked actions are never queued - their
   * typed result is recorded in the projection instead. Idempotent under the
   * command idempotency key; a different command under the same physical
   * action dedupe key is a typed conflict (RL-LOCK-014).
   */
  async queue(
    request: DeviceActionRequest,
    context: EdgeOutboxEnqueueContext,
    at: UtcInstant | string,
  ): Promise<DeviceActionQueueOutcome> {
    const instant = parseUtcInstant(at);
    this.#requireOutbox();

    const admission = this.admit(request, instant);
    if (admission.admission !== "ADMITTED") {
      await this.#options.projection.recordResult({
        actionId: request.actionId,
        capability: request.capabilityRequirement.capability,
        actionDedupeKey: request.dedupeKey,
        commandId: request.command.commandId,
        correlationId: request.command.correlationId,
        source: "local-execution",
        result: admission.result,
        at: instant,
      });
      return { outcome: "BLOCKED", admission, result: admission.result };
    }

    const enqueue = await this.#options.outbox?.enqueue(request, context, instant);
    if (enqueue === undefined) {
      throw new DomainError("the offline outbox is not wired", {
        reason: "EDGE_ACTION_QUEUE_NOT_WIRED",
      });
    }
    await this.#options.projection.recordResult({
      actionId: request.actionId,
      capability: request.capabilityRequirement.capability,
      actionDedupeKey: request.dedupeKey,
      commandId: request.command.commandId,
      correlationId: request.command.correlationId,
      deviceRef: context.deviceRef,
      source: "local-execution",
      result: new DeviceActionResult({
        actionId: request.actionId,
        status: "accepted",
        completedAt: instant,
      }),
      at: instant,
    });
    // The queued command's honest boundary state (pending until synced).
    await this.#options.projection.recordSyncBoundary({
      actionDedupeKey: request.dedupeKey,
      boundary: "pending",
      at: instant,
    });
    return { outcome: enqueue.outcome, enqueue, admission };
  }

  /**
   * Runs one bounded sync pass of the encrypted offline outbox and updates
   * the local projection's sync-boundary states from the run report
   * (RL-LOCK-015: queue offline, converge when connectivity returns).
   */
  async sync(
    at: UtcInstant | string,
    transport: EdgeSyncTransport,
    options?: SyncDueOptions,
  ): Promise<EdgeSyncRunReport> {
    const instant = parseUtcInstant(at);
    this.#requireOutbox();
    const outbox = this.#options.outbox;
    const store = this.#options.outboxStore;
    if (outbox === undefined || store === undefined) {
      throw new DomainError("the offline outbox is not wired", {
        reason: "EDGE_ACTION_QUEUE_NOT_WIRED",
      });
    }
    const report = await outbox.syncDue(instant, transport, options);
    await this.#projectSyncRun(report, instant, outbox, store);
    return report;
  }

  /**
   * Re-queues records left in-flight by a crash/restart (replay-safe
   * redelivery; the carried commands are idempotency-keyed, RL-LOCK-014).
   */
  async recoverInFlight(at: UtcInstant | string): Promise<readonly EdgeOutboxRecord[]> {
    const instant = parseUtcInstant(at);
    this.#requireOutbox();
    const outbox = this.#options.outbox;
    const store = this.#options.outboxStore;
    if (outbox === undefined || store === undefined) {
      throw new DomainError("the offline outbox is not wired", {
        reason: "EDGE_ACTION_QUEUE_NOT_WIRED",
      });
    }
    const recovered = await outbox.recoverInFlight(instant);
    for (const record of recovered) {
      await this.#options.projection.recordSyncBoundary({
        actionDedupeKey: record.actionDedupeKey,
        boundary: "pending",
        at: instant,
      });
    }
    return recovered;
  }

  /**
   * Receives an authoritative result from the server/ADCOS integration and
   * updates the local projection. The result is validated through the RL-040
   * honesty rules (`executed-observed` REQUIRES evidence); an action unknown
   * to this adapter requires a full descriptor so the projection stays
   * correlatable. Never fabricates state it did not receive.
   */
  async receiveAuthoritativeResult(
    result: DeviceActionResult,
    descriptor: AuthoritativeResultDescriptor | undefined,
    at: UtcInstant | string,
  ): Promise<DeviceActionProjectionEntry> {
    const instant = parseUtcInstant(at);
    const existing = await this.#options.projection.get(result.actionId);
    if (existing === null) {
      if (descriptor === undefined) {
        throw new DomainError(
          "an authoritative result for an action this adapter does not know requires a descriptor (capability + command correlation + dedupe key)",
          { reason: "EDGE_ACTION_RESULT_UNCORRELATABLE" },
        );
      }
      if (
        descriptor.capability === undefined ||
        descriptor.commandId === undefined ||
        descriptor.correlationId === undefined ||
        descriptor.actionDedupeKey === undefined
      ) {
        throw new DomainError(
          "the authoritative result descriptor must carry capability, commandId, correlationId and actionDedupeKey for an unknown action",
          { reason: "EDGE_ACTION_RESULT_UNCORRELATABLE" },
        );
      }
    }
    const capability = existing?.capability ?? descriptor?.capability;
    if (capability === undefined) {
      throw new DomainError(
        "the authoritative result descriptor must name the capability",
        { reason: "EDGE_ACTION_RESULT_UNCORRELATABLE" },
      );
    }
    const dedupeKey = existing?.actionDedupeKey ?? descriptor?.actionDedupeKey;
    const commandId = existing?.commandId ?? descriptor?.commandId;
    const correlationId = existing?.correlationId ?? descriptor?.correlationId;
    if (dedupeKey === undefined || commandId === undefined || correlationId === undefined) {
      throw new DomainError(
        "the authoritative result descriptor is missing correlation fields",
        { reason: "EDGE_ACTION_RESULT_UNCORRELATABLE" },
      );
    }
    return this.#options.projection.recordResult({
      actionId: result.actionId,
      capability,
      actionDedupeKey: dedupeKey,
      commandId,
      correlationId,
      deviceRef: descriptor?.deviceRef ?? existing?.deviceRef ?? null,
      source: "server-authoritative",
      result,
      at: instant,
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #requireOutbox(): void {
    if (this.#options.outbox === undefined || this.#options.outboxStore === undefined) {
      throw new DomainError(
        "the offline outbox is not wired; queue/sync/recover fail closed (wire EdgeOfflineOutbox + its store)",
        { reason: "EDGE_ACTION_QUEUE_NOT_WIRED" },
      );
    }
  }

  #absentEvidenceAdmission(
    request: DeviceActionRequest,
    at: UtcInstant,
  ): DeviceActionAdmission & { readonly admission: "BLOCKED-UNSUPPORTED" } {
    const result = new DeviceActionResult({
      actionId: request.actionId,
      status: "unsupported",
      completedAt: at,
      reason: "capability-unknown",
      detail: NO_SNAPSHOT_DETAIL,
    });
    return {
      admission: "BLOCKED-UNSUPPORTED",
      gate: this.#absentEvidenceGate(request),
      result,
    };
  }

  #absentEvidenceGate(request: DeviceActionRequest): CapabilityGateDecision & {
    readonly decision: "deny";
  } {
    return {
      decision: "deny",
      capability: request.capabilityRequirement.capability,
      reason: "capability-unknown",
      detail: NO_SNAPSHOT_DETAIL,
      evidenceClass: null,
      observedAt: null,
    };
  }

  async #executorOutcome(
    request: DeviceActionRequest,
    instant: UtcInstant,
  ): Promise<ReturnType<typeof parsePlatformExecutionOutcome>> {
    let raw;
    try {
      raw = await this.#options.executor.execute(request, instant);
    } catch {
      // Third-party/platform error text may carry secrets; suppressed
      // (RL-LOCK-016). A throwing executor is a deterministic typed failure.
      return { outcome: "failed", reason: "execution-failed" as const, detail: "the platform executor threw an unexpected error (details suppressed)" };
    }
    try {
      return parsePlatformExecutionOutcome(raw);
    } catch {
      // A non-conforming executor outcome (e.g. success without evidence) is
      // NEVER an executed claim: it degrades to a typed failure.
      return {
        outcome: "failed",
        reason: "execution-failed" as const,
        detail:
          "the platform executor returned a non-conforming outcome (e.g. success without platform evidence); refusing to claim physical success (RL-LOCK-011)",
      };
    }
  }

  #resultFromOutcome(
    request: DeviceActionRequest,
    outcome: ReturnType<typeof parsePlatformExecutionOutcome>,
    at: UtcInstant,
  ): DeviceActionResult {
    switch (outcome.outcome) {
      case "succeeded":
        // Evidence is validated by the DeviceActionResult constructor itself;
        // a "succeeded" outcome that reached here carries real evidence.
        return new DeviceActionResult({
          actionId: request.actionId,
          status: "executed-observed",
          completedAt: at,
          evidence: outcome.evidence,
        });
      case "failed":
        return new DeviceActionResult({
          actionId: request.actionId,
          status: "failed",
          completedAt: at,
          reason: outcome.reason,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
      case "requires-guidance":
        return new DeviceActionResult({
          actionId: request.actionId,
          status: "degraded",
          completedAt: at,
          reason: outcome.reason,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
      case "unsupported":
        return new DeviceActionResult({
          actionId: request.actionId,
          status: "unsupported",
          completedAt: at,
          reason: outcome.reason,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
    }
  }

  async #projectSyncRun(
    report: EdgeSyncRunReport,
    at: UtcInstant,
    outbox: EdgeOfflineOutbox,
    store: EdgeOutboxStore,
  ): Promise<void> {
    const affected: EdgeOutboxRecordId[] = [
      ...report.synced,
      ...report.requeued,
      ...report.deadLettered,
      ...report.conflicts.map((conflict) => conflict.recordId),
    ];
    for (const recordId of affected) {
      const boundary = await outbox.boundaryState(recordId);
      if (boundary === null) continue;
      const record = await store.get(recordId);
      if (record === null) continue;
      await this.#options.projection.recordSyncBoundary({
        actionDedupeKey: record.actionDedupeKey,
        boundary,
        at,
      });
    }
  }
}
