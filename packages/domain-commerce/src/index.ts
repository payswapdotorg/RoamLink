/**
 * @roamlink/domain-commerce - the Commerce domain (RL-020 + RL-021 + RL-022).
 *
 * Customer-facing commercial packaging for offerable connectivity
 * experiences: the catalog (Product/ProductVariant with a tenant-scoped
 * catalog read model), the order/subscription lifecycle (Order +
 * immutable OrderLine snapshots; Subscription with explicit typed
 * transitions and supersession of subscription changes), and the
 * customer-facing money lifecycle (CustomerPayment, CustomerInvoice with
 * proven reconciliation, CustomerRefund with typed reason codes - each with
 * its OWN closed state vocabulary, integer-minor-unit money and append-only
 * event-sourced transitions), with idempotent envelope-gated commands and
 * compare-and-swap optimistic concurrency over the Wave-0 persistence
 * primitives.
 *
 * AUTHORITY BOUNDARY (RL-LOCK-008 "payment is not delivery"): commerce
 * records express COMMERCIAL INTENT and MONEY FACTS ONLY. No reservation,
 * session, path, usage, delivery or settlement state lives here; a payment
 * is never a delivery claim and an order never implies delivery (ADCOS owns
 * connectivity, RL-LOCK-001/005). The commerce-to-connectivity reference
 * model is RL-023 (sibling package @roamlink/commerce-connectivity).
 *
 * Depends ONLY on @roamlink/contracts + @roamlink/persistence
 * (RL-LOCK-007/019): no other domain package is imported.
 */
export * from "./version.js";
export * from "./money.js";
export * from "./product.js";
export * from "./product-variant.js";
export * from "./order.js";
export * from "./subscription.js";
export * from "./payment.js";
export * from "./invoice.js";
export * from "./refund.js";
export * from "./events.js";
export * from "./idempotency.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./catalog.js";
export * from "./commerce-service.js";
export * from "./payment-service.js";
