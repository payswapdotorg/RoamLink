/**
 * The typed enterprise API client (RL-063).
 *
 * The ONLY way integration code talks to the enterprise API surface: reads
 * return parsed, fail-closed wire resources; every mutation carries the full
 * command header set (request/correlation/idempotency ids + the presented
 * API key); server errors surface as {@link EnterpriseApiError} with the
 * taxonomy kind intact; transport failures fail closed as retryable
 * `unavailable`. The client holds NO authority: it never decides outcomes and
 * never invents state (it is the enterprise twin of the app-kit client).
 */
import {
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  ValidationError,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
} from "@roamlink/contracts";

import {
  ENTERPRISE_API_KEY_HEADER,
  enterpriseRoute,
  parseApiKeyIssuanceOrThrow,
  parseApiKeyResource,
  parseApiKeyResourceList,
  parseConnectorProvisioningResource,
  parseEnrollmentResource,
  parseEnrollmentResourceList,
  parseEnterpriseScopeList,
  parseFederationResource,
  parseFederationResourceList,
  parseManagedEdgeEnrollmentResource,
  parseManagedEdgeEnrollmentResourceList,
  parseWebhookDeliveryResourceList,
  parseWebhookEndpointIssuanceOrThrow,
  parseWebhookEndpointResource,
  parseWebhookEndpointResourceList,
  type ApiKeyIssuanceWireResource,
  type ApiKeyWireResource,
  type ConnectorProvisioningWireResource,
  type EnrollmentWireResource,
  type FederationWireResource,
  type ManagedEdgeEnrollmentWireResource,
  type WebhookDeliveryWireResource,
  type WebhookEndpointWireResource,
} from "./api-surface.js";

// ---------------------------------------------------------------------------
// Transport + errors
// ---------------------------------------------------------------------------

export type EnterpriseHttpMethod = "GET" | "POST";

export interface EnterpriseHttpRequest {
  readonly method: EnterpriseHttpMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface EnterpriseHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The injectable transport seam (fetch in production; the fake in tests). */
export interface EnterpriseHttpTransport {
  request(request: EnterpriseHttpRequest): Promise<EnterpriseHttpResponse>;
}

export const ENTERPRISE_HTTP_STATUS = Object.freeze({
  ok: 200,
  accepted: 202,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooManyRequests: 429,
  internalError: 500,
} as const);

/** The closed enterprise client error kinds (Wave-0 taxonomy alignment). */
export const ENTERPRISE_CLIENT_ERROR_KINDS = [
  "invalid-input",
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "unavailable",
  "internal",
] as const;

export type EnterpriseClientErrorKind = (typeof ENTERPRISE_CLIENT_ERROR_KINDS)[number];

export class EnterpriseApiError extends Error {
  readonly kind: EnterpriseClientErrorKind;
  readonly reason: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(input: {
    readonly kind: EnterpriseClientErrorKind;
    readonly reason: string;
    readonly message: string;
    readonly status: number;
    readonly retryable: boolean;
  }) {
    super(input.message);
    this.name = "EnterpriseApiError";
    this.kind = input.kind;
    this.reason = input.reason;
    this.status = input.status;
    this.retryable = input.retryable;
  }
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** The command header set every mutation must carry (RL-LOCK-014). */
export interface EnterpriseRequestContext {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** The presented enterprise API key material (header-only, never logged). */
  readonly apiKeyMaterial: string;
}

function parseRequestContext(context: EnterpriseRequestContext): {
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
} {
  let commandId: CommandId;
  try {
    commandId = parseCommandId(context.commandId);
  } catch {
    throw new ValidationError("commandId must be a canonical lowercase UUID", {
      reason: "ENTERPRISE_REQUEST_CONTEXT_INVALID",
    });
  }
  let correlationId: CorrelationId;
  try {
    correlationId = parseCorrelationId(context.correlationId);
  } catch {
    throw new ValidationError("correlationId must be a safe reference string", {
      reason: "ENTERPRISE_REQUEST_CONTEXT_INVALID",
    });
  }
  let idempotencyKey: IdempotencyKey;
  try {
    idempotencyKey = parseIdempotencyKey(context.idempotencyKey);
  } catch {
    throw new ValidationError("idempotencyKey must be a safe reference string", {
      reason: "ENTERPRISE_REQUEST_CONTEXT_INVALID",
    });
  }
  if (typeof context.apiKeyMaterial !== "string" || context.apiKeyMaterial.length === 0) {
    throw new ValidationError("an API key material is required on every request", {
      reason: "ENTERPRISE_REQUEST_CONTEXT_INVALID",
    });
  }
  return { commandId, correlationId, idempotencyKey };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface EnterpriseApiClientDeps {
  readonly transport: EnterpriseHttpTransport;
}

/** The typed client over the enterprise route table. */
export class EnterpriseApiClient {
  readonly #transport: EnterpriseHttpTransport;

  constructor(deps: EnterpriseApiClientDeps) {
    this.#transport = deps.transport;
  }

  // ----- enrollment journey -------------------------------------------------

  async createEnrollment(
    input: { readonly organizationName: string },
    context: EnterpriseRequestContext,
  ): Promise<EnrollmentWireResource> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    return parseEnrollmentResource(
      await this.#post(
        enterpriseRoute("enrollments"),
        {
          commandId,
          correlationId,
          idempotencyKey,
          organizationName: input.organizationName,
        },
        context,
      ),
    );
  }

  async submitEnrollment(
    enrollmentId: string,
    context: EnterpriseRequestContext,
  ): Promise<EnrollmentWireResource> {
    return parseEnrollmentResource(
      await this.#post(enterpriseRoute("enrollmentSubmit", { enrollmentId }), {}, context),
    );
  }

  async verifyEnrollment(
    enrollmentId: string,
    context: EnterpriseRequestContext,
  ): Promise<EnrollmentWireResource> {
    return parseEnrollmentResource(
      await this.#post(enterpriseRoute("enrollmentVerify", { enrollmentId }), {}, context),
    );
  }

  async activateEnrollment(
    enrollmentId: string,
    context: EnterpriseRequestContext,
  ): Promise<EnrollmentWireResource> {
    return parseEnrollmentResource(
      await this.#post(enterpriseRoute("enrollmentActivate", { enrollmentId }), {}, context),
    );
  }

  async listEnrollments(context: EnterpriseRequestContext): Promise<readonly EnrollmentWireResource[]> {
    return parseEnrollmentResourceList(await this.#get(enterpriseRoute("enrollments"), context));
  }

  // ----- federation ----------------------------------------------------------

  async configureFederation(
    input: { readonly protocol: string; readonly issuerReference: string },
    context: EnterpriseRequestContext,
  ): Promise<FederationWireResource> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    return parseFederationResource(
      await this.#post(
        enterpriseRoute("federation"),
        {
          commandId,
          correlationId,
          idempotencyKey,
          protocol: input.protocol,
          issuerReference: input.issuerReference,
        },
        context,
      ),
    );
  }

  async listFederation(context: EnterpriseRequestContext): Promise<readonly FederationWireResource[]> {
    return parseFederationResourceList(await this.#get(enterpriseRoute("federation"), context));
  }

  // ----- API keys -------------------------------------------------------------

  async createApiKey(
    input: { readonly name: string; readonly scopes: readonly string[] },
    context: EnterpriseRequestContext,
  ): Promise<ApiKeyIssuanceWireResource> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    parseEnterpriseScopeList(input.scopes);
    return parseApiKeyIssuanceOrThrow(
      await this.#post(
        enterpriseRoute("apiKeys"),
        { commandId, correlationId, idempotencyKey, name: input.name, scopes: [...input.scopes] },
        context,
      ),
    );
  }

  async rotateApiKey(
    keyId: string,
    context: EnterpriseRequestContext,
  ): Promise<ApiKeyIssuanceWireResource> {
    return parseApiKeyIssuanceOrThrow(
      await this.#post(enterpriseRoute("apiKeyRotate", { keyId }), {}, context),
    );
  }

  async revokeApiKey(
    keyId: string,
    context: EnterpriseRequestContext,
  ): Promise<ApiKeyWireResource> {
    return parseApiKeyResource(
      await this.#post(enterpriseRoute("apiKeyRevoke", { keyId }), {}, context),
    );
  }

  async listApiKeys(context: EnterpriseRequestContext): Promise<readonly ApiKeyWireResource[]> {
    return parseApiKeyResourceList(await this.#get(enterpriseRoute("apiKeys"), context));
  }

  // ----- connector provisioning -------------------------------------------------

  async provisionConnector(
    input: {
      readonly enrollmentId: string;
      readonly connectorId: string;
      readonly requestedCapabilities: readonly string[];
      readonly availableCapabilities: readonly string[];
    },
    context: EnterpriseRequestContext,
  ): Promise<ConnectorProvisioningWireResource> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    return parseConnectorProvisioningResource(
      await this.#post(
        enterpriseRoute("connectors"),
        {
          commandId,
          correlationId,
          idempotencyKey,
          enrollmentId: input.enrollmentId,
          connectorId: input.connectorId,
          requestedCapabilities: [...input.requestedCapabilities],
          availableCapabilities: [...input.availableCapabilities],
        },
        context,
      ),
    );
  }

  async enrollManagedEdge(
    provisioningId: string,
    input: {
      readonly deviceRef: string;
      readonly capabilitySnapshotDigest: string;
      readonly capabilitySnapshotSequence: number;
    },
    context: EnterpriseRequestContext,
  ): Promise<ManagedEdgeEnrollmentWireResource> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    return parseManagedEdgeEnrollmentResource(
      await this.#post(
        enterpriseRoute("connectorManagedEnrollments", { provisioningId }),
        {
          commandId,
          correlationId,
          idempotencyKey,
          deviceRef: input.deviceRef,
          capabilitySnapshotDigest: input.capabilitySnapshotDigest,
          capabilitySnapshotSequence: input.capabilitySnapshotSequence,
        },
        context,
      ),
    );
  }

  async listManagedEdgeEnrollments(
    provisioningId: string,
    context: EnterpriseRequestContext,
  ): Promise<readonly ManagedEdgeEnrollmentWireResource[]> {
    return parseManagedEdgeEnrollmentResourceList(
      await this.#get(
        enterpriseRoute("connectorManagedEnrollments", { provisioningId }),
        context,
      ),
    );
  }

  // ----- webhooks -------------------------------------------------------------

  async registerWebhookEndpoint(
    input: { readonly url: string; readonly eventTypes?: readonly string[] },
    context: EnterpriseRequestContext,
  ): Promise<{ readonly endpoint: WebhookEndpointWireResource; readonly signingSecret: string }> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    const response = await this.#post(
      enterpriseRoute("webhookEndpoints"),
      {
        commandId,
        correlationId,
        idempotencyKey,
        url: input.url,
        ...(input.eventTypes === undefined ? {} : { eventTypes: [...input.eventTypes] }),
      },
      context,
    );
    return parseWebhookEndpointIssuanceOrThrow(response);
  }

  async revokeWebhookEndpoint(
    endpointId: string,
    context: EnterpriseRequestContext,
  ): Promise<WebhookEndpointWireResource> {
    return parseWebhookEndpointResource(
      await this.#post(enterpriseRoute("webhookEndpointRevoke", { endpointId }), {}, context),
    );
  }

  async listWebhookEndpoints(
    context: EnterpriseRequestContext,
  ): Promise<readonly WebhookEndpointWireResource[]> {
    return parseWebhookEndpointResourceList(
      await this.#get(enterpriseRoute("webhookEndpoints"), context),
    );
  }

  async listWebhookDeliveries(
    endpointId: string,
    context: EnterpriseRequestContext,
  ): Promise<readonly WebhookDeliveryWireResource[]> {
    return parseWebhookDeliveryResourceList(
      await this.#get(enterpriseRoute("webhookDeliveries", { endpointId }), context),
    );
  }

  // ---------------------------------------------------------------------------

  async #get(path: string, context: EnterpriseRequestContext): Promise<unknown> {
    let response: EnterpriseHttpResponse;
    try {
      response = await this.#transport.request({
        method: "GET",
        path,
        headers: { [ENTERPRISE_API_KEY_HEADER]: context.apiKeyMaterial },
      });
    } catch {
      throw new EnterpriseApiError({
        kind: "unavailable",
        reason: "TRANSPORT_UNAVAILABLE",
        message: "the enterprise API transport failed (retry with backoff)",
        status: 0,
        retryable: true,
      });
    }
    return this.#unwrap(response);
  }

  async #post(path: string, body: unknown, context: EnterpriseRequestContext): Promise<unknown> {
    const { commandId, correlationId, idempotencyKey } = parseRequestContext(context);
    let response: EnterpriseHttpResponse;
    try {
      response = await this.#transport.request({
        method: "POST",
        path,
        headers: { [ENTERPRISE_API_KEY_HEADER]: context.apiKeyMaterial },
        body: JSON.stringify({
          commandId,
          correlationId,
          idempotencyKey,
          ...(typeof body === "object" && body !== null ? body : {}),
        }),
      });
    } catch {
      throw new EnterpriseApiError({
        kind: "unavailable",
        reason: "TRANSPORT_UNAVAILABLE",
        message: "the enterprise API transport failed (retry with backoff)",
        status: 0,
        retryable: true,
      });
    }
    return this.#unwrap(response);
  }

  #unwrap(response: EnterpriseHttpResponse): unknown {
    if (response.status === ENTERPRISE_HTTP_STATUS.ok) {
      return response.body === undefined ? {} : (JSON.parse(response.body) as unknown);
    }
    let reason = "ENTERPRISE_API_ERROR";
    let message = `the enterprise API answered ${response.status}`;
    if (response.body !== undefined) {
      try {
        const parsed = JSON.parse(response.body) as { readonly reason?: unknown; readonly message?: unknown };
        if (typeof parsed.reason === "string") reason = parsed.reason;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // non-JSON error body - keep the generic message
      }
    }
    const kind: EnterpriseClientErrorKind =
      response.status === 400
        ? "invalid-input"
        : response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not-found"
              : response.status === 409
                ? "conflict"
                : response.status === 500
                  ? "internal"
                  : response.status === 0 || response.status >= 500
                    ? "unavailable"
                    : "internal";
    throw new EnterpriseApiError({
      kind,
      reason,
      message,
      status: response.status,
      retryable: kind === "unavailable",
    });
  }
}
