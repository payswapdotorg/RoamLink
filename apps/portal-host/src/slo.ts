/**
 * The host's §11 SLO composition bindings (RL-109 — the HOST-SIDE ops
 * surface architecture).
 *
 * ARCHITECTURE CHOICE (documented where the code lives, per the work item):
 * the operator SLO dashboard is a HOST-SIDE SURFACE fed directly by the
 * @roamlink/observability package through the composition this host already
 * owns — NOT an apps/admin console page. The trade-off:
 *
 *  - (a) ADMIN EXTENSION loses: every admin-console page fetches its data
 *    through the RoamLinkApiClient's /v1 read routes, and on the REAL
 *    runtime every spec read route (projection-health, reconciliation-jobs,
 *    ...) answers the HONEST typed 501 READ_MODEL_NOT_COMPOSED
 *    (services/api). A dashboard that needs those read models must not
 *    invent them (RL-109's own constraint), so an admin SLO page would
 *    render the 501 error panels — an error surface, never the SLO truth —
 *    unless this item silently composed the missing read models, which is
 *    explicitly out of scope.
 *  - (b) HOST-SIDE SURFACE wins: the host composition is the one place the
 *    real bindings are assembled, so the observability recorder composes
 *    here once per process and the surface renders the REAL recorder state
 *    (evaluations, burn rates, the closed §11 vocabulary) through PUBLIC
 *    seams only — no new HTTP read model, no 501 dependency, no second
 *    authority. The cost (the surface lives with the host's session layer
 *    instead of the console's page table) is smaller than inventing a read
 *    model or shipping an always-broken admin page.
 *
 * Targets are OPERATOR CONFIGURATION (the machinery's "NO invented targets"
 * law): `ROAMLINK_SLO_OBJECTIVES` carries the budgeted objectives as
 * comma-separated `id:targetRatio:windowMs[:atRiskBurnRate]` entries keyed
 * by the closed §11 SLO ids. Unconfigured ids are honestly "measured-only"
 * on the dashboard — never silently classified. Parsing fails closed (a
 * malformed entry refuses the boot) instead of half-configuring.
 */
import {
  MetricRegistry,
  SloEventRecorder,
  createMetricsRecorder,
  createProductSloRecorder,
  makeProductSloObjective,
  parseProductSloId,
  registerProductSloMetrics,
  registerSloMetrics,
  PRODUCT_SLO_IDS,
  type ProductSloId,
  type ProductSloRecorder,
  type ServiceLevelObjective,
} from "@roamlink/observability";
import type { UtcInstant } from "@roamlink/contracts";

import { CompositionError } from "./composition.js";

/** The env key carrying the deployment's budgeted §11 objectives. */
export const SLO_OBJECTIVES_ENV_KEY = "ROAMLINK_SLO_OBJECTIVES";

/**
 * Parses `ROAMLINK_SLO_OBJECTIVES` ("id:targetRatio:windowMs[:atRiskBurnRate],...").
 * Every entry must key one of the nine closed §11 SLO ids; ratios stay in
 * (0, 1], windows are positive integers, and unknown ids or malformed
 * entries REFUSE the composition (fail closed, nothing half-configured).
 */
export function parseSloObjectivesEnv(
  raw: string | undefined,
): Readonly<Record<ProductSloId, ServiceLevelObjective | undefined>> {
  const objectives: Partial<Record<ProductSloId, ServiceLevelObjective>> = {};
  if (raw === undefined || raw.trim().length === 0) {
    return Object.freeze(
      Object.fromEntries(PRODUCT_SLO_IDS.map((id) => [id, undefined])) as Record<
        ProductSloId,
        ServiceLevelObjective | undefined
      >,
    );
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(":");
    if (parts.length < 3 || parts.length > 4) {
      throw new CompositionError(
        `${SLO_OBJECTIVES_ENV_KEY} entries must be id:targetRatio:windowMs[:atRiskBurnRate] (got ${parts.length} part(s); refusing to boot half-configured)`,
      );
    }
    const [idRaw, targetRaw, windowRaw, burnRaw] = parts.map((part) => part.trim());
    let id: ProductSloId;
    try {
      id = parseProductSloId(idRaw);
    } catch {
      throw new CompositionError(
        `${SLO_OBJECTIVES_ENV_KEY} names an unknown §11 SLO id (the closed set is: ${PRODUCT_SLO_IDS.join(", ")})`,
      );
    }
    const targetRatio = Number(targetRaw);
    const windowMs = Number(windowRaw);
    const atRiskBurnRate = burnRaw === undefined || burnRaw.length === 0 ? undefined : Number(burnRaw);
    try {
      objectives[id] = makeProductSloObjective(id, {
        targetRatio,
        windowMs,
        ...(atRiskBurnRate !== undefined ? { atRiskBurnRate } : {}),
      });
    } catch {
      throw new CompositionError(
        `${SLO_OBJECTIVES_ENV_KEY} entry '${idRaw}' carries out-of-bounds numbers (targetRatio in (0,1], windowMs a positive integer, atRiskBurnRate in (0,1])`,
      );
    }
  }
  return Object.freeze(
    Object.fromEntries(PRODUCT_SLO_IDS.map((id) => [id, objectives[id]])) as Record<
      ProductSloId,
      ServiceLevelObjective | undefined
    >,
  );
}

/** The host's §11 SLO bindings (one set per composed process). */
export interface HostSloBindings {
  /** The recorder the service seams emit through (RL-052 §11 surface). */
  readonly recorder: ProductSloRecorder;
  /** The objectives THIS deployment configured (the budgeted subset). */
  readonly objectives: Readonly<Record<ProductSloId, ServiceLevelObjective | undefined>>;
}

/**
 * Composes the host's SLO bindings: the in-process metrics registry with
 * the §11 metric definitions registered, the event recorder behind the
 * typed product-SLO recorder, and the deployment's configured objectives.
 * NO budget thresholds are handed to the recorder (targets are never
 * invented in code) — the recorder classifies good/bad only for SLOs whose
 * threshold-bearing measurements a deployment explicitly budgets, and the
 * dashboard evaluates the configured objectives at request time.
 */
export function createHostSloBindings(options: {
  readonly objectivesRaw: string | undefined;
  readonly now: () => UtcInstant;
}): HostSloBindings {
  const registry = new MetricRegistry();
  registerProductSloMetrics(registry);
  registerSloMetrics(registry);
  const recorder = createProductSloRecorder({
    metrics: createMetricsRecorder(registry),
    events: new SloEventRecorder(),
    now: options.now,
  });
  return {
    recorder,
    objectives: parseSloObjectivesEnv(options.objectivesRaw),
  };
}
