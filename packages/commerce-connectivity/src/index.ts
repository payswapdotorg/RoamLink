/**
 * @roamlink/commerce-connectivity - the commerce-to-connectivity reference
 * model (RL-023, Wave 3 Worker A).
 *
 * The explicit, evidence-carrying reference layer between commercial
 * subjects (Orders / Subscriptions) and ADCOS-derived projections: an order
 * does NOT imply delivery (RL-LOCK-008), and the ONLY sanctioned way the
 * commerce surface reads connectivity status is through this model, which
 * exposes the subject's own commercial state PLUS the linked delivery
 * evidence with first-class freshness (observedAt / receivedAt /
 * freshUntil / FRESH | STALE | UNKNOWN - RL-LOCK-010). It never invents a
 * combined opaque status; `delivery_evidence_state` is its own closed
 * vocabulary, never merged with order/payment/subscription/ADCOS state
 * (spec/data-model.md "State separation").
 *
 * The model is READ-ONLY towards both sides: it consumes ADCOS-derived
 * observations through the DeliveryEvidenceSource port (bound at the
 * composition layer to the integration boundary's exposed get/list/count
 * projection reader - never here, RL-LOCK-002; it never writes projections
 * and never commands ADCOS, RL-LOCK-005) and consumes domain-commerce's
 * committed read views through the CommercialSubjectReader port (never
 * writes commerce state). Commands are §5-envelope-gated, idempotent
 * (reusing the domain-commerce ledger semantics) and CAS-aware; every
 * transition appends a chain-sequenced immutable event retaining the full
 * observation history.
 *
 * Depends on @roamlink/contracts + @roamlink/persistence (Wave-0) and
 * @roamlink/domain-commerce (subject facts + idempotency ledger).
 */
export * from "./version.js";
export * from "./ids.js";
export * from "./delivery-evidence.js";
export * from "./reference.js";
export * from "./evidence-source.js";
export * from "./events.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./adapters.js";
export * from "./read-model.js";
export * from "./reference-service.js";
