/**
 * @roamlink/integration - the ADCOS integration adapters (RL-031 + RL-032).
 *
 * Implements the CLIENT SEAM from @roamlink/adcos over a real HTTP transport
 * and builds the RoamLink-facing adapter surface on top of it:
 *
 *  - intent command mapping + submission with the full §5 idempotency
 *    metadata and retry-safe resubmission (RL-031);
 *  - the offer/reservation (contract/lease) command + read surface, strictly
 *    over the pinned v2 route table, with typed unsupported degradation for
 *    surfaces v2 does not expose (RL-032);
 *  - the §9 compatibility gate with fail-closed mutation enforcement;
 *  - the closed ADCOS->RoamLink error adaptation (no parallel kinds).
 *
 * Authority: ADCOS remains the connectivity authority (RL-LOCK-001/002);
 * this package maps, submits, and reads - it never redefines lifecycle
 * semantics. It is the only production integration boundary beside
 * @roamlink/adcos itself (ADR-0001).
 */
export * from "./transport.js";
export * from "./error-mapping.js";
export * from "./client-impl.js";
export * from "./command-context.js";
export * from "./intent-command.js";
export * from "./intent-adapter.js";
export * from "./offer-reservation-adapter.js";
export * from "./compatibility.js";
