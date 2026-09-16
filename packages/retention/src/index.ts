/**
 * @roamlink/retention - data retention/privacy enforcement (RL-054, Wave 3).
 *
 * The enforcement layer for spec/data-model.md "Privacy" (device telemetry is
 * minimized; location, network identifiers, diagnostics and usage data have
 * explicit purpose/retention classifications; secrets and credentials are
 * never persisted in ordinary domain tables) and spec/mobile.md "Device
 * privacy" (collection is purpose-limited, configurable and minimized;
 * location and network identifiers receive stricter retention and access
 * controls):
 *
 *  - purpose/retention classifications as first-class CLOSED vocabularies
 *    (classification.ts) and a validated policy whose location and
 *    network-identifier rules are STRUCTURALLY stricter (shorter windows,
 *    explicit consent) - a lax policy cannot even be constructed;
 *  - the RL-LOCK-016 enforcement point: `assertNoSecretMaterial` /
 *    `scanForSecretMaterial` - testable against ANY package's persisted
 *    payloads;
 *  - classified records with purpose limitation, consent gating,
 *    minimization byte bounds and policy-computed expiry (record.ts);
 *  - the enforcement engine: admission, bounded expiry sweeps, tombstone /
 *    hard-delete erasure semantics, explicit erasure and audited access
 *    control, every decision appended to the append-only audit trail
 *    atomically with its record effect (engine.ts + audit.ts);
 *  - persistence-backed stores over the RL-003 primitives (units of work,
 *    optimistic concurrency, insert-only audit rows).
 *
 * Depends on @roamlink/contracts and @roamlink/persistence only.
 */
export * from "./version.js";
export * from "./classification.js";
export * from "./secret-scan.js";
export * from "./policy.js";
export * from "./record.js";
export * from "./audit.js";
export * from "./store.js";
export * from "./engine.js";
