/**
 * Payment services (RL-022): envelope-gated, idempotent, CAS-aware use
 * cases for CustomerPayment, CustomerInvoice and CustomerRefund.
 *
 * Same discipline as the catalog/order/subscription services:
 *  - every mutating command takes a full §5 CommandEnvelope; the envelope's
 *    tenant IS the tenant of every read and write (RL-LOCK-018);
 *  - idempotency (RL-LOCK-014): a replay of the same envelope returns the
 *    recorded outcome and performs NO writes (a duplicate payment/refund
 *    command is a recorded no-op); a DIFFERENT command under the same key
 *    is a typed ConflictError;
 *  - optimistic concurrency via explicit `expectedRevision` inputs
 *    (RL-LOCK-017);
 *  - every transition appends an immutable, chain-sequenced commerce event
 *    carrying the full command correlation, in the SAME session;
 *  - authorization is delegated to the CommerceAccessPolicy seam (fail
 *    closed);
 *  - RL-LOCK-008 ("payment is not delivery"): no method here reads, writes
 *    or implies delivery/connectivity state. A succeeded payment settles
 *    MONEY only; invoice reconciliation proves MONEY coverage, never
 *    delivery; the commerce-to-connectivity reference model (RL-023) lives
 *    in a sibling package and is the ONLY way commerce surfaces read
 *    connectivity status.
 *
 * Money discipline: integer minor units + ISO-4217-style alpha-3 codes
 * only; currency mismatches are typed errors; there is NO rounding
 * anywhere (amounts are exact or rejected).
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseCustomerInvoiceId,
  parseCustomerPaymentId,
  parseCustomerRefundId,
  parseOrderId,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type OrderId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  admitCommerceCommand,
  commitCommerceCommand,
  type CommerceIdempotencyLedger,
} from "./idempotency.js";
import { CommerceEvent } from "./events.js";
import type { CommerceEventRecord } from "./events.js";
import {
  CustomerInvoice,
  INVOICE_NUMBER_PATTERN,
  isInvoiceState,
  type CustomerInvoiceRecord,
} from "./invoice.js";
import {
  moneyGreaterThan,
  parseMoneyValue,
  subtractMoneyFloorZero,
  type MoneyValue,
} from "./money.js";
import { Order } from "./order.js";
import {
  CustomerPayment,
  isPaymentFailureReason,
  isPaymentMethod,
  type CustomerPaymentRecord,
  type PaymentFailureReason,
  type PaymentMethod,
} from "./payment.js";
import type {
  CommerceAccessPolicy,
  CommerceSession,
  CommerceStore,
  OrderReader,
} from "./ports.js";
import {
  CustomerRefund,
  isRefundFailureReason,
  isRefundReasonCode,
  type CustomerRefundRecord,
  type RefundFailureReason,
} from "./refund.js";

/** Dependencies shared by the payment services. */
export interface PaymentServiceDeps {
  readonly store: CommerceStore;
  readonly policy: CommerceAccessPolicy;
  readonly ledger: CommerceIdempotencyLedger;
  /** Explicit time source (never ambient; deterministic in tests). */
  readonly now: () => UtcInstant;
  /** Supplies fresh entity ids (deterministic in tests). */
  readonly generateId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`payment command rejected: ${issue}`, {
    reason: "PAYMENT_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

// ---------------------------------------------------------------------------
// Event recording helper (session-scoped, chain-sequenced)
// ---------------------------------------------------------------------------

async function recordPaymentEvent(
  session: CommerceSession,
  envelope: CommandEnvelope,
  aggregateType: "customer_payment" | "customer_invoice" | "customer_refund",
  aggregateId: string,
  aggregateRevision: number,
  transition: CommerceEventRecord["transition"],
  payload: object,
  at: UtcInstant,
  generateId: () => string,
): Promise<void> {
  const chain = await session.events.listForAggregate(
    envelope.tenantId,
    aggregateType,
    aggregateId,
  );
  const event = new CommerceEvent({
    eventId: generateId(),
    tenantId: envelope.tenantId,
    aggregateType,
    aggregateId,
    aggregateRevision,
    sequence: chain.length + 1,
    transition,
    payload,
    actorId: envelope.actorId,
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    occurredAt: at,
  });
  await session.events.append(event.toRecord());
}

// ---------------------------------------------------------------------------
// Pure reconciliation arithmetic (read-side proofs, RL-LOCK-008)
// ---------------------------------------------------------------------------

/**
 * The computed invoice-reconciliation coverage: SUCCEEDED payments minus
 * SUCCEEDED refunds for the order (same currency as the invoice), never
 * negative. A PURE read model - it exposes the underlying facts and never
 * mutates anything.
 */
export interface InvoiceReconciliation {
  readonly invoiceId: string;
  readonly orderId: OrderId;
  readonly currency: string;
  readonly totalDueMinorUnits: number;
  readonly paidMinorUnits: number;
  readonly refundedMinorUnits: number;
  /** paid - refunded, floored at zero. */
  readonly netPaidMinorUnits: number;
  readonly outstandingMinorUnits: number;
  /** True iff net paid covers the total due exactly or better. */
  readonly covered: boolean;
  /** The payment ids whose SUCCEEDED amounts constitute the proof. */
  readonly coveringPaymentIds: readonly string[];
}

/**
 * Computes the reconciliation coverage of an invoice from the order's
 * payment/refund records. Payments/refunds in a DIFFERENT currency than the
 * invoice are excluded from coverage (and reported by the caller's read
 * views - never silently converted).
 */
export function computeInvoiceReconciliation(
  invoice: CustomerInvoiceRecord,
  payments: readonly CustomerPaymentRecord[],
  refunds: readonly CustomerRefundRecord[],
): InvoiceReconciliation {
  const currency = invoice.totalAmount.currency;
  const succeeded = payments.filter(
    (payment) => payment.status === "succeeded" && payment.amount.currency === currency,
  );
  const succeededRefunds = refunds.filter(
    (refund) => refund.status === "succeeded" && refund.amount.currency === currency,
  );
  let paid = 0;
  for (const payment of succeeded) paid += payment.amount.amountMinorUnits;
  let refunded = 0;
  for (const refund of succeededRefunds) refunded += refund.amount.amountMinorUnits;
  const net = paid - refunded < 0 ? 0 : paid - refunded;
  const total = invoice.totalAmount.amountMinorUnits;
  return Object.freeze({
    invoiceId: invoice.invoiceId,
    orderId: invoice.orderId,
    currency,
    totalDueMinorUnits: total,
    paidMinorUnits: paid,
    refundedMinorUnits: refunded,
    netPaidMinorUnits: net,
    outstandingMinorUnits: total - net < 0 ? 0 : total - net,
    covered: net >= total,
    coveringPaymentIds: Object.freeze(succeeded.map((payment) => payment.paymentId)),
  });
}

/**
 * The refundable remainder of a payment: the SUCCEEDED payment amount minus
 * PENDING + SUCCEEDED refund amounts (same currency). Pure arithmetic over
 * the recorded facts; failed/cancelled refunds release their hold.
 */
export function computeRefundableAmount(
  payment: CustomerPaymentRecord,
  refunds: readonly CustomerRefundRecord[],
): MoneyValue {
  if (payment.status !== "succeeded") {
    throw new ValidationError(
      "refundable amount rejected: payment - only a succeeded payment can be refunded",
      {
        reason: "PAYMENT_NOT_REFUNDABLE",
        details: [{ path: "payment", issue: `the payment is ${payment.status}, not succeeded` }],
      },
    );
  }
  let held = 0;
  for (const refund of refunds) {
    if (refund.status === "pending" || refund.status === "succeeded") {
      if (refund.amount.currency !== payment.amount.currency) {
        throw new ConflictError(
          "refund currency mismatch: a refund attached to this payment uses a different currency than the payment (never silently converted)",
          { reason: "MONEY_CURRENCY_MISMATCH" },
        );
      }
      held += refund.amount.amountMinorUnits;
    }
  }
  return subtractMoneyFloorZero(
    payment.amount,
    parseMoneyValue({ amountMinorUnits: held, currency: payment.amount.currency }),
  );
}

// ---------------------------------------------------------------------------
// PaymentService
// ---------------------------------------------------------------------------

/**
 * Payment/invoice/refund use cases. Payment state NEVER touches order
 * state: recording or succeeding a payment does not place, complete or
 * cancel anything, and no method here claims delivery (RL-LOCK-008).
 */
export class PaymentService {
  readonly #deps: PaymentServiceDeps;

  constructor(deps: PaymentServiceDeps) {
    this.#deps = deps;
  }

  async #findOrder(session: CommerceSession, tenantId: TenantId, orderId: string): Promise<Order> {
    const record = await session.orders.findById(tenantId, parseOrderId(orderId));
    if (record === undefined) {
      throw new NotFoundError("order not found in the command tenant", {
        reason: "ORDER_NOT_FOUND",
      });
    }
    return Order.fromRecord(record);
  }

  async #findPayment(
    session: CommerceSession,
    tenantId: TenantId,
    paymentId: string,
  ): Promise<CustomerPayment> {
    const record = await session.payments.findById(tenantId, parseCustomerPaymentId(paymentId));
    if (record === undefined) {
      throw new NotFoundError("payment not found in the command tenant", {
        reason: "PAYMENT_NOT_FOUND",
      });
    }
    return CustomerPayment.fromRecord(record);
  }

  private expectRevision(expected: number, current: number, label: string): void {
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1
    ) {
      commandInvalid(`${label} must be a positive integer (the observed revision)`);
    }
    if (expected !== current) {
      throw new ConflictError(
        `${label} optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the aggregate changed concurrently); re-read and retry - never overwrite silently`,
        { reason: "REVISION_CONFLICT" },
      );
    }
  }

  // --- payments ---------------------------------------------------------------

  /**
   * Records a PENDING customer payment against a PLACED-or-later order in
   * the command tenant (payment:write). A draft order expresses nothing
   * payable yet; a cancelled order is not payable.
   */
  async recordPayment(
    envelope: CommandEnvelope,
    input: {
      readonly paymentId: string;
      readonly orderId: string;
      readonly amount: { readonly amountMinorUnits: number; readonly currency: string };
      readonly method?: string;
      readonly providerReference?: string;
    },
  ): Promise<{ readonly paymentId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly paymentId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "payment:write", this.#deps.now());

    if (input.method !== undefined && !isPaymentMethod(input.method)) {
      commandInvalid("method must be card, wallet, bank_transfer or voucher");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const order = await this.#findOrder(session, envelope.tenantId, input.orderId);
      if (order.status === "draft" || order.status === "cancelled") {
        throw new ConflictError(
          "the order is not payable (a draft order expresses nothing payable yet; a cancelled order is closed)",
          { reason: "ORDER_NOT_PAYABLE" },
        );
      }
      const amount = parseMoneyValue(input.amount);
      if (amount.amountMinorUnits === 0) {
        throw new ValidationError(
          "payment command rejected: amount - a zero payment expresses nothing",
          {
            reason: "PAYMENT_COMMAND_INVALID",
            details: [{ path: "amount", issue: "must be greater than zero minor units" }],
          },
        );
      }
      const payment = new CustomerPayment({
        paymentId: input.paymentId,
        tenantId: envelope.tenantId,
        orderId: order.orderId,
        ownerUserId: order.ownerUserId,
        amount,
        ...(input.method !== undefined ? { method: input.method as PaymentMethod } : {}),
        ...(input.providerReference !== undefined
          ? { providerReference: input.providerReference }
          : {}),
        status: "pending",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordPaymentEvent(
        session,
        envelope,
        "customer_payment",
        payment.paymentId,
        payment.revision,
        "customer_payment.recorded",
        { record: payment.toRecord(), orderStatus: order.status },
        at,
        this.#deps.generateId,
      );
      await session.payments.save(payment.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        paymentId: payment.paymentId,
        status: payment.status,
        revision: payment.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** Applies a typed payment transition (payment:write; CAS via expectedRevision). */
  async transitionPayment(
    envelope: CommandEnvelope,
    input: {
      readonly paymentId: string;
      readonly expectedRevision: number;
      readonly transition: "succeed" | "fail" | "cancel";
      readonly failureReason?: string;
    },
  ): Promise<{ readonly paymentId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly paymentId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "payment:write", this.#deps.now());

    if (input.transition === "fail" && !isPaymentFailureReason(input.failureReason)) {
      commandInvalid("failureReason must be a member of the closed payment failure-reason vocabulary when failing a payment");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const payment = await this.#findPayment(session, envelope.tenantId, input.paymentId);
      this.expectRevision(input.expectedRevision, payment.revision, "payment");
      const next =
        input.transition === "succeed"
          ? payment.succeed(at)
          : input.transition === "fail"
            ? payment.fail(at, input.failureReason as PaymentFailureReason)
            : payment.cancel(at);
      const transitionEvent: CommerceEventRecord["transition"] =
        input.transition === "succeed"
          ? "customer_payment.succeeded"
          : input.transition === "fail"
            ? "customer_payment.failed"
            : "customer_payment.cancelled";
      await recordPaymentEvent(
        session,
        envelope,
        "customer_payment",
        payment.paymentId,
        next.revision,
        transitionEvent,
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.payments.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        paymentId: next.paymentId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- invoices ---------------------------------------------------------------

  /**
   * Issues an invoice for a PLACED-or-later order (invoice:write). The
   * total is the exact order-total snapshot; the invoice number is
   * tenant-unique (typed conflict on reuse).
   */
  async issueInvoice(
    envelope: CommandEnvelope,
    input: {
      readonly invoiceId: string;
      readonly invoiceNumber: string;
      readonly orderId: string;
    },
  ): Promise<{
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly status: string;
    readonly revision: number;
  }> {
    type Outcome = {
      readonly invoiceId: string;
      readonly invoiceNumber: string;
      readonly status: string;
      readonly revision: number;
    };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "invoice:write", this.#deps.now());

    if (typeof input.invoiceNumber !== "string" || !INVOICE_NUMBER_PATTERN.test(input.invoiceNumber)) {
      commandInvalid("invoiceNumber must match INV-<4-digit year>-<6-digit sequence>");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const order = await this.#findOrder(session, envelope.tenantId, input.orderId);
      if (order.status === "draft" || order.status === "cancelled") {
        throw new ConflictError(
          "the order is not billable (a draft order expresses nothing commercial yet; a cancelled order is closed)",
          { reason: "ORDER_NOT_BILLABLE" },
        );
      }
      const existing = await session.invoices.findByNumber(
        envelope.tenantId,
        input.invoiceNumber,
      );
      if (existing !== undefined) {
        throw new ConflictError(
          "the invoice number is already used in this tenant (invoice numbers are tenant-unique)",
          { reason: "INVOICE_NUMBER_CONFLICT" },
        );
      }
      const invoice = new CustomerInvoice({
        invoiceId: input.invoiceId,
        tenantId: envelope.tenantId,
        invoiceNumber: input.invoiceNumber,
        orderId: order.orderId,
        ownerUserId: order.ownerUserId,
        totalAmount: order.totalAmount,
        status: "issued",
        issuedAt: at,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordPaymentEvent(
        session,
        envelope,
        "customer_invoice",
        invoice.invoiceId,
        invoice.revision,
        "customer_invoice.issued",
        { record: invoice.toRecord(), orderTotalAmount: order.totalAmount },
        at,
        this.#deps.generateId,
      );
      await session.invoices.save(invoice.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        revision: invoice.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * issued -> reconciled (invoice:write; CAS via expectedRevision).
   * Reconciliation is PROVEN inside the same session from the recorded
   * payments/refunds: succeeded payments minus succeeded refunds must cover
   * the invoice total in the same currency. The proof (payment ids and
   * amounts) is written into the event payload - the audit trail.
   */
  async reconcileInvoice(
    envelope: CommandEnvelope,
    input: { readonly invoiceId: string; readonly expectedRevision: number },
  ): Promise<{
    readonly invoiceId: string;
    readonly status: string;
    readonly revision: number;
    readonly reconciliation: InvoiceReconciliation;
  }> {
    type Outcome = {
      readonly invoiceId: string;
      readonly status: string;
      readonly revision: number;
      readonly reconciliation: InvoiceReconciliation;
    };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "invoice:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const record = await session.invoices.findById(
        envelope.tenantId,
        parseCustomerInvoiceId(input.invoiceId),
      );
      if (record === undefined) {
        throw new NotFoundError("invoice not found in the command tenant", {
          reason: "INVOICE_NOT_FOUND",
        });
      }
      const invoice = CustomerInvoice.fromRecord(record);
      this.expectRevision(input.expectedRevision, invoice.revision, "invoice");
      const payments = await session.payments.listForOrder(
        envelope.tenantId,
        invoice.orderId,
      );
      const refunds = await session.refunds.listForOrder(
        envelope.tenantId,
        invoice.orderId,
      );
      const reconciliation = computeInvoiceReconciliation(invoice.toRecord(), payments, refunds);
      if (!reconciliation.covered) {
        throw new ConflictError(
          "the invoice cannot be reconciled: succeeded payments minus succeeded refunds do not cover the invoice total in the invoice currency (reconciliation is proven from recorded money facts, never assumed)",
          {
            reason: "INVOICE_NOT_COVERED",
            details: [
              {
                path: "reconciliation",
                issue: `outstanding ${reconciliation.outstandingMinorUnits} ${reconciliation.currency} minor units`,
              },
            ],
          },
        );
      }
      const next = invoice.reconcile(at);
      await recordPaymentEvent(
        session,
        envelope,
        "customer_invoice",
        invoice.invoiceId,
        next.revision,
        "customer_invoice.reconciled",
        {
          record: next.toRecord(),
          reconciliation: {
            currency: reconciliation.currency,
            totalDueMinorUnits: reconciliation.totalDueMinorUnits,
            paidMinorUnits: reconciliation.paidMinorUnits,
            refundedMinorUnits: reconciliation.refundedMinorUnits,
            netPaidMinorUnits: reconciliation.netPaidMinorUnits,
            coveringPaymentIds: reconciliation.coveringPaymentIds,
          },
        },
        at,
        this.#deps.generateId,
      );
      await session.invoices.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        invoiceId: next.invoiceId,
        status: next.status,
        revision: next.revision,
        reconciliation: {
          invoiceId: reconciliation.invoiceId,
          orderId: reconciliation.orderId,
          currency: reconciliation.currency,
          totalDueMinorUnits: reconciliation.totalDueMinorUnits,
          paidMinorUnits: reconciliation.paidMinorUnits,
          refundedMinorUnits: reconciliation.refundedMinorUnits,
          netPaidMinorUnits: reconciliation.netPaidMinorUnits,
          outstandingMinorUnits: reconciliation.outstandingMinorUnits,
          covered: reconciliation.covered,
          coveringPaymentIds: reconciliation.coveringPaymentIds,
        },
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** issued -> voided (invoice:write; CAS via expectedRevision). */
  async voidInvoice(
    envelope: CommandEnvelope,
    input: { readonly invoiceId: string; readonly expectedRevision: number },
  ): Promise<{ readonly invoiceId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly invoiceId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "invoice:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const record = await session.invoices.findById(
        envelope.tenantId,
        parseCustomerInvoiceId(input.invoiceId),
      );
      if (record === undefined) {
        throw new NotFoundError("invoice not found in the command tenant", {
          reason: "INVOICE_NOT_FOUND",
        });
      }
      const invoice = CustomerInvoice.fromRecord(record);
      this.expectRevision(input.expectedRevision, invoice.revision, "invoice");
      const next = invoice.void(at);
      await recordPaymentEvent(
        session,
        envelope,
        "customer_invoice",
        invoice.invoiceId,
        next.revision,
        "customer_invoice.voided",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.invoices.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        invoiceId: next.invoiceId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- refunds ----------------------------------------------------------------

  /**
   * Requests a PENDING refund against a SUCCEEDED payment (refund:write).
   * Enforces the partial-refund bound: pending + succeeded refunds may
   * never exceed the payment amount (same currency, integer minor units).
   */
  async requestRefund(
    envelope: CommandEnvelope,
    input: {
      readonly refundId: string;
      readonly paymentId: string;
      readonly amount: { readonly amountMinorUnits: number; readonly currency: string };
      readonly reasonCode: string;
      readonly note?: string;
    },
  ): Promise<{ readonly refundId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly refundId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "refund:write", this.#deps.now());

    if (!isRefundReasonCode(input.reasonCode)) {
      commandInvalid("reasonCode must be a member of the closed refund reason-code vocabulary");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const payment = await this.#findPayment(session, envelope.tenantId, input.paymentId);
      if (payment.status !== "succeeded") {
        throw new ConflictError(
          "only a succeeded payment can be refunded (money that never moved cannot return)",
          { reason: "PAYMENT_NOT_REFUNDABLE" },
        );
      }
      const amount = parseMoneyValue(input.amount);
      if (amount.amountMinorUnits === 0) {
        throw new ValidationError(
          "refund command rejected: amount - a zero refund expresses nothing",
          {
            reason: "PAYMENT_COMMAND_INVALID",
            details: [{ path: "amount", issue: "must be greater than zero minor units" }],
          },
        );
      }
      if (amount.currency !== payment.amount.currency) {
        throw new ConflictError(
          "the refund currency differs from the payment currency (money is never silently converted)",
          { reason: "MONEY_CURRENCY_MISMATCH" },
        );
      }
      const existingRefunds = await session.refunds.listForPayment(
        envelope.tenantId,
        payment.paymentId,
      );
      const refundable = computeRefundableAmount(payment.toRecord(), existingRefunds);
      if (moneyGreaterThan(amount, refundable)) {
        throw new ConflictError(
          "the refund exceeds the refundable remainder of the payment (pending + succeeded refunds may never exceed the succeeded payment amount; no rounding, exact minor units)",
          {
            reason: "REFUND_EXCEEDS_REFUNDABLE",
            details: [
              {
                path: "amount",
                issue: `requested ${amount.amountMinorUnits} ${amount.currency}; refundable ${refundable.amountMinorUnits}`,
              },
            ],
          },
        );
      }
      const refund = new CustomerRefund({
        refundId: input.refundId,
        tenantId: envelope.tenantId,
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        ownerUserId: payment.ownerUserId,
        amount,
        reasonCode: input.reasonCode,
        ...(input.note !== undefined ? { note: input.note } : {}),
        status: "pending",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordPaymentEvent(
        session,
        envelope,
        "customer_refund",
        refund.refundId,
        refund.revision,
        "customer_refund.requested",
        { record: refund.toRecord(), refundableAmountBefore: refundable },
        at,
        this.#deps.generateId,
      );
      await session.refunds.save(refund.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        refundId: refund.refundId,
        status: refund.status,
        revision: refund.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** Applies a typed refund transition (refund:write; CAS via expectedRevision). */
  async transitionRefund(
    envelope: CommandEnvelope,
    input: {
      readonly refundId: string;
      readonly expectedRevision: number;
      readonly transition: "succeed" | "fail" | "cancel";
      readonly failureReason?: string;
    },
  ): Promise<{ readonly refundId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly refundId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "refund:write", this.#deps.now());

    if (input.transition === "fail" && !isRefundFailureReason(input.failureReason)) {
      commandInvalid("failureReason must be a member of the closed refund failure-reason vocabulary when failing a refund");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const record = await session.refunds.findById(
        envelope.tenantId,
        parseCustomerRefundId(input.refundId),
      );
      if (record === undefined) {
        throw new NotFoundError("refund not found in the command tenant", {
          reason: "REFUND_NOT_FOUND",
        });
      }
      const refund = CustomerRefund.fromRecord(record);
      this.expectRevision(input.expectedRevision, refund.revision, "refund");
      const next =
        input.transition === "succeed"
          ? refund.succeed(at)
          : input.transition === "fail"
            ? refund.fail(at, input.failureReason as RefundFailureReason)
            : refund.cancel(at);
      const transitionEvent: CommerceEventRecord["transition"] =
        input.transition === "succeed"
          ? "customer_refund.succeeded"
          : input.transition === "fail"
            ? "customer_refund.failed"
            : "customer_refund.cancelled";
      await recordPaymentEvent(
        session,
        envelope,
        "customer_refund",
        refund.refundId,
        next.revision,
        transitionEvent,
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.refunds.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        refundId: next.refundId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Committed-state read helpers (tenant-scoped; read models consume these)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped read view over the RL-022 records, for read models and
 * the RL-023 reference layer. Exposes the recorded facts only - it never
 * derives combined status (RL-LOCK-008).
 */
export interface PaymentReadViews {
  readonly orders: OrderReader;
  listPaymentsForOrder(tenantId: TenantId, orderId: OrderId): Promise<readonly CustomerPaymentRecord[]>;
  listRefundsForOrder(tenantId: TenantId, orderId: OrderId): Promise<readonly CustomerRefundRecord[]>;
  listInvoicesForOrder(tenantId: TenantId, orderId: OrderId): Promise<readonly CustomerInvoiceRecord[]>;
  /** True iff the invoice state is a member of the closed vocabulary (guard). */
  isKnownInvoiceState(state: string): boolean;
}

/** Builds a committed-state payment read view over a commerce store. */
export function paymentReadViewsOf(store: CommerceStore): PaymentReadViews {
  return {
    orders: store.read.orders,
    async listPaymentsForOrder(tenantId, orderId) {
      return store.read.payments.listForOrder(tenantId, orderId);
    },
    async listRefundsForOrder(tenantId, orderId) {
      return store.read.refunds.listForOrder(tenantId, orderId);
    },
    async listInvoicesForOrder(tenantId, orderId) {
      return store.read.invoices.listForOrder(tenantId, orderId);
    },
    isKnownInvoiceState(state: string): boolean {
      return isInvoiceState(state);
    },
  };
}
