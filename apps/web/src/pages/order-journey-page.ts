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
 *    not on a payment-success page (user-journey-audit §6).
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
  type HtmlFragment,
  type MutationAcknowledgement,
  type OrderDetailResource,
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
