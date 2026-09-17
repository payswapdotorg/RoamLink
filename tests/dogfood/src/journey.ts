/**
 * The compressed onboarding journey (shared dogfood seed).
 *
 * Runs the scenario-1 lifecycle end to end - customer, device, paid order,
 * intent authoring + compilation, ADCOS submission, offer/activation/
 * reservation, webhook projection, evidence link - so the failure-path
 * scenarios (2 and 3) start from an honestly established "first usable
 * connectivity" state instead of fixtures.
 *
 * Everything runs through the REAL package surfaces with the world's
 * deterministic clock/ids and one correlation family.
 */
import { parseAdcosSignatureRef } from "@roamlink/adcos";
import type { IntentCommandInput } from "@roamlink/integration";
import { compileExperienceIntent } from "@roamlink/intent-compiler";
import { epochMsOf, parseUtcInstant } from "@roamlink/contracts";

import {
  journeyIntentPayload,
  makeDogfoodWorld,
  must,
  registerCustomer,
  enrollJourneyDevice,
  type DogfoodWorld,
  type JourneyCustomer,
} from "./world.js";

const PRODUCT_ID = "00000000-0000-4000-8000-0000000000c1";
const VARIANT_ID = "00000000-0000-4000-8000-0000000000c2";
const ORDER_ID = "00000000-0000-4000-8000-0000000000c3";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000c4";
const INTENT_ID = "00000000-0000-4000-8000-0000000000c5";
const REFERENCE_ID = "00000000-0000-4000-8000-0000000000c6";

/** Everything the failure-path scenarios need from the seeded journey. */
export interface ActiveConnectivity {
  readonly world: DogfoodWorld;
  readonly customer: JourneyCustomer;
  readonly deviceId: string;
  readonly orderId: string;
  readonly paymentId: string;
  readonly intentId: string;
  readonly referenceId: string;
  readonly adcosIntentId: string;
  readonly contractId: string;
  readonly leaseId: string;
  /** The reference's revision after the initial evidence link. */
  readonly referenceRevision: number;
  /** The instant first usable connectivity was established (§11 marker). */
  readonly usableAt: string;
}

/**
 * Walks the full happy path and returns the established connectivity
 * context (projections FRESH, evidence EVIDENCED, decision supported).
 */
export async function seedActiveConnectivity(
  world: DogfoodWorld,
): Promise<ActiveConnectivity> {
  const customer = await registerCustomer(world, 0x31);
  const deviceId = await enrollJourneyDevice(world, customer, 0x31);
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };

  // Catalog + paid order.
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
  // §11 "time to usable connectivity" (harness-side measurement point):
  // the paid-order instant is the journey's start marker — the first
  // usable-connectivity instant is captured when the evidence link lands
  // FRESH below.
  const paidAt = world.clock.now();

  // ExperienceIntent -> compile -> submit through the boundary.
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
  const currentVersion = must(
    versions.find((version) => version.intentVersionId === intentRecord.currentVersionId),
    "current intent version",
  );
  const compiled = compileExperienceIntent(intentRecord.toRecord(), currentVersion, {
    at: world.clock.now(),
    commandId: world.ids.next(),
    actorId: customer.actorId,
  });
  await world.adcos.intents.runCompatibilityCheck(undefined, world.clock.now());
  const submission = await world.adcos.intents.submit(
    compiled.payload as unknown as IntentCommandInput,
  );
  const adcosIntentId = (submission.document as Record<string, unknown>)["id"] as string;

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
  const contractId = (contract.document as Record<string, unknown>)["id"] as string;
  await world.adcos.offers.activateContract(
    adcosIntentId,
    {
      activated_at: world.clock.now(),
      signature_refs: [parseAdcosSignatureRef("sig-activation-1")],
    },
    context,
  );
  const lease = await world.adcos.offers.createReservation(contractId, {
    granted_at: world.clock.now(),
  }, context);
  const leaseId = (lease.document as Record<string, unknown>)["id"] as string;

  // Webhooks -> projections.
  await world.admitAndProject();

  // Evidence link.
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
  expectLinkedFresh(linked);

  // FIRST USABLE CONNECTIVITY (§11 "time to usable connectivity"): the
  // reference is EVIDENCED + FRESH against the AUTHENTICATED activated
  // contract projection. The measured duration is paidAt -> this instant on
  // the deterministic clock, recorded through the REAL product-SLO recorder
  // (histogram sample + threshold-classified good/bad event).
  const usableAt = world.clock.now();
  world.slo.recorder.recordTimeToUsableConnectivity({
    tenantId: customer.tenantId,
    durationMs: epochMsOf(parseUtcInstant(usableAt)) - epochMsOf(parseUtcInstant(paidAt)),
  });

  return {
    world,
    customer,
    deviceId,
    orderId: ORDER_ID,
    paymentId: PAYMENT_ID,
    intentId: INTENT_ID,
    referenceId: REFERENCE_ID,
    adcosIntentId,
    contractId,
    leaseId,
    referenceRevision: linked.revision,
    usableAt,
  };
}

function expectLinkedFresh(
  linked: { readonly deliveryEvidenceState: string; readonly freshnessState: string },
): void {
  if (linked.deliveryEvidenceState !== "EVIDENCED" || linked.freshnessState !== "FRESH") {
    throw new Error(
      `seedActiveConnectivity: expected EVIDENCED/FRESH after the initial link, got ${linked.deliveryEvidenceState}/${linked.freshnessState}`,
    );
  }
}

/** Builds one edge world with the real deterministic id sources. */
export function makeJourneyWorld(scene: string): DogfoodWorld {
  return makeDogfoodWorld(scene);
}

