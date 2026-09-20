/**
 * The §11 SLO dashboard read model (RL-109) — an ADDITIVE presentation
 * helper over the frozen recorder primitives (slo.ts / slo-health.ts /
 * slo-metrics.ts are the source of truth; this module only READS them).
 *
 * What it does (pure, zero invented numbers):
 *  - takes a {@link ProductSloRecorder}-shaped event stream (only the
 *    `events` + `now` seams it needs) and the DEPLOYMENT-CONFIGURED
 *    objectives (targets are operator decisions — the machinery refuses to
 *    invent them, matching slo-metrics' "NO invented targets" law);
 *  - evaluates EVERY §11 product SLO id: BUDGETED ids (an objective is
 *    configured) get the real evaluation (state, burn rate, budget
 *    remaining) over the objective window plus the multi-window burn-rate
 *    pairing, and their closed {@link SloState} maps onto the health
 *    vocabulary through the frozen {@link sloHealthState};
 *  - MEASURED-ONLY ids (no objective configured) are rendered as exactly
 *    that: `not budgeted (no target configured)`. They are never silently
 *    classified and never show a fabricated state — fail-safe defaults.
 *  - the overall roll-up is the pure health aggregation of the budgeted
 *    rows (aggregateHealthStates); with NO budgeted rows the honest overall
 *    is `degraded` (never silently healthy — fail-safe defaults).
 *
 * NO domain authority, NO vendor surface, NO secret-bearing fields
 * (RL-LOCK-016): every value is a counter, a ratio, a closed-vocabulary
 * label or a bounded string.
 */
import { parseUtcInstant, type UtcInstant } from "@roamlink/contracts";

import { aggregateHealthStates, type HealthState } from "../health/health.js";
import {
  PRODUCT_SLO_IDS,
  type ProductSloId,
} from "./slo-metrics.js";
import {
  describeSloEvaluation,
  sloHealthState,
} from "./slo-health.js";
import {
  multiWindowBurnRates,
  type ServiceLevelObjective,
  type SloEvaluation,
  type SloEventRecorder,
  type SloWindowBurnRate,
} from "./slo.js";

/** The default multi-window burn-rate pairing (the classic fast/slow alert). */
export const SLO_DASHBOARD_WINDOWS: readonly { readonly label: string; readonly windowMs: number }[] =
  Object.freeze([
    { label: "5m", windowMs: 5 * 60_000 },
    { label: "1h", windowMs: 3_600_000 },
    { label: "30m", windowMs: 30 * 60_000 },
    { label: "6h", windowMs: 6 * 3_600_000 },
  ]);

/** One dashboard row: one §11 product SLO, evaluated at one instant. */
export interface SloDashboardRow {
  /** The §11 SLO id (the closed PRODUCT_SLO_IDS vocabulary). */
  readonly id: ProductSloId;
  /** The objective name the events are recorded under (null when not budgeted). */
  readonly objectiveName: string | null;
  /** True when the deployment configured an objective (target + window) for this id. */
  readonly budgeted: boolean;
  /** The configured target good-event ratio (null when not budgeted). */
  readonly targetRatio: number | null;
  /** The configured evaluation window in ms (null when not budgeted). */
  readonly windowMs: number | null;
  /** The real evaluation over the objective window (null when not budgeted). */
  readonly evaluation: SloEvaluation | null;
  /** Multi-window burn rates for budgeted rows (empty when not budgeted). */
  readonly windows: readonly SloWindowBurnRate[];
  /** The health-vocabulary mapping (null when not budgeted — never guessed). */
  readonly healthState: HealthState | null;
  /** The bounded human summary (the evaluation's own description, or the honest not-budgeted line). */
  readonly detail: string;
}

/** The dashboard snapshot: every §11 product SLO + the honest overall. */
export interface SloDashboardSnapshot {
  readonly asOf: UtcInstant;
  /** The health-vocabulary overall over the BUDGETED rows (see module doc). */
  readonly overall: HealthState;
  /** True when at least one objective is configured (drives the overall's meaning). */
  readonly budgetedCount: number;
  readonly rows: readonly SloDashboardRow[];
}

export interface BuildSloDashboardInput {
  /** The event stream the evaluations read (a ProductSloRecorder satisfies this). */
  readonly events: SloEventRecorder;
  /** The evaluation instant. Explicit (deterministic) OR the recorder's clock via `now`.
   *  Exactly one of `asOf` / `now` must be provided — never ambient time. */
  readonly asOf?: UtcInstant | string;
  /** The clock used when `asOf` is absent (a ProductSloRecorder carries one). */
  readonly now?: () => UtcInstant;
  /**
   * The objectives the DEPLOYMENT configured, keyed by §11 SLO id. An id
   * mapped to `undefined` (or absent) renders as measured-only (never
   * fabricated).
   */
  readonly objectives: Readonly<Record<ProductSloId, ServiceLevelObjective | undefined>>;
  /** Multi-window pairing (defaults to {@link SLO_DASHBOARD_WINDOWS}). */
  readonly windows?: readonly { readonly label: string; readonly windowMs: number }[];
}

/**
 * Builds the dashboard snapshot from the REAL recorder state (pure read).
 * Never throws on an unconfigured objective set and never invents an
 * evaluation: the closed §11 vocabulary flows straight through.
 */
export function buildProductSloDashboard(input: BuildSloDashboardInput): SloDashboardSnapshot {
  if (input === null || typeof input !== "object") {
    throw new TypeError("buildProductSloDashboard requires an input object");
  }
  if (typeof input.events?.evaluate !== "function") {
    throw new TypeError("buildProductSloDashboard requires an events: SloEventRecorder seam");
  }
  const objectives = input.objectives ?? {};
  const windows = input.windows ?? SLO_DASHBOARD_WINDOWS;
  const asOf: UtcInstant =
    input.asOf !== undefined
      ? parseUtcInstant(input.asOf)
      : input.now !== undefined
        ? input.now()
        : assertAsOfPresent();

  const rows: SloDashboardRow[] = PRODUCT_SLO_IDS.map((id) => {
    const objective = objectives[id];
    if (objective === undefined) {
      return Object.freeze({
        id,
        objectiveName: null,
        budgeted: false,
        targetRatio: null,
        windowMs: null,
        evaluation: null,
        windows: Object.freeze([]),
        healthState: null,
        detail: "not budgeted (no target configured) — measurements export through the metrics contract; never silently classified",
      });
    }
    if (objective.name === undefined || typeof objective.name !== "string") {
      throw new TypeError(`the objective configured for ${id} is not a ServiceLevelObjective`);
    }
    const evaluation = input.events.evaluate(objective, asOf);
    return Object.freeze({
      id,
      objectiveName: objective.name,
      budgeted: true,
      targetRatio: objective.targetRatio,
      windowMs: objective.windowMs,
      evaluation,
      windows: multiWindowBurnRates(input.events, objective, windows, asOf),
      healthState: sloHealthState(evaluation.state),
      detail: describeSloEvaluation(evaluation),
    });
  });

  const budgetedHealth = rows
    .filter((row) => row.healthState !== null)
    .map((row) => row.healthState as HealthState);
  // No budgeted rows is an UNCONFIGURED deployment: honestly degraded (the
  // dashboard cannot claim health over objectives it does not have).
  const overall =
    budgetedHealth.length === 0 ? "degraded" : aggregateHealthStates(budgetedHealth);

  return Object.freeze({
    asOf,
    overall,
    budgetedCount: budgetedHealth.length,
    rows: Object.freeze(rows),
  });
}

function assertAsOfPresent(): never {
  throw new TypeError(
    "buildProductSloDashboard requires an explicit asOf or a now clock (never ambient time)",
  );
}
