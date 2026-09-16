/**
 * @roamlink/domain-experience - the Experience domain (RL-010 device
 * registry + RL-011 ExperienceIntent).
 *
 * Device aggregate (lifecycle + ownership + platform metadata), immutable
 * evidence-tagged DeviceCapabilitySnapshot with the closed 11-name
 * capability vocabulary (spec/architecture.md §7), privacy-classified
 * minimized DeviceContextSnapshot with consent-gated fine location,
 * ExperienceIntent with immutable versions linked by a supersession chain
 * and a validated state machine, the preference sub-model (access classes
 * are PREFERENCES ONLY), tenant-scoped repository ports + in-memory
 * adapters (fail-closed cross-tenant, CAS, chain continuity), the
 * envelope-gated registry + intent services, and (RL-013, Wave 2) the
 * explainable ExperienceDecision read model - immutable, freshness/evidence
 * weighted, derived-status-only (references authoritative state, never
 * replaces it).
 *
 * No ADCOS type is imported or modeled (RL-LOCK-007); intent compilation to
 * ADCOS ConnectivityIntent is RL-012 (Wave 2) and lives outside this
 * package. Depends ONLY on @roamlink/contracts (RL-LOCK-019).
 */
export * from "./version.js";
export * from "./capability/device-capability-name.js";
export * from "./capability/device-capability-snapshot.js";
export * from "./device/platform.js";
export * from "./device/device.js";
export * from "./device/device-context-snapshot.js";
export * from "./intent/access-class.js";
export * from "./intent/preference-profile.js";
export * from "./intent/rationale.js";
export * from "./intent/intent-payload.js";
export * from "./intent/experience-intent.js";
export * from "./idempotency.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./device-registry-service.js";
export * from "./experience-intent-service.js";
// RL-013 (Wave 2): the explainable decision read model - additive module.
export * from "./decision/derived-status.js";
export * from "./decision/evidence-weight.js";
export * from "./decision/experience-decision.js";
