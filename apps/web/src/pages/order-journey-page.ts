/**
 * The guided purchase-to-delivery journey (RL-101, spec/tech-lead-handoff.md
 * §9, spec/ux-architecture.md §10 L199, spec/user-journey-audit.md §6).
 *
 * The frozen journey laws this page renders under:
 *
 *  - the commercial chain ("payment confirmed") is VISIBLY DISTINGUISHED
 *    from the connectivity chain ("connectivity requested -> offer/
 *    reservation -> activation -> delivery evidence -> billable-final");
 *    the two chains NEVER collapse into one status (RL-LOCK-008);
 *  - "Payment confirms a commercial fact; it does not prove connectivity
 *    delivery" — delivery evidence is rendered separately;
 *  - success is never shown merely because payment succeeded, an order was
 *    placed, a reservation exists, or a webhook arrived;
 *  - the four-stage command pipeline (accepted/executed/delivered/
 *    billable-final) renders as separate per-stage facts, never one word;
 *  - a newly placed order legitimately renders referenceStatus "none"
 *    until delivery evidence exists — the state renders truthfully;
 *  - evidence freshness is re-evaluated at render by the read (the fake
 *    evaluates at the query instant); the page renders what the read
 *    asserts and invents nothing;
 *  - after payment the customer lands HERE — a delivery-progress view —
 *    not on a payment-success page (user-journey-audit §6);
 *  - PA-002 (closes RL-115-F4): the refund section renders refund state
 *    FROM THE READ ONLY (the additive refunds read riding this order
 *    journey read). Refund state is a MONEY FACT in its own closed
 *    vocabulary (customer_refund_state, mirrored through the app contract,
 *    never merged with payment/invoice/order states — RL-LOCK-008); a
 *    refund never claims anything about connectivity delivery, and refund
 *    EXECUTION lives upstream in commerce operations — the section is
 *    READ-ONLY (no refund request/cancel control exists anywhere on this
 *    page, because no customer refund write contract backs one). A stale
 *    refund read keeps its content PAIRED with the stale badge (§14); an
 *    absent/null section renders the honest not-available state; an empty
 *    section renders the honest no-refunds state.
 *
 * Every stage the read model cannot confirm renders honestly as waiting /
 * not-recorded / none. Pure function over parsed read models plus the
 * optional place-order command acknowledgement.
 */
import {
  deliveryEvidenceBadge,
  evidenceDisclosure,
  freshnessBadge,
  instantView,
  moneyView,
  mutationStages,
  stateBadge,
  technicalDisclosure,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type CustomerRefundFailureResourceReason,
  type CustomerRefundResourceState,
  type FreshnessView,
  type HtmlFragment,
  type MoneyView,
  type MutationAcknowledgement,
  type OrderDetailResource,
  type RefundReasonResourceCode,
  type RefundView,
  type SubjectConnectivityResource,
  type SubscriptionResource,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading, tableWrap } from "../app.js";
import {
  DELIVERY_EVIDENCE_LANGUAGE,
  REFERENCE_STATUS_LANGUAGE,
} from "./language.js";
import { supportEscape } from "./support-context.js";

export interface OrderJourneyInput {
  /** The commercial subject: order + payments + invoices (money facts). */
  readonly orderDetail: OrderDetailResource;
  /** The authoritative connectivity read (per-subject delivery truth). */
  readonly connectivity: ConnectivityOverviewResource;
  /**
   * The subscriptions spawned by this order, so the journey can render the
   * subscription subject's connectivity truth next to the order's.
   */
  readonly subscriptions: readonly SubscriptionResource[];
  /**
   * The place-order command acknowledgement (accepted/executed/delivered/
   * billable-final as separate per-stage facts), when the caller knows the
   * command. Absent renders the honest not-recorded note - the pipeline is
   * never fabricated from the read models.
   */
  readonly command?: MutationAcknowledgement | null;
}

/** The closed per-subject connectivity-chain stage keys on this page. */
export const ORDER_JOURNEY_CHAIN_STAGES = [
  "connectivity-requested",
  "offer-reservation",
  "activation",
  "delivery-evidence",
  "billable-final",
] as const;

export type OrderJourneyChainStage = (typeof ORDER_JOURNEY_CHAIN_STAGES)[number];

/** The honest per-stage states (a closed vocabulary, like the journey page). */
export const ORDER_JOURNEY_CHAIN_STATES = [
  "confirmed",
  "waiting",
  "not-recorded",
  "blocked",
] as const;

export type OrderJourneyChainState = (typeof ORDER_JOURNEY_CHAIN_STATES)[number];

const CHAIN_STATE_LANGUAGE: Readonly<Record<OrderJourneyChainState, string>> = Object.freeze({
  confirmed: "Confirmed",
  waiting: "Waiting",
  "not-recorded": "Not recorded yet",
  blocked: "Blocked",
});

// --------------------------------------------------------------------------------
// PA-002 (closes RL-115-F4): the refund read section
// --------------------------------------------------------------------------------

/**
 * Human words for the mirrored `customer_refund_state` vocabulary
 * (presentation only — the authoritative state value always renders too,
 * as the `data-refund-state` marker and the visible state word).
 */
const REFUND_STATE_LANGUAGE: Readonly<Record<CustomerRefundResourceState, string>> =
  Object.freeze({
    pending: "Pending",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  });

/**
 * The closed reason-code LABEL vocabulary (presentation only): each label
 * explains the commercial decision the reason code records. A reason label
 * never asserts delivery evidence (RL-LOCK-008 — a refund is a money fact).
 */
const REFUND_REASON_LANGUAGE: Readonly<Record<RefundReasonResourceCode, string>> =
  Object.freeze({
    customer_request: "You asked for this refund",
    service_not_delivered: "The service was not delivered",
    billing_error: "A billing error was corrected",
    duplicate_charge: "A duplicate charge was returned",
    goodwill: "A goodwill adjustment",
    other: "A recorded reason",
  });

/** Human sentences for the closed refund failure-reason vocabulary. */
const REFUND_FAILURE_LANGUAGE: Readonly<
  Record<CustomerRefundFailureResourceReason, string>
> = Object.freeze({
  processor_error: "the payment processor reported an error",
  payment_instrument_unreachable: "the payment instrument could not be reached",
  compliance_hold: "a compliance hold stopped the refund",
  cancelled_by_operator: "commerce operations cancelled it",
});

/** One refund row, derived purely from the order journey's refunds read. */
export interface RefundRowView {
  readonly refundId: string;
  /** The payment this refund returns money from (the parent reference). */
  readonly paymentId: string;
  readonly state: CustomerRefundResourceState;
  readonly amount: MoneyView;
  readonly reasonCode: RefundReasonResourceCode;
  /** The human label for the reason code (presentation only). */
  readonly reasonLabel: string;
  /** The optional human-facing note riding the record. */
  readonly note?: string;
  /** The per-state honest fact (a money fact — never a delivery claim). */
  readonly fact: string;
  /** The read's freshness; PAIRS with the state at render (§14). */
  readonly freshness: FreshnessView;
}

function refundFailureSentence(failureReason: CustomerRefundFailureResourceReason): string {
  return REFUND_FAILURE_LANGUAGE[failureReason] ?? failureReason;
}

/**
 * Derives the honest per-state fact for ONE refund. The §14 discipline:
 * the CONTENT stays PAIRED with the freshness state — a stale read keeps
 * its state word and fact, qualified as the last verified read; an
 * unverified read says so instead of guessing.
 */
function refundFact(
  refund: RefundView,
): string {
  const freshness = refund.freshness.freshnessState;
  if (refund.state === "pending") {
    if (freshness === "FRESH") {
      return "In progress — the refund has been recorded and commerce operations are returning this money. It is not confirmed returned yet.";
    }
    if (freshness === "STALE") {
      return "In progress as of the last verified read — the read is stale, so the refund may have progressed since.";
    }
    return "A pending refund record exists, but no verified observation backs this read yet.";
  }
  if (refund.state === "succeeded") {
    if (freshness === "FRESH") {
      return "Completed — the recorded refund state is succeeded. This is a money fact only: it says nothing about connectivity delivery.";
    }
    if (freshness === "STALE") {
      return "Completed as of the last verified read — the read is stale; this is what was last verified, never a guess about now.";
    }
    return "A succeeded refund record exists, but no verified observation backs this read yet.";
  }
  if (refund.state === "failed") {
    const reason =
      refund.failureReason !== undefined ? ` — ${refundFailureSentence(refund.failureReason)}` : "";
    if (freshness === "STALE") {
      return `The refund attempt failed${reason} (as of the last verified read). No money moved back for this refund.`;
    }
    if (freshness === "UNKNOWN") {
      return `A failed refund record exists${reason}, but no verified observation backs this read yet.`;
    }
    return `The refund attempt failed${reason}. No money moved back for this refund.`;
  }
  // cancelled
  if (freshness === "STALE") {
    return "Cancelled as of the last verified read — the read is stale.";
  }
  if (freshness === "UNKNOWN") {
    return "A cancelled refund record exists, but no verified observation backs this read yet.";
  }
  return "Cancelled before any money moved — the refund was withdrawn.";
}

/**
 * Derives the refund rows from the order journey read's refunds section.
 * Pure over every shape-legal wire world: a NULL section (an older
 * payload, or a surface composing no refund read) derives NO rows — the
 * section render owns that honest not-available state; an empty section
 * derives no rows (the honest no-refunds state); nothing invents a refund,
 * collapses a state, or merges the refund vocabulary with another state
 * family.
 */
export function deriveRefundRows(
  refunds: readonly RefundView[] | null | undefined,
): readonly RefundRowView[] {
  if (refunds === null || refunds === undefined) return [];
  return refunds.map((refund) => ({
    refundId: refund.refundId,
    paymentId: refund.paymentId,
    state: refund.state,
    amount: refund.amount,
    reasonCode: refund.reasonCode,
    reasonLabel: REFUND_REASON_LANGUAGE[refund.reasonCode],
    ...(refund.note !== undefined ? { note: refund.note } : {}),
    fact: refundFact(refund),
    freshness: refund.freshness,
  }));
}

function refundRow(row: RefundRowView): HtmlFragment {
  return el(
    "li",
    {
      class: "goal-card",
      "data-refund-id": row.refundId,
      "data-refund-state": row.state,
    },
    fragment(
      el(
        "p",
        {},
        fragment(
          el("strong", {}, fragment(text("Refund "), moneyView(row.amount))),
          text(" — "),
          el(
            "span",
            { class: "journey-state", "data-state-word": row.state },
            text(REFUND_STATE_LANGUAGE[row.state]),
          ),
        ),
      ),
      el("p", { class: "muted" }, text(`Returns money from payment ${row.paymentId}`)),
      el(
        "p",
        { class: "muted" },
        fragment(
          text(`Reason: ${row.reasonLabel}`),
          row.note === undefined ? fragment() : text(` — "${row.note}"`),
        ),
      ),
      el("p", { class: "journey-fact" }, text(row.fact)),
      // The freshness PAIRING (§14): the read's state rides NEXT TO the
      // refund's own content — a stale read keeps its content paired with
      // the stale badge, never hidden, never dropped.
      el("p", {}, fragment(text("Refund read: "), freshnessBadge(row.freshness))),
    ),
  );
}

/**
 * The PA-002 refund section: one row per refund with its state word,
 * per-state fact, amount + currency, reason label and freshness pairing —
 * rendered FROM THE READ ONLY. The authority note names where refund
 * EXECUTION lives (upstream, in commerce operations); the recovery path is
 * the §15 support escape (pre-carrying the order + refund references) in
 * the degraded worlds, the quiet reachability note otherwise. An
 * absent/null section renders the honest not-available state; an empty
 * section renders the honest no-refunds state.
 */
function refundSection(orderDetail: OrderDetailResource): HtmlFragment {
  const refunds = orderDetail.refunds;
  const rows = deriveRefundRows(refunds);
  // The authority note (the available user action, honestly bounded):
  // refund execution lives UPSTREAM, in commerce operations. This section
  // composes no refund request or cancellation control — no write contract
  // backs one, so composing one would fabricate capability.
  const authorityNote = el(
    "p",
    { class: "muted", "data-refunds-authority": "true" },
    text(
      "Refunds are executed by RoamLink's commerce operations, upstream of this journey. This section shows their recorded state read-only — there is no refund button here because requesting or changing a refund is not a capability this surface composes.",
    ),
  );
  // The §15 recovery path: a degraded refund world (a failed refund, a
  // stale/unverified read, or no refund read composed at all) carries the
  // support escape with the facts the read holds pre-carried in the
  // narrative; a fully-verified healthy world renders the quiet
  // reachability note instead (an escape is for degraded states, never
  // decoration).
  const degraded =
    refunds === null ||
    rows.some(
      (row) =>
        row.state === "failed" ||
        row.freshness.freshnessState === "STALE" ||
        row.freshness.freshnessState === "UNKNOWN",
    );
  const recovery = degraded
    ? supportEscape({
        context: {
          subject: "I need help with a refund on my order.",
          detail:
            refunds === null
              ? "The order journey composes no refund read for this order yet, so no refund state is visible."
              : `The order journey reads: ${rows
                  .map(
                    (row) =>
                      `refund ${row.refundId} — ${REFUND_STATE_LANGUAGE[row.state]} (${row.freshness.freshnessState})`,
                  )
                  .join("; ")}.`,
          refs: [
            { kind: "order", id: orderDetail.order.orderId },
            ...rows.map((row) => ({ kind: "refund" as const, id: row.refundId })),
          ],
        },
        label: "Get help with refunds",
      })
    : el(
        "p",
        { class: "muted", "data-refunds-reachability": "true" },
        text("If a refund looks wrong or stale, Support is reachable from this page's journeys."),
      );

  if (refunds === null) {
    // The honest not-available state: this surface composes no refund read
    // (the page's established pattern — the same discipline the command
    // pipeline's absent note uses).
    return el(
      "section",
      { class: "panel", "data-refunds": "not-available", "data-refunds-absent": "true" },
      fragment(
        el("h3", {}, text("Refunds")),
        el(
          "p",
          { class: "muted" },
          text(
            "Refund state for this order is not part of this read yet. When the refund read composes, the real states appear here — nothing is invented in the meantime.",
          ),
        ),
        authorityNote,
        recovery,
      ),
    );
  }

  return el(
    "section",
    { class: "panel", "data-refunds": refunds.length === 0 ? "empty" : "true" },
    fragment(
      el("h3", {}, text("Refunds")),
      el(
        "p",
        { class: "muted" },
        text(
          "Money facts: refunds recorded against this order's payments. A refund never claims anything about connectivity delivery — the two chains stay separate.",
        ),
      ),
      refunds.length === 0
        ? el(
            "p",
            { class: "muted", "data-refunds-empty": "true" },
            text("No refunds are recorded for this order."),
          )
        : el(
            "ul",
            {
              class: "goal-list",
              "data-refund-rows": "true",
              "aria-label": "Refunds for this order and their current states",
            },
            ...rows.map(refundRow),
          ),
      authorityNote,
      recovery,
    ),
  );
}

function subjectFor(
  subjects: readonly SubjectConnectivityResource[],
  subjectType: "order" | "subscription",
  subjectId: string,
): SubjectConnectivityResource | undefined {
  return subjects.find((s) => s.subjectType === subjectType && s.subjectId === subjectId);
}

/**
 * Derives the honest connectivity-chain stage states for ONE subject from
 * what the read model asserts — nothing else. Commercial state NEVER feeds
 * this derivation (RL-LOCK-008): a paid order with no evidence renders
 * every network stage as waiting, and billable-final only from the
 * command's own recorded stage when present.
 */
export interface OrderJourneyChainStep {
  readonly stage: OrderJourneyChainStage;
  readonly state: OrderJourneyChainState;
  readonly fact: string;
}

export function deriveOrderJourneyChain(
  subject: SubjectConnectivityResource,
  command: MutationAcknowledgement | undefined,
): readonly OrderJourneyChainStep[] {
  const evidenced = subject.deliveryEvidenceState === "EVIDENCED";
  const freshnessState = subject.evidence?.freshness.freshnessState ?? null;
  const referenceActive = subject.referenceStatus === "active";
  const referenceKnown = subject.referenceStatus !== "none";
  // An inactive/retired reference can no longer progress: honest blocked.
  const chainState = (state: OrderJourneyChainState): OrderJourneyChainState =>
    referenceActive || subject.referenceStatus === "none" ? state : "blocked";

  const steps: readonly OrderJourneyChainStep[] = [
    {
      stage: "connectivity-requested",
      state: chainState(referenceKnown ? "confirmed" : "waiting"),
      fact:
        referenceKnown
          ? `Reference ${subject.referenceStatus} — a connectivity request exists for this ${subject.subjectType}.`
          : "No connectivity request exists yet for this purchase. RoamLink requests connectivity; the request appearing here is the first connectivity step.",
    },
    {
      stage: "offer-reservation",
      state: chainState(referenceKnown ? (evidenced ? "confirmed" : "waiting") : "not-recorded"),
      fact: evidenced
        ? "Confirmed by the linked delivery evidence."
        : referenceKnown
          ? "RoamLink is working with the network; the reservation shows as confirmed when delivery evidence is linked."
          : "Nothing is requested yet, so there is nothing to reserve.",
    },
    {
      stage: "activation",
      state: chainState(referenceKnown ? (evidenced ? "confirmed" : "waiting") : "not-recorded"),
      fact: evidenced
        ? "Confirmed by the linked delivery evidence."
        : referenceKnown
          ? "Activation is confirmed when delivery evidence is linked — never from the payment itself."
          : "Nothing is requested yet, so there is nothing to activate.",
    },
    {
      stage: "delivery-evidence",
      state: chainState(evidenced ? "confirmed" : referenceKnown ? "waiting" : "not-recorded"),
      fact: evidenced
        ? `Delivery evidence linked (${subject.evidence?.evidenceClass ?? "class not recorded"}); freshness ${freshnessState ?? "unknown"}.`
        : DELIVERY_EVIDENCE_LANGUAGE[subject.deliveryEvidenceState] ??
          subject.deliveryEvidenceState,
    },
    {
      stage: "billable-final",
      state: chainState(
        command?.billableFinalAt !== undefined
          ? "confirmed"
          : evidenced || referenceKnown
            ? "waiting"
            : "not-recorded",
      ),
      fact:
        command?.billableFinalAt !== undefined
          ? `Commerce finality recorded ${command.billableFinalAt} (e.g. the invoice reconciled).`
          : "Commerce finality (billable-final) is reached only after delivery is proven and the invoice reconciles — a paid order is not a final bill.",
    },
  ];
  return steps;
}

function commerceChainSection(orderDetail: OrderDetailResource): HtmlFragment {
  const succeededPayments = orderDetail.payments.filter((p) => p.state === "succeeded");
  return el(
    "section",
    { class: "panel", "data-commerce-chain": "true", "data-order-id": orderDetail.order.orderId },
    fragment(
      el("h3", {}, text("Commercial facts (separate)")),
      el(
        "p",
        { class: "muted" },
        text(
          "These are money facts. Payment confirms a commercial fact; it does not prove connectivity delivery.",
        ),
      ),
      el(
        "dl",
        { class: "fact-list" },
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Order")),
          el("dd", {}, fragment(stateBadge(orderDetail.order.status), text(` ${orderDetail.order.orderId}`))),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Payment confirmed?")),
          el(
            "dd",
            {},
            succeededPayments.length === 0
              ? text("No succeeded payment recorded for this order yet.")
              : fragment(
                  stateBadge("succeeded"),
                  text(
                    ` ${succeededPayments.length} succeeded payment${succeededPayments.length === 1 ? "" : "s"} — a commercial fact only`,
                  ),
                ),
          ),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Order total")),
          el("dd", {}, moneyView(orderDetail.order.total)),
        ),
      ),
      tableWrap(
        "Payments for this order (money facts)",
        el(
          "table",
          { "data-payments": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { scope: "col" }, text("Payment")),
              el("th", { scope: "col" }, text("Amount")),
              el("th", { scope: "col" }, text("State")),
              el("th", { scope: "col" }, text("Recorded")),
            ),
          ),
          el(
            "tbody",
            {},
            ...orderDetail.payments.map((payment) =>
              el(
                "tr",
                {},
                el("td", {}, text(payment.paymentId)),
                el("td", {}, moneyView(payment.amount)),
                el("td", {}, stateBadge(payment.state)),
                el("td", {}, instantView(payment.recordedAt)),
              ),
            ),
          ),
        ),
      ),
      tableWrap(
        "Invoices for this order",
        el(
          "table",
          { "data-invoices": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { scope: "col" }, text("Invoice")),
              el("th", { scope: "col" }, text("Amount")),
              el("th", { scope: "col" }, text("State")),
              el("th", { scope: "col" }, text("Issued")),
              el("th", { scope: "col" }, text("Reconciled")),
            ),
          ),
          el(
            "tbody",
            {},
            ...orderDetail.invoices.map((invoice) =>
              el(
                "tr",
                { "data-invoice-state": invoice.state },
                el("td", {}, text(invoice.invoiceId)),
                el("td", {}, moneyView(invoice.amount)),
                el("td", {}, stateBadge(invoice.state)),
                el("td", {}, instantView(invoice.issuedAt)),
                el(
                  "td",
                  {},
                  invoice.reconciledAt === undefined ? text("-") : instantView(invoice.reconciledAt),
                ),
              ),
            ),
          ),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(
          "Payment, order, delivery and billable finality are separate states; this section shows commerce only.",
        ),
      ),
      orderDetail.payments.some((payment) => payment.state === "failed")
        ? supportEscape({
            context: {
              subject: "A payment on my order failed and I need help completing the purchase.",
              refs: [
                { kind: "order", id: orderDetail.order.orderId },
                ...orderDetail.payments
                  .filter((payment) => payment.state === "failed")
                  .map((payment) => ({ kind: "payment" as const, id: payment.paymentId })),
              ],
            },
          })
        : fragment(),
    ),
  );
}

function subjectChainCard(
  subject: SubjectConnectivityResource,
  command: MutationAcknowledgement | undefined,
): HtmlFragment {
  const stages = deriveOrderJourneyChain(subject, command);
  const reference = REFERENCE_STATUS_LANGUAGE[subject.referenceStatus] ?? subject.referenceStatus;
  return el(
    "section",
    {
      class: "panel",
      "data-connectivity-chain": "true",
      "data-subject-type": subject.subjectType,
      "data-subject-id": subject.subjectId,
      "data-reference-status": subject.referenceStatus,
      "data-delivery-evidence-state": subject.deliveryEvidenceState,
    },
    fragment(
      el(
        "h3",
        {},
        text(`${subject.subjectType === "order" ? "Order" : "Subscription"} connectivity journey`),
      ),
      el("p", { class: "muted" }, text(`Reference ${subject.subjectId}`)),
      el(
        "p",
        {},
        fragment(
          text("Reference: "),
          stateBadge(subject.referenceStatus),
          text(` ${reference}`),
        ),
      ),
      el(
        "p",
        {},
        fragment(
          text("Delivery evidence: "),
          deliveryEvidenceBadge(subject.deliveryEvidenceState),
          text(" — "),
          text(
            DELIVERY_EVIDENCE_LANGUAGE[subject.deliveryEvidenceState] ??
              subject.deliveryEvidenceState,
          ),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        fragment(
          text("Commercial state of this subject (kept separate): "),
          stateBadge(subject.commercialState),
        ),
      ),
      el(
        "ol",
        { class: "journey", "aria-label": "The connectivity chain for this purchase, stage by stage" },
        ...stages.map((stage) =>
          el(
            "li",
            {
              class: "journey-stage",
              "data-chain-stage": stage.stage,
              "data-chain-state": stage.state,
            },
            fragment(
              el(
                "p",
                { class: "journey-headline" },
                fragment(
                  el("strong", {}, text(stage.stage.replace(/-/g, " "))),
                  text(" — "),
                  el(
                    "span",
                    { class: "journey-state", "data-state-word": stage.state },
                    text(CHAIN_STATE_LANGUAGE[stage.state]),
                  ),
                ),
              ),
              el("p", { class: "muted" }, text(stage.fact)),
            ),
          ),
        ),
      ),
      subject.evidence === null
        ? fragment()
        : el(
            "p",
            { class: "muted" },
            fragment(text("Evidence freshness (re-evaluated at this render): "), freshnessBadge(subject.evidence.freshness)),
          ),
      evidenceDisclosure({ subjects: [subject] }),
      technicalDisclosure({ subjects: [subject] }),
      // Stale/unevidenced subjects carry the contextual support escape
      // (RL-103): the escape pre-carries this subject's reference.
      subject.deliveryEvidenceState !== "EVIDENCED" || subject.evidence?.freshness.freshnessState !== "FRESH"
        ? supportEscape({
            context: {
              subject:
                subject.deliveryEvidenceState === "EVIDENCED"
                  ? "My connectivity delivery evidence is not fresh."
                  : "I paid but my connectivity has no delivery evidence yet.",
              refs: [{ kind: subject.subjectType, id: subject.subjectId }],
            },
          })
        : fragment(),
    ),
  );
}

function commandPipelineSection(command: MutationAcknowledgement | null): HtmlFragment {
  if (command === null || command === undefined) {
    return el(
      "section",
      { class: "panel", "data-command-pipeline": "absent" },
      fragment(
        el("h3", {}, text("Command pipeline")),
        el(
          "p",
          { class: "muted" },
          text(
            "The four-stage command record for this purchase is not part of this read. Everything this page claims comes from the connectivity read above; Activity records what RoamLink has done.",
          ),
        ),
      ),
    );
  }
  return el(
    "section",
    { class: "panel", "data-command-pipeline": "true", "data-command-id": command.commandId },
    fragment(
      el("h3", {}, text("Command pipeline")),
      el(
        "p",
        { class: "muted" },
        text(
          "The four stages stay separate on purpose — accepted is not executed, executed is not delivered, and delivered is not billable-final.",
        ),
      ),
      mutationStages(command),
    ),
  );
}

export function orderJourneyPage(input: OrderJourneyInput): HtmlFragment {
  const orderId = input.orderDetail.order.orderId;
  const orderSubject = subjectFor(input.connectivity.subjects, "order", orderId);
  const subscriptionSubjects = input.subscriptions
    .filter((subscription) => subscription.orderId === orderId)
    .map((subscription) =>
      subjectFor(input.connectivity.subjects, "subscription", subscription.subscriptionId),
    )
    .filter((subject): subject is SubjectConnectivityResource => subject !== undefined);
  const subjects = [...(orderSubject === undefined ? [] : [orderSubject]), ...subscriptionSubjects];

  return fragment(
    pageHeading(
      "Your delivery progress",
      "What you bought, what RoamLink has requested, and what the network has actually confirmed — kept as separate, honest chains.",
    ),
    el(
      "section",
      { "data-order-journey": "true", "data-order-id": orderId },
      fragment(
        commerceChainSection(input.orderDetail),
        // PA-002 (closes RL-115-F4): the refund read section rides the
        // order journey right after the commercial facts it belongs to —
        // refunds are money facts against this order's payments.
        refundSection(input.orderDetail),
        subjects.length === 0
          ? el(
              "p",
              { class: "muted", "data-journey-subjects-empty": "true" },
              text(
                "The connectivity read has no subjects recorded for this order yet. Nothing is claimed — the journey appears as soon as the read carries it.",
              ),
            )
          : fragment(...subjects.map((subject) => subjectChainCard(subject, input.command ?? undefined))),
        commandPipelineSection(input.command ?? null),
        el(
          "p",
          { class: "muted" },
          fragment(
            text("Connectivity read presented at "),
            instantView(input.connectivity.presentedAt),
            text(" — state is claimed only from delivery evidence and its freshness."),
          ),
        ),
        el(
          "p",
          {},
          el("a", { href: pagePath("connectivity") }, text("See the full connectivity journey")),
        ),
      ),
    ),
  );
}
