/**
 * The deterministic in-memory fake enterprise API (RL-063 test surface).
 *
 * Implements the SAME route table the production service (services/api, a
 * later wave) will implement, at the CONTRACT level, by BINDING the routes
 * to the real in-memory services (onboarding, API keys, stores, webhook
 * dispatcher). Fail-closed request discipline, in order
 * (spec/security.md "Authorization"):
 *
 *  1. the API-key material is authenticated (record located from the
 *     embedded key id, verified in constant time through the secrets
 *     boundary) - failure answers 401 and touches NO state;
 *  2. the route's required scope is authorized over the authenticated key -
 *     failure answers 403 and touches NO state;
 *  3. the command envelope (request/correlation/idempotency ids) is parsed
 *     - failure answers 400;
 *  4. only then does the handler run, and every mutation is idempotency-key
 *     aware: replaying a key replays the ORIGINAL response with no
 *     additional effect (RL-LOCK-014).
 *
 * It is a FAKE: contract-level behavior over the in-memory ports, not a
 * durable service. Webhook EMISSION is deliberately NOT a route - emission
 * is triggered by RoamLink's own durable state transitions server-side
 * (RL-LOCK-009); the harness exposes an explicit `emitTransition` test seam
 * instead.
 */
import { randomBytes } from "node:crypto";

import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
} from "@roamlink/contracts";
import { InMemoryAuditLog } from "@roamlink/audit";
import { InMemorySecrets } from "@roamlink/secrets";

import {
  negotiateConnectorProvisioning,
  parseManagedEdgeEnrollmentRecord,
} from "./connectors.js";
import { parseTenantFederationRecord } from "./federation.js";
import { CustomerWebhookDispatcher } from "./webhooks.js";
import {
  parseWebhookEndpointRecord,
  webhookEndpointSecretName,
  type WebhookEndpointRecord,
} from "./webhooks.js";
import type { EnterpriseApiScope } from "./api-keys.js";
import { EnterpriseOnboardingService } from "./onboarding.js";
import { EnterpriseApiKeyService } from "./api-key-service.js";
import {
  InMemoryApiKeyStore,
  InMemoryConnectorProvisioningStore,
  InMemoryEnrollmentStore,
  InMemoryFederationStore,
  InMemoryManagedEdgeEnrollmentStore,
  InMemoryOrganizationRegistrar,
  InMemorySecretRegistrarAdapter,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
} from "./stores.js";
import {
  ENTERPRISE_HTTP_STATUS,
  type EnterpriseHttpTransport,
  type EnterpriseHttpRequest,
  type EnterpriseHttpResponse,
} from "./api-client.js";
import {
  ENTERPRISE_API_KEY_HEADER,
  ENTERPRISE_API_ROUTE_TEMPLATES,
  ENTERPRISE_ROUTE_SCOPES,
} from "./api-surface.js";

/** Options for {@link createEnterpriseApiHarness}. */
export interface EnterpriseApiHarnessOptions {
  /** Deterministic id sources (tests); defaults are random UUID-shaped. */
  readonly enrollmentIdGenerator?: () => string;
  readonly keyIdGenerator?: () => string;
  readonly deliveryIdGenerator?: () => string;
  /** The webhook delivery sink (a success-by-default fake). */
  readonly sink?: CustomerWebhookSinkLike;
  /** Deterministic clock for the fake's internal timestamps (default: now). */
  readonly now?: () => string;
}

/** The duck-typed sink the harness accepts (structural, like webhooks.ts). */
export interface CustomerWebhookSinkLike {
  deliver(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: string;
  }): Promise<{ readonly outcome: "delivered" } | { readonly outcome: "retryable-failure"; readonly summary?: string }>;
}

/** Everything the harness wires together (assertion surface for tests). */
export interface EnterpriseApiHarness {
  readonly transport: EnterpriseHttpTransport;
  readonly onboarding: EnterpriseOnboardingService;
  readonly apiKeys: EnterpriseApiKeyService;
  readonly secrets: InMemorySecrets;
  readonly audit: InMemoryAuditLog;
  readonly enrollments: InMemoryEnrollmentStore;
  readonly federation: InMemoryFederationStore;
  readonly connectorProvisioning: InMemoryConnectorProvisioningStore;
  readonly managedEdge: InMemoryManagedEdgeEnrollmentStore;
  readonly webhookEndpoints: InMemoryWebhookEndpointStore;
  readonly webhookDeliveries: InMemoryWebhookDeliveryStore;
  readonly webhookDispatcher: CustomerWebhookDispatcher;
  /** TEST SEAM (not a route): emits a durable transition to endpoints. */
  emitTransition(
    tenantId: string,
    transition: unknown,
    at: string,
  ): ReturnType<CustomerWebhookDispatcher["emit"]>;
}

function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] as number) & 0x0f | 0x40;
  bytes[8] = (bytes[8] as number) & 0x3f | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function json(status: number, body: unknown): EnterpriseHttpResponse {
  return { status, body: JSON.stringify(body) };
}

function errorBody(error: unknown): EnterpriseHttpResponse {
  if (error instanceof UnauthorizedError) {
    return json(ENTERPRISE_HTTP_STATUS.unauthorized, {
      reason: error.reason ?? "ENTERPRISE_API_KEY_DENIED",
      message: error.message,
    });
  }
  if (error instanceof NotFoundError) {
    return json(ENTERPRISE_HTTP_STATUS.notFound, {
      reason: error.reason ?? "NOT_FOUND",
      message: error.message,
    });
  }
  if (error instanceof ValidationError) {
    return json(ENTERPRISE_HTTP_STATUS.badRequest, {
      reason: error.reason ?? "INVALID_INPUT",
      message: error.message,
    });
  }
  const maybeConflict = error as { reason?: unknown; message?: unknown };
  if (
    typeof maybeConflict.reason === "string" &&
    maybeConflict.reason.endsWith("_CONFLICT")
  ) {
    return json(ENTERPRISE_HTTP_STATUS.conflict, {
      reason: maybeConflict.reason,
      message: typeof maybeConflict.message === "string" ? maybeConflict.message : "conflict",
    });
  }
  return json(ENTERPRISE_HTTP_STATUS.internalError, {
    reason: "INTERNAL",
    message: "the enterprise API failed (details suppressed)",
  });
}

/**
 * Builds the full in-memory enterprise API harness over the real ports.
 */
export function createEnterpriseApiHarness(
  options: EnterpriseApiHarnessOptions = {},
): EnterpriseApiHarness {
  const now: () => string = options.now ?? (() => new Date().toISOString());
  const secrets = new InMemorySecrets();
  const registrar = new InMemorySecretRegistrarAdapter(secrets);
  const audit = new InMemoryAuditLog();
  const enrollments = new InMemoryEnrollmentStore();
  const federation = new InMemoryFederationStore();
  const apiKeyStore = new InMemoryApiKeyStore();
  const connectorProvisioning = new InMemoryConnectorProvisioningStore();
  const managedEdge = new InMemoryManagedEdgeEnrollmentStore();
  const webhookEndpoints = new InMemoryWebhookEndpointStore();
  const webhookDeliveries = new InMemoryWebhookDeliveryStore();

  const onboarding = new EnterpriseOnboardingService({
    enrollments,
    registrar: new InMemoryOrganizationRegistrar(),
    audit,
    enrollmentIdGenerator: options.enrollmentIdGenerator ?? randomUuid,
  });
  const apiKeys = new EnterpriseApiKeyService({
    keys: apiKeyStore,
    registrar,
    secrets,
    audit,
    keyIdGenerator: options.keyIdGenerator ?? randomUuid,
  });
  const webhookDispatcher = new CustomerWebhookDispatcher({
    endpoints: webhookEndpoints,
    deliveries: webhookDeliveries,
    sink:
      options.sink ??
      ({
        async deliver() {
          return { outcome: "delivered" as const };
        },
      } satisfies CustomerWebhookSinkLike),
    secrets,
    deliveryIdGenerator: options.deliveryIdGenerator ?? randomUuid,
  });

  const replay = new Map<string, EnterpriseHttpResponse>();

  const routes: ReadonlyArray<{
    readonly method: "GET" | "POST";
    readonly pattern: RegExp;
    readonly scope: string;
    readonly handle: (
      match: RegExpMatchArray,
      body: Record<string, unknown>,
      tenantId: string,
    ) => Promise<unknown>;
  }> = [
    {
      method: "POST",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.enrollments}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.enrollments] as string,
      handle: async (_match, body) => {
        const outcome = await onboarding.create(
          {
            organizationName: String(body["organizationName"] ?? ""),
            requestedBy: "api-key",
          },
          commandContextOf(body),
          now(),
        );
        return enrollmentResourceOf(outcome.record);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentSubmit.replace("{enrollmentId}", "([0-9a-f-]+)")}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentSubmit] as string,
      handle: async (match, body) => {
        const outcome = await onboarding.apply(
          match[1] as string,
          "submit",
          commandContextOf(body),
          now(),
        );
        return enrollmentResourceOf(outcome.record);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentVerify.replace("{enrollmentId}", "([0-9a-f-]+)")}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentVerify] as string,
      handle: async (match, body) => {
        const outcome = await onboarding.apply(
          match[1] as string,
          "verify",
          commandContextOf(body),
          now(),
        );
        return enrollmentResourceOf(outcome.record);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentActivate.replace("{enrollmentId}", "([0-9a-f-]+)")}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentActivate] as string,
      handle: async (match, body) => {
        const outcome = await onboarding.apply(
          match[1] as string,
          "activate",
          commandContextOf(body),
          now(),
        );
        return enrollmentResourceOf(outcome.record);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.enrollments}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.enrollments] as string,
      handle: async () => (await onboarding.list()).map(enrollmentResourceOf),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.federation}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.federation] as string,
      handle: async (_match, body, tenantId) => {
        const record = parseTenantFederationRecord({
          federationId: randomUuid(),
          contractVersion: "0.1",
          tenantId: tenantId as string,
          protocol: String(body["protocol"] ?? ""),
          issuerReference: String(body["issuerReference"] ?? ""),
          state: "configured",
          createdAt: now(),
          updatedAt: now(),
          revision: 1,
        });
        await federation.save(record);
        return federationResourceOf(record);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.federation}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.federation] as string,
      handle: async (_match, _body, tenantId) =>
        (await federation.listByTenant(tenantId as string)).map(federationResourceOf),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.apiKeys}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.apiKeys] as string,
      handle: async (_match, body, tenantId) => {
        const issuance = await apiKeys.issue(
          {
            tenantId: tenantId as string,
            name: String(body["name"] ?? ""),
            scopes: Array.isArray(body["scopes"]) ? (body["scopes"] as string[]) : [],
          },
          commandContextOf(body),
          now(),
        );
        return {
          key: apiKeyResourceOf(issuance.record),
          material: issuance.material.value,
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRotate.replace("{keyId}", "([0-9a-f-]+)")}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRotate] as string,
      handle: async (match, body, tenantId) => {
        const issuance = await apiKeys.rotate(
          match[1] as string,
          tenantId as string,
          commandContextOf(body),
          now(),
        );
        return { key: apiKeyResourceOf(issuance.record), material: issuance.material.value };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRevoke.replace("{keyId}", "([0-9a-f-]+)")}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRevoke] as string,
      handle: async (match, body, tenantId) => {
        const record = await apiKeys.revoke(
          match[1] as string,
          tenantId as string,
          commandContextOf(body),
          now(),
        );
        return apiKeyResourceOf(record);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.apiKeys}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.apiKeys] as string,
      handle: async (_match, _body, tenantId) =>
        (await apiKeys.listByTenant(tenantId as string)).map(apiKeyResourceOf),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.connectors}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.connectors] as string,
      handle: async (_match, body, tenantId) => {
        const record = negotiateConnectorProvisioning(
          {
            provisioningId: randomUuid(),
            tenantId: tenantId as string,
            enrollmentId: String(body["enrollmentId"] ?? ""),
            connectorId: String(body["connectorId"] ?? ""),
          },
          Array.isArray(body["requestedCapabilities"])
            ? (body["requestedCapabilities"] as unknown[])
            : [],
          Array.isArray(body["availableCapabilities"])
            ? (body["availableCapabilities"] as string[])
            : [],
          now(),
        );
        await connectorProvisioning.save(record);
        return connectorResourceOf(record);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.connectorManagedEnrollments.replace(
          "{provisioningId}",
          "([0-9a-f-]+)",
        )}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[
        ENTERPRISE_API_ROUTE_TEMPLATES.connectorManagedEnrollments
      ] as string,
      handle: async (match, body, tenantId) => {
        const provisioning = await connectorProvisioning.get(
          match[1] as string,
          tenantId as string,
        );
        if (provisioning === null) {
          throw new NotFoundError("the connector provisioning does not exist", {
            reason: "CONNECTOR_PROVISIONING_NOT_FOUND",
          });
        }
        const record = parseManagedEdgeEnrollmentRecord({
          managedEnrollmentId: randomUuid(),
          contractVersion: "0.1",
          tenantId: tenantId as string,
          provisioningId: provisioning.provisioningId,
          deviceRef: String(body["deviceRef"] ?? ""),
          connectorId: provisioning.connectorId,
          capabilitySnapshotDigest: String(body["capabilitySnapshotDigest"] ?? ""),
          capabilitySnapshotSequence: Number(body["capabilitySnapshotSequence"] ?? 0),
          state: "enrolled",
          enrolledAt: now(),
          updatedAt: now(),
          revision: 1,
        });
        await managedEdge.save(record);
        return managedEdgeResourceOf(record);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.connectorManagedEnrollments.replace(
          "{provisioningId}",
          "([0-9a-f-]+)",
        )}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[
        ENTERPRISE_API_ROUTE_TEMPLATES.connectorManagedEnrollments
      ] as string,
      handle: async (_match, _body, tenantId) =>
        (await managedEdge.listByTenant(tenantId as string)).map(managedEdgeResourceOf),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpoints}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpoints] as string,
      handle: async (_match, body, tenantId) => {
        const endpointId = randomUuid();
        const signingSecret = randomBytes(32).toString("hex");
        await registrar.register(webhookEndpointSecretName(endpointId), signingSecret);
        const record = parseWebhookEndpointRecord({
          endpointId,
          contractVersion: "0.1",
          tenantId: tenantId as string,
          url: String(body["url"] ?? ""),
          eventTypes: Array.isArray(body["eventTypes"]) ? (body["eventTypes"] as string[]) : [],
          signingKeyRef: { name: webhookEndpointSecretName(endpointId), version: null },
          status: "pending",
          createdAt: now(),
          updatedAt: now(),
          revision: 1,
        });
        await webhookEndpoints.save(record);
        return { endpoint: webhookEndpointResourceOf(record), signingSecret };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpointRevoke.replace(
          "{endpointId}",
          "([0-9a-f-]+)",
        )}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpointRevoke] as string,
      handle: async (match, body, tenantId) => {
        const current = await webhookEndpoints.get(match[1] as string);
        if (current === null || current.tenantId !== (tenantId as string)) {
          throw new NotFoundError("the webhook endpoint does not exist in this tenant", {
            reason: "WEBHOOK_ENDPOINT_NOT_FOUND",
          });
        }
        const revoked = setWebhookEndpointRevoked(current, now());
        await webhookEndpoints.save(revoked);
        return webhookEndpointResourceOf(revoked);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpoints}$`),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpoints] as string,
      handle: async (_match, _body, tenantId) =>
        (await webhookEndpoints.listByTenant(tenantId as string)).map(webhookEndpointResourceOf),
    },
    {
      method: "GET",
      pattern: new RegExp(
        `^${ENTERPRISE_API_ROUTE_TEMPLATES.webhookDeliveries.replace(
          "{endpointId}",
          "([0-9a-f-]+)",
        )}$`,
      ),
      scope: ENTERPRISE_ROUTE_SCOPES[ENTERPRISE_API_ROUTE_TEMPLATES.webhookDeliveries] as string,
      handle: async (match, _body, tenantId) => {
        const endpoint = await webhookEndpoints.get(match[1] as string);
        if (endpoint === null || endpoint.tenantId !== (tenantId as string)) {
          throw new NotFoundError("the webhook endpoint does not exist in this tenant", {
            reason: "WEBHOOK_ENDPOINT_NOT_FOUND",
          });
        }
        return (await webhookDeliveries.listByEndpoint(endpoint.endpointId)).map(
          webhookDeliveryResourceOf,
        );
      },
    },
  ];

  const transport: EnterpriseHttpTransport = {
    async request(request: EnterpriseHttpRequest): Promise<EnterpriseHttpResponse> {
      // 1. authenticate (401 on failure; no state touched)
      const material = request.headers[ENTERPRISE_API_KEY_HEADER];
      if (material === undefined) {
        return json(ENTERPRISE_HTTP_STATUS.unauthorized, {
          reason: "MATERIAL_MISSING",
          message: "an enterprise API key header is required",
        });
      }
      let authenticated;
      let tenantId: string;
      try {
        authenticated = await apiKeys.authenticate(material);
        tenantId = authenticated.tenantId;
      } catch (error) {
        return errorBody(error);
      }
      // 2. + 3. route match, scope authorization (403), command envelope (400)
      for (const route of routes) {
        const match = route.pattern.exec(request.path);
        if (match === null || route.method !== request.method) continue;
        const decision = apiKeys.authorize(
          authenticated,
          route.scope as EnterpriseApiScope,
        );
        if (decision.decision === "deny") {
          return json(ENTERPRISE_HTTP_STATUS.forbidden, {
            reason: decision.reason,
            message: `this route requires the '${route.scope}' scope`,
          });
        }
        const idempotencyKey = `${request.method} ${request.path} ${material} ${
          request.body ?? ""
        }`;
        const cached = replay.get(idempotencyKey);
        if (cached !== undefined) return cached;
        let body: Record<string, unknown> = {};
        if (request.body !== undefined && request.body.length > 0) {
          try {
            body = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return json(ENTERPRISE_HTTP_STATUS.badRequest, {
              reason: "BODY_INVALID",
              message: "the request body must be JSON",
            });
          }
        }
        // 3. command-envelope validation on mutations (400 BEFORE any state)
        if (request.method === "POST") {
          const envelopeError = validateCommandEnvelope(body);
          if (envelopeError !== null) return envelopeError;
        }
        try {
          const result = await route.handle(match, body, tenantId);
          const response = json(ENTERPRISE_HTTP_STATUS.ok, result);
          replay.set(idempotencyKey, response);
          return response;
        } catch (error) {
          return errorBody(error);
        }
      }
      return json(ENTERPRISE_HTTP_STATUS.notFound, {
        reason: "ROUTE_UNKNOWN",
        message: "the enterprise API route does not exist",
      });
    },
  };

  return {
    transport,
    onboarding,
    apiKeys,
    secrets,
    audit,
    enrollments,
    federation,
    connectorProvisioning,
    managedEdge,
    webhookEndpoints,
    webhookDeliveries,
    webhookDispatcher,
    emitTransition: (tenant: string, transition: unknown, at: string) =>
      webhookDispatcher.emit(tenant, transition, at),
  };
}

// ---------------------------------------------------------------------------
// resource mappers (record -> wire shape; secrets never included)
// ---------------------------------------------------------------------------

function validateCommandEnvelope(body: Record<string, unknown>): EnterpriseHttpResponse | null {
  try {
    parseCommandId(String(body["commandId"] ?? ""));
    parseCorrelationId(String(body["correlationId"] ?? ""));
    parseIdempotencyKey(String(body["idempotencyKey"] ?? ""));
    return null;
  } catch {
    return json(ENTERPRISE_HTTP_STATUS.badRequest, {
      reason: "COMMAND_ENVELOPE_INVALID",
      message: "mutations must carry a valid command envelope (request/correlation/idempotency ids)",
    });
  }
}

function commandContextOf(body: Record<string, unknown>): {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
} {
  return {
    commandId: String(body["commandId"] ?? ""),
    correlationId: String(body["correlationId"] ?? ""),
    idempotencyKey: String(body["idempotencyKey"] ?? ""),
    actorId: "enterprise-api",
  };
}

function enrollmentResourceOf(record: {
  readonly enrollmentId: string;
  readonly organizationName: string;
  readonly tenantId: string | null;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly verifiedAt?: string;
  readonly rejectionReason?: string;
  readonly cancelledAt?: string;
  readonly activatedAt?: string;
}) {
  return {
    enrollmentId: record.enrollmentId,
    organizationName: record.organizationName,
    tenantId: record.tenantId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(record.verifiedAt !== undefined ? { verifiedAt: record.verifiedAt } : {}),
    ...(record.rejectionReason !== undefined ? { rejectionReason: record.rejectionReason } : {}),
    ...(record.cancelledAt !== undefined ? { cancelledAt: record.cancelledAt } : {}),
    ...(record.activatedAt !== undefined ? { activatedAt: record.activatedAt } : {}),
  };
}

function federationResourceOf(record: {
  readonly federationId: string;
  readonly tenantId: string;
  readonly protocol: string;
  readonly issuerReference: string;
  readonly state: string;
  readonly revision: number;
}) {
  return {
    federationId: record.federationId,
    tenantId: record.tenantId,
    protocol: record.protocol,
    issuerReference: record.issuerReference,
    state: record.state,
    revision: record.revision,
  };
}

function apiKeyResourceOf(record: {
  readonly keyId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly lastRotatedAt?: string;
}) {
  // Deliberately excludes secretRef and any material (RL-LOCK-016).
  return {
    keyId: record.keyId,
    name: record.name,
    scopes: [...record.scopes],
    status: record.status,
    createdAt: record.createdAt,
    revision: record.revision,
    ...(record.lastRotatedAt !== undefined ? { lastRotatedAt: record.lastRotatedAt } : {}),
  };
}

function connectorResourceOf(record: {
  readonly provisioningId: string;
  readonly enrollmentId: string;
  readonly connectorId: string;
  readonly capabilities: readonly string[];
  readonly operatingMode: string;
  readonly state: string;
  readonly revision: number;
}) {
  return {
    provisioningId: record.provisioningId,
    enrollmentId: record.enrollmentId,
    connectorId: record.connectorId,
    capabilities: [...record.capabilities],
    operatingMode: record.operatingMode,
    state: record.state,
    revision: record.revision,
  };
}

function managedEdgeResourceOf(record: {
  readonly managedEnrollmentId: string;
  readonly provisioningId: string;
  readonly deviceRef: string;
  readonly connectorId: string;
  readonly capabilitySnapshotDigest: string;
  readonly state: string;
  readonly enrolledAt: string;
  readonly revision: number;
}) {
  return {
    managedEnrollmentId: record.managedEnrollmentId,
    provisioningId: record.provisioningId,
    deviceRef: record.deviceRef,
    connectorId: record.connectorId,
    capabilitySnapshotDigest: record.capabilitySnapshotDigest,
    state: record.state,
    enrolledAt: record.enrolledAt,
    revision: record.revision,
  };
}

function webhookEndpointResourceOf(record: {
  readonly endpointId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
}) {
  return {
    endpointId: record.endpointId,
    url: record.url,
    eventTypes: [...record.eventTypes],
    status: record.status,
    createdAt: record.createdAt,
    revision: record.revision,
    ...(record.lastSuccessAt !== undefined ? { lastSuccessAt: record.lastSuccessAt } : {}),
    ...(record.lastFailureAt !== undefined ? { lastFailureAt: record.lastFailureAt } : {}),
  };
}

function webhookDeliveryResourceOf(record: {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly attemptedAt: string;
  readonly responseSummary?: string;
}) {
  return {
    deliveryId: record.deliveryId,
    endpointId: record.endpointId,
    eventId: record.eventId,
    sequence: record.sequence,
    outcome: record.outcome,
    attemptedAt: record.attemptedAt,
    ...(record.responseSummary !== undefined
      ? { responseSummary: record.responseSummary }
      : {}),
  };
}

function setWebhookEndpointRevoked(record: WebhookEndpointRecord, at: string): WebhookEndpointRecord {
  return parseWebhookEndpointRecord({
    endpointId: record.endpointId,
    contractVersion: record.contractVersion,
    tenantId: record.tenantId,
    url: record.url,
    eventTypes: [...record.eventTypes],
    signingKeyRef: { name: record.signingKeyRef.name, version: record.signingKeyRef.version },
    status: "revoked",
    createdAt: record.createdAt,
    updatedAt: at,
    revision: record.revision + 1,
  });
}
