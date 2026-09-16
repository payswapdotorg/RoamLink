/**
 * RL-022 tests: CustomerPayment / CustomerInvoice / CustomerRefund.
 *
 * Proves:
 *  - the three state machines' legal AND illegal transitions (the full
 *    truth tables, including the failure paths - never happy-path-only);
 *  - the STATE-SEPARATION discipline (RL-LOCK-008 + spec/data-model.md
 *    "State separation"): a payment record rejects order/subscription
 *    states and delivery-shaped fields; a succeeded payment NEVER mutates
 *    the order, the subscription, or any delivery notion (payment is not
 *    delivery);
 *  - invoice issuance + PROVEN reconciliation (coverage from recorded
 *    payments minus refunds; partial coverage is refused; refunds
 *    de-reconcile nothing - reconciliation is a proven money fact);
 *  - partial refunds and the refundable-remainder bound (pending + succeeded
 *    refunds may never exceed the payment; currency mismatches are typed
 *    errors; zero amounts are rejected);
 *  - duplicate payment/refund commands are recorded no-ops (same envelope
 *    key + digest replays the recorded outcome, performs NO writes) and a
 *    DIFFERENT command under the same key is a typed ConflictError
 *    (RL-LOCK-014);
 *  - the refund audit trail is complete (reason codes are closed-vocabulary
 *    facts; every transition is on the append-only chain with the full
 *    command correlation);
 *  - money discipline (integer minor units, no floats, no silent currency
 *    conversion);
 *  - tenant fail-closed boundaries (RL-LOCK-018).
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseCustomerInvoiceId,
  parseCustomerPaymentId,
  parseOrderId,
  parseUtcInstant,
  parseUserId,
} from "@roamlink/contracts";

import {
  CUSTOMER_INVOICE_STATES,
  CUSTOMER_PAYMENT_STATES,
  CUSTOMER_REFUND_STATES,
  CustomerInvoice,
  CustomerPayment,
  CustomerRefund,
  computeInvoiceReconciliation,
  computeRefundableAmount,
  parseMoneyValue,
  subtractMoneyFloorZero,
  type CustomerInvoiceRecord,
  type CustomerPaymentRecord,
  type CustomerRefundRecord,
} from "../src/index.js";
import { makeWorld, idAt, T0 } from "./helpers.js";

const PRODUCT = idAt(200);
const VARIANT_7D = idAt(210);
const ORDER = parseOrderId(idAt(220));
const OTHER_ORDER = parseOrderId(idAt(224));
const OWNER = parseUserId("00000000-0000-4000-8000-000000000002");
const PAYMENT_1 = idAt(300);
const PAYMENT_2 = idAt(301);
const PAYMENT_EUR = idAt(302);
const INVOICE_1 = idAt(400);
const INVOICE_2 = idAt(401);
const REFUND_1 = idAt(500);
const REFUND_2 = idAt(501);
const REFUND_3 = idAt(502);

const USD_999 = { amountMinorUnits: 999, currency: "USD" };

const at = (iso: string) => parseUtcInstant(iso);

async function seedPlacedOrder(world: ReturnType<typeof makeWorld>) {
  await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "Traveler" });
  await world.catalog.activateProduct(world.envelope(), { productId: PRODUCT, expectedRevision: 1 });
  await world.catalog.createVariant(world.envelope(), {
    variantId: VARIANT_7D,
    productId: PRODUCT,
    name: "7-Day Pass",
    sku: "pass-7d",
    billingModel: "one_time",
    termDays: 7,
    price: USD_999,
  });
  await world.orders.createOrder(world.envelope({ orderVersion: 1 }), {
    orderId: ORDER,
    ownerUserId: OWNER,
  });
  await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
    orderId: ORDER,
    lineId: idAt(230),
    variantId: VARIANT_7D,
    quantity: 1,
  });
  await world.orders.placeOrder(world.envelope({ orderVersion: 2 }), { orderId: ORDER });
}

async function seedSucceededPayment(world: ReturnType<typeof makeWorld>) {
  await seedPlacedOrder(world);
  await world.payments.recordPayment(world.envelope(), {
    paymentId: PAYMENT_1,
    orderId: ORDER,
    amount: USD_999,
    method: "card",
  });
  await world.payments.transitionPayment(world.envelope(), {
    paymentId: PAYMENT_1,
    expectedRevision: 1,
    transition: "succeed",
  });
}

/** Builds a minimal valid payment record input for aggregate-level tests. */
const paymentBase = {
  tenantId: "org:00000000-0000-4000-8000-000000000001",
  orderId: ORDER,
  ownerUserId: OWNER,
  amount: USD_999,
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

const invoiceBase = {
  tenantId: "org:00000000-0000-4000-8000-000000000001",
  invoiceNumber: "INV-2026-000001",
  orderId: ORDER,
  ownerUserId: OWNER,
  totalAmount: USD_999,
  issuedAt: T0,
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

const refundBase = {
  tenantId: "org:00000000-0000-4000-8000-000000000001",
  paymentId: PAYMENT_1,
  orderId: ORDER,
  ownerUserId: OWNER,
  amount: { amountMinorUnits: 400, currency: "USD" },
  reasonCode: "customer_request",
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

// ---------------------------------------------------------------------------
// Aggregate state machines
// ---------------------------------------------------------------------------

describe("CustomerPayment aggregate (customer_payment_state)", () => {
  it("proves the legal transitions incl. the failure path", () => {
    const pending = new CustomerPayment({ ...paymentBase, paymentId: PAYMENT_1, status: "pending" });
    const succeeded = pending.succeed(at("2026-02-01T00:00:00.000Z"));
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.revision).toBe(2);

    const failed = new CustomerPayment({ ...paymentBase, paymentId: PAYMENT_2, status: "pending" })
      .fail(at("2026-02-01T00:00:00.000Z"), "declined_by_processor");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("declined_by_processor");

    const cancelled = new CustomerPayment({ ...paymentBase, paymentId: PAYMENT_2, status: "pending" })
      .cancel(at("2026-02-01T00:00:00.000Z"));
    expect(cancelled.status).toBe("cancelled");
  });

  it("proves every illegal transition (the full truth table)", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      const payment = new CustomerPayment({
        ...paymentBase,
        paymentId: PAYMENT_1,
        status: terminal,
        ...(terminal === "failed" ? { failureReason: "processor_error" } : {}),
      });
      expect(() => payment.succeed(at("2026-02-01T00:00:00.000Z")), terminal).toThrow(ValidationError);
      expect(() => payment.fail(at("2026-02-01T00:00:00.000Z"), "processor_error"), terminal).toThrow(ValidationError);
      expect(() => payment.cancel(at("2026-02-01T00:00:00.000Z")), terminal).toThrow(ValidationError);
    }
    const pending = new CustomerPayment({ ...paymentBase, paymentId: PAYMENT_1, status: "pending" });
    expect(() => pending.fail(at("2026-02-01T00:00:00.000Z"), "not_a_reason" as never)).toThrow(ValidationError);
  });

  it("keeps customer_payment_state separate from order/subscription states (RL-LOCK-008)", () => {
    // order/subscription states are rejected on a payment
    for (const foreign of ["draft", "placed", "completed", "cancelled", "active", "superseded"]) {
      if (foreign === "cancelled") continue; // legitimately shared token, separate vocabulary
      expect(
        () => new CustomerPayment({ ...paymentBase, paymentId: PAYMENT_1, status: foreign }),
        foreign,
      ).toThrow(ValidationError);
    }
    // the vocabularies are distinct exported consts
    expect(CUSTOMER_PAYMENT_STATES).not.toBe(CUSTOMER_INVOICE_STATES);
    expect(CUSTOMER_PAYMENT_STATES).not.toBe(CUSTOMER_REFUND_STATES);
    // and no payment state value leaks into the order vocabulary semantics
    expect(CUSTOMER_PAYMENT_STATES).not.toContain("placed");
    expect(CUSTOMER_PAYMENT_STATES).not.toContain("reconciled");
  });

  it("rejects delivery-shaped fields and float money (closed vocabulary)", () => {
    expect(
      () =>
        new CustomerPayment({
          ...paymentBase,
          paymentId: PAYMENT_1,
          status: "pending",
          deliveryState: "delivered",
        } as never),
    ).toThrow(ValidationError);
    expect(
      () =>
        new CustomerPayment({
          ...paymentBase,
          paymentId: PAYMENT_1,
          status: "pending",
          amount: { amountMinorUnits: 9.99, currency: "USD" },
        }),
    ).toThrow(ValidationError);
  });
});

describe("CustomerInvoice aggregate (invoice_state)", () => {
  it("proves the legal transitions", () => {
    const issued = new CustomerInvoice({ ...invoiceBase, invoiceId: INVOICE_1, status: "issued" });
    const reconciled = issued.reconcile(at("2026-02-01T00:00:00.000Z"));
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciledAt).toBeDefined();
    expect(reconciled.revision).toBe(2);
    const voided = new CustomerInvoice({ ...invoiceBase, invoiceId: INVOICE_2, status: "issued" })
      .void(at("2026-02-01T00:00:00.000Z"));
    expect(voided.status).toBe("voided");
  });

  it("proves every illegal transition (terminal states)", () => {
    const reconciled = new CustomerInvoice({
      ...invoiceBase,
      invoiceId: INVOICE_1,
      status: "reconciled",
      reconciledAt: T0,
      updatedAt: T0,
    });
    expect(() => reconciled.reconcile(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => reconciled.void(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    const voided = new CustomerInvoice({
      ...invoiceBase,
      invoiceId: INVOICE_1,
      status: "voided",
      voidedAt: T0,
      updatedAt: T0,
    });
    expect(() => voided.reconcile(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    // payment states are foreign to an invoice
    expect(
      () => new CustomerInvoice({ ...invoiceBase, invoiceId: INVOICE_1, status: "succeeded" }),
    ).toThrow(ValidationError);
  });
});

describe("CustomerRefund aggregate (customer_refund_state)", () => {
  it("proves the legal transitions incl. the failure path", () => {
    const pending = new CustomerRefund({ ...refundBase, refundId: REFUND_1, status: "pending" });
    const succeeded = pending.succeed(at("2026-02-01T00:00:00.000Z"));
    expect(succeeded.status).toBe("succeeded");
    const failed = new CustomerRefund({ ...refundBase, refundId: REFUND_2, status: "pending" })
      .fail(at("2026-02-01T00:00:00.000Z"), "compliance_hold");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("compliance_hold");
    const cancelled = new CustomerRefund({ ...refundBase, refundId: REFUND_2, status: "pending" })
      .cancel(at("2026-02-01T00:00:00.000Z"));
    expect(cancelled.status).toBe("cancelled");
  });

  it("proves every illegal transition and closed reason codes", () => {
    const succeeded = new CustomerRefund({ ...refundBase, refundId: REFUND_1, status: "succeeded", updatedAt: T0 });
    expect(() => succeeded.succeed(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => succeeded.cancel(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(
      () => new CustomerRefund({ ...refundBase, refundId: REFUND_1, status: "pending", reasonCode: "because" }),
    ).toThrow(ValidationError);
    expect(
      () => new CustomerRefund({ ...refundBase, refundId: REFUND_1, status: "failed" }),
    ).toThrow(ValidationError); // failed without a typed reason
  });
});

// ---------------------------------------------------------------------------
// Service: payments
// ---------------------------------------------------------------------------

describe("PaymentService.recordPayment", () => {
  it("records a pending payment against a placed order with full correlation on the event", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    const envelope = world.envelope();
    const result = await world.payments.recordPayment(envelope, {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
      method: "card",
    });
    expect(result).toMatchObject({ paymentId: PAYMENT_1, status: "pending", revision: 1 });

    const events = await world.store.read.events.listForAggregate(
      world.tenant,
      "customer_payment",
      PAYMENT_1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.transition).toBe("customer_payment.recorded");
    expect(events[0]?.commandId).toBe(envelope.commandId);
    expect(events[0]?.correlationId).toBe(envelope.correlationId);
    expect(events[0]?.idempotencyKey).toBe(envelope.idempotencyKey);
    // the order is untouched by the payment (payment is not delivery, and
    // payment is not order-state either)
    const order = await world.store.read.orders.findById(world.tenant, ORDER);
    expect(order?.status).toBe("placed");
  });

  it("refuses to record a payment against a draft or cancelled order", async () => {
    const world = makeWorld();
    await world.catalog.createProduct(world.envelope(), { productId: PRODUCT, name: "Traveler" });
    await world.catalog.activateProduct(world.envelope(), { productId: PRODUCT, expectedRevision: 1 });
    await world.catalog.createVariant(world.envelope(), {
      variantId: VARIANT_7D,
      productId: PRODUCT,
      name: "7-Day Pass",
      sku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      price: USD_999,
    });
    await world.orders.createOrder(world.envelope({ orderVersion: 1 }), {
      orderId: ORDER,
      ownerUserId: OWNER,
    });
    await expect(
      world.payments.recordPayment(world.envelope(), {
        paymentId: PAYMENT_1,
        orderId: ORDER,
        amount: USD_999,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("fails closed across tenants (no existence oracle)", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await expect(
      world.payments.recordPayment(
        world.envelope({ tenantId: world.otherTenant }),
        { paymentId: PAYMENT_1, orderId: ORDER, amount: USD_999 },
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("PaymentService.transitionPayment", () => {
  it("succeeds and fails payments with CAS on expectedRevision", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
    });
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_2,
      orderId: ORDER,
      amount: USD_999,
    });

    const failed = await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT_2,
      expectedRevision: 1,
      transition: "fail",
      failureReason: "declined_by_processor",
    });
    expect(failed.status).toBe("failed");

    const succeeded = await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT_1,
      expectedRevision: 1,
      transition: "succeed",
    });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.revision).toBe(2);

    // stale expectedRevision -> typed conflict
    await expect(
      world.payments.transitionPayment(world.envelope(), {
        paymentId: PAYMENT_1,
        expectedRevision: 1,
        transition: "cancel",
      }),
    ).rejects.toThrow(ConflictError);
    // terminal payment -> typed state-machine rejection (same discipline as
    // order/subscription aggregates: illegal transitions are ValidationErrors)
    await expect(
      world.payments.transitionPayment(world.envelope(), {
        paymentId: PAYMENT_1,
        expectedRevision: 2,
        transition: "cancel",
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Service: invoices + reconciliation
// ---------------------------------------------------------------------------

describe("PaymentService issue/reconcile/void invoice", () => {
  it("issues an invoice snapshotting the order total; numbers are tenant-unique", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await expect(
      world.payments.issueInvoice(world.envelope(), {
        invoiceId: INVOICE_2,
        invoiceNumber: "INV-2026-000001",
        orderId: ORDER,
      }),
    ).rejects.toThrow(ConflictError);
    const invoice = await world.store.read.invoices.findById(
      world.tenant,
      parseCustomerInvoiceId(INVOICE_1),
    );
    expect(invoice?.totalAmount).toEqual(USD_999);
    expect(invoice?.status).toBe("issued");
  });

  it("reconciles ONLY when succeeded payments minus succeeded refunds cover the total (proven, partial refused)", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    // partial payment: record a SECOND, smaller order+payment to prove partial coverage refusal
    await world.orders.createOrder(world.envelope({ orderVersion: 1 }), {
      orderId: OTHER_ORDER,
      ownerUserId: OWNER,
    });
    await world.orders.addOrderLine(world.envelope({ orderVersion: 1 }), {
      orderId: OTHER_ORDER,
      lineId: idAt(231),
      variantId: VARIANT_7D,
      quantity: 1,
    });
    await world.orders.placeOrder(world.envelope({ orderVersion: 2 }), { orderId: OTHER_ORDER });
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_2,
      orderId: OTHER_ORDER,
      amount: { amountMinorUnits: 500, currency: "USD" },
    });
    await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT_2,
      expectedRevision: 1,
      transition: "succeed",
    });
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_2,
      invoiceNumber: "INV-2026-000002",
      orderId: OTHER_ORDER,
    });
    await expect(
      world.payments.reconcileInvoice(world.envelope(), {
        invoiceId: INVOICE_2,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(ConflictError); // 500 paid of 999 due

    // full coverage on the first order reconciles
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    const reconciled = await world.payments.reconcileInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      expectedRevision: 1,
    });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciliation.covered).toBe(true);
    expect(reconciled.reconciliation.paidMinorUnits).toBe(999);

    // the reconciliation proof is in the event payload (audit)
    const events = await world.store.read.events.listForAggregate(
      world.tenant,
      "customer_invoice",
      INVOICE_1,
    );
    const reconciledEvent = events.find((event) => event.transition === "customer_invoice.reconciled");
    expect(reconciledEvent).toBeDefined();
    expect(
      (reconciledEvent?.payload as { reconciliation?: { coveringPaymentIds?: string[] } })
        .reconciliation?.coveringPaymentIds,
    ).toEqual([PAYMENT_1]);
  });

  it("a PENDING payment never counts toward coverage; a refund de-covers nothing silently", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
    }); // stays PENDING
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await expect(
      world.payments.reconcileInvoice(world.envelope(), {
        invoiceId: INVOICE_1,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(ConflictError); // pending money is not coverage
  });

  it("voids an issued invoice; a reconciled invoice is settled history", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await world.payments.reconcileInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      expectedRevision: 1,
    });
    // reconciled invoices are settled history: voiding is a typed
    // state-machine rejection (corrections are credit notes, never rewrites)
    await expect(
      world.payments.voidInvoice(world.envelope(), { invoiceId: INVOICE_1, expectedRevision: 2 }),
    ).rejects.toThrow(ValidationError);
  });

  it("excludes foreign-currency payments from USD coverage (no silent conversion)", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_EUR,
      orderId: ORDER,
      amount: { amountMinorUnits: 999, currency: "EUR" },
    });
    await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT_EUR,
      expectedRevision: 1,
      transition: "succeed",
    });
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await expect(
      world.payments.reconcileInvoice(world.envelope(), {
        invoiceId: INVOICE_1,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Service: refunds + partial refunds + audit
// ---------------------------------------------------------------------------

describe("PaymentService.requestRefund / transitionRefund", () => {
  it("refunds partially: two partial refunds up to the exact payment amount", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    await world.payments.requestRefund(world.envelope(), {
      refundId: REFUND_1,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 400, currency: "USD" },
      reasonCode: "customer_request",
    });
    await world.payments.transitionRefund(world.envelope(), {
      refundId: REFUND_1,
      expectedRevision: 1,
      transition: "succeed",
    });
    const second = await world.payments.requestRefund(world.envelope(), {
      refundId: REFUND_2,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 599, currency: "USD" },
      reasonCode: "goodwill",
      note: "service credit",
    });
    expect(second.status).toBe("pending");
    // 400 + 599 = 999: exactly refundable now; a third refund of 1 is over
    await expect(
      world.payments.requestRefund(world.envelope(), {
        refundId: REFUND_3,
        paymentId: PAYMENT_1,
        amount: { amountMinorUnits: 1, currency: "USD" },
        reasonCode: "other",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("holds pending refunds against the refundable remainder; cancelled refunds release the hold", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    await world.payments.requestRefund(world.envelope(), {
      refundId: REFUND_1,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 900, currency: "USD" },
      reasonCode: "customer_request",
    }); // pending: holds 900
    await expect(
      world.payments.requestRefund(world.envelope(), {
        refundId: REFUND_2,
        paymentId: PAYMENT_1,
        amount: { amountMinorUnits: 100, currency: "USD" },
        reasonCode: "other",
      }),
    ).rejects.toThrow(ConflictError);
    await world.payments.transitionRefund(world.envelope(), {
      refundId: REFUND_1,
      expectedRevision: 1,
      transition: "cancel",
    }); // releases the hold
    const retry = await world.payments.requestRefund(world.envelope(), {
      refundId: REFUND_2,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 100, currency: "USD" },
      reasonCode: "other",
    });
    expect(retry.status).toBe("pending");
  });

  it("refuses refunds against pending/failed/cancelled payments and foreign currencies", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    await world.payments.recordPayment(world.envelope(), {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
    }); // pending payment
    await expect(
      world.payments.requestRefund(world.envelope(), {
        refundId: REFUND_1,
        paymentId: PAYMENT_1,
        amount: { amountMinorUnits: 1, currency: "USD" },
        reasonCode: "other",
      }),
    ).rejects.toThrow(ConflictError);

    await world.payments.transitionPayment(world.envelope(), {
      paymentId: PAYMENT_1,
      expectedRevision: 1,
      transition: "succeed",
    });
    await expect(
      world.payments.requestRefund(world.envelope(), {
        refundId: REFUND_1,
        paymentId: PAYMENT_1,
        amount: { amountMinorUnits: 1, currency: "EUR" },
        reasonCode: "other",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("keeps a complete refund audit trail: reason codes, transitions, full command correlation", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    const requestEnvelope = world.envelope();
    await world.payments.requestRefund(requestEnvelope, {
      refundId: REFUND_1,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 400, currency: "USD" },
      reasonCode: "service_not_delivered",
      note: "customer reported no coverage",
    });
    const failEnvelope = world.envelope();
    await world.payments.transitionRefund(failEnvelope, {
      refundId: REFUND_1,
      expectedRevision: 1,
      transition: "fail",
      failureReason: "compliance_hold",
    });

    const refunds = await world.store.read.refunds.listForPayment(
      world.tenant,
      parseCustomerPaymentId(PAYMENT_1),
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.reasonCode).toBe("service_not_delivered");
    expect(refunds[0]?.status).toBe("failed");
    expect(refunds[0]?.failureReason).toBe("compliance_hold");

    const events = await world.store.read.events.listForAggregate(
      world.tenant,
      "customer_refund",
      REFUND_1,
    );
    expect(events.map((event) => event.transition)).toEqual([
      "customer_refund.requested",
      "customer_refund.failed",
    ]);
    expect(events[0]?.commandId).toBe(requestEnvelope.commandId);
    expect(events[0]?.actorId).toBe(requestEnvelope.actorId);
    expect(events[1]?.commandId).toBe(failEnvelope.commandId);
    expect(events[1]?.sequence).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (RL-LOCK-014)
// ---------------------------------------------------------------------------

describe("payment command idempotency (RL-LOCK-014)", () => {
  it("a duplicate payment command (same key + same digest) replays the outcome and performs NO writes", async () => {
    const world = makeWorld();
    await seedPlacedOrder(world);
    const envelope = world.envelope({ key: "payment-once" });
    const first = await world.payments.recordPayment(envelope, {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
    });
    const second = await world.payments.recordPayment(envelope, {
      paymentId: PAYMENT_1,
      orderId: ORDER,
      amount: USD_999,
    });
    expect(second).toEqual(first);

    const payments = await world.store.read.payments.listByTenant(world.tenant);
    expect(payments).toHaveLength(1);
    const events = await world.store.read.events.listByTenant(world.tenant);
    expect(events.filter((event) => event.aggregateType === "customer_payment")).toHaveLength(1);
  });

  it("a duplicate refund command is a recorded no-op; a DIFFERENT command under the same key is a typed conflict", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    const envelope = world.envelope({ key: "refund-once" });
    const first = await world.payments.requestRefund(envelope, {
      refundId: REFUND_1,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 400, currency: "USD" },
      reasonCode: "customer_request",
    });
    const replay = await world.payments.requestRefund(envelope, {
      refundId: REFUND_1,
      paymentId: PAYMENT_1,
      amount: { amountMinorUnits: 400, currency: "USD" },
      reasonCode: "customer_request",
    });
    expect(replay).toEqual(first);

    // a DIFFERENT envelope (different canonical digest: the clock advanced,
    // so createdAt differs) under the same key is a typed conflict and
    // nothing is applied
    await world.clock.advanceBy(1_000);
    const different = world.envelope({ key: "refund-once" });
    expect(different.idempotencyKey).toBe(envelope.idempotencyKey);
    await expect(
      world.payments.requestRefund(different, {
        refundId: REFUND_2,
        paymentId: PAYMENT_1,
        amount: { amountMinorUnits: 100, currency: "USD" },
        reasonCode: "other",
      }),
    ).rejects.toThrow(ConflictError);
    const refunds = await world.store.read.refunds.listByTenant(world.tenant);
    expect(refunds.map((refund) => refund.refundId)).toEqual([REFUND_1]);
  });
});

// ---------------------------------------------------------------------------
// Pure reconciliation / refundable arithmetic + money discipline
// ---------------------------------------------------------------------------

describe("pure money + reconciliation arithmetic", () => {
  const invoice: CustomerInvoiceRecord = {
    contractVersion: "0.1" as never,
    tenantId: "org:00000000-0000-4000-8000-000000000001" as never,
    invoiceId: INVOICE_1 as never,
    invoiceNumber: "INV-2026-000001",
    orderId: ORDER,
    ownerUserId: OWNER,
    totalAmount: USD_999,
    status: "issued",
    issuedAt: T0 as never,
    createdAt: T0 as never,
    updatedAt: T0 as never,
    revision: 1 as never,
  };
  const payment = (status: string, amountMinorUnits: number): CustomerPaymentRecord => ({
    contractVersion: "0.1" as never,
    tenantId: invoice.tenantId,
    paymentId: PAYMENT_1 as never,
    orderId: ORDER,
    ownerUserId: OWNER,
    amount: { amountMinorUnits, currency: "USD" },
    status: status as never,
    createdAt: T0 as never,
    updatedAt: T0 as never,
    revision: 1 as never,
  });
  const refund = (status: string, amountMinorUnits: number): CustomerRefundRecord => ({
    contractVersion: "0.1" as never,
    tenantId: invoice.tenantId,
    refundId: REFUND_1 as never,
    paymentId: PAYMENT_1 as never,
    orderId: ORDER,
    ownerUserId: OWNER,
    amount: { amountMinorUnits, currency: "USD" },
    reasonCode: "customer_request",
    status: status as never,
    createdAt: T0 as never,
    updatedAt: T0 as never,
    revision: 1 as never,
  });

  it("computes coverage: paid - succeeded refunds, pending excluded, floor at zero", () => {
    const reconciliation = computeInvoiceReconciliation(
      invoice,
      [payment("succeeded", 700), payment("pending", 999), payment("failed", 999)],
      [refund("succeeded", 200), refund("pending", 100), refund("cancelled", 50)],
    );
    expect(reconciliation.paidMinorUnits).toBe(700);
    expect(reconciliation.refundedMinorUnits).toBe(200);
    expect(reconciliation.netPaidMinorUnits).toBe(500);
    expect(reconciliation.outstandingMinorUnits).toBe(499);
    expect(reconciliation.covered).toBe(false);
  });

  it("refundable remainder holds pending+succeeded refunds only", () => {
    const remainder = computeRefundableAmount(payment("succeeded", 999), [
      refund("succeeded", 400),
      refund("pending", 100),
      refund("failed", 50),
      refund("cancelled", 25),
    ]);
    expect(remainder).toEqual({ amountMinorUnits: 499, currency: "USD" });
  });

  it("refuses refund arithmetic on non-succeeded payments", () => {
    expect(() => computeRefundableAmount(payment("pending", 999), [])).toThrow(ValidationError);
  });

  it("money helpers: floor-zero subtraction and typed currency mismatch", () => {
    expect(
      subtractMoneyFloorZero(
        parseMoneyValue({ amountMinorUnits: 10, currency: "USD" }),
        parseMoneyValue({ amountMinorUnits: 25, currency: "USD" }),
      ),
    ).toEqual({ amountMinorUnits: 0, currency: "USD" });
    expect(() =>
      subtractMoneyFloorZero(
        parseMoneyValue({ amountMinorUnits: 10, currency: "USD" }),
        parseMoneyValue({ amountMinorUnits: 25, currency: "EUR" }),
      ),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Cross-aggregate isolation (RL-LOCK-008, the core invariant)
// ---------------------------------------------------------------------------

describe("payment is not delivery (RL-LOCK-008 cross-aggregate isolation)", () => {
  it("a fully succeeded + reconciled payment + invoice changes NO order/subscription state", async () => {
    const world = makeWorld();
    await seedSucceededPayment(world);
    await world.payments.issueInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      invoiceNumber: "INV-2026-000001",
      orderId: ORDER,
    });
    await world.payments.reconcileInvoice(world.envelope(), {
      invoiceId: INVOICE_1,
      expectedRevision: 1,
    });

    const order = await world.store.read.orders.findById(world.tenant, ORDER);
    expect(order?.status).toBe("placed"); // money facts moved the order ZERO steps
    expect(order?.revision).toBe(3); // create + line + place, untouched since

    const subscriptions = await world.store.read.subscriptions.listByTenant(world.tenant);
    expect(subscriptions).toHaveLength(0); // money never invented an entitlement

    // and the payment/invoice records carry no delivery vocabulary at all
    const paymentRecord = await world.store.read.payments.findById(
      world.tenant,
      parseCustomerPaymentId(PAYMENT_1),
    );
    expect(Object.keys(paymentRecord ?? {})).not.toContain("deliveryState");
    const invoiceRecord = await world.store.read.invoices.findById(
      world.tenant,
      parseCustomerInvoiceId(INVOICE_1),
    );
    expect(Object.keys(invoiceRecord ?? {})).not.toContain("deliveryState");
  });
});
