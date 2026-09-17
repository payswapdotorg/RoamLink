/**
 * @roamlink/reconciliation - the ADCOS reconciliation engine (RL-035).
 *
 * The `ReconciliationJob` orchestration of spec/adcos-integration.md §7:
 * periodically compares projection freshness against canonical ADCOS
 * resources and repairs missed webhooks, duplicate webhooks, out-of-order
 * events, stale projections, partially applied projections and transient
 * ADCOS/API failures. When canonical truth cannot be obtained, projections
 * degrade to STALE/UNKNOWN - the system never guesses (RL-LOCK-010).
 *
 * Authority: ADCOS remains the connectivity authority (RL-LOCK-001); the
 * reconciler READS canonical resources and repairs RoamLink-side
 * projections; it never mutates ADCOS and never redefines lifecycle
 * semantics. Only the reconciler/integration boundary writes ADCOS-derived
 * projections (spec §8): the boundary factory captures the projection
 * writer capability and hands it only to the Wave-2 projection engine.
 *
 * Durability: jobs are §5-envelope-carrying records on the Wave-1
 * persistence primitives (optimistic concurrency); every repair effect is
 * idempotent, so crash + re-run converges (RL-LOCK-014).
 */
export * from "./job-record.js";
export * from "./policy.js";
export * from "./resource-discovery.js";
export * from "./job-store.js";
export * from "./projector.js";
export * from "./engine.js";
export * from "./boundary.js";
export * from "./scheduler.js";
export * from "./slo-emission.js";
