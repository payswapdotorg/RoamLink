/**
 * @roamlink/notifications - the notifications/support domain (RL-014, Wave
 * 3 Worker A).
 *
 * Durable notifications, notification preferences/channels as typed
 * contracts, support cases with a structural customer/internal visibility
 * boundary, and event correlation (tickets <-> orders / subscriptions /
 * payments / invoices / refunds / connectivity references), plus the
 * /v1/notifications API resource shapes.
 *
 * RL-LOCK-009 ("webhooks are signals, not truth"): notifications are
 * emitted ONLY from RoamLink's OWN durable state transitions. The
 * TransitionOrigin contract enforces this structurally - a closed
 * single-member origin vocabulary ("roamlink_state_transition"), a closed
 * RoamLink aggregate-type vocabulary and a REQUIRED durable event id
 * (the persisted-transition receipt). A raw ADCOS payload has no shape
 * that can pass it.
 *
 * Depends ONLY on @roamlink/contracts + @roamlink/persistence
 * (RL-LOCK-007/019): commerce/connectivity references enter as TYPED
 * related-reference values (kind + id); the composition layer resolves
 * them against the owning domains - this package imports no sibling
 * domain package.
 */
export * from "./version.js";
export * from "./ids.js";
export * from "./notification.js";
export * from "./preferences.js";
export * from "./channel-delivery.js";
export * from "./support-case.js";
export * from "./events.js";
export * from "./idempotency.js";
export * from "./ports.js";
export * from "./in-memory.js";
export * from "./notification-service.js";
export * from "./notification-api.js";
