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
 * The model is READ-ONLY towards both sides: it consumes the RL-034
 * projection read surface through the DeliveryEvidenceSource port (never
 * writes projections, never commands ADCOS - RL-LOCK-002/005) and consumes
 * domain-commerce's committed read views through the CommercialSubjectReader
 * port (never writes commerce state). Commands are §5-envelope-gated,
 * idempotent (reusing the domain-commerce ledger semantics) and CAS-aware;
 * every transition appends a chain-sequenced immutable event retaining the
 * full observation history.
 *
 * Depends on @roamlink/contracts + @roamlink/persistence (Wave-0),
 * @roamlink/domain-commerce (subject facts + idempotency ledger) and
 * @roamlink/projections (READ surface only, bound in ./adapters.ts).
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
