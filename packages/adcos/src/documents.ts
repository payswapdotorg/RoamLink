/**
 * ADCOS v2 response document types (RL-030).
 *
 * The verified v2 facts pin the pagination envelope (next_cursor), the
 * contract state machine, the execution statuses, the webhook event envelope
 * and the error taxonomy - but NOT the per-resource response field layouts.
 * Modeling guessed layouts would violate "do not invent fields", so each
 * route family gets a NOMINAL opaque document type instead: parsed JSON
 * objects fit structurally, while responses of different routes are not
 * assignable to each other (the brand discriminates).
 *
 * RL-031+ (client implementation) and RL-036 (compatibility suite) will pin
 * concrete field schemas additively; until then nothing in RoamLink may
 * depend on response field layouts.
 */
declare const adcosDocumentTag: unique symbol;

/** A route-specific opaque v2 resource document. */
export type AdcosOpaqueDocument<K extends string> = Readonly<Record<string, unknown>> & {
  readonly [adcosDocumentTag]?: K;
};

/** GET application (application_self). */
export type AdcosApplicationDocument = AdcosOpaqueDocument<"adcos.application">;
/** POST/GET intents. */
export type AdcosIntentDocument = AdcosOpaqueDocument<"adcos.intent">;
/** GET intents/{id}/lifecycle. */
export type AdcosIntentLifecycleDocument = AdcosOpaqueDocument<"adcos.intent.lifecycle">;
/** Contracts (accepted-offer results), their lifecycle/usage/assurance reads. */
export type AdcosContractDocument = AdcosOpaqueDocument<"adcos.contract">;
export type AdcosContractUsageDocument = AdcosOpaqueDocument<"adcos.contract.usage">;
export type AdcosContractAssuranceDocument = AdcosOpaqueDocument<"adcos.contract.assurance">;
/** Leases (grant/renew/revoke lifecycle). */
export type AdcosLeaseDocument = AdcosOpaqueDocument<"adcos.lease">;
/** Webhook endpoints and their delivery records. */
export type AdcosWebhookEndpointDocument = AdcosOpaqueDocument<"adcos.webhook_endpoint">;
export type AdcosWebhookDeliveryDocument = AdcosOpaqueDocument<"adcos.webhook_endpoint.delivery">;
