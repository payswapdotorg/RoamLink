/**
 * @roamlink/domain-commerce - the Commerce domain (RL-020 + RL-021, Wave 2).
 *
 * Customer-facing commercial packaging for offerable connectivity
 * experiences: the catalog (Product/ProductVariant with a tenant-scoped
 * catalog read model) and the order/subscription lifecycle (Order +
 * immutable OrderLine snapshots; Subscription with explicit typed
 * transitions and supersession of subscription changes), with append-only
 * event-sourced transitions, idempotent envelope-gated commands and
 * compare-and-swap optimistic concurrency over the Wave-0 persistence
 * primitives.
 *
 * AUTHORITY BOUNDARY (RL-LOCK-008 "payment is not delivery"): commerce
 * records express COMMERCIAL INTENT ONLY. No reservation, session, path,
 * usage or settlement state lives here; an order never implies delivery and
 * a subscription never authorizes connectivity (ADCOS owns connectivity,
 * RL-LOCK-001/005). Payments/invoices/refunds are RL-022 and the
 * commerce-to-connectivity reference model is RL-023 (both Wave 3).
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
export * from "./events.js";
export * from "./idempotency.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./catalog.js";
export * from "./commerce-service.js";
