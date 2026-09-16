/**
 * @roamlink/edge-actions - the device action adapter (RL-043, Wave 3).
 *
 * Layer C (RoamLink Edge): the action-execution half of the RL-040 edge
 * capability contract, behind stable seams:
 *
 *  - the pure, capability-gated admission (`admitDeviceAction`) - every
 *    executed OR queued action passes the evidence-based gate first;
 *    unsupported capability/platform combos degrade to typed, diagnosable
 *    states, and absent evidence fails closed (RL-LOCK-011);
 *  - the {@link PlatformActionExecutor} seam - the stable adapter boundary
 *    platform implementations hang behind, with an in-memory fake for
 *    tests/local dev (RL-LOCK-013 - no platform type leaks);
 *  - the {@link DeviceActionAdapter} - the desired-state loop driver: policy
 *    evaluation from the privacy-classified local context (deferred, never
 *    silently dropped, restricted data consent-gated), admission, execution
 *    with platform-evidence discipline, encrypted-outbox queueing with
 *    dedupe/replay safety, and authoritative-result projection updates
 *    (RL-LOCK-014/015, spec/mobile.md "Edge desired-state loop");
 *  - the {@link DeviceActionProjectionStore} local read model with honest
 *    sync-boundary states (server acceptance is never physical success).
 *
 * Depends on @roamlink/contracts, @roamlink/edge (the capability gate,
 * action contracts and offline outbox) and the domain-experience
 * DeviceCapabilitySnapshot closed vocabulary the gate is keyed against. No
 * ADCOS imports, no provider SDKs, no AI in the action path (RL-LOCK-006/012).
 */
export * from "./version.js";
export * from "./vocabulary-alignment.js";
export * from "./platform-executor.js";
export * from "./in-memory-executor.js";
export * from "./admission.js";
export * from "./policy.js";
export * from "./projection.js";
export * from "./action-adapter.js";
