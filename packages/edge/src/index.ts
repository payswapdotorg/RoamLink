/**
 * @roamlink/edge - the edge capability contract package (RL-040) plus the
 * RL-041 observation engine and the RL-042 encrypted offline outbox/sync
 * engine (both additive Wave-2 modules).
 *
 * Layer C (RoamLink Edge) CONTRACTS + ENGINES: the closed capability
 * vocabulary with platform scope + evidence requirements, the immutable
 * versioned capability snapshot, the pure evidence-based capability gate
 * (`assertCapability`), device action request/result contracts, the local
 * desired-state + encrypted-outbox record shapes (RL-040); the raw
 * observation contract + context snapshot + observation engine that turn
 * platform probes into evidence-tagged snapshot chain updates with the
 * closed evidence-kind->class map (RL-041, RL-LOCK-011); and the encrypted
 * offline outbox/sync engine - ciphertext-only payloads at rest, batched
 * sync with an explicit conflict policy, replay-safe redelivery and honest
 * boundary states (RL-042, RL-LOCK-015/016). No platform adapters (RL-043),
 * no AI in the action path (RL-LOCK-012), no hidden ADCOS authority or
 * provider credentials (spec/architecture.md Layer C).
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
export * from "./sync/payload-codec.js";
export * from "./sync/offline-outbox.js";
export * from "./observation/observation.js";
export * from "./observation/context-snapshot.js";
export * from "./observation/observation-engine.js";
