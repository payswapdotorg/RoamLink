/**
 * The ADCOS v2 public route table (RL-030).
 *
 * The COMPLETE, closed set of v2 public routes (method + path template +
 * operation + mutation flag). Every POST is a mutation and requires the
 * `X-ADCOS-Idempotency-Key` header (see ./headers.ts).
 *
 * Operation names `application_self`, `intent_create`, `offers_accept`,
 * `contract_activate` and `lease_grant` are the v2-documented names; the
 * remaining operation identifiers follow the same
 * `<resource>_<action>` pattern (flagged for TL confirmation in the RL-030
 * report - harmless to adjust, no behavior depends on the exact strings
 * yet).
 *
 * CRITICAL v2 reality: the public surface exposes CONTRACTS and LEASES
 * (accepted-offer results) plus intents, webhook endpoints and deliveries.
 * There is NO session or NetworkPath resource type in the public API -
 * a conformance test asserts none is introduced here (RL-LOCK-004/005).
 */
import { ValidationError } from "@roamlink/contracts";

export const ADCOS_OPERATIONS = [
  "application_self",
  "intent_create",
  "intent_list",
  "intent_get",
  "intent_lifecycle_get",
  "offers_accept",
  "contract_activate",
  "contract_list",
  "contract_get",
  "contract_usage_get",
  "contract_assurance_get",
  "contract_terminate",
  "lease_grant",
  "lease_list",
  "lease_get",
  "lease_renew",
  "lease_revoke",
  "webhook_endpoint_list",
  "webhook_endpoint_create",
  "webhook_endpoint_get",
  "webhook_endpoint_deliveries_list",
] as const;

export type AdcosOperation = (typeof ADCOS_OPERATIONS)[number];

export interface AdcosRoute {
  readonly method: "GET" | "POST";
  /** Path template, e.g. "intents/{id}" - no leading slash. */
  readonly path: string;
  readonly operation: AdcosOperation;
  /** True for every mutation (all and only POST routes). */
  readonly mutation: boolean;
}

/** The closed v2 route table (21 routes). */
export const ADCOS_ROUTES: readonly AdcosRoute[] = Object.freeze([
  { method: "GET", path: "application", operation: "application_self", mutation: false },
  { method: "POST", path: "intents", operation: "intent_create", mutation: true },
  { method: "GET", path: "intents", operation: "intent_list", mutation: false },
  { method: "GET", path: "intents/{id}", operation: "intent_get", mutation: false },
  { method: "GET", path: "intents/{id}/lifecycle", operation: "intent_lifecycle_get", mutation: false },
  { method: "POST", path: "intents/{id}/offers", operation: "offers_accept", mutation: true },
  { method: "POST", path: "intents/{id}/activation", operation: "contract_activate", mutation: true },
  { method: "GET", path: "contracts", operation: "contract_list", mutation: false },
  { method: "GET", path: "contracts/{id}", operation: "contract_get", mutation: false },
  { method: "GET", path: "contracts/{id}/usage", operation: "contract_usage_get", mutation: false },
  { method: "GET", path: "contracts/{id}/assurance", operation: "contract_assurance_get", mutation: false },
  { method: "POST", path: "contracts/{id}/termination", operation: "contract_terminate", mutation: true },
  { method: "POST", path: "contracts/{id}/leases", operation: "lease_grant", mutation: true },
  { method: "GET", path: "leases", operation: "lease_list", mutation: false },
  { method: "GET", path: "leases/{id}", operation: "lease_get", mutation: false },
  { method: "POST", path: "leases/{id}/renewal", operation: "lease_renew", mutation: true },
  { method: "POST", path: "leases/{id}/revocation", operation: "lease_revoke", mutation: true },
  { method: "GET", path: "webhook-endpoints", operation: "webhook_endpoint_list", mutation: false },
  { method: "POST", path: "webhook-endpoints", operation: "webhook_endpoint_create", mutation: true },
  { method: "GET", path: "webhook-endpoints/{id}", operation: "webhook_endpoint_get", mutation: false },
  {
    method: "GET",
    path: "webhook-endpoints/{id}/deliveries",
    operation: "webhook_endpoint_deliveries_list",
    mutation: false,
  },
]);

export function isAdcosOperation(value: unknown): value is AdcosOperation {
  return typeof value === "string" && (ADCOS_OPERATIONS as readonly string[]).includes(value);
}

/** Parses an operation; anything outside the closed set is rejected. */
export function parseAdcosOperation(value: unknown): AdcosOperation {
  if (!isAdcosOperation(value)) {
    throw new ValidationError("AdcosOperation must be a member of the closed v2 route table", {
      reason: "ADCOS_OPERATION_INVALID",
      details: [{ path: "AdcosOperation", issue: "outside the closed vocabulary" }],
    });
  }
  return value;
}

/** The route for an operation, if it exists. */
export function adcosRouteForOperation(operation: AdcosOperation): AdcosRoute {
  const route = ADCOS_ROUTES.find((candidate) => candidate.operation === operation);
  if (route === undefined) {
    throw new ValidationError("AdcosOperation must be a member of the closed v2 route table", {
      reason: "ADCOS_OPERATION_INVALID",
      details: [{ path: "AdcosOperation", issue: "no route declares this operation" }],
    });
  }
  return route;
}

/** True when the operation is a mutation (requires the idempotency key). */
export function isAdcosMutationOperation(operation: AdcosOperation): boolean {
  return adcosRouteForOperation(operation).mutation;
}
