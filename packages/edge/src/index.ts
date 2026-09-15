/**
 * @roamlink/edge - the edge capability contract package (RL-040).
 *
 * Layer C (RoamLink Edge) CONTRACTS ONLY: the closed capability vocabulary
 * with platform scope + evidence requirements, the immutable versioned
 * capability snapshot, the pure evidence-based capability gate
 * (`assertCapability`), device action request/result contracts, and the
 * local desired-state + encrypted-outbox record shapes. No platform
 * adapters (RL-043), no sync engine (RL-042), no AI in the action path
 * (RL-LOCK-012), no hidden ADCOS authority or provider credentials
 * (spec/architecture.md Layer C).
 *
 * Depends ONLY on @roamlink/contracts (Wave-0 foundation).
 */
export * from "./ids.js";
export * from "./version.js";
export * from "./capability/capability-name.js";
export * from "./capability/evidence.js";
export * from "./capability/capability-model.js";
export * from "./capability/capability-snapshot.js";
export * from "./capability/capability-gating.js";
export * from "./action/device-action.js";
export * from "./sync/desired-state.js";
export * from "./sync/outbox.js";
