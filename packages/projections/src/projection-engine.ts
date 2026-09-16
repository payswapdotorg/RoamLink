/**
 * The ADCOS projection engine (RL-034, spec/adcos-integration.md §7/§8).
 *
 * Writes canonical-resource projections with the exact §8 record shape
 * through the integration-boundary-only writer, with:
 *
 *  - ORDERING DEFENSE: an event whose `source_version` is strictly lower
 *    than the applied one is SKIPPED (out-of-order delivery never regresses
 *    state); the same version is an idempotent no-op; higher versions
 *    apply. A versionless authoritative snapshot (canonical read) applies,
 *    but an event older than the snapshot's observation instant is still
 *    skipped (late delivery);
 *  - FRESHNESS: `fresh_until = received_at + policy TTL`; the recorded
 *    `freshness_state` is honestly evaluated at write time. When canonical
 *    truth cannot be obtained, records degrade to STALE or UNKNOWN - never
 *    a guess (spec §7; "stale/unknown-state duration" is then measurable);
 *  - EVIDENCE: verified-webhook projections and authenticated canonical
 *    reads are AUTHENTICATED statements from the authority; degradation
 *    transitions record STALE/UNKNOWN evidence classes (the frozen
 *    vocabulary from @roamlink/contracts);
 *  - VERSIONED WRITES: every apply advances `projection_version` by one
 *    under optimistic concurrency (typed ConflictError on races).
 *
 * Webhooks are signals, not truth (RL-LOCK-009): `projectVerifiedEvent`
 * records the authenticated EVENT (its envelope IS the payload of the
 * projection); the full canonical body comes from `projectCanonicalRead`
 * when the boundary fetches it. Periodic repair and canonical refresh
 * scheduling belong to the reconciliation engine (RL-035) which builds on
 * this engine.
 */
import {
  ConflictError,
  DomainError,
  addMilliseconds,
  compareUtcInstants,
  type CanonicalJsonValue,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import { canonicalJsonDigest, canonicalizeJson, parseRevision } from "@roamlink/contracts";
import type { AdcosWebhookEvent } from "@roamlink/adcos";
import type { Clock } from "@roamlink/testkit";
import {
  parseAdcosProjectionRecord,
  projectionIdFor,
  type AdcosProjectionRecord,
  type AdcosProjectionResourceType,
} from "./projection-record.js";
import type { ProjectionReader, ProjectionWriter } from "./projection-store.js";

// --------------------------------------------------------------------------------
// Freshness policy
// --------------------------------------------------------------------------------

/** Per-resource-type freshness TTLs (milliseconds from received_at). */
export interface FreshnessPolicy {
  readonly ttlMsByResourceType: Readonly<Partial<Record<AdcosProjectionResourceType, number>>>;
  readonly defaultTtlMs: number;
}

/** Sensible defaults: event signals 60s, read surfaces 300s. */
export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = Object.freeze({
  ttlMsByResourceType: Object.freeze({
    connectivity_intent: 60_000,
    connectivity_contract: 60_000,
    connectivity_lease: 60_000,
    contract_usage: 300_000,
    contract_assurance: 300_000,
    webhook_endpoint: 300_000,
  }),
  defaultTtlMs: 60_000,
});

function ttlFor(policy: FreshnessPolicy, resourceType: AdcosProjectionResourceType): number {
  const ttl = policy.ttlMsByResourceType[resourceType];
  return ttl !== undefined && Number.isInteger(ttl) && ttl > 0 ? ttl : policy.defaultTtlMs;
}

// --------------------------------------------------------------------------------
// Apply outcomes (closed)
// --------------------------------------------------------------------------------

export type ProjectionApplyOutcome =
  | { readonly outcome: "APPLIED"; readonly record: AdcosProjectionRecord }
  | { readonly outcome: "SKIPPED_OUTDATED"; readonly reason: string; readonly record: AdcosProjectionRecord }
  | { readonly outcome: "SKIPPED_SAME_VERSION"; readonly reason: string; readonly record: AdcosProjectionRecord }
  | { readonly outcome: "MARKED_STALE"; readonly cause: UnreachableCause; readonly record: AdcosProjectionRecord }
  | { readonly outcome: "MARKED_UNKNOWN"; readonly cause: UnreachableCause; readonly record: AdcosProjectionRecord }
  | { readonly outcome: "NO_RECORD"; readonly reason: string };

// --------------------------------------------------------------------------------
// The engine
// --------------------------------------------------------------------------------

export interface AdcosProjectionEngineOptions {
  /** The integration-boundary writer (the ONLY writer of ADCOS projections). */
  readonly writer: ProjectionWriter;
  readonly reader: ProjectionReader;
  readonly clock: Clock;
  readonly freshness?: FreshnessPolicy;
}

/** The reason a canonical source became unreachable (log-safe). */
export type UnreachableCause = "TRANSPORT_UNAVAILABLE" | "TIMEOUT_OUTCOME_UNKNOWN" | "PROBE_FAILED";

/**
 * The projection engine. All writes go through the ordering rules; all
 * degradation is explicit. Nothing about ADCOS lifecycle semantics is
 * redefined here - payloads are opaque canonical JSON snapshots.
 */
export class AdcosProjectionEngine {
  readonly #writer: ProjectionWriter;
  readonly #reader: ProjectionReader;
  readonly #clock: Clock;
  readonly #freshness: FreshnessPolicy;

  constructor(options: AdcosProjectionEngineOptions) {
    this.#writer = options.writer;
    this.#reader = options.reader;
    this.#clock = options.clock;
    this.#freshness = options.freshness ?? DEFAULT_FRESHNESS_POLICY;
  }

  // --- event-driven projection (webhook signals, RL-033 -> RL-034) --------------

  /**
   * Projects a VERIFIED webhook event (authenticated statement from the
   * authority). The projection payload is the event envelope itself; the
   * canonical body is fetched separately via `projectCanonicalRead` when
   * needed (RL-LOCK-009: signals, not truth).
   */
  async projectVerifiedEvent(
    event: AdcosWebhookEvent,
    receivedAt: UtcInstant,
  ): Promise<ProjectionApplyOutcome> {
    const resourceType = resourceTypeOfKind(event.resource_kind);
    const current = await this.#reader.get(resourceType, event.resource_id);
    if (current !== null) {
      // Ordering defense: strictly-lower source versions are late deliveries.
      if (current.source_version !== null && event.resource_version < current.source_version) {
        return {
          outcome: "SKIPPED_OUTDATED",
          reason: `EVENT_VERSION_LOWER_THAN_APPLIED (${event.resource_version} < ${current.source_version})`,
          record: current,
        };
      }
      // Same version: idempotent no-op (first observation at that version won).
      if (current.source_version === event.resource_version) {
        return {
          outcome: "SKIPPED_SAME_VERSION",
          reason: `EVENT_VERSION_ALREADY_APPLIED (${event.resource_version})`,
          record: current,
        };
      }
      // Versioned event over a versionless canonical snapshot: only an event
      // at-or-after the snapshot's observation may supersede it.
      if (
        current.source_version === null &&
        current.observed_at !== null &&
        compareUtcInstants(event.occurred_at, current.observed_at) < 0
      ) {
        return {
          outcome: "SKIPPED_OUTDATED",
          reason: "EVENT_OCCURRED_BEFORE_CANONICAL_SNAPSHOT",
          record: current,
        };
      }
    }
    const payload = eventEnvelopePayload(event);
    const record: AdcosProjectionRecord = {
      projection_id: projectionIdFor(resourceType, event.resource_id),
      source_authority: "adcos",
      canonical_resource_type: resourceType,
      canonical_resource_id: event.resource_id,
      source_version: event.resource_version,
      event_id: event.event_id,
      payload_digest: canonicalJsonDigest(payload),
      observed_at: event.occurred_at,
      received_at: receivedAt,
      fresh_until: addMilliseconds(receivedAt, ttlFor(this.#freshness, resourceType)),
      freshness_state: "FRESH",
      evidence_class: "AUTHENTICATED",
      projection_version: nextVersion(current),
      payload,
    };
    const applied = await this.#applyChecked(record, current);
    return { outcome: "APPLIED", record: applied };
  }

  // --- canonical-read projection (authoritative snapshots) -----------------------

  /**
   * Projects a canonical resource document fetched through the authenticated
   * ADCOS read surface. `sourceVersion` is optional because v2 response
   * documents are opaque (no pinned fields may be invented); when the caller
   * knows the version (e.g. from the triggering event), the same ordering
   * rules apply; a versionless snapshot is an authoritative refresh.
   */
  async projectCanonicalRead(input: {
    readonly resourceType: AdcosProjectionResourceType;
    readonly resourceId: string;
    readonly payload: CanonicalJsonValue;
    readonly observedAt: UtcInstant;
    readonly sourceVersion?: number;
    readonly eventId?: string | null;
  }): Promise<ProjectionApplyOutcome> {
    const current = await this.#reader.get(input.resourceType, input.resourceId);
    const sourceVersion: Revision | null =
      input.sourceVersion !== undefined ? parseRevision(input.sourceVersion) : null;
    if (current !== null && sourceVersion !== null) {
      if (current.source_version !== null) {
        if (sourceVersion < current.source_version) {
          return {
            outcome: "SKIPPED_OUTDATED",
            reason: `READ_VERSION_LOWER_THAN_APPLIED (${sourceVersion} < ${current.source_version})`,
            record: current,
          };
        }
        if (sourceVersion === current.source_version) {
          return {
            outcome: "SKIPPED_SAME_VERSION",
            reason: `READ_VERSION_ALREADY_APPLIED (${sourceVersion})`,
            record: current,
          };
        }
      }
    }
    const receivedAt = this.#clock.now();
    const record: AdcosProjectionRecord = {
      projection_id: projectionIdFor(input.resourceType, input.resourceId),
      source_authority: "adcos",
      canonical_resource_type: input.resourceType,
      canonical_resource_id: input.resourceId,
      source_version: sourceVersion,
      event_id: input.eventId ?? null,
      payload_digest: canonicalJsonDigest(input.payload),
      observed_at: input.observedAt,
      received_at: receivedAt,
      fresh_until: addMilliseconds(receivedAt, ttlFor(this.#freshness, input.resourceType)),
      freshness_state: "FRESH",
      evidence_class: "AUTHENTICATED",
      projection_version: nextVersion(current),
      payload: input.payload,
    };
    const applied = await this.#applyChecked(record, current);
    return { outcome: "APPLIED", record: applied };
  }

  // --- degradation (unreachable canonical truth: never guess) --------------------

  /**
   * Marks a projection STALE: the known prior state whose freshness
   * guarantee has expired (or was voided by an unreachable canonical
   * source). The payload is RETAINED (known prior state); evidence and
   * freshness degrade honestly. Requires an existing projection.
   */
  async markStale(
    resourceType: AdcosProjectionResourceType,
    resourceId: string,
    cause: UnreachableCause,
  ): Promise<ProjectionApplyOutcome> {
    const current = await this.#reader.get(resourceType, resourceId);
    if (current === null) {
      return { outcome: "NO_RECORD", reason: "NEVER_OBSERVED (absence is already the unknown state)" };
    }
    const record: AdcosProjectionRecord = {
      ...current,
      // fresh_until stays the historical guarantee instant; the STATE field
      // is the authoritative degradation signal consumers read.
      freshness_state: "STALE",
      evidence_class: "STALE",
      projection_version: nextVersion(current),
    };
    const applied = await this.#applyChecked(record, current);
    return { outcome: "MARKED_STALE", cause, record: applied };
  }

  /**
   * Marks a projection UNKNOWN: the canonical truth could not be obtained
   * and the current state cannot be asserted. The last-known payload is
   * retained for diagnostics but carries no freshness guarantee. Requires an
   * existing projection (a never-observed resource is already unknown).
   */
  async markUnknown(
    resourceType: AdcosProjectionResourceType,
    resourceId: string,
    cause: UnreachableCause,
  ): Promise<ProjectionApplyOutcome> {
    const current = await this.#reader.get(resourceType, resourceId);
    if (current === null) {
      return { outcome: "NO_RECORD", reason: "NEVER_OBSERVED (absence is already the unknown state)" };
    }
    const record: AdcosProjectionRecord = {
      ...current,
      fresh_until: null,
      freshness_state: "UNKNOWN",
      evidence_class: "UNKNOWN",
      projection_version: nextVersion(current),
    };
    const applied = await this.#applyChecked(record, current);
    return { outcome: "MARKED_UNKNOWN", cause, record: applied };
  }

  // --- freshness maintenance -------------------------------------------------------

  /**
   * Re-evaluates freshness for every FRESH record whose guarantee has
   * expired: FRESH -> STALE transitions only (monotone degradation). Also
   * flips the evidence class to STALE so consumers see the guarantee loss.
   */
  async refreshFreshnessStates(at?: UtcInstant): Promise<{ readonly transitionedToStale: number }> {
    const evaluationAt = at ?? this.#clock.now();
    let transitioned = 0;
    const all = await this.#reader.list();
    for (const current of all) {
      if (current.freshness_state !== "FRESH") continue;
      if (current.fresh_until === null) continue;
      if (compareUtcInstants(evaluationAt, current.fresh_until) > 0) {
        const record: AdcosProjectionRecord = {
          ...current,
          freshness_state: "STALE",
          evidence_class: "STALE",
          projection_version: nextVersion(current),
        };
        await this.#applyChecked(record, current);
        transitioned += 1;
      }
    }
    return { transitionedToStale: transitioned };
  }

  // --- internals ---------------------------------------------------------------------

  async #applyChecked(
    next: AdcosProjectionRecord,
    current: AdcosProjectionRecord | null,
  ): Promise<AdcosProjectionRecord> {
    const validated = parseAdcosProjectionRecord(next);
    try {
      return await this.#writer.apply(
        validated,
        current === null ? null : current.projection_version,
      );
    } catch (error) {
      if (error instanceof ConflictError) {
        // A concurrent writer won the race; its projection stands. Surface
        // the typed conflict to the caller (never overwrite silently).
        throw new DomainError(
          "projection write race: a concurrent projection apply won; re-read and re-apply from the committed state",
          { reason: "PROJECTION_WRITE_RACE", cause: error },
        );
      }
      throw error;
    }
  }
}

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

function nextVersion(current: AdcosProjectionRecord | null): Revision {
  return parseRevision(current === null ? 1 : current.projection_version + 1);
}

function resourceTypeOfKind(kind: AdcosWebhookEvent["resource_kind"]): AdcosProjectionResourceType {
  // The webhook resource kinds map 1:1 onto canonical resource types
  // (connectivity_intent / connectivity_contract / connectivity_lease /
  // webhook_endpoint are all canonical v2 resources).
  return kind as AdcosProjectionResourceType;
}

function eventEnvelopePayload(event: AdcosWebhookEvent): CanonicalJsonValue {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    resource_id: event.resource_id,
    resource_kind: event.resource_kind,
    resource_version: event.resource_version,
    occurred_at: event.occurred_at,
    api_version: event.api_version,
    environment: event.environment,
    correlation_id: event.correlation_id,
  };
}

/** Digest helper exposed for tests/consumers (payload digest of a canonical value). */
export function payloadDigestOf(payload: CanonicalJsonValue): string {
  return canonicalJsonDigest(payload);
}

/**
 * Validates an unknown (e.g. opaque ADCOS document) value as a canonical
 * JSON value - opaque documents carry no typed fields, but they must be
 * canonicalizable before they can be projected. Throws the typed Wave-0
 * ValidationError naming the offending path, never the value.
 */
export function canonicalizeUnknown(value: unknown): CanonicalJsonValue {
  canonicalizeJson(value); // throws a path-precise ValidationError otherwise
  return value as CanonicalJsonValue;
}
