/**
 * @roamlink/webhook-inbox - the durable ADCOS webhook inbox (RL-033).
 *
 * Inbound ADCOS webhook events are processed as
 * `receive -> authenticate -> replay check -> persist immutable inbox record
 * -> acknowledge -> async project` (spec/adcos-integration.md §6), built on
 * the persistence primitives from @roamlink/persistence (RL-003) and the
 * WebhookVerifier seam from @roamlink/adcos (RL-030).
 *
 * Webhooks are SIGNALS, not truth (RL-LOCK-009): admission never asserts
 * physical delivery; the projection/reconciliation layers (RL-034/RL-035)
 * decide what the signal means against canonical ADCOS state.
 */
export * from "./verifier.js";
export * from "./inbox.js";
