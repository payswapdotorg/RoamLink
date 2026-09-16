/**
 * The local device-action projection (RL-043, spec/mobile.md "Edge
 * desired-state loop": `... -> receive authoritative result -> update local
 * projection`; RL-LOCK-010/015).
 *
 * The edge's CURRENT read model of what happened to its device actions: the
 * latest honest result per action (local-execution or server-authoritative),
 * the queued command's sync-boundary state, and the last-known freshness of
 * the projection entry. The projection never fabricates connectivity state:
 * `synced` means the SERVER ACCEPTED the command - it is never a physical
 * success claim; only an `executed-observed` result carrying platform
 * evidence is (RL-LOCK-011, RL-LOCK-015).
 *
 * Entries are keyed by action id with secondary lookups on the physical action
 * dedupe key and the command id (the outbox record carries those in the
 * clear, RL-LOCK-014). Every update advances a monotonic revision and
 * refreshes `receivedAt` freshness - "displays last-known freshness" is a
 * first-class field, not an afterthought.
 */
import {
  ValidationError,
  makeFreshness,
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  parseRevision,
  parseUtcInstant,
  type CommandId,
  type CorrelationId,
  type Freshness,
  type IdempotencyKey,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  parseDeviceActionId,
  parseEdgeDeviceRef,
  type DeviceActionId,
  type DeviceActionResult,
  type DeviceActionResultPlain,
  type DeviceActionStatus,
  type EdgeCapabilityName,
  type EdgeDeviceRef,
  type EdgeSyncBoundaryState,
} from "@roamlink/edge";

/** Where a recorded result came from. */
export const DEVICE_ACTION_RESULT_SOURCES = ["local-execution", "server-authoritative"] as const;
export type DeviceActionResultSource = (typeof DEVICE_ACTION_RESULT_SOURCES)[number];

/** The immutable projection entry (one per action id). */
export interface DeviceActionProjectionEntry {
  readonly actionId: DeviceActionId;
  readonly capability: EdgeCapabilityName;
  readonly actionDedupeKey: IdempotencyKey;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly deviceRef: EdgeDeviceRef | null;
  /**
   * The queued command's honest sync-boundary state; null when the action was
   * never queued toward the server/ADCOS integration.
   */
  readonly syncBoundary: EdgeSyncBoundaryState | null;
  /** The most recent result record, from either source. */
  readonly latestResult: DeviceActionResultPlain | null;
  readonly latestResultSource: DeviceActionResultSource | null;
  /** Last-known freshness of this entry (RL-LOCK-015 - displayed, never fabricated). */
  readonly lastKnownFreshness: Freshness;
  readonly updatedAt: UtcInstant;
  /** Monotonic projection revision (optimistic-concurrency token). */
  readonly revision: Revision;
}

/** Input for recording a result. */
export interface RecordResultInput {
  readonly actionId: string;
  readonly capability: EdgeCapabilityName;
  readonly actionDedupeKey: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly deviceRef?: string | null;
  readonly source: DeviceActionResultSource;
  readonly result: DeviceActionResult;
  readonly at: UtcInstant | string;
}

/** Input for recording a sync-boundary update of a queued command. */
export interface RecordSyncBoundaryInput {
  readonly actionDedupeKey: string;
  readonly boundary: EdgeSyncBoundaryState;
  readonly at: UtcInstant | string;
}

/** The projection store port (device DB adapter later; in-memory here). */
export interface DeviceActionProjectionStore {
  /** Records/merges a result for the action (creates the entry when absent). */
  recordResult(input: RecordResultInput): Promise<DeviceActionProjectionEntry>;
  /**
   * Updates the sync-boundary state of the entry carrying the dedupe key.
   * Returns null when no entry exists (an honest miss, never a fabrication).
   */
  recordSyncBoundary(input: RecordSyncBoundaryInput): Promise<DeviceActionProjectionEntry | null>;
  get(actionId: string): Promise<DeviceActionProjectionEntry | null>;
  findByActionDedupeKey(dedupeKey: string): Promise<DeviceActionProjectionEntry | null>;
  findByCommandId(commandId: string): Promise<DeviceActionProjectionEntry | null>;
  /** All entries, deterministically ordered by action id. */
  list(): Promise<readonly DeviceActionProjectionEntry[]>;
}

function boundaryOf(value: string): EdgeSyncBoundaryState {
  switch (value) {
    case "synced":
    case "pending":
    case "conflict":
    case "degraded":
      return value;
    default:
      throw new ValidationError("sync boundary must be a member of the closed boundary vocabulary", {
        reason: "DEVICE_ACTION_PROJECTION_INVALID",
        details: [{ path: "syncBoundary", issue: "outside the closed vocabulary" }],
      });
  }
}

function sourceOf(value: string): DeviceActionResultSource {
  if (!(DEVICE_ACTION_RESULT_SOURCES as readonly string[]).includes(value)) {
    throw new ValidationError("result source must be local-execution or server-authoritative", {
      reason: "DEVICE_ACTION_PROJECTION_INVALID",
      details: [{ path: "source", issue: "outside the closed vocabulary" }],
    });
  }
  return value as DeviceActionResultSource;
}

/**
 * Deterministic in-memory projection store. All time-dependent operations take
 * explicit caller-supplied UTC instants (deterministic under the testkit
 * clock); entries are deeply frozen.
 */
export class InMemoryDeviceActionProjectionStore implements DeviceActionProjectionStore {
  readonly #entries = new Map<DeviceActionProjectionEntry["actionId"], DeviceActionProjectionEntry>();

  async recordResult(input: RecordResultInput): Promise<DeviceActionProjectionEntry> {
    const actionId = parseDeviceActionId(input.actionId);
    const dedupeKey = parseIdempotencyKey(input.actionDedupeKey);
    const commandId = parseCommandId(input.commandId);
    const correlationId = parseCorrelationId(input.correlationId);
    const source = sourceOf(input.source);
    const at = parseUtcInstant(input.at);
    const existing = this.#entries.get(actionId);

    const entry: DeviceActionProjectionEntry = Object.freeze({
      actionId,
      capability: input.capability,
      actionDedupeKey: dedupeKey,
      commandId,
      correlationId: existing?.correlationId ?? correlationId,
      deviceRef:
        input.deviceRef === undefined
          ? (existing?.deviceRef ?? null)
          : input.deviceRef === null
            ? null
            : parseEdgeDeviceRef(input.deviceRef),
      syncBoundary: existing?.syncBoundary ?? null,
      latestResult: input.result.toPlain(),
      latestResultSource: source,
      lastKnownFreshness: makeFreshness(
        { observedAt: input.result.completedAt, receivedAt: at, freshUntil: null },
        at,
      ),
      updatedAt: at,
      revision: parseRevision((existing?.revision ?? 0) + 1),
    });
    this.#entries.set(actionId, entry);
    return entry;
  }

  async recordSyncBoundary(
    input: RecordSyncBoundaryInput,
  ): Promise<DeviceActionProjectionEntry | null> {
    const dedupeKey = parseIdempotencyKey(input.actionDedupeKey);
    const boundary = boundaryOf(input.boundary);
    const at = parseUtcInstant(input.at);
    const existing = await this.findByActionDedupeKey(dedupeKey);
    if (existing === null) return null;
    const entry: DeviceActionProjectionEntry = Object.freeze({
      ...existing,
      syncBoundary: boundary,
      lastKnownFreshness: makeFreshness(
        {
          observedAt: existing.lastKnownFreshness.observedAt,
          receivedAt: at,
          freshUntil: null,
        },
        at,
      ),
      updatedAt: at,
      revision: parseRevision(existing.revision + 1),
    });
    this.#entries.set(entry.actionId, entry);
    return entry;
  }

  async get(actionId: string): Promise<DeviceActionProjectionEntry | null> {
    return this.#entries.get(parseDeviceActionId(actionId)) ?? null;
  }

  async findByActionDedupeKey(dedupeKey: string): Promise<DeviceActionProjectionEntry | null> {
    const key = parseIdempotencyKey(dedupeKey);
    return (
      [...this.#entries.values()].find((entry) => entry.actionDedupeKey === key) ?? null
    );
  }

  async findByCommandId(commandId: string): Promise<DeviceActionProjectionEntry | null> {
    const key = parseCommandId(commandId);
    return [...this.#entries.values()].find((entry) => entry.commandId === key) ?? null;
  }

  async list(): Promise<readonly DeviceActionProjectionEntry[]> {
    return Object.freeze(
      [...this.#entries.values()].sort((a, b) =>
        a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0,
      ),
    );
  }
}

/**
 * The honest customer-facing status vocabulary of a projection entry: `synced`
 * stays `queued` here because server acceptance is NOT execution, and a
 * missing result is `unknown` - never a guess (RL-LOCK-015).
 */
export function projectionDisplayStatus(
  entry: DeviceActionProjectionEntry,
): DeviceActionStatus | "queued-unknown" {
  if (entry.latestResult !== null) {
    return entry.latestResult.status;
  }
  return "queued-unknown";
}
