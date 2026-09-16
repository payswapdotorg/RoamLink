/**
 * @roamlink/intent-compiler - the ExperienceIntent compiler (RL-012, Wave 2).
 *
 * Deterministic, pure compilation of ExperienceIntent versions into
 * technology-neutral ADCOS ConnectivityIntent commands per
 * spec/adcos-integration.md §4: schema validation, policy normalization,
 * hard/soft constraint classification, privacy/service constraint mapping,
 * validity-window calculation, deterministic canonical serialization, digest
 * generation and command creation, with full source-intent traceability.
 *
 * Depends ONLY on @roamlink/contracts + @roamlink/domain-experience
 * (RL-LOCK-007/019): no ADCOS type is imported or modeled here. The ADCOS
 * v2 request mapping is the integration surface's concern (RL-031); this
 * package's structural output is that surface's documented input.
 */
export * from "./version.js";
export * from "./requirement.js";
export * from "./validate-compilation-input.js";
export * from "./policy.js";
export * from "./command.js";
export * from "./experience-intent-compiler.js";
