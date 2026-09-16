/**
 * The AdcosClient implementation (RL-031/RL-032, packages/adcos/src/client.ts
 * seam: "RL-031+ implements this interface (HTTP transport, mapping,
 * retries)").
 *
 * Routing comes from the CLOSED v2 route table in @roamlink/adcos (single
 * source of truth - this module cannot invent, extend or reorder routes,
 * RL-LOCK-002). Request bodies are validated by the boundary's own closed
 * parsers before dispatch; responses are validated against the pinned v2
 * response facts (JSON documents; the `next_cursor` page envelope) and fail
 * closed with `version-unsupported` when a response violates the pinned
 * contract (spec/security.md "Fail-safe defaults").
 *
 * Every mutation sends canonical JSON bytes (deterministic serialization:
 * same inputs -> same bytes) and REQUIRES the idempotency key (RL-LOCK-014).
 */
import {
  ValidationError,
  canonicalizeJson,
  type CanonicalJsonValue,
} from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  AdcosApiError,
  type AdcosClient,
  type AdcosListQuery,
  type AdcosMutationContext,
} from "@roamlink/adcos";
import { parseAdcosListQuery } from "@roamlink/adcos";
import type {
  AdcosApplicationDocument,
  AdcosContractAssuranceDocument,
  AdcosContractDocument,
  AdcosContractUsageDocument,
  AdcosIntentDocument,
  AdcosIntentLifecycleDocument,
  AdcosLeaseDocument,
  AdcosPage,
  AdcosWebhookDeliveryDocument,
  AdcosWebhookEndpointDocument,
} from "@roamlink/adcos";
import type {
  AdcosActivationRequest,
  AdcosIntentRequest,
  AdcosLeaseRenewal,
  AdcosLeaseRequest,
  AdcosLeaseRevocation,
  AdcosOfferSelection,
  AdcosTerminationRequest,
  AdcosWebhookEndpointRequest,
} from "@roamlink/adcos";
import {
  parseAdcosActivationRequest,
  parseAdcosIntentRequest,
  parseAdcosLeaseRenewal,
  parseAdcosLeaseRequest,
  parseAdcosLeaseRevocation,
  parseAdcosOfferSelection,
  parseAdcosTerminationRequest,
  parseAdcosWebhookEndpointRequest,
} from "@roamlink/adcos";
import { parseAdcosContractRef, parseAdcosIntentRef, parseAdcosLeaseRef, parseAdcosResourceId } from "@roamlink/contracts";
import type {
  AdcosContractRef,
  AdcosIntentRef,
  AdcosLeaseRef,
  AdcosResourceId,
} from "@roamlink/contracts";
import { parseAdcosEnvironment } from "@roamlink/adcos";
import type { AdcosEnvironment } from "@roamlink/adcos";
import { parseAdcosErrorBody } from "./transport.js";
import type { AdcosTransport } from "./transport.js";

// --------------------------------------------------------------------------------
// Response validation (pinned v2 response facts only)
// --------------------------------------------------------------------------------

const PAGE_ENVELOPE_FIELDS = ["next_cursor", "items"] as const;

/**
 * Validates a document response: must be a JSON object. Field layouts are NOT
 * pinned by the verified v2 facts, so nothing else may be assumed
 * ("no invented fields").
 */
export function parseAdcosDocumentResponse(body: unknown, operation: string): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdcosApiError(
      "version-unsupported",
      `ADCOS '${operation}' response violated the pinned v2 contract: expected a JSON object document (failing closed as a version incompatibility signal)`,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * Validates a page response against the pinned pagination envelope
 * (`next_cursor` + items). Item layouts stay opaque per-route.
 */
export function parseAdcosPageResponse(
  body: unknown,
  operation: string,
): AdcosPage<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdcosApiError(
      "version-unsupported",
      `ADCOS '${operation}' response violated the pinned v2 contract: expected the next_cursor page envelope (failing closed as a version incompatibility signal)`,
    );
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PAGE_ENVELOPE_FIELDS as readonly string[]).includes(key)) {
      throw new AdcosApiError(
        "version-unsupported",
        `ADCOS '${operation}' response violated the pinned v2 contract: the page envelope carries unknown members (failing closed as a version incompatibility signal)`,
      );
    }
  }
  const nextCursor = record["next_cursor"];
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new AdcosApiError(
      "version-unsupported",
      `ADCOS '${operation}' response violated the pinned v2 contract: next_cursor must be a string or null (failing closed as a version incompatibility signal)`,
    );
  }
  const items = record["items"];
  if (!Array.isArray(items)) {
    throw new AdcosApiError(
      "version-unsupported",
      `ADCOS '${operation}' response violated the pinned v2 contract: items must be a list of documents (failing closed as a version incompatibility signal)`,
    );
  }
  const parsedItems: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdcosApiError(
        "version-unsupported",
        `ADCOS '${operation}' response violated the pinned v2 contract: every page item must be a JSON object document (failing closed as a version incompatibility signal)`,
      );
    }
    parsedItems.push(item as Record<string, unknown>);
  }
  return Object.freeze({ next_cursor: nextCursor, items: Object.freeze(parsedItems) });
}

// --------------------------------------------------------------------------------
// Wire helpers
// --------------------------------------------------------------------------------

function flattenQuery(query: AdcosListQuery | undefined): Record<string, string> | undefined {
  const validated = parseAdcosListQuery(query);
  const params: Record<string, string> = {};
  if (validated.limit !== undefined) {
    params["limit"] = String(validated.limit);
  }
  if (validated.cursor !== undefined) {
    params["cursor"] = validated.cursor;
  }
  if (validated.filters !== undefined) {
    for (const [key, value] of Object.entries(validated.filters)) {
      params[`filter.${key}`] = value;
    }
  }
  return Object.keys(params).length === 0 ? undefined : params;
}

function canonicalBody(value: CanonicalJsonValue): string {
  return canonicalizeJson(value);
}

function pathParam(value: string, label: string): string {
  // foreign-ref shaped path parameters only (no path traversal, no injection)
  if (typeof value !== "string" || value.length === 0 || value.includes("/")) {
    throw new ValidationError(`${label} must be a non-empty ADCOS resource reference without path separators`, {
      reason: "ADCOS_PATH_PARAM_INVALID",
      details: [{ path: label, issue: "not a safe route parameter" }],
    });
  }
  return value;
}

function requireMutationContext(mutation: AdcosMutationContext | undefined, operation: string): AdcosMutationContext {
  if (mutation === null || mutation === undefined || typeof mutation !== "object") {
    throw new AdcosApiError(
      "idempotency-key-required",
      `ADCOS '${operation}' is a mutation: an AdcosMutationContext with an idempotency key is required (RL-LOCK-014)`,
    );
  }
  if (typeof mutation.idempotencyKey !== "string" || mutation.idempotencyKey.length === 0) {
    throw new AdcosApiError(
      "idempotency-key-required",
      `ADCOS '${operation}' is a mutation: the idempotency key must be a non-empty string (RL-LOCK-014)`,
    );
  }
  return mutation;
}

// --------------------------------------------------------------------------------
// The client
// --------------------------------------------------------------------------------

export interface CreateAdcosClientOptions {
  /** The transport performing the wire I/O. */
  readonly transport: AdcosTransport;
  /**
   * The environment this client is scoped to. Observed environment values
   * (webhook envelopes, verifier inputs) are checked against it and fail
   * closed on mismatch.
   */
  readonly environment: AdcosEnvironment;
}

/** Creates an AdcosClient bound to one transport + environment. */
export function createAdcosClient(options: CreateAdcosClientOptions): AdcosClient {
  const environment = parseAdcosEnvironment(options.environment);
  const transport = options.transport;

  async function getDocument(operation: string, path: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await transport.request({
      method: "GET",
      path,
      ...(query !== undefined ? { query } : {}),
      mutation: false,
    });
    return parseAdcosDocumentResponse(interpretResponse(operation, response), operation);
  }

  async function getPage(
    operation: string,
    path: string,
    query?: AdcosListQuery,
  ): Promise<AdcosPage<Record<string, unknown>>> {
    const flattened = flattenQuery(query);
    const response = await transport.request({
      method: "GET",
      path,
      ...(flattened !== undefined ? { query: flattened } : {}),
      mutation: false,
    });
    return parseAdcosPageResponse(interpretResponse(operation, response), operation);
  }

  async function postMutation<TReturn>(
    operation: string,
    path: string,
    body: CanonicalJsonValue,
    mutation: AdcosMutationContext | undefined,
    validate: (raw: Record<string, unknown>) => TReturn,
  ): Promise<TReturn> {
    const context = requireMutationContext(mutation, operation);
    const response = await transport.request({
      method: "POST",
      path,
      body: canonicalBody(body),
      mutation: true,
      idempotencyKey: context.idempotencyKey,
    });
    return validate(parseAdcosDocumentResponse(interpretResponse(operation, response), operation));
  }

  /**
   * Classifies a transport response: 2xx passes through; every other status
   * is an ADCOS error response parsed against the closed taxonomy (the
   * single classification site - transports return raw parsed responses).
   */
  function interpretResponse(
    operation: string,
    response: { readonly status: number; readonly body: unknown },
  ): unknown {
    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }
    throw parseAdcosErrorBody(response.status, response.body);
  }

  const asIntentDocument = (raw: Record<string, unknown>): AdcosIntentDocument => raw as AdcosIntentDocument;
  const asContractDocument = (raw: Record<string, unknown>): AdcosContractDocument => raw as AdcosContractDocument;
  const asLeaseDocument = (raw: Record<string, unknown>): AdcosLeaseDocument => raw as AdcosLeaseDocument;

  return {
    environment,
    apiVersion: ADCOS_API_VERSION,

    async getApplication(): Promise<AdcosApplicationDocument> {
      return (await getDocument("application_self", "application")) as AdcosApplicationDocument;
    },

    async createIntent(
      request: AdcosIntentRequest,
      mutation: AdcosMutationContext,
    ): Promise<AdcosIntentDocument> {
      // Validate through the boundary's closed schema BEFORE any I/O.
      const validated = parseAdcosIntentRequest(request);
      return postMutation("intent_create", "intents", validated as unknown as CanonicalJsonValue, mutation, asIntentDocument);
    },

    async listIntents(query?: AdcosListQuery): Promise<AdcosPage<AdcosIntentDocument>> {
      const page = await getPage("intent_list", "intents", query);
      return { next_cursor: page.next_cursor, items: Object.freeze([...page.items]) } as AdcosPage<AdcosIntentDocument>;
    },

    async getIntent(intentId: AdcosIntentRef): Promise<AdcosIntentDocument> {
      const id = pathParam(parseAdcosIntentRef(intentId), "intentId");
      return asIntentDocument(await getDocument("intent_get", `intents/${id}`));
    },

    async getIntentLifecycle(intentId: AdcosIntentRef): Promise<AdcosIntentLifecycleDocument> {
      const id = pathParam(parseAdcosIntentRef(intentId), "intentId");
      return (await getDocument("intent_lifecycle_get", `intents/${id}/lifecycle`)) as AdcosIntentLifecycleDocument;
    },

    async acceptOffers(
      intentId: AdcosIntentRef,
      request: AdcosOfferSelection,
      mutation: AdcosMutationContext,
    ): Promise<AdcosContractDocument> {
      const id = pathParam(parseAdcosIntentRef(intentId), "intentId");
      const validated = parseAdcosOfferSelection(request);
      return postMutation(
        "offers_accept",
        `intents/${id}/offers`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asContractDocument,
      );
    },

    async activateContract(
      intentId: AdcosIntentRef,
      request: AdcosActivationRequest,
      mutation: AdcosMutationContext,
    ): Promise<AdcosContractDocument> {
      const id = pathParam(parseAdcosIntentRef(intentId), "intentId");
      const validated = parseAdcosActivationRequest(request);
      return postMutation(
        "contract_activate",
        `intents/${id}/activation`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asContractDocument,
      );
    },

    async listContracts(query?: AdcosListQuery): Promise<AdcosPage<AdcosContractDocument>> {
      const page = await getPage("contract_list", "contracts", query);
      return { next_cursor: page.next_cursor, items: Object.freeze([...page.items]) } as AdcosPage<AdcosContractDocument>;
    },

    async getContract(contractId: AdcosContractRef): Promise<AdcosContractDocument> {
      const id = pathParam(parseAdcosContractRef(contractId), "contractId");
      return asContractDocument(await getDocument("contract_get", `contracts/${id}`));
    },

    async getContractUsage(contractId: AdcosContractRef): Promise<AdcosContractUsageDocument> {
      const id = pathParam(parseAdcosContractRef(contractId), "contractId");
      return (await getDocument("contract_usage_get", `contracts/${id}/usage`)) as AdcosContractUsageDocument;
    },

    async getContractAssurance(contractId: AdcosContractRef): Promise<AdcosContractAssuranceDocument> {
      const id = pathParam(parseAdcosContractRef(contractId), "contractId");
      return (await getDocument("contract_assurance_get", `contracts/${id}/assurance`)) as AdcosContractAssuranceDocument;
    },

    async terminateContract(
      contractId: AdcosContractRef,
      request: AdcosTerminationRequest,
      mutation: AdcosMutationContext,
    ): Promise<AdcosContractDocument> {
      const id = pathParam(parseAdcosContractRef(contractId), "contractId");
      const validated = parseAdcosTerminationRequest(request);
      return postMutation(
        "contract_terminate",
        `contracts/${id}/termination`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asContractDocument,
      );
    },

    async grantLease(
      contractId: AdcosContractRef,
      request: AdcosLeaseRequest,
      mutation: AdcosMutationContext,
    ): Promise<AdcosLeaseDocument> {
      const id = pathParam(parseAdcosContractRef(contractId), "contractId");
      const validated = parseAdcosLeaseRequest(request);
      return postMutation(
        "lease_grant",
        `contracts/${id}/leases`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asLeaseDocument,
      );
    },

    async listLeases(query?: AdcosListQuery): Promise<AdcosPage<AdcosLeaseDocument>> {
      const page = await getPage("lease_list", "leases", query);
      return { next_cursor: page.next_cursor, items: Object.freeze([...page.items]) } as AdcosPage<AdcosLeaseDocument>;
    },

    async getLease(leaseId: AdcosLeaseRef): Promise<AdcosLeaseDocument> {
      const id = pathParam(parseAdcosLeaseRef(leaseId), "leaseId");
      return asLeaseDocument(await getDocument("lease_get", `leases/${id}`));
    },

    async renewLease(
      leaseId: AdcosLeaseRef,
      request: AdcosLeaseRenewal,
      mutation: AdcosMutationContext,
    ): Promise<AdcosLeaseDocument> {
      const id = pathParam(parseAdcosLeaseRef(leaseId), "leaseId");
      const validated = parseAdcosLeaseRenewal(request);
      return postMutation(
        "lease_renew",
        `leases/${id}/renewal`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asLeaseDocument,
      );
    },

    async revokeLease(
      leaseId: AdcosLeaseRef,
      request: AdcosLeaseRevocation,
      mutation: AdcosMutationContext,
    ): Promise<AdcosLeaseDocument> {
      const id = pathParam(parseAdcosLeaseRef(leaseId), "leaseId");
      const validated = parseAdcosLeaseRevocation(request);
      return postMutation(
        "lease_revoke",
        `leases/${id}/revocation`,
        validated as unknown as CanonicalJsonValue,
        mutation,
        asLeaseDocument,
      );
    },

    async listWebhookEndpoints(query?: AdcosListQuery): Promise<AdcosPage<AdcosWebhookEndpointDocument>> {
      const page = await getPage("webhook_endpoint_list", "webhook-endpoints", query);
      return { next_cursor: page.next_cursor, items: Object.freeze([...page.items]) } as AdcosPage<AdcosWebhookEndpointDocument>;
    },

    async createWebhookEndpoint(
      request: AdcosWebhookEndpointRequest,
      mutation: AdcosMutationContext,
    ): Promise<AdcosWebhookEndpointDocument> {
      const validated = parseAdcosWebhookEndpointRequest(request);
      return postMutation(
        "webhook_endpoint_create",
        "webhook-endpoints",
        validated as unknown as CanonicalJsonValue,
        mutation,
        (raw) => raw as AdcosWebhookEndpointDocument,
      );
    },

    async getWebhookEndpoint(endpointId: AdcosResourceId): Promise<AdcosWebhookEndpointDocument> {
      const id = pathParam(parseAdcosResourceId(endpointId), "endpointId");
      return (await getDocument("webhook_endpoint_get", `webhook-endpoints/${id}`)) as AdcosWebhookEndpointDocument;
    },

    async listWebhookEndpointDeliveries(
      endpointId: AdcosResourceId,
      query?: AdcosListQuery,
    ): Promise<AdcosPage<AdcosWebhookDeliveryDocument>> {
      const id = pathParam(parseAdcosResourceId(endpointId), "endpointId");
      const page = await getPage("webhook_endpoint_deliveries_list", `webhook-endpoints/${id}/deliveries`, query);
      return { next_cursor: page.next_cursor, items: Object.freeze([...page.items]) } as AdcosPage<AdcosWebhookDeliveryDocument>;
    },
  } satisfies AdcosClient;
}
