/**
 * RL-072 dogfood scenario 4: REFUND + PARTIAL REFUND WITH INCIDENT
 * CORRELATION (RL-022 + RL-014 + RL-051).
 *
 * A payment failure opens an incident; the support case correlates it; the
 * retry payment succeeds; a connectivity-related service failure leads to a
 * FULL refund, and a second payment carries PARTIAL refunds with typed
 * bounds. The architectural truth properties:
 *
 *   - payment failure is a typed, closed-vocabulary money fact
 *     (RL-LOCK-008): a failed payment never mutates order state and never
 *     implies anything about delivery;
 *   - the refund lifecycle is bounded by PROVEN money facts: refunds are
 *     capped by the succeeded-payments-minus-succeeded-refunds arithmetic;
 *     over-refunds are typed rejections, never silent clamps;
 *   - incident correlation: the support case, the notifications and the
 *     audit events all carry the SAME correlation-id family and typed
 *     related refs (orders/payments/refunds);
 *   - notifications are emitted only from durable RoamLink transitions
 *     (RL-LOCK-009) and delivered through channel attempts;
 *   - the audit trail is COMPLETE and tamper-evident (RL-051): commerce
 *     event chains, notification event chains and the SHA-256 audit chain
 *     all verify, and every artifact is queryable by correlation id.
 */
import { describe, expect, it } from "vitest";
import { ConflictError } from "@roamlink/contracts";
import { computeRefundableAmount } from "@roamlink/domain-commerce";
import {
  SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
  evaluateProductSlo,
} from "@roamlink/observability";

import {
  makeDogfoodWorld,
  must,
  registerCustomer,
  type DogfoodWorld,
} from "../src/world.js";
import type { JourneyCustomer } from "../src/world.js";

const PRODUCT_ID = "00000000-0000-4000-8000-0000000000e1";

const ORDER_A = "00000000-0000-4000-8000-0000000000e3";
const ORDER_B = "00000000-0000-4000-8000-0000000000f3";
const PAYMENT_A1 = "00000000-0000-4000-8000-0000000000e4";
const PAYMENT_A2 = "00000000-0000-4000-8000-0000000000e5";
const PAYMENT_B = "00000000-0000-4000-8000-0000000000f4";
const INVOICE_A = "00000000-0000-4000-8000-0000000000e6";
const REFUND_FULL = "00000000-0000-4000-8000-0000000000e7";
const REFUND_PARTIAL_1 = "00000000-0000-4000-8000-0000000000f7";
const REFUND_PARTIAL_2 = "00000000-0000-4000-8000-0000000000f8";
const CASE_ID = "00000000-0000-4000-8000-0000000000e9";
const NOTIF_PAYMENT_FAILED = "00000000-0000-4000-8000-0000000000ea";
const NOTIF_REFUND_SUCCEEDED = "00000000-0000-4000-8000-0000000000eb";

/** Seeds the product once per world (catalog leg). */
async function seedProduct(world: DogfoodWorld, customer: JourneyCustomer): Promise<void> {
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  await world.commerce.catalog.createProduct(world.envelope(actor), {
    productId: PRODUCT_ID,
    name: "Traveler Pass",
  });
  await world.commerce.catalog.activateProduct(world.envelope(actor), {
    productId: PRODUCT_ID,
    expectedRevision: 1,
  });
}

/** Places one order for the given amount (a fresh variant per order). */
async function placedOrder(
  world: DogfoodWorld,
  customer: JourneyCustomer,
  orderId: string,
  amountMinorUnits: number,
  sku: string,
): Promise<void> {
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  // One distinct variant per order (deterministic id derived from the order).
  const variantId = `00000000-0000-4000-8000-${orderId.slice(-12)}`;
  await world.commerce.catalog.createVariant(world.envelope(actor), {
    variantId,
    productId: PRODUCT_ID,
    name: "Pass",
    sku,
    billingModel: "one_time",
    termDays: 14,
    price: { amountMinorUnits, currency: "USD" },
  });
  await world.commerce.orders.createOrder(world.envelope({ ...actor, orderVersion: 1 }), {
    orderId,
    ownerUserId: customer.userId,
  });
  await world.commerce.orders.addOrderLine(world.envelope({ ...actor, orderVersion: 1 }), {
    orderId,
    lineId: world.ids.next(),
    variantId,
    quantity: 1,
  });
  await world.commerce.orders.placeOrder(world.envelope({ ...actor, orderVersion: 2 }), { orderId });
}

describe("RL-072 scenario 4: refund + partial refund with incident correlation", () => {
  it("payment failure -> support case -> retry payment -> full refund; partial refunds with typed bounds; complete correlated audit trail", async () => {
    const world = makeDogfoodWorld("refund-incident");
    const customer = await registerCustomer(world, 0x51);
    const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
    const env = () => world.envelope(actor);
    await seedProduct(world, customer);

    // ------------------------------------------------------------------
    // 1. The order is placed; the FIRST payment FAILS (typed money fact).
    // ------------------------------------------------------------------
    await placedOrder(world, customer, ORDER_A, 2499, "pass-refund-a");
    await world.commerce.payments.recordPayment(env(), {
      paymentId: PAYMENT_A1,
      orderId: ORDER_A,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(env(), {
      paymentId: PAYMENT_A1,
      expectedRevision: 1,
      transition: "fail",
      failureReason: "processor_error",
    });
    const failedPayment = await world.commerce.store.read.payments.findById(
      customer.tenantId,
      PAYMENT_A1 as never,
    );
    expect(failedPayment?.status).toBe("failed");
    // A failed payment carries its TYPED failure reason (closed vocabulary).
    expect(failedPayment?.failureReason).toBe("processor_error");
    // The failure is a MONEY fact only: the order stays placed, delivery is
    // still unevidenced (RL-LOCK-008 - payment is not delivery).
    const orderA = await world.commerce.store.read.orders.findById(
      customer.tenantId,
      ORDER_A as never,
    );
    expect(orderA?.status).toBe("placed");

    // ------------------------------------------------------------------
    // 2. Incident correlation: a support case links the failed payment.
    // ------------------------------------------------------------------
    await world.notifications.openCase(env(), {
      supportCaseId: CASE_ID,
      requesterUserId: customer.userId,
      subject: "Payment failed while traveling",
      description: "Card payment errored during Ghana trip checkout.",
      priority: "high",
      relatedRefs: [{ kind: "payment", id: PAYMENT_A1 }],
    });

    // The failure notification is emitted from the DURABLE payment event
    // (RL-LOCK-009: RoamLink state transitions, never raw ADCOS payloads).
    const paymentEvents = await world.commerce.store.read.events.listForAggregate(
      customer.tenantId,
      "customer_payment",
      PAYMENT_A1,
    );
    const failedEvent = must(
      paymentEvents.find((event) => event.transition === "customer_payment.failed"),
      "payment failed event",
    );
    await world.notifications.emitFromTransition(env(), {
      notificationId: NOTIF_PAYMENT_FAILED,
      recipientUserId: customer.userId,
      topic: "payment",
      severity: "critical",
      title: "Payment failed",
      body: "Your payment could not be processed (processor_error). No delivery is implied.",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "customer_payment",
        aggregateId: PAYMENT_A1,
        transition: "customer_payment.failed",
        eventId: failedEvent.eventId,
        occurredAt: failedEvent.occurredAt,
      },
      relatedRefs: [
        { kind: "payment", id: PAYMENT_A1 },
        { kind: "order", id: ORDER_A },
      ],
    });
    await world.notifications.recordChannelDelivery(env(), {
      notificationId: NOTIF_PAYMENT_FAILED,
      channel: "in_app",
      outcome: "delivered",
    });

    // The incident support case is correlated to the payment.
    const casesForPayment = await world.notifications.listCasesForRelatedRef(
      customer.tenantId,
      { kind: "payment", id: PAYMENT_A1 },
    );
    expect(casesForPayment.map((record) => record.supportCaseId)).toContain(CASE_ID);

    // ------------------------------------------------------------------
    // 3. The retry payment SUCCEEDS; the invoice reconciles from money facts.
    // ------------------------------------------------------------------
    await world.commerce.payments.recordPayment(env(), {
      paymentId: PAYMENT_A2,
      orderId: ORDER_A,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(env(), {
      paymentId: PAYMENT_A2,
      expectedRevision: 1,
      transition: "succeed",
    });
    await world.commerce.payments.issueInvoice(env(), {
      invoiceId: INVOICE_A,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER_A,
    });
    const reconciliation = await world.commerce.payments.reconcileInvoice(env(), {
      invoiceId: INVOICE_A,
      expectedRevision: 1,
    });
    expect(reconciliation.reconciliation.covered).toBe(true);
    expect(reconciliation.reconciliation.paidMinorUnits).toBe(2499);
    expect(reconciliation.reconciliation.refundedMinorUnits).toBe(0);

    // ------------------------------------------------------------------
    // 4. A connectivity incident leads to a FULL refund of the retried
    //    payment, correlated with the support case and the incident note.
    // ------------------------------------------------------------------
    const paymentA2 = must(
      await world.commerce.store.read.payments.findById(customer.tenantId, PAYMENT_A2 as never),
      "succeeded retry payment",
    );
    expect(computeRefundableAmount(paymentA2, [])).toEqual({
      amountMinorUnits: 2499,
      currency: "USD",
    });
    await world.commerce.payments.requestRefund(env(), {
      refundId: REFUND_FULL,
      paymentId: PAYMENT_A2,
      amount: { amountMinorUnits: 2499, currency: "USD" },
      reasonCode: "service_not_delivered",
      note: "Connectivity incident during travel window (support case correlated)",
    });
    await world.commerce.payments.transitionRefund(env(), {
      refundId: REFUND_FULL,
      expectedRevision: 1,
      transition: "succeed",
    });
    const refundFull = must(
      await world.commerce.store.read.refunds.findById(customer.tenantId, REFUND_FULL as never),
      "full refund record",
    );
    expect(refundFull.status).toBe("succeeded");
    expect(refundFull.reasonCode).toBe("service_not_delivered");

    // After the full refund, the refundable remainder is ZERO and a further
    // refund is a TYPED rejection - never a silent clamp or negative money.
    const paymentAfterFull = must(
      await world.commerce.store.read.payments.findById(customer.tenantId, PAYMENT_A2 as never),
      "payment after full refund",
    );
    expect(computeRefundableAmount(paymentAfterFull, [refundFull])).toEqual({
      amountMinorUnits: 0,
      currency: "USD",
    });
    await expect(
      world.commerce.payments.requestRefund(env(), {
        refundId: "00000000-0000-4000-8000-0000000000e8",
        paymentId: PAYMENT_A2,
        amount: { amountMinorUnits: 100, currency: "USD" },
        reasonCode: "goodwill",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // ------------------------------------------------------------------
    // 5. PARTIAL refunds on a second payment, with typed bounds.
    // ------------------------------------------------------------------
    await placedOrder(world, customer, ORDER_B, 10_000, "pass-refund-b");
    await world.commerce.payments.recordPayment(env(), {
      paymentId: PAYMENT_B,
      orderId: ORDER_B,
      amount: { amountMinorUnits: 10_000, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(env(), {
      paymentId: PAYMENT_B,
      expectedRevision: 1,
      transition: "succeed",
    });

    // Partial refund 1: 40.00 of 100.00 USD.
    await world.commerce.payments.requestRefund(env(), {
      refundId: REFUND_PARTIAL_1,
      paymentId: PAYMENT_B,
      amount: { amountMinorUnits: 4_000, currency: "USD" },
      reasonCode: "billing_error",
    });
    await world.commerce.payments.transitionRefund(env(), {
      refundId: REFUND_PARTIAL_1,
      expectedRevision: 1,
      transition: "succeed",
    });

    // A 70.00 refund on top of the 40.00 would exceed the 100.00 payment:
    // typed rejection with the refundable bound presented.
    await expect(
      world.commerce.payments.requestRefund(env(), {
        refundId: "00000000-0000-4000-8000-0000000000f9",
        paymentId: PAYMENT_B,
        amount: { amountMinorUnits: 7_000, currency: "USD" },
        reasonCode: "customer_request",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Partial refund 2: the remaining 60.00 - now fully refunded.
    await world.commerce.payments.requestRefund(env(), {
      refundId: REFUND_PARTIAL_2,
      paymentId: PAYMENT_B,
      amount: { amountMinorUnits: 6_000, currency: "USD" },
      reasonCode: "customer_request",
    });
    await world.commerce.payments.transitionRefund(env(), {
      refundId: REFUND_PARTIAL_2,
      expectedRevision: 1,
      transition: "succeed",
    });
    const paymentBRefunds = await world.commerce.store.read.refunds.listForPayment(
      customer.tenantId,
      PAYMENT_B as never,
    );
    expect(paymentBRefunds.filter((refund) => refund.status === "succeeded")).toHaveLength(2);
    const paymentB = must(
      await world.commerce.store.read.payments.findById(customer.tenantId, PAYMENT_B as never),
      "second payment",
    );
    expect(computeRefundableAmount(paymentB, paymentBRefunds)).toEqual({
      amountMinorUnits: 0,
      currency: "USD",
    });

    // ------------------------------------------------------------------
    // 6. The refund notification: durable transition -> delivered channel.
    // ------------------------------------------------------------------
    const refundEvents = await world.commerce.store.read.events.listForAggregate(
      customer.tenantId,
      "customer_refund",
      REFUND_FULL,
    );
    const refundSucceededEvent = must(
      refundEvents.find((event) => event.transition === "customer_refund.succeeded"),
      "refund succeeded event",
    );
    await world.notifications.emitFromTransition(env(), {
      notificationId: NOTIF_REFUND_SUCCEEDED,
      recipientUserId: customer.userId,
      topic: "refund",
      severity: "info",
      title: "Refund issued",
      body: "A full refund of 24.99 USD was issued for your Traveler Pass (service not delivered).",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "customer_refund",
        aggregateId: REFUND_FULL,
        transition: "customer_refund.succeeded",
        eventId: refundSucceededEvent.eventId,
        occurredAt: refundSucceededEvent.occurredAt,
      },
      relatedRefs: [
        { kind: "refund", id: REFUND_FULL },
        { kind: "payment", id: PAYMENT_A2 },
        { kind: "order", id: ORDER_A },
      ],
    });
    await world.notifications.recordChannelDelivery(env(), {
      notificationId: NOTIF_REFUND_SUCCEEDED,
      channel: "in_app",
      outcome: "delivered",
    });
    const refundNotifications = await world.notifications.listNotificationsForRelatedRef(
      customer.tenantId,
      { kind: "refund", id: REFUND_FULL },
    );
    expect(refundNotifications).toHaveLength(1);
    expect(refundNotifications[0]?.status).toBe("delivered");

    // ------------------------------------------------------------------
    // 7. The support case: customer thread + internal notes (structural
    //    boundary), resolved and closed with the incident correlated.
    // ------------------------------------------------------------------
    await world.notifications.addCaseMessage(env(), {
      supportCaseId: CASE_ID,
      messageId: world.ids.next(),
      visibility: "customer",
      body: "The retry payment went through; connectivity still failed.",
    });
    await world.notifications.addCaseMessage(env(), {
      supportCaseId: CASE_ID,
      messageId: world.ids.next(),
      visibility: "internal",
      body: "Incident correlated: connectivity degradation window matches the refund request.",
    });
    await world.notifications.linkCaseRelatedRef(env(), {
      supportCaseId: CASE_ID,
      expectedRevision: 1,
      kind: "refund",
      id: REFUND_FULL,
    });

    // §11 "support incidents attributable to connectivity orchestration"
    // (harness measurement point): THIS support case is attributable - it
    // correlated a connectivity incident (the service_not_delivered refund
    // whose note names the connectivity incident during the travel window)
    // with the customer's money facts. One attributable incident, recorded
    // through the REAL product-SLO recorder and classified against the
    // harness budget (max 1/day).
    const incidentRefund = must(
      await world.commerce.store.read.refunds.findById(
        customer.tenantId,
        REFUND_FULL as never,
      ),
      "incident-attributable refund",
    );
    expect(incidentRefund.reasonCode).toBe("service_not_delivered");
    expect(incidentRefund.note).toContain("Connectivity incident");
    world.slo.recorder.recordSupportIncidentAttributable({
      tenantId: customer.tenantId,
    });
    const incidentSamples = world.slo.metrics
      .samples()
      .filter(
        (sample) =>
          sample.name === SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
      );
    expect(incidentSamples).toHaveLength(1);
    expect((incidentSamples[0] as { delta: number }).delta).toBe(1);
    const incidentsSlo = evaluateProductSlo(
      world.slo.recorder,
      "support-incidents-attributable-to-connectivity-orchestration",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    // One incident is within the harness budget (max 1/day): good event,
    // within budget - and a SECOND attributable incident on the same day
    // would honestly exhaust it (the threshold classifies, never hides).
    expect(incidentsSlo.good).toBe(1);
    expect(incidentsSlo.bad).toBe(0);
    expect(incidentsSlo.state).toBe("within-budget");
    await world.notifications.transitionCase(env(), {
      supportCaseId: CASE_ID,
      expectedRevision: 2,
      transition: "startProgress",
    });
    await world.notifications.transitionCase(env(), {
      supportCaseId: CASE_ID,
      expectedRevision: 3,
      transition: "resolve",
    });
    await world.notifications.transitionCase(env(), {
      supportCaseId: CASE_ID,
      expectedRevision: 4,
      transition: "close",
    });
    const closedCase = (await world.notifications.listCasesForRelatedRef(
      customer.tenantId,
      { kind: "payment", id: PAYMENT_A1 },
    )).find((record) => record.supportCaseId === CASE_ID);
    expect(closedCase?.status).toBe("closed");

    // The CUSTOMER thread view structurally hides internal messages.
    const customerThread = await world.notifications.listCustomerCaseMessages(
      customer.tenantId,
      CASE_ID,
    );
    expect(customerThread).toHaveLength(1);
    expect(customerThread.every((message) => !("visibility" in message))).toBe(true);
    const staffThread = await world.notifications.listAllCaseMessages(
      customer.tenantId,
      CASE_ID,
    );
    expect(staffThread).toHaveLength(2);

    // ------------------------------------------------------------------
    // 8. The audit trail is COMPLETE and tamper-evident (RL-051).
    // ------------------------------------------------------------------
    await world.audit.append({
      category: "authority-decision",
      action: "payment.failure.reviewed",
      outcome: "degraded",
      actorId: customer.actorId,
      tenantId: customer.tenantId,
      correlationId: failedEvent.correlationId,
      commandId: failedEvent.commandId,
      target: `customer_payment:${PAYMENT_A1}`,
      occurredAt: world.clock.now(),
      detail: "typed failure reason recorded; retry authorized as new payment",
    });
    await world.audit.append({
      category: "authority-decision",
      action: "refund.approved",
      outcome: "allowed",
      actorId: customer.actorId,
      tenantId: customer.tenantId,
      correlationId: refundSucceededEvent.correlationId,
      commandId: refundSucceededEvent.commandId,
      target: `customer_refund:${REFUND_FULL}`,
      occurredAt: world.clock.now(),
      detail: "full refund within proven refundable bound",
    });

    // The SHA-256 digest chain verifies end to end.
    const verification = await world.audit.verify();
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.verifiedCount).toBe(2);
    }
    // The audit events are queryable by the journey's correlation family.
    const byRefundCorrelation = await world.audit.query({
      correlationId: refundSucceededEvent.correlationId,
    });
    expect(byRefundCorrelation).toHaveLength(1);
    expect(byRefundCorrelation[0]?.action).toBe("refund.approved");

    // The commerce event chains retain full command correlation for every
    // money aggregate (audit-grade history, one family).
    for (const [aggregateType, aggregateId] of [
      ["customer_payment", PAYMENT_A1],
      ["customer_payment", PAYMENT_A2],
      ["customer_refund", REFUND_FULL],
      ["customer_refund", REFUND_PARTIAL_1],
      ["customer_refund", REFUND_PARTIAL_2],
      ["customer_invoice", INVOICE_A],
    ] as const) {
      const events = await world.commerce.store.read.events.listForAggregate(
        customer.tenantId,
        aggregateType,
        aggregateId,
      );
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.correlationId).toMatch(/^corr\.dogfood\.refund-incident\.\d+$/);
      }
    }

    // The invoice arithmetic is still honest after all refunds: the
    // reconciliation PROVEN view shows paid minus refunded exactly.
    const invoiceView = await world.commerce.store.read.invoices.findById(
      customer.tenantId,
      INVOICE_A as never,
    );
    expect(invoiceView?.status).toBe("reconciled");
    const paymentsForA = await world.commerce.store.read.payments.listForOrder(
      customer.tenantId,
      ORDER_A as never,
    );
    const refundsForA2 = await world.commerce.store.read.refunds.listForPayment(
      customer.tenantId,
      PAYMENT_A2 as never,
    );
    const succeededPayments = paymentsForA.filter((payment) => payment.status === "succeeded");
    const succeededRefunds = refundsForA2.filter((refund) => refund.status === "succeeded");
    const paid = succeededPayments.reduce((sum, payment) => sum + payment.amount.amountMinorUnits, 0);
    const refunded = succeededRefunds.reduce(
      (sum, refund) => sum + refund.amount.amountMinorUnits,
      0,
    );
    expect(paid).toBe(2499);
    expect(refunded).toBe(2499);
  });

  it("a muted topic suppresses durably: the refund notification under a preference mute is a state, never a deletion", async () => {
    const world = makeDogfoodWorld("refund-mute");
    const customer = await registerCustomer(world, 0x52);
    const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
    const env = () => world.envelope(actor);
    await seedProduct(world, customer);

    await placedOrder(world, customer, ORDER_A, 2499, "pass-mute-a");
    await world.commerce.payments.recordPayment(env(), {
      paymentId: PAYMENT_A1,
      orderId: ORDER_A,
      amount: { amountMinorUnits: 2499, currency: "USD" },
    });
    await world.commerce.payments.transitionPayment(env(), {
      paymentId: PAYMENT_A1,
      expectedRevision: 1,
      transition: "succeed",
    });

    // The customer mutes the payment topic entirely (empty channel set).
    await world.notifications.setPreferences(env(), {
      userId: customer.userId,
      channelsByTopic: { payment: [], refund: ["in_app"] },
    });

    // A payment-topic notification under the mute: durable SUPPRESSED state.
    const paymentEvents = await world.commerce.store.read.events.listForAggregate(
      customer.tenantId,
      "customer_payment",
      PAYMENT_A1,
    );
    const succeededEvent = must(
      paymentEvents.find((event) => event.transition === "customer_payment.succeeded"),
      "payment succeeded event",
    );
    const suppressed = await world.notifications.emitFromTransition(env(), {
      notificationId: NOTIF_PAYMENT_FAILED,
      recipientUserId: customer.userId,
      topic: "payment",
      severity: "info",
      title: "Payment succeeded",
      body: "Your payment was captured.",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "customer_payment",
        aggregateId: PAYMENT_A1,
        transition: "customer_payment.succeeded",
        eventId: succeededEvent.eventId,
        occurredAt: succeededEvent.occurredAt,
      },
      relatedRefs: [{ kind: "payment", id: PAYMENT_A1 }],
    });
    expect(suppressed.status).toBe("suppressed");

    // A refund-topic notification still delivers (the mute is per-topic).
    await world.commerce.payments.requestRefund(env(), {
      refundId: REFUND_FULL,
      paymentId: PAYMENT_A1,
      amount: { amountMinorUnits: 2499, currency: "USD" },
      reasonCode: "customer_request",
    });
    const refundEvents = await world.commerce.store.read.events.listForAggregate(
      customer.tenantId,
      "customer_refund",
      REFUND_FULL,
    );
    const requestedEvent = must(
      refundEvents.find((event) => event.transition === "customer_refund.requested"),
      "refund requested event",
    );
    const delivered = await world.notifications.emitFromTransition(env(), {
      notificationId: NOTIF_REFUND_SUCCEEDED,
      recipientUserId: customer.userId,
      topic: "refund",
      severity: "info",
      title: "Refund requested",
      body: "Your refund request was recorded.",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "customer_refund",
        aggregateId: REFUND_FULL,
        transition: "customer_refund.requested",
        eventId: requestedEvent.eventId,
        occurredAt: requestedEvent.occurredAt,
      },
      relatedRefs: [
        { kind: "refund", id: REFUND_FULL },
        { kind: "payment", id: PAYMENT_A1 },
      ],
    });
    expect(delivered.status).toBe("pending");
    await world.notifications.recordChannelDelivery(env(), {
      notificationId: NOTIF_REFUND_SUCCEEDED,
      channel: "in_app",
      outcome: "delivered",
    });
    const notifications = await world.notifications.listNotificationsForRelatedRef(
      customer.tenantId,
      { kind: "payment", id: PAYMENT_A1 },
    );
    // BOTH notifications exist durably: one suppressed, one delivered.
    expect(notifications.map((record) => record.status).sort()).toEqual([
      "delivered",
      "suppressed",
    ]);
  });
});
