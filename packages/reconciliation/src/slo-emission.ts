/**
 * §11 SLO emission from reconciliation outcomes (additive RL-052 wiring for
 * spec/architecture.md §11 — "successful automatic recovery rate",
 * "stale/unknown-state duration", "manual interventions per session/day").
 *
 * The reconciliation loop is the product's clearest measurement point for
 * these quantities: every job's RECORDED actions are the durable truth of
 * what the automatic repair path did:
 *
 *  - a `CANONICAL_REFRESH` action with outcome `REPAIRED` is one SUCCESSFUL
 *    AUTOMATIC RECOVERY (authoritative truth was restored with no human in
 *    the loop — an automatic-recovery GOOD event);
 *  - a `CANONICAL_REFRESH` action with outcome `DEGRADED_STALE` or
 *    `DEGRADED_UNKNOWN` is a FAILED automatic recovery attempt (the loop
 *    degraded honestly instead of repairing — an automatic-recovery BAD
 *    event);
 *  - STALE/UNKNOWN-STATE DURATION is measured at both boundaries of a
 *    stale/unknown window, and the engine stamps BOTH quantities into the
 *    action's `metrics` from the projection's own freshness fields — never
 *    guessed:
 *      · `metrics.staleForMs` on a REPAIRED action whose pre-repair record
 *        was STALE or UNKNOWN: the CLOSED window's full duration
 *        (repair instant - fresh_until/observed_at);
 *      · `metrics.degradedForMs` on a DEGRADED action: how long the truth
 *        had already been unguaranteed at the moment of honest degradation
 *        (usually 0 — the loop degrades within the renewal margin while the
 *        guarantee is still valid; positive when the guarantee is absent).
 *  - a job whose `trigger_reason` is `manual` is one MANUAL INTERVENTION (a
 *    human had to trigger the repair loop — the automatic path did not
 *    converge on its own).
 *
 * `DEFERRED`, `ALREADY_CONSISTENT` and `CANONICAL_ABSENT` outcomes emit
 * NOTHING: they are not recovery attempts (no attempt, already consistent,
 * or the authority honestly reports the resource absent).
 *
 * The port ({@link ReconciliationSloObserver}) is intentionally structural:
 * the `@roamlink/observability` §11 recorder
 * (`ProductSloRecorder` from `createProductSloRecorder`) satisfies it
 * directly, so composed services and harnesses wire the SAME typed recorder
 * they assert on — this package adds NO dependency on observability and
 * keeps no metrics vendor surface of its own.
 */
import type { UtcInstant } from "@roamlink/contracts";

import type { ReconciliationJobRecord } from "./job-record.js";

/** The shared measurement input (tenant-scoped, explicit instant). */
export interface ReconciliationSloMeasurementInput {
  /** The tenant the measurement is scoped to (opaque id, label value). */
  readonly tenantId: string;
  /** Explicit recording instant (default: the observer's own clock). */
  readonly at?: UtcInstant | string;
}

/**
 * The §11 measurement port the reconciliation loop emits through. The
 * `@roamlink/observability` product-SLO recorder is structurally compatible;
 * any other adapter implementing these three methods works too.
 */
export interface ReconciliationSloObserver {
  /** §11 "successful automatic recovery rate": one attempt outcome. */
  recordSuccessfulAutomaticRecovery(
    input: ReconciliationSloMeasurementInput & { readonly succeeded: boolean },
  ): void;
  /** §11 "stale/unknown-state duration": ms one target's truth spent stale/unknown. */
  recordStaleUnknownStateDuration(
    input: ReconciliationSloMeasurementInput & {
      readonly durationMs: number;
      readonly freshnessState: "stale" | "unknown";
    },
  ): void;
  /** §11 "manual interventions per session/day": one human-triggered repair loop. */
  recordManualIntervention(input: ReconciliationSloMeasurementInput): void;
}

/** The `metrics.staleForMs` key the engine stamps on stale-window-CLOSING repairs. */
export const STALE_FOR_MS_METRIC_KEY = "staleForMs";

/** The `metrics.staleState` key naming the closed window's pre-repair freshness state. */
export const STALE_STATE_METRIC_KEY = "staleState";

/** The `metrics.degradedForMs` key the engine stamps on honest degradations. */
export const DEGRADED_FOR_MS_METRIC_KEY = "degradedForMs";

function readMetricsNumber(action: { readonly metrics?: unknown }, key: string): number | null {
  const metrics = action.metrics;
  if (metrics === null || metrics === undefined || typeof metrics !== "object") return null;
  const value = (metrics as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function readStaleState(action: { readonly metrics?: unknown }): "stale" | "unknown" | null {
  const metrics = action.metrics;
  if (metrics === null || metrics === undefined || typeof metrics !== "object") return null;
  const value = (metrics as Record<string, unknown>)[STALE_STATE_METRIC_KEY];
  return value === "UNKNOWN" ? "unknown" : value === "STALE" ? "stale" : null;
}

/**
 * Emits the §11 SLO events implied by one COMPLETED reconciliation job —
 * pure: a function of the job's durable record and the observer. The engine
 * calls this once per completed job (idempotent job replays return the
 * recorded outcome without re-running, so they never double-emit); the
 * function itself never mutates the job.
 *
 * Throws only on observer contract violations (typed measurement errors) —
 * callers that must never fail on emission wrap it.
 */
export function emitReconciliationSloEvents(
  observer: ReconciliationSloObserver,
  job: ReconciliationJobRecord,
): void {
  if (observer === null || typeof observer !== "object") {
    throw new TypeError("emitReconciliationSloEvents requires a ReconciliationSloObserver");
  }
  const tenantId = job.tenant_id;
  const completedAt: UtcInstant | string | undefined =
    job.completed_at === null ? undefined : job.completed_at;

  if (job.trigger_reason === "manual") {
    observer.recordManualIntervention({ tenantId, ...(completedAt !== undefined ? { at: completedAt } : {}) });
  }

  for (const action of job.actions) {
    if (action.action_type !== "CANONICAL_REFRESH") continue;
    switch (action.outcome) {
      case "REPAIRED": {
        observer.recordSuccessfulAutomaticRecovery({
          tenantId,
          succeeded: true,
          at: action.attempted_at,
        });
        const staleForMs = readMetricsNumber(action, STALE_FOR_MS_METRIC_KEY);
        const staleState = readStaleState(action);
        if (staleForMs !== null && staleState !== null) {
          observer.recordStaleUnknownStateDuration({
            tenantId,
            durationMs: staleForMs,
            freshnessState: staleState,
            at: action.attempted_at,
          });
        }
        break;
      }
      case "DEGRADED_STALE":
      case "DEGRADED_UNKNOWN": {
        observer.recordSuccessfulAutomaticRecovery({
          tenantId,
          succeeded: false,
          at: action.attempted_at,
        });
        const degradedForMs = readMetricsNumber(action, DEGRADED_FOR_MS_METRIC_KEY);
        if (degradedForMs !== null) {
          observer.recordStaleUnknownStateDuration({
            tenantId,
            durationMs: degradedForMs,
            freshnessState: action.outcome === "DEGRADED_STALE" ? "stale" : "unknown",
            at: action.attempted_at,
          });
        }
        break;
      }
      default:
        // ALREADY_CONSISTENT / DEFERRED / CANONICAL_ABSENT: not recovery
        // attempts — nothing to emit (see module doc).
        break;
    }
  }
}

/**
 * How long a target's truth had already been unguaranteed at the moment the
 * loop degrades it honestly: `at - fresh_until` for STALE decay (the
 * guarantee expired in the past), `at - observed_at` when the guarantee is
 * absent. Pure and defensive: null freshness fields degrade to the other
 * timestamp, and the result is never negative. (Usually 0: the loop
 * typically degrades within the renewal margin while the guarantee is still
 * valid.)
 */
export function degradedForMsAt(
  record: {
    readonly freshness_state: string;
    readonly fresh_until: UtcInstant | null;
    readonly observed_at: UtcInstant | null;
  },
  at: UtcInstant,
  toEpochMs: (instant: UtcInstant) => number,
): number {
  const atMs = toEpochMs(at);
  const reference =
    record.freshness_state === "STALE" && record.fresh_until !== null
      ? record.fresh_until
      : (record.fresh_until ?? record.observed_at);
  if (reference === null) return 0;
  const referenceMs = toEpochMs(reference);
  return atMs > referenceMs ? atMs - referenceMs : 0;
}

/** The minimal pre-repair freshness shape the closed-window math needs. */
export interface PreRepairFreshness {
  readonly freshness_state: string;
  readonly fresh_until: UtcInstant | null;
  readonly observed_at: UtcInstant | null;
}

/**
 * The FULL duration of a stale/unknown window that a repair just CLOSED:
 * `repairedAt - (fresh_until ?? observed_at)` of the PRE-repair record, when
 * that record was STALE or UNKNOWN. Returns null when the pre-repair record
 * was FRESH (or absent) — no stale window existed, so there is nothing to
 * measure (the renewal just extended a still-valid guarantee). Never
 * negative.
 */
export function closedStaleWindowMs(
  preRepair: PreRepairFreshness | null,
  repairedAt: UtcInstant,
  toEpochMs: (instant: UtcInstant) => number,
): { durationMs: number; staleState: "stale" | "unknown" } | null {
  if (preRepair === null) return null;
  if (preRepair.freshness_state !== "STALE" && preRepair.freshness_state !== "UNKNOWN") {
    return null;
  }
  const repairedAtMs = toEpochMs(repairedAt);
  const start = preRepair.fresh_until ?? preRepair.observed_at;
  if (start === null) return { durationMs: 0, staleState: preRepair.freshness_state === "UNKNOWN" ? "unknown" : "stale" };
  const durationMs = Math.max(0, repairedAtMs - toEpochMs(start));
  return {
    durationMs,
    staleState: preRepair.freshness_state === "UNKNOWN" ? "unknown" : "stale",
  };
}
