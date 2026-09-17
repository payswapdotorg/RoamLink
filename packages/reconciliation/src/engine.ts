/**
 * The ADCOS reconciliation engine (RL-035, spec/adcos-integration.md §7).
 *
 * A `ReconciliationJob` orchestration that periodically compares projection
 * freshness against canonical ADCOS resources and repairs, per §7:
 *
 *  - MISSED WEBHOOKS: freshness expiry (or discovery of a never-observed
 *    resource) triggers a canonical read that re-applies authoritative truth;
 *  - DUPLICATE WEBHOOKS: the scan verifies the projection against canonical
 *    truth and records ALREADY_CONSISTENT - a duplicate never re-applies
 *    (the inbox dedupes by event id; the engine skips same versions);
 *  - OUT-OF-ORDER EVENTS: the projection engine's ordering defense already
 *    skipped late events; the canonical refresh converges to the newest
 *    version regardless of arrival order;
 *  - STALE PROJECTIONS: the freshness sweep flips expired FRESH records to
 *    STALE, then the canonical refresh renews them when truth is reachable;
 *  - PARTIALLY APPLIED PROJECTIONS: records whose payload no longer matches
 *    their recorded digest (torn/partial writes) are repaired by an
 *    AUTHORITATIVE REPLACEMENT (versionless canonical apply), and
 *    admitted-but-unprojected inbox records are drained idempotently;
 *  - TRANSIENT ADCOS/API FAILURES: bounded in-job retries; on exhaustion the
 *    projection degrades to STALE (trustworthy prior state) or UNKNOWN
 *    (untrustworthy prior state) and the NEXT job retries.
 *
 * When canonical truth cannot be obtained, the state becomes STALE or
 * UNKNOWN - the system NEVER guesses (RL-LOCK-010). ADCOS remains the
 * connectivity authority (RL-LOCK-001): the reconciler only READS canonical
 * resources and maps/repairs projections; it never mutates ADCOS state and
 * never redefines lifecycle semantics.
 *
 * Only the reconciler/integration boundary writes ADCOS-derived projections
 * (spec §8): all writes go through the Wave-2 projection engine instance
 * owned by the boundary factory (see ./boundary.ts) - the raw writer never
 * escapes.
 */
import {
  ConflictError,
  RoamLinkError,
  canonicalJsonDigest,
  epochMsOf,
  normalizeUnknownError,
  parseActorId,
  parseCommandId,
  parseCorrelationId,
  parseUtcInstant,
  type ActorId,
  type CommandId,
  type CorrelationId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  AdcosApiError,
  type AdcosClient,
} from "@roamlink/adcos";
import {
  parseAdcosContractRef,
  parseAdcosIntentRef,
  parseAdcosLeaseRef,
  parseAdcosResourceId,
} from "@roamlink/contracts";
import { AdcosTransportError } from "@roamlink/integration";
import {
  canonicalizeUnknown,
  type AdcosProjectionEngine,
  type AdcosProjectionRecord,
  type AdcosProjectionResourceType,
  type ProjectionReader,
  type UnreachableCause,
} from "@roamlink/projections";
import type { WebhookProcessingReport } from "@roamlink/webhook-inbox";
import type { Clock, IdGenerator } from "@roamlink/testkit";
import { randomUUID } from "node:crypto";
import {
  parseReconciliationJobRecord,
  parseReconciliationActionRecord,
  reconciliationJobIdempotencyKey,
  summarizeReconciliationActions,
  type ReconciliationActionOutcome,
  type ReconciliationActionRecord,
  type ReconciliationActionType,
  type ReconciliationJobRecord,
  type ReconciliationJobRetry,
  type ReconciliationTriggerReason,
} from "./job-record.js";
import { parseReconciliationPolicy, type ReconciliationPolicy, DEFAULT_RECONCILIATION_POLICY } from "./policy.js";
import type { CanonicalResourceDiscovery, DiscoveryResult } from "./resource-discovery.js";
import type { ReconciliationJobStore, StoredReconciliationJob } from "./job-store.js";
import { degradedForMsAt, emitReconciliationSloEvents, closedStaleWindowMs, type ReconciliationSloObserver } from "./slo-emission.js";

// --------------------------------------------------------------------------------
// Ports and inputs
// --------------------------------------------------------------------------------

/** The durable webhook inbox drain (satisfied by AdcosWebhookInboxService). */
export interface PendingWebhookDrain {
  processPending(limit?: number): Promise<WebhookProcessingReport>;
}

/** The diagnosable compatibility health state (RL-036 seam, duck-typed). */
export interface ReconciliationCompatibilityGate {
  status(): "unknown" | "compatible" | "incompatible";
}

/** A request to run one reconciliation job. */
export interface ReconciliationJobRequest {
  /**
   * The §5 command id of the job. Omit for a fresh (e.g. scheduled) run;
   * pass a KNOWN id to re-run a crashed/failed job idempotently
   * (RL-LOCK-014: re-running produces the same outcome, not duplicates).
   */
  readonly jobId?: CommandId | string;
  readonly correlationId?: CorrelationId | string;
  readonly actorId?: ActorId | string;
  readonly reason: ReconciliationTriggerReason;
  /**
   * Allow taking over a RUNNING job record (crash recovery). Without this,
   * a RUNNING record refuses with a typed conflict - the live runner wins.
   */
  readonly resume?: boolean;
}

export interface AdcosReconciliationEngineOptions {
  /** The public ADCOS client (READ surface only - the reconciler never mutates ADCOS). */
  readonly client: AdcosClient;
  /** The Wave-2 projection engine owned by the boundary (the §8 writer). */
  readonly projectionEngine: AdcosProjectionEngine;
  readonly projectionReader: ProjectionReader;
  readonly jobs: ReconciliationJobStore;
  readonly inbox: PendingWebhookDrain;
  readonly clock: Clock;
  /** The tenant all reconciliation jobs run under (platform/deployment tenant). */
  readonly tenantId: TenantId;
  readonly policy?: ReconciliationPolicy;
  readonly discovery?: CanonicalResourceDiscovery;
  readonly compatibility?: ReconciliationCompatibilityGate;
  /** Deterministic in tests; defaults to random canonical UUIDs. */
  readonly jobIdGenerator?: IdGenerator;
  /**
   * Optional §11 SLO emission port (additive RL-052 wiring): the completed
   * job's durable actions are emitted as successful-automatic-recovery,
   * stale/unknown-state-duration and manual-intervention measurements. The
   * `@roamlink/observability` product-SLO recorder satisfies it structurally.
   * Absent by default — behavior is IDENTICAL without it.
   */
  readonly sloObserver?: ReconciliationSloObserver;
}

/** The default system actor reconciliation jobs run as. */
export const DEFAULT_RECONCILER_ACTOR_ID: ActorId = "actor:reconciliation-engine" as ActorId;

// --------------------------------------------------------------------------------
// Scan classification
// --------------------------------------------------------------------------------

type TargetClassification = "CONSISTENT" | "NEEDS_REFRESH" | "PARTIALLY_APPLIED";

interface ScanTarget {
  readonly resourceType: AdcosProjectionResourceType;
  readonly resourceId: string;
  readonly record: AdcosProjectionRecord | null;
}

/**
 * Classifies one target against the freshness policy. A record whose payload
 * no longer digests to its recorded `payload_digest` is PARTIALLY APPLIED
 * (torn write); a FRESH record inside its guarantee (and refresh margin) is
 * CONSISTENT; everything else NEEDS_REFRESH.
 */
export function classifyScanTarget(
  record: AdcosProjectionRecord | null,
  at: UtcInstant,
  policy: ReconciliationPolicy,
): TargetClassification {
  if (record === null) return "NEEDS_REFRESH"; // never observed (discovery)
  if (canonicalJsonDigest(record.payload) !== record.payload_digest) {
    return "PARTIALLY_APPLIED";
  }
  if (record.freshness_state === "FRESH") {
    if (record.fresh_until === null) return "NEEDS_REFRESH"; // defensive: no guarantee
    const remainingMs = epochMsOf(record.fresh_until) - epochMsOf(at);
    return remainingMs <= policy.refreshMarginMs ? "NEEDS_REFRESH" : "CONSISTENT";
  }
  return "NEEDS_REFRESH"; // STALE or UNKNOWN
}

// --------------------------------------------------------------------------------
// Canonical failure classification (closed, onto existing kinds)
// --------------------------------------------------------------------------------

/** True when the failure is transient and an immediate retry may succeed. */
export function isTransientCanonicalFailure(error: unknown): boolean {
  if (error instanceof AdcosApiError) return error.retryable; // rate-limited / store-failed
  if (error instanceof AdcosTransportError) return true; // not-sent and unknown both retry for reads
  if (error instanceof RoamLinkError) return error.retryable;
  return false;
}

/** True when the authority deterministically reports the resource absent. */
export function isCanonicalResourceAbsent(error: unknown): boolean {
  return error instanceof AdcosApiError && error.code === "resource-unknown";
}

/** Maps a canonical-read failure onto the closed projection-degradation cause. */
export function unreachableCauseOf(error: unknown): UnreachableCause {
  if (error instanceof AdcosTransportError) {
    return error.outcome === "not-sent" ? "TRANSPORT_UNAVAILABLE" : "TIMEOUT_OUTCOME_UNKNOWN";
  }
  return "PROBE_FAILED";
}

function failureCodeOf(error: unknown): string {
  if (error instanceof AdcosApiError) return error.code;
  if (error instanceof AdcosTransportError) return `transport-${error.outcome}`;
  if (error instanceof RoamLinkError) return error.reason;
  return "UNKNOWN_FAILURE";
}

// --------------------------------------------------------------------------------
// The engine
// --------------------------------------------------------------------------------

/**
 * The reconciliation engine. `runJob` is the whole §7 orchestration; every
 * effect it drives is idempotent (projection writes are version-guarded,
 * inbox processing is status-guarded), so crash + re-run converges.
 */
export class AdcosReconciliationEngine {
  readonly #client: AdcosClient;
  readonly #projectionEngine: AdcosProjectionEngine;
  readonly #projectionReader: ProjectionReader;
  readonly #jobs: ReconciliationJobStore;
  readonly #inbox: PendingWebhookDrain;
  readonly #clock: Clock;
  readonly #tenantId: TenantId;
  readonly #policy: ReconciliationPolicy;
  readonly #discovery: CanonicalResourceDiscovery | undefined;
  readonly #compatibility: ReconciliationCompatibilityGate | undefined;
  readonly #jobIdGenerator: IdGenerator;
  readonly #sloObserver: ReconciliationSloObserver | undefined;

  constructor(options: AdcosReconciliationEngineOptions) {
    this.#client = options.client;
    this.#projectionEngine = options.projectionEngine;
    this.#projectionReader = options.projectionReader;
    this.#jobs = options.jobs;
    this.#inbox = options.inbox;
    this.#clock = options.clock;
    this.#tenantId = options.tenantId;
    this.#policy = options.policy === undefined
      ? DEFAULT_RECONCILIATION_POLICY
      : parseReconciliationPolicy(options.policy);
    this.#discovery = options.discovery;
    this.#compatibility = options.compatibility;
    this.#jobIdGenerator = options.jobIdGenerator ?? { next: () => randomUUID() };
    this.#sloObserver = options.sloObserver;
  }

  /** Lists the durable job records (diagnostics; committed state only). */
  async listJobs(): Promise<readonly ReconciliationJobRecord[]> {
    const stored = await this.#jobs.list();
    return stored.map((job) => job.record);
  }

  /**
   * Runs one reconciliation job. Idempotent by job id: a COMPLETED job
   * returns its recorded outcome with NO new effects; a FAILED or crashed
   * (RUNNING + resume) job re-runs with all effects converging.
   */
  async runJob(request: ReconciliationJobRequest): Promise<ReconciliationJobRecord> {
    const reason = request.reason;
    const existing: StoredReconciliationJob | null =
      request.jobId !== undefined ? await this.#jobs.get(request.jobId) : null;

    if (existing !== null && existing.record.status === "COMPLETED") {
      return existing.record; // the recorded outcome stands - no re-execution
    }
    if (existing !== null && existing.record.status === "RUNNING" && request.resume !== true) {
      throw new ConflictError(
        "reconciliation job is already RUNNING (a live runner owns it); pass resume: true only for crash recovery",
        { reason: "RECONCILIATION_JOB_ALREADY_RUNNING" },
      );
    }

    const now = this.#clock.now();
    let stored: StoredReconciliationJob;
    let retry: ReconciliationJobRetry;
    if (existing === null) {
      const jobId = parseCommandId(request.jobId ?? this.#jobIdGenerator.next());
      const record = parseReconciliationJobRecord({
        job_id: jobId,
        correlation_id: parseCorrelationId(request.correlationId ?? `corr-${jobId}`),
        idempotency_key: reconciliationJobIdempotencyKey(jobId),
        actor_id: parseActorId(request.actorId ?? DEFAULT_RECONCILER_ACTOR_ID),
        tenant_id: this.#tenantId,
        created_at: now,
        retry: { attempt: 1 },
        trigger_reason: reason,
        status: "PENDING",
        started_at: null,
        completed_at: null,
        actions: [],
        summary: null,
      });
      stored = await this.#jobs.create(record);
      retry = { attempt: 1 };
    } else {
      stored = existing;
      retry = {
        attempt: existing.record.retry.attempt + 1,
        ...(existing.record.retry.lastError !== undefined
          ? { lastError: existing.record.retry.lastError }
          : {}),
      };
    }

    // PENDING/FAILED -> RUNNING (started_at is the FIRST start). A resumed
    // RUNNING record needs no transition write - the takeover itself is the
    // heartbeat; effects proceed against the stored record/version.
    const startedAt = stored.record.started_at ?? now;
    const running: StoredReconciliationJob =
      stored.record.status === "RUNNING"
        ? stored
        : await this.#jobs.transition(stored.record.job_id, stored.version, stored.record, {
            status: "RUNNING",
            started_at: startedAt,
            retry,
            ...(stored.record.status === "FAILED" ? { trigger_reason: reason } : {}),
          });

    try {
      const builder = new ActionBuilder(running.record.job_id);
      // Phase A - freshness sweep (FRESH -> STALE, monotone degradation).
      const sweep = await this.#projectionEngine.refreshFreshnessStates(now);
      builder.push({
        action_type: "FRESHNESS_SWEEP",
        outcome: sweep.transitionedToStale > 0 ? "REPAIRED" : "ALREADY_CONSISTENT",
        detail: `TRANSITIONED_TO_STALE(${sweep.transitionedToStale})`,
        attempted_at: now,
        attempts: 1,
        metrics: { transitionedToStale: sweep.transitionedToStale },
      });

      // Phase B - inbox drain (admitted-but-unprojected / failed records).
      const inboxReport = await this.#inbox.processPending(this.#policy.inboxBatchLimit);
      const drainEffects =
        inboxReport.applied + inboxReport.failed + inboxReport.conflicts + inboxReport.skipped;
      builder.push({
        action_type: "INBOX_DRAIN",
        outcome: drainEffects > 0 ? "REPAIRED" : "ALREADY_CONSISTENT",
        detail: `CONSIDERED(${inboxReport.considered}) APPLIED(${inboxReport.applied}) SKIPPED(${inboxReport.skipped}) FAILED(${inboxReport.failed}) CONFLICTS(${inboxReport.conflicts}) ALREADY_PROJECTED(${inboxReport.alreadyProjected})`,
        attempted_at: now,
        attempts: 1,
        metrics: { ...inboxReport },
      });

      // Phase C - canonical scan + repair.
      const scanned = await this.#canonicalScan(now, builder);

      const actions = builder.actions();
      const summary = summarizeReconciliationActions(actions, scanned);
      const completed = await this.#jobs.transition(
        running.record.job_id,
        running.version,
        running.record,
        {
          status: "COMPLETED",
          completed_at: this.#clock.now(),
          actions,
          summary,
          retry,
        },
      );
      this.#emitSloEvents(completed.record);
      return completed.record;
    } catch (error) {
      const normalized = normalizeUnknownError(error);
      try {
        await this.#jobs.transition(running.record.job_id, running.version, running.record, {
          status: "FAILED",
          failure_reason: normalized.reason,
          retry: {
            attempt: retry.attempt,
            lastError: {
              reason: normalized.reason,
              kind: normalized.kind,
              occurredAt: this.#clock.now(),
            },
          },
        });
      } catch {
        // The FAILED transition itself lost a race; the original error is
        // the one that matters - it propagates.
      }
      throw normalized;
    }
  }

  // --- phase C ---------------------------------------------------------------------

  async #canonicalScan(now: UtcInstant, builder: ActionBuilder): Promise<number> {
    const targets = new Map<string, ScanTarget>();
    for (const record of await this.#projectionReader.list()) {
      targets.set(`${record.canonical_resource_type}\n${record.canonical_resource_id}`, {
        resourceType: record.canonical_resource_type,
        resourceId: record.canonical_resource_id,
        record,
      });
    }

    if (this.#policy.discoveryEnabled && this.#discovery !== undefined) {
      let discovery: DiscoveryResult;
      try {
        discovery = await this.#discovery.discover();
      } catch (error) {
        builder.push({
          action_type: "DISCOVERY",
          outcome: "DEFERRED",
          detail: `DISCOVERY_FAILED (${failureCodeOf(error)})`,
          attempted_at: now,
          attempts: 1,
        });
        discovery = { resources: [], routeFailures: [] };
      }
      for (const failure of discovery.routeFailures) {
        builder.push({
          action_type: "DISCOVERY",
          outcome: "DEFERRED",
          detail: `ROUTE_FAILED ${failure.route} (${failure.code})`,
          attempted_at: now,
          attempts: 1,
        });
      }
      for (const resource of discovery.resources) {
        const key = `${resource.resource_type}\n${resource.resource_id}`;
        if (!targets.has(key)) {
          targets.set(key, {
            resourceType: resource.resource_type,
            resourceId: resource.resource_id,
            record: null,
          });
        }
      }
    }

    const ordered = [...targets.values()].sort((a, b) =>
      a.resourceType < b.resourceType
        ? -1
        : a.resourceType > b.resourceType
          ? 1
          : a.resourceId < b.resourceId
            ? -1
            : a.resourceId > b.resourceId
              ? 1
              : 0,
    );
    for (const target of ordered) {
      await this.#reconcileTarget(target, now, builder);
    }
    return ordered.length;
  }

  async #reconcileTarget(target: ScanTarget, now: UtcInstant, builder: ActionBuilder): Promise<void> {
    const classification = classifyScanTarget(target.record, now, this.#policy);
    const record = target.record;

    if (classification === "CONSISTENT") {
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "ALREADY_CONSISTENT",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `FRESHNESS_GUARANTEE_VALID (fresh_until=${record?.fresh_until ?? "null"})`,
        attempted_at: now,
        attempts: 0,
      });
      return;
    }

    // An unverified/incompatible boundary must not project foreign-version
    // documents: fetches defer, local degradation still happens via the sweep.
    const gateStatus = this.#compatibility?.status();
    if (gateStatus !== undefined && gateStatus !== "compatible") {
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "DEFERRED",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `COMPATIBILITY_GATE_${gateStatus.toUpperCase()} (canonical fetch refused)`,
        attempted_at: now,
        attempts: 0,
      });
      return;
    }

    // Bounded canonical-read attempts (immediate retries; deterministic).
    let document: Record<string, unknown> | null = null;
    let failure: unknown = null;
    let attempts = 0;
    while (attempts < this.#policy.maxCanonicalReadAttempts) {
      attempts += 1;
      try {
        document = await this.#readCanonical(target);
        failure = null;
        break;
      } catch (error) {
        failure = error;
        if (!isTransientCanonicalFailure(error)) break;
      }
    }

    if (document !== null) {
      await this.#applyCanonicalDocument(target, classification, document, builder);
      return;
    }

    // Truth could not be obtained: degrade honestly or defer - never guess.
    if (failure !== null && isCanonicalResourceAbsent(failure)) {
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "CANONICAL_ABSENT",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `AUTHORITY_REPORTS_RESOURCE_UNKNOWN (prior payload retained; freshness ages it; attempts=${attempts})`,
        attempted_at: now,
        attempts,
      });
      return;
    }
    const code = failureCodeOf(failure);
    if (record === null) {
      // A never-observed resource: absence is already the unknown state.
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "DEFERRED",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `NEVER_OBSERVED (${code}; attempts=${attempts}; retry next job)`,
        attempted_at: now,
        attempts,
      });
      return;
    }
    const alreadyDegraded =
      record.freshness_state === "STALE" || record.freshness_state === "UNKNOWN";
    if (alreadyDegraded) {
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "DEFERRED",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `PRIOR_STATE_ALREADY_${record.freshness_state} (${code}; attempts=${attempts}; retry next job)`,
        attempted_at: now,
        attempts,
      });
      return;
    }
    if (classification === "PARTIALLY_APPLIED") {
      const cause = unreachableCauseOf(failure);
      const outcome = await this.#projectionEngine.markUnknown(
        target.resourceType,
        target.resourceId,
        cause,
      );
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "DEGRADED_UNKNOWN",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `PARTIAL_APPLICATION_UNREPAIRABLE (${code}; cause=${cause}; attempts=${attempts}; ${outcome.outcome})`,
        attempted_at: now,
        attempts,
        metrics: {
          degradedForMs: degradedForMsAt(
            {
              freshness_state: record?.freshness_state ?? "UNKNOWN",
              fresh_until: record?.fresh_until ?? null,
              observed_at: record?.observed_at ?? null,
            },
            now,
            epochMsOf,
          ),
        },
      });
      return;
    }
    const cause = unreachableCauseOf(failure);
    const outcome = await this.#projectionEngine.markStale(
      target.resourceType,
      target.resourceId,
      cause,
    );
    builder.push({
      action_type: "CANONICAL_REFRESH",
      outcome: "DEGRADED_STALE",
      resource_type: target.resourceType,
      resource_id: target.resourceId,
        detail: `TRUTH_UNOBTAINABLE (${code}; cause=${cause}; attempts=${attempts}; ${outcome.outcome})`,
      attempted_at: now,
      attempts,
      metrics: {
        degradedForMs: degradedForMsAt(
          {
            freshness_state: record?.freshness_state ?? "FRESH",
            fresh_until: record?.fresh_until ?? null,
            observed_at: record?.observed_at ?? null,
          },
          now,
          epochMsOf,
        ),
      },
    });
  }

  async #applyCanonicalDocument(
    target: ScanTarget,
    classification: TargetClassification,
    document: Record<string, unknown>,
    builder: ActionBuilder,
  ): Promise<void> {
    const payload = canonicalizeUnknown(document);
    const fetchedAt = this.#clock.now();
    const rawVersion = document["resource_version"];
    const sourceVersion =
      typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1
        ? rawVersion
        : undefined;
    // §11 stale/unknown-state duration: when this repair CLOSES a
    // stale/unknown window, the closed window's duration is stamped into the
    // durable action metrics (never guessed — computed from the pre-repair
    // record's own freshness fields).
    const closedWindow = closedStaleWindowMs(target.record, fetchedAt, epochMsOf);

    if (classification === "PARTIALLY_APPLIED") {
      // AUTHORITATIVE REPLACEMENT: a partially applied record's version
      // lineage is untrustworthy, so the version ordering defense must not
      // gate this repair - the authority's current document replaces the
      // record wholesale (source_version resets to null: honest lineage).
      const outcome = await this.#projectionEngine.projectCanonicalRead({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        payload,
        observedAt: fetchedAt,
      });
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "REPAIRED",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `PARTIAL_APPLICATION_REPAIRED (authoritative replacement; ${outcome.outcome})`,
        attempted_at: fetchedAt,
        attempts: 1,
        ...(closedWindow !== null
          ? {
              metrics: {
                staleForMs: closedWindow.durationMs,
                staleState: closedWindow.staleState === "unknown" ? "UNKNOWN" : "STALE",
              },
            }
          : {}),
      });
      return;
    }

    const outcome = await this.#projectionEngine.projectCanonicalRead({
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      payload,
      observedAt: fetchedAt,
      ...(sourceVersion !== undefined ? { sourceVersion } : {}),
    });
    if (outcome.outcome === "APPLIED") {
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "REPAIRED",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `CANONICAL_READ_APPLIED (source_version=${sourceVersion ?? "null"})`,
        attempted_at: fetchedAt,
        attempts: 1,
        ...(closedWindow !== null
          ? {
              metrics: {
                staleForMs: closedWindow.durationMs,
                staleState: closedWindow.staleState === "unknown" ? "UNKNOWN" : "STALE",
              },
            }
          : {}),
      });
      return;
    }
    if (outcome.outcome === "SKIPPED_SAME_VERSION" || outcome.outcome === "SKIPPED_OUTDATED") {
      // FRESHNESS RENEWAL: a same-version canonical read of a record whose
      // guarantee already expired (STALE/UNKNOWN) is a RE-OBSERVATION of the
      // same truth - the guarantee is renewed through a versionless
      // authoritative apply (observed_at/received_at/fresh_until advance;
      // source_version becomes null: honest lineage after renewal).
      if (
        outcome.outcome === "SKIPPED_SAME_VERSION" &&
        target.record !== null &&
        target.record.freshness_state !== "FRESH"
      ) {
        await this.#projectionEngine.projectCanonicalRead({
          resourceType: target.resourceType,
          resourceId: target.resourceId,
          payload,
          observedAt: fetchedAt,
        });
        builder.push({
          action_type: "CANONICAL_REFRESH",
          outcome: "REPAIRED",
          resource_type: target.resourceType,
          resource_id: target.resourceId,
          detail: `FRESHNESS_RENEWED (same truth re-observed at source_version=${sourceVersion ?? "null"}; guarantee renewed)`,
          attempted_at: fetchedAt,
          attempts: 1,
          ...(closedWindow !== null
            ? {
                metrics: {
                  staleForMs: closedWindow.durationMs,
                  staleState: closedWindow.staleState === "unknown" ? "UNKNOWN" : "STALE",
                },
              }
            : {}),
        });
        return;
      }
      // Still FRESH (or the read is older than what was applied): the
      // applied projection already reflects the same or newer truth -
      // duplicates and reordered signals verified harmless.
      builder.push({
        action_type: "CANONICAL_REFRESH",
        outcome: "ALREADY_CONSISTENT",
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        detail: `CANONICAL_READ_SKIPPED (${outcome.reason})`,
        attempted_at: fetchedAt,
        attempts: 1,
      });
      return;
    }
    // MARKED_* / NO_RECORD cannot be produced by projectCanonicalRead; the
    // defensive branch still records the outcome honestly (never guess).
    builder.push({
      action_type: "CANONICAL_REFRESH",
      outcome: "ALREADY_CONSISTENT",
      resource_type: target.resourceType,
      resource_id: target.resourceId,
      detail: `CANONICAL_READ_UNEXPECTED_OUTCOME (${outcome.outcome})`,
      attempted_at: fetchedAt,
      attempts: 1,
    });
  }

  async #readCanonical(target: ScanTarget): Promise<Record<string, unknown>> {
    switch (target.resourceType) {
      case "connectivity_intent":
        return await this.#client.getIntent(parseAdcosIntentRef(target.resourceId));
      case "connectivity_contract":
        return await this.#client.getContract(parseAdcosContractRef(target.resourceId));
      case "connectivity_lease":
        return await this.#client.getLease(parseAdcosLeaseRef(target.resourceId));
      case "contract_usage":
        return await this.#client.getContractUsage(parseAdcosContractRef(target.resourceId));
      case "contract_assurance":
        return await this.#client.getContractAssurance(parseAdcosContractRef(target.resourceId));
      case "webhook_endpoint":
        return await this.#client.getWebhookEndpoint(parseAdcosResourceId(target.resourceId));
    }
  }

  /**
   * Emits the completed job's §11 SLO events through the optional observer.
   * Emission can never break the repair loop: a throwing observer is
   * swallowed (the job's durable record is already the truth; the observer
   * is a projection of it). No-op without an observer.
   */
  #emitSloEvents(job: ReconciliationJobRecord): void {
    if (this.#sloObserver === undefined) return;
    try {
      emitReconciliationSloEvents(this.#sloObserver, job);
    } catch {
      // Deliberately suppressed: observability emission is downstream of the
      // durable truth, never a gate in front of it.
    }
  }
}

// --------------------------------------------------------------------------------
// Action list builder (deterministic ids)
// --------------------------------------------------------------------------------

type ActionPushInput = {
  readonly action_type: ReconciliationActionType;
  readonly outcome: ReconciliationActionOutcome;
  readonly detail: string;
  readonly attempted_at: UtcInstant | string;
  readonly attempts: number;
  readonly resource_type?: AdcosProjectionResourceType;
  readonly resource_id?: string;
  readonly metrics?: Record<string, unknown>;
};

class ActionBuilder {
  readonly #jobId: CommandId;
  readonly #actions: ReconciliationActionRecord[] = [];
  #ordinal = 0;

  constructor(jobId: CommandId) {
    this.#jobId = jobId;
  }

  push(input: ActionPushInput): void {
    this.#ordinal += 1;
    const attemptedAt = parseUtcInstant(input.attempted_at);
    const record: Record<string, unknown> = {
      action_id: `${this.#jobId}#${this.#ordinal}`,
      action_type: input.action_type,
      outcome: input.outcome,
      detail: input.detail,
      attempted_at: attemptedAt,
      attempts: Math.max(1, input.attempts),
    };
    if (input.resource_type !== undefined) record["resource_type"] = input.resource_type;
    if (input.resource_id !== undefined) record["resource_id"] = input.resource_id;
    if (input.metrics !== undefined) record["metrics"] = input.metrics;
    // Round-trips through the closed parser: a malformed action can never
    // enter the durable record.
    this.#actions.push(parseReconciliationActionRecord(record, this.#jobId));
  }

  actions(): readonly ReconciliationActionRecord[] {
    return Object.freeze([...this.#actions]);
  }
}
