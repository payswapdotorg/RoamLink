/**
 * @roamlink/mobile - the mobile/edge UX shell (RL-062, spec/mobile.md).
 *
 * The observation/experience/synchronization agent surface:
 *
 *  - `platform-probe.ts` - the host-bound platform seam (the ONLY source of
 *    platform facts) + the deterministic in-memory fake;
 *  - `enrollment.ts` - the signed/versioned/expiring capability-snapshot
 *    publication (signing key material never enters the shell);
 *  - `shell.ts` - the edge desired-state loop driver: observation cycles,
 *    policy evaluation, capability-gated actions (local execution or
 *    encrypted-outbox queueing toward the server/ADCOS integration),
 *    explicit sync + crash recovery, authoritative-result intake and the
 *    freshness-first read models;
 *  - `views.ts` - the framework-free, typed, XSS-safe screens (connectivity
 *    with ALWAYS-rendered freshness, the capability truth table with gate
 *    previews, degraded controls with observation/manual guidance, the
 *    ciphertext-only outbox view, the honest action history).
 *
 * The shell contains NO radio/network authority logic (RL-LOCK-003/004/005):
 * it composes @roamlink/edge, @roamlink/edge-actions and
 * @roamlink/edge-connector, renders through @roamlink/app-kit's typed HTML
 * core, and depends on @roamlink/contracts for the shared primitives.
 * Hosts bind the platform-specific adapters (probe, executor, cipher keys,
 * signer, sync transport); app sources never touch node builtins.
 */
export * from "./platform-probe.js";
export * from "./enrollment.js";
export * from "./shell.js";
export * from "./views.js";
