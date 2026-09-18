/**
 * The commerce page (RL-060): product catalog, orders, subscriptions,
 * payments and invoices - with the honest separation between commercial
 * state, money facts and delivery evidence (RL-LOCK-008: payment is not
 * delivery).
 */
import {
  emptyState,
  instantView,
  moneyView,
  stateBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type OrderDetailResource,
  type OrderResource,
  type ProductResource,
  type SubscriptionResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

export function commercePage(input: {
  readonly products: readonly ProductResource[];
  readonly orders: readonly OrderResource[];
  readonly subscriptions: readonly SubscriptionResource[];
  readonly orderDetail?: OrderDetailResource;
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Plans & Billing",
      "Commercial intent only: buying a product never implies connectivity delivery (that is proven by delivery evidence on the connectivity page).",
    ),
    input.products.length === 0
      ? emptyState("products")
      : el(
          "table",
          { "data-products": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Product")),
              el("th", {}, text("Variant")),
              el("th", {}, text("Billing")),
              el("th", {}, text("Price")),
              el("th", {}, text("Term")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.products.flatMap((product) =>
              product.variants.map((variant) =>
                el(
                  "tr",
                  { "data-variant-id": variant.variantId },
                  el("td", {}, text(product.name)),
                  el("td", {}, text(variant.name)),
                  el("td", {}, text(variant.billingModel)),
                  el("td", {}, moneyView(variant.price)),
                  el("td", {}, variant.termDays === undefined ? text("-") : text(`${variant.termDays} days`)),
                ),
              ),
            ),
          ),
        ),
    pageHeading("Place an order"),
    el(
      "form",
      { method: "post", action: "/flows/place-order", "data-flow": "place-order" },
      el("label", {}, text("Variant id ")),
      el("input", { type: "text", name: "variantId", required: true }),
      el("label", {}, text(" Quantity ")),
      el("input", { type: "number", name: "quantity", min: 1, value: 1 }),
      el("button", { type: "submit" }, text("Place order")),
    ),
    pageHeading("Orders"),
    input.orders.length === 0
      ? emptyState("orders")
      : el(
          "table",
          { "data-orders": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Order")),
              el("th", {}, text("Status")),
              el("th", {}, text("Total")),
              el("th", {}, text("Revision")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.orders.map((order) =>
              el(
                "tr",
                { "data-order-id": order.orderId },
                el("td", {}, text(order.orderId)),
                el("td", {}, stateBadge(order.status)),
                el("td", {}, moneyView(order.total)),
                el("td", {}, text(order.revision)),
              ),
            ),
          ),
        ),
    input.orderDetail === undefined ? fragment() : orderDetailBlock(input.orderDetail),
    pageHeading("Subscriptions"),
    input.subscriptions.length === 0
      ? emptyState("subscriptions")
      : el(
          "table",
          { "data-subscriptions": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Subscription")),
              el("th", {}, text("Status")),
              el("th", {}, text("Period start")),
              el("th", {}, text("Period end")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.subscriptions.map((subscription) =>
              el(
                "tr",
                { "data-subscription-id": subscription.subscriptionId },
                el("td", {}, text(subscription.subscriptionId)),
                el("td", {}, stateBadge(subscription.status)),
                el("td", {}, instantView(subscription.periodStart)),
                el(
                  "td",
                  {},
                  subscription.periodEnd === undefined ? text("-") : instantView(subscription.periodEnd),
                ),
              ),
            ),
          ),
        ),
  );
}

function orderDetailBlock(detail: OrderDetailResource): HtmlFragment {
  return fragment(
    pageHeading(`Order ${detail.order.orderId}`, `Status ${detail.order.status}`),
    el(
      "table",
      { "data-order-lines": "true" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, text("Line")),
          el("th", {}, text("Variant")),
          el("th", {}, text("Quantity")),
          el("th", {}, text("Unit price")),
        ),
      ),
      el(
        "tbody",
        {},
        ...detail.order.lines.map((line) =>
          el(
            "tr",
            {},
            el("td", {}, text(line.lineId)),
            el("td", {}, text(line.variantId)),
            el("td", {}, text(line.quantity)),
            el("td", {}, moneyView(line.unitPrice)),
          ),
        ),
      ),
    ),
    pageHeading("Payments (money facts)"),
    detail.payments.length === 0
      ? emptyState("payments")
      : el(
          "table",
          { "data-payments": "true" },
          el(
            "thead",
            {},
            el("tr", {}, el("th", {}, text("Payment")), el("th", {}, text("Amount")), el("th", {}, text("State")), el("th", {}, text("Recorded"))),
          ),
          el(
            "tbody",
            {},
            ...detail.payments.map((payment) =>
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
    pageHeading("Invoices"),
    detail.invoices.length === 0
      ? emptyState("invoices")
      : el(
          "table",
          { "data-invoices": "true" },
          el(
            "thead",
            {},
            el("tr", {}, el("th", {}, text("Invoice")), el("th", {}, text("Amount")), el("th", {}, text("State")), el("th", {}, text("Issued")), el("th", {}, text("Reconciled"))),
          ),
          el(
            "tbody",
            {},
            ...detail.invoices.map((invoice) =>
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
    el(
      "p",
      { class: "muted" },
      text("Payment, order, delivery and billable finality are separate states; this page shows commerce only."),
    ),
    el(
      "form",
      { method: "post", action: "/flows/record-payment", "data-flow": "record-payment" },
      el("label", {}, text("Order id ")),
      el("input", { type: "text", name: "orderId", required: true }),
      el("label", {}, text(" Amount (minor units) ")),
      el("input", { type: "number", name: "amountMinor", min: 1, required: true }),
      el("label", {}, text(" Currency ")),
      el("input", { type: "text", name: "currency", value: "USD", required: true }),
      el("button", { type: "submit" }, text("Record payment")),
    ),
    el(
      "form",
      { method: "post", action: "/flows/cancel-order", "data-flow": "cancel-order" },
      el("label", {}, text("Order id ")),
      el("input", { type: "text", name: "orderId", required: true }),
      el("button", { type: "submit" }, text("Cancel order")),
    ),
  );
}
