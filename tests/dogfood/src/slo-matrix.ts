/**
 * The RL-116 journey-state × §11-SLO emission matrix (executable truth).
 *
 * spec/architecture.md §11 lands nine product SLOs; the reconciliation
 * engine emits its durable-action measurements through the sloObserver
 * (packages/reconciliation/src/slo-emission.ts), the decision read model
 * exposes the pure intent-satisfaction mapping, and the remaining §11
 * quantities have their measurement points in harness/scenario code. What
 * this module adds is the SYSTEMATIC cross-check: one row per journey
 * state (tech-lead handoff §8 vocabulary + architecture.md §10 failure
 * semantics), stating exactly which §11 SLO observes that state's
 * transition, through which kind of emission point:
 *
 *   - `productEmissions`: the PRODUCT-OWNED emission point fires (the
 *     reconciliation sloObserver; the recorded decision mapping);
 *   - `harnessMeasurements`: the quantity is measured only at a
 *     harness/scenario measurement point (recorded by scenario/walk code,
 *     not by a product surface) — an honest, named limitation;
 *   - `knownGap`: the named finding when NO §11 SLO observes the state.
 *
 * The rows are EXECUTED by `slo-journey-emission-matrix.test.ts` against
 * the real dogfood world: each row's drive advances the real domain planes
 * through that state's transition and asserts the emission deltas EXACTLY —
 * presence for expected emissions, absence for gap rows. A future regression
 * that breaks (or silently adds) an emission path fails this suite.
 */
import { epochMsOf, parseUtcInstant } from "@roamlink/contracts";
import { parseAdcosSignatureRef } from "@roamlink/adcos";
import type { ExperienceIntent, ExperienceIntentVersionRecord } from "@roamlink/domain-experience";
import {
  CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC,
  INTENT_SATISFACTION_RATE_METRIC,
  MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
  MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC,
  PRODUCT_SLO_IDS,
  PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC,
  STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
  SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
  SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
  TIME_TO_USABLE_CONNECTIVITY_MS_METRIC,
  type InMemoryMetrics,
  type ProductSloId,
} from "@roamlink/observability";
import { compileExperienceIntent } from "@roamlink/intent-compiler";
import type { IntentCommandInput } from "@roamlink/integration";

import type { DogfoodWorld, JourneyCustomer } from "./world.js";
import { enrollJourneyDevice, journeyIntentPayload, registerCustomer } from "./world.js";

/** The §11 metric-name constant of each closed §11 SLO id. */
export const METRIC_OF: Record<ProductSloId, string> = {
  "time-to-usable-connectivity": TIME_TO_USABLE_CONNECTIVITY_MS_METRIC,
  "minutes-without-usable-connectivity": MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC,
  "manual-interventions-per-session-day": MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
  "successful-automatic-recovery-rate": SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
  "intent-satisfaction-rate": INTENT_SATISFACTION_RATE_METRIC,
  "connectivity-cost-per-useful-hour-gb-where-available":
    CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC,
  "stale-unknown-state-duration": STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
  "provider-access-failover-success": PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC,
  "support-incidents-attributable-to-connectivity-orchestration":
    SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
};

/** One matrix row: a journey state and the §11 SLOs that observe it. */
export interface SloMatrixRow {
  /** The closed journey-state vocabulary value (handoff §8 / §10). */
  readonly state: string;
  /** §11 SLOs whose PRODUCT-OWNED emission point fires at this transition. */
  readonly productEmissions: readonly ProductSloId[];
  /** §11 SLOs measured ONLY at harness/scenario measurement points. */
  readonly harnessMeasurements: readonly ProductSloId[];
  /** The named finding when no §11 SLO observes this state (null = covered). */
  readonly knownGap: string | null;
}

/**
 * THE MATRIX. Rows follow the journey walk; the §10 failure semantics
 * follow the happy path. Every word in `knownGap` is a finding.
 */
export const SLO_EMISSION_MATRIX: readonly SloMatrixRow[] = [
  {
    state: "observed",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO has a product-owned emission point for device/connectivity observation; observation reaches the §11 plane only indirectly (intent satisfaction over the decision read model)",
  },
  {
    state: "requested",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the connectivity-request transition (paid order -> submitted ConnectivityIntent); time-to-usable SPANS this state but is measured once at the usable instant, not per state",
  },
  {
    state: "accepted",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the offer/contract acceptance transition (harness measurement points bracket the whole journey instead)",
  },
  {
    state: "reserved",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the reservation transition (the §11 plane measures outcomes over windows, not per network step)",
  },
  {
    state: "path-active",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the path-activation transition; activation truth reaches the projection plane (webhook -> projection) with no §11 emission site",
  },
  {
    state: "delivery",
    productEmissions: [],
    harnessMeasurements: ["time-to-usable-connectivity"],
    knownGap:
      "the evidence link (first usable connectivity) has NO product-owned §11 emission point; time-to-usable-connectivity is recorded by the HARNESS at this instant (the src/journey.ts blueprint)",
  },
  {
    state: "intent-satisfaction (decision evaluated)",
    productEmissions: ["intent-satisfaction-rate"],
    harnessMeasurements: [],
    knownGap: null,
  },
  {
    state: "failover (provider/access re-planning)",
    productEmissions: [],
    harnessMeasurements: ["provider-access-failover-success"],
    knownGap:
      "the failover attempt's outcome has NO product-owned §11 emission point; provider/access failover success is HARNESS-recorded at the granted failover reservation (scenario 2's measurement point)",
  },
  {
    state: "recovered (automatic repair closes the stale/unknown window)",
    productEmissions: ["successful-automatic-recovery-rate", "stale-unknown-state-duration"],
    harnessMeasurements: ["minutes-without-usable-connectivity"],
    knownGap:
      "recovery is product-emitted (the reconciliation sloObserver mirrors the durable actions) AND minutes-without-usable-connectivity is HARNESS-recorded at the same window close — the outage window itself has no second product emission point",
  },
  {
    state: "manual intervention (operator-triggered repair loop)",
    productEmissions: ["manual-interventions-per-session-day"],
    harnessMeasurements: [],
    knownGap: null,
  },
  {
    state: "authorized (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "authorization is ADCOS authority (RL-LOCK-001/002); there is no RoamLink-side drive or §11 emission point for this state — mapping-only row, recorded as a finding",
  },
  {
    state: "delivery-started (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no distinct RoamLink-side state exists between activation and delivery evidence (the reference model's deliveryEvidenceState carries UNEVIDENCED until evidence links), so no §11 emission point can observe it — mapping-only row, recorded as a finding",
  },
  {
    state: "delivered/usage accruing (§10, cost where available)",
    productEmissions: [],
    harnessMeasurements: ["connectivity-cost-per-useful-hour-gb-where-available"],
    knownGap:
      "usage-derived cost has NO product-owned emission point; the harness records per-useful-hour cost where available (and honestly records NOTHING per useful GB while the usage evidence reports zero bytes)",
  },
  {
    state: "completed (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the order-completion transition (a commerce-terminal state with no connectivity outcome to measure)",
  },
  {
    state: "billable-final (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the invoice-reconciliation (billable-final) transition; the §11 plane measures connectivity experience, not commerce finality",
  },
  {
    state: "failed (§10)",
    productEmissions: [],
    harnessMeasurements: ["support-incidents-attributable-to-connectivity-orchestration"],
    knownGap:
      "the failure transition has NO product-owned §11 emission point; support-incidents-attributable is HARNESS-recorded downstream of the failure (scenario 4's measurement point)",
  },
  {
    state: "canceled (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "no §11 SLO observes the cancel transition (a terminal commerce state with no connectivity outcome to measure)",
  },
  {
    state: "unknown/stale (window open, no repair) (§10)",
    productEmissions: [],
    harnessMeasurements: [],
    knownGap:
      "while the stale/unknown window is OPEN (repair deferred) the §11 plane emits NOTHING — honest absence, executable here: no fabricated recovery event, no guessed duration; the closed window is measured only at repair time",
  },
];

/** Snapshot of every §11 metric's sample count, keyed by name + labels. */
export function snapshotSloSamples(metrics: InMemoryMetrics): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const sample of metrics.samples()) {
    const key = `${sample.name}|${JSON.stringify(sample.labels)}`;
    snapshot.set(key, (snapshot.get(key) ?? 0) + 1);
  }
  return snapshot;
}

/** The samples of ONE §11 metric (label sets + values) at a point in time. */
export function samplesOf(
  metrics: InMemoryMetrics,
  slo: ProductSloId,
): readonly { labels: Record<string, unknown>; value?: number; delta?: number }[] {
  const metric = METRIC_OF[slo];
  const out: { labels: Record<string, unknown>; value?: number; delta?: number }[] = [];
  for (const sample of metrics.samples()) {
    if (sample.name !== metric) continue;
    const labels = sample.labels as Record<string, unknown>;
    out.push(
      sample.kind === "counter"
        ? { labels, delta: sample.delta }
        : { labels, value: sample.value },
    );
  }
  return out;
}

/** Emission delta of ONE §11 SLO between two snapshots. */
export function sloDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  slo: ProductSloId,
): number {
  let delta = 0;
  const metric = METRIC_OF[slo];
  for (const [key, count] of after) {
    if (!key.startsWith(`${metric}|`)) continue;
    delta += count - (before.get(key) ?? 0);
  }
  return delta;
}

/** Emission delta of ONE §11 SLO restricted to samples whose labels match. */
export function sloDeltaWhere(
  before: Map<string, number>,
  after: Map<string, number>,
  slo: ProductSloId,
  match: (labels: Record<string, unknown>) => boolean,
): number {
  let delta = 0;
  const metric = METRIC_OF[slo];
  for (const [key, count] of after) {
    if (!key.startsWith(`${metric}|`)) continue;
    const labels = JSON.parse(key.slice(metric.length + 1)) as Record<string, unknown>;
    if (!match(labels)) continue;
    delta += count - (before.get(key) ?? 0);
  }
  return delta;
}

/** Every §11 SLO id NOT named by the given expectations (absence assertions). */
export function otherSlos(...named: readonly ProductSloId[]): readonly ProductSloId[] {
  return PRODUCT_SLO_IDS.filter((id) => !named.includes(id));
}

// ---------------------------------------------------------------------------
// The staged journey walk (the seedActiveConnectivity blueprint, cut into
// per-state stage drivers so the matrix can snapshot emissions BETWEEN
// transitions)
// ---------------------------------------------------------------------------

const PRODUCT_ID = "00000000-0000-4000-8000-0000000000d1";
const VARIANT_ID = "00000000-0000-4000-8000-0000000000d2";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d3";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000d4";
const INTENT_ID = "00000000-0000-4000-8000-0000000000d5";
const REFERENCE_ID = "00000000-0000-4000-8000-0000000000d6";

export interface ObservedStage {
  readonly customer: JourneyCustomer;
  readonly deviceId: string;
}

/** `observed`: the customer + the journey device with fresh evidence snapshots. */
export async function stageObserved(world: DogfoodWorld): Promise<ObservedStage> {
  const customer = await registerCustomer(world, 0x71);
  const deviceId = await enrollJourneyDevice(world, customer, 0x71);
  return { customer, deviceId };
}

export interface RequestedStage {
  readonly paidAt: string;
  readonly intentRecord: ExperienceIntent;
  readonly currentVersion: ExperienceIntentVersionRecord;
  readonly adcosIntentId: string;
}

/** `requested`: paid order + authored/activated intent + submitted ConnectivityIntent. */
export async function stageRequested(
  world: DogfoodWorld,
  stage: ObservedStage,
): Promise<RequestedStage> {
  const { customer, deviceId } = stage;
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  await world.commerce.catalog.createProduct(world.envelope(actor), {
    productId: PRODUCT_ID,
    name: "Traveler Pass",
  });
  await world.commerce.catalog.activateProduct(world.envelope(actor), {
    productId: PRODUCT_ID,
    expectedRevision: 1,
  });
  await world.commerce.catalog.createVariant(world.envelope(actor), {
    variantId: VARIANT_ID,
    productId: PRODUCT_ID,
    name: "Ghana 14-Day",
    sku: `pass-${world.correlation.issued()}-14d`,
    billingModel: "one_time",
    termDays: 14,
    price: { amountMinorUnits: 2499, currency: "USD" },
  });
  await world.commerce.orders.createOrder(world.envelope({ ...actor, orderVersion: 1 }), {
    orderId: ORDER_ID,
    ownerUserId: customer.userId,
  });
  await world.commerce.orders.addOrderLine(world.envelope({ ...actor, orderVersion: 1 }), {
    orderId: ORDER_ID,
    lineId: world.ids.next(),
    variantId: VARIANT_ID,
    quantity: 1,
  });
  await world.commerce.orders.placeOrder(world.envelope({ ...actor, orderVersion: 2 }), {
    orderId: ORDER_ID,
  });
  await world.commerce.payments.recordPayment(world.envelope(actor), {
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    amount: { amountMinorUnits: 2499, currency: "USD" },
  });
  await world.commerce.payments.transitionPayment(world.envelope(actor), {
    paymentId: PAYMENT_ID,
    expectedRevision: 1,
    transition: "succeed",
  });
  const paidAt = world.clock.now();

  await world.experience.intents.createIntent(world.envelope(actor), {
    intentId: INTENT_ID,
    ownerUserId: customer.userId,
    deviceId,
    payload: journeyIntentPayload(),
    rationale: "Travel to Ghana for two weeks; keep work traffic reliable",
  });
  await world.experience.intents.transitionIntent(
    world.envelope({ ...actor, intentVersion: 1 }),
    { intentId: INTENT_ID, transition: "activate" },
  );
  const intentRecord = await world.experience.intents.getIntent(customer.tenantId, INTENT_ID);
  const versions = await world.experience.intents.listVersions(customer.tenantId, INTENT_ID);
  const currentVersion = versions.find(
    (version) => version.intentVersionId === intentRecord.currentVersionId,
  );
  if (currentVersion === undefined) {
    throw new Error("slo-matrix walk: expected the current intent version");
  }
  const compiled = compileExperienceIntent(
    intentRecord.toRecord(),
    currentVersion,
    { at: world.clock.now(), commandId: world.ids.next(), actorId: customer.actorId },
  );
  await world.adcos.intents.runCompatibilityCheck(undefined, world.clock.now());
  const submission = await world.adcos.intents.submit(
    compiled.payload as unknown as IntentCommandInput,
  );
  const adcosIntentId = (submission.document as Record<string, unknown>)["id"] as string;
  return { paidAt, intentRecord, currentVersion, adcosIntentId };
}

/** `accepted`: the offer is selected through the boundary (contract created). */
export async function stageAccepted(
  world: DogfoodWorld,
  customer: JourneyCustomer,
  adcosIntentId: string,
): Promise<string> {
  const context = {
    actorId: customer.actorId,
    tenantId: customer.tenantId,
    correlationId: world.correlation.next(),
  };
  const contract = await world.adcos.offers.selectOffers(
    adcosIntentId,
    { offers: [{ offer: "offer-ghana-primary" }], recorded_at: world.clock.now() },
    context,
  );
  return (contract.document as Record<string, unknown>)["id"] as string;
}

/** `reserved`: the contract is activated and the lease granted. */
export async function stageReserved(
  world: DogfoodWorld,
  customer: JourneyCustomer,
  adcosIntentId: string,
  contractId: string,
): Promise<void> {
  const context = {
    actorId: customer.actorId,
    tenantId: customer.tenantId,
    correlationId: world.correlation.next(),
  };
  await world.adcos.offers.activateContract(
    adcosIntentId,
    {
      activated_at: world.clock.now(),
      signature_refs: [parseAdcosSignatureRef("sig-matrix-activation-1")],
    },
    context,
  );
  await world.adcos.offers.createReservation(
    contractId,
    { granted_at: world.clock.now() },
    context,
  );
}

/** `path-active`: the connectivity events flow back and project (FRESH truth). */
export async function stagePathActive(world: DogfoodWorld): Promise<void> {
  await world.admitAndProject();
}

/**
 * `delivery`: the evidence link lands FRESH/EVIDENCED against the REAL
 * projected contract, and the HARNESS records §11 time-to-usable at the
 * first usable-connectivity instant (the src/journey.ts measurement point).
 */
export async function stageDelivery(
  world: DogfoodWorld,
  customer: JourneyCustomer,
  contractId: string,
  paidAt: string,
): Promise<string> {
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  const reference = await world.references.createReference(world.envelope(actor), {
    referenceId: REFERENCE_ID,
    subjectType: "order",
    subjectId: ORDER_ID,
  });
  const linked = await world.references.linkDeliveryEvidence(world.envelope(actor), {
    referenceId: REFERENCE_ID,
    expectedRevision: reference.revision,
    canonicalResourceType: "connectivity_contract",
    canonicalResourceId: contractId,
  });
  if (linked.deliveryEvidenceState !== "EVIDENCED" || linked.freshnessState !== "FRESH") {
    throw new Error("slo-matrix walk: expected the delivery evidence link to land FRESH/EVIDENCED");
  }
  const usableAt = world.clock.now();
  world.slo.recorder.recordTimeToUsableConnectivity({
    tenantId: customer.tenantId,
    durationMs: epochMsOf(parseUtcInstant(usableAt)) - epochMsOf(parseUtcInstant(paidAt)),
  });
  return REFERENCE_ID;
}
