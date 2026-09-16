/**
 * @roamlink/projections - the ADCOS projection engine (RL-034).
 *
 * Canonical-resource projections with the exact record shape from
 * spec/adcos-integration.md §8 (projection_id, source_authority,
 * canonical_resource_type/id, source_version/event_id, payload_digest,
 * observed_at, received_at, fresh_until, freshness_state, evidence_class,
 * projection_version) plus the projected payload itself.
 *
 * Only the integration boundary writes ADCOS-derived projections (spec §8):
 * the engine is the sole consumer of the ProjectionWriter surface. Everyone
 * else reads. Freshness degrades to STALE/UNKNOWN when canonical truth is
 * unavailable - the system never guesses (spec §7, RL-LOCK-010). ADCOS
 * remains the connectivity authority (RL-LOCK-001): payloads are opaque
 * canonical snapshots; lifecycle semantics are never redefined here.
 *
 * Depends on @roamlink/adcos PUBLIC TYPES ONLY (the webhook event contract
 * and resource kinds); no ADCOS internals (RL-LOCK-002).
 */
export * from "./projection-record.js";
export * from "./projection-store.js";
export * from "./projection-engine.js";
