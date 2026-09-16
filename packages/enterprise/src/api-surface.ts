/**
 * The public enterprise API surface - routes + typed wire resources
 * (RL-063, spec/api.md "Command semantics" + "API compatibility").
 *
 * The `/v1/enterprise/...` route table below is the typed client's entire URL
 * surface. Semantic versioning with additive-change tolerance (RL-LOCK-017):
 * the resource parsers reject unknown fields fail-closed, and record
 * contract versions gate cross-minor reads exactly like the other RoamLink
 * contract families.
 *
 * Mutation semantics mirror the customer application contract: every
 * mutation returns a command/resource acknowledgement that keeps
 * `accepted`, `executed`, `delivered` and `billable-final` as SEPARATE,
 * individually-absent-or-present facts (never a collapsed enum). The stage
 * vocabulary is a drift-guarded mirror of the application kit's owner
 * contract (tests/architecture compares them).
 */
import {
  ValidationError,
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  parseUtcInstant,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
} from "@roamlink/contracts";

import { isEnterpriseApiScope } from "./api-keys.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The enterprise API route table (additive within a major, RL-LOCK-017). */
export const ENTERPRISE_API_ROUTE_TEMPLATES = Object.freeze({
  enrollments: "/v1/enterprise/enrollments",
  enrollment: "/v1/enterprise/enrollments/{enrollmentId}",
  enrollmentSubmit: "/v1/enterprise/enrollments/{enrollmentId}/submit",
  enrollmentVerify: "/v1/enterprise/enrollments/{enrollmentId}/verify",
  enrollmentActivate: "/v1/enterprise/enrollments/{enrollmentId}/activate",
  federation: "/v1/enterprise/federation",
  apiKeys: "/v1/enterprise/api-keys",
  apiKeyRotate: "/v1/enterprise/api-keys/{keyId}/rotate",
  apiKeyRevoke: "/v1/enterprise/api-keys/{keyId}/revoke",
  connectors: "/v1/enterprise/connectors",
  connectorManagedEnrollments: "/v1/enterprise/connectors/{provisioningId}/managed-enrollments",
  webhookEndpoints: "/v1/enterprise/webhook-endpoints",
  webhookEndpointRevoke: "/v1/enterprise/webhook-endpoints/{endpointId}/revoke",
  webhookDeliveries: "/v1/enterprise/webhook-endpoints/{endpointId}/deliveries",
} as const);

export type EnterpriseRouteName = keyof typeof ENTERPRISE_API_ROUTE_TEMPLATES;

/** Fills a route template's `{param}` segments. */
export function enterpriseRoute(
  name: EnterpriseRouteName,
  params: Readonly<Record<string, string>> = {},
): string {
  const template: string = ENTERPRISE_API_ROUTE_TEMPLATES[name];
  return template.replace(/\{(\w+)\}/g, (_match, param: string) => {
    const value = params[param];
    if (value === undefined || value.length === 0) {
      throw new Error(
        `route '${String(name)}' is missing the required path parameter '${param}'`,
      );
    }
    return encodeURIComponent(value);
  });
}

/** The API-key header carrying the presented material (never logged). */
export const ENTERPRISE_API_KEY_HEADER = "x-roamlink-api-key";

/** The required service scope per enterprise route (fail-closed authz). */
export const ENTERPRISE_ROUTE_SCOPES: Readonly<Record<string, string>> = Object.freeze({
  [ENTERPRISE_API_ROUTE_TEMPLATES.enrollments]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.enrollment]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentSubmit]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentVerify]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.enrollmentActivate]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.federation]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.apiKeys]: "api-keys:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRotate]: "api-keys:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.apiKeyRevoke]: "api-keys:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.connectors]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.connectorManagedEnrollments]: "enrollments:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpoints]: "webhooks:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.webhookEndpointRevoke]: "webhooks:manage",
  [ENTERPRISE_API_ROUTE_TEMPLATES.webhookDeliveries]: "webhooks:manage",
});

// ---------------------------------------------------------------------------
// Mutation acknowledgement (drift-guarded mirror of the four-stage contract)
// ---------------------------------------------------------------------------

/** The closed, ordered mutation-outcome stage vocabulary (spec/api.md). */
export const ENTERPRISE_MUTATION_STAGES = [
  "accepted",
  "executed",
  "delivered",
  "billable-final",
] as const;

export type EnterpriseMutationStage = (typeof ENTERPRISE_MUTATION_STAGES)[number];

/** The acknowledgement returned by every enterprise mutation endpoint. */
export interface EnterpriseMutationAcknowledgement {
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly acceptedAt: string;
  readonly executedAt?: string;
  readonly deliveredAt?: string;
  readonly billableFinalAt?: string;
  readonly resource?: { readonly type: string; readonly id: string; readonly version?: number };
}

function ackField(label: string, issue: string): never {
  throw new ValidationError(`EnterpriseMutationAcknowledgement rejected: ${label} - ${issue}`, {
    reason: "ENTERPRISE_MUTATION_ACK_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Fail-closed parser for an enterprise mutation acknowledgement. Enforces the
 * structural stage ordering: delivered implies executed; billable-final
 * implies delivered (stages never collapse or skip).
 */
export function parseEnterpriseMutationAcknowledgement(
  value: unknown,
): EnterpriseMutationAcknowledgement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    ackField("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "commandId",
    "correlationId",
    "idempotencyKey",
    "acceptedAt",
    "executedAt",
    "deliveredAt",
    "billableFinalAt",
    "resource",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      ackField(key, "unknown field (the acknowledgement carries exactly its contract fields)");
    }
  }
  let commandId: CommandId;
  try {
    commandId = parseCommandId(record["commandId"]);
  } catch {
    ackField("commandId", "must be a canonical lowercase UUID");
  }
  let correlationId: CorrelationId;
  try {
    correlationId = parseCorrelationId(record["correlationId"]);
  } catch {
    ackField("correlationId", "must be a non-empty safe reference string");
  }
  let idempotencyKey: IdempotencyKey;
  try {
    idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
  } catch {
    ackField("idempotencyKey", "must be a non-empty safe reference string");
  }
  if (record["acceptedAt"] === undefined) {
    ackField("acceptedAt", "is required (every command is accepted before anything else)");
  }
  const parseInstant = (raw: unknown, label: string): string => {
    try {
      return parseUtcInstant(raw);
    } catch {
      ackField(label, "must be a UTC instant string with an explicit zone designator");
    }
  };
  const acceptedAt = parseInstant(record["acceptedAt"], "acceptedAt");
  if (
    record["executedAt"] === undefined &&
    (record["deliveredAt"] !== undefined || record["billableFinalAt"] !== undefined)
  ) {
    ackField("deliveredAt", "may not be present without executedAt (stages never collapse or skip)");
  }
  if (record["deliveredAt"] === undefined && record["billableFinalAt"] !== undefined) {
    ackField("billableFinalAt", "may not be present without deliveredAt (stages never collapse or skip)");
  }
  const executedAt =
    record["executedAt"] === undefined ? undefined : parseInstant(record["executedAt"], "executedAt");
  const deliveredAt =
    record["deliveredAt"] === undefined
      ? undefined
      : parseInstant(record["deliveredAt"], "deliveredAt");
  const billableFinalAt =
    record["billableFinalAt"] === undefined
      ? undefined
      : parseInstant(record["billableFinalAt"], "billableFinalAt");
  const resource =
    record["resource"] === undefined
      ? undefined
      : (() => {
          const raw = record["resource"];
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            ackField("resource", "must be an object with type/id/version");
          }
          const resourceRecord = raw as Record<string, unknown>;
          for (const key of Object.keys(resourceRecord)) {
            if (!["type", "id", "version"].includes(key)) {
              ackField(`resource.${key}`, "unknown field");
            }
          }
          if (typeof resourceRecord["type"] !== "string" || resourceRecord["type"].length === 0) {
            ackField("resource.type", "must be a non-empty resource kind label");
          }
          if (typeof resourceRecord["id"] !== "string" || resourceRecord["id"].length === 0) {
            ackField("resource.id", "must be a non-empty resource id");
          }
          const version = resourceRecord["version"];
          if (
            version !== undefined &&
            (typeof version !== "number" || !Number.isInteger(version) || version < 1)
          ) {
            ackField("resource.version", "must be a positive integer when present");
          }
          return Object.freeze({
            type: resourceRecord["type"] as string,
            id: resourceRecord["id"] as string,
            ...(version !== undefined ? { version: version as number } : {}),
          });
        })();
  return Object.freeze({
    commandId,
    correlationId,
    idempotencyKey,
    acceptedAt,
    ...(executedAt !== undefined ? { executedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(billableFinalAt !== undefined ? { billableFinalAt } : {}),
    ...(resource !== undefined ? { resource } : {}),
  });
}

// ---------------------------------------------------------------------------
// Wire resources (typed, fail-closed parsers; no authority, no secrets)
// ---------------------------------------------------------------------------

function resourceParser<T>(
  label: string,
  required: readonly string[],
  optional: readonly string[],
): (value: unknown) => T {
  return (value: unknown): T => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`${label} must be an object`, {
        reason: "ENTERPRISE_RESOURCE_INVALID",
        details: [{ path: label, issue: "not an object" }],
      });
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!required.includes(key) && !optional.includes(key)) {
        throw new ValidationError(`${label} rejected unknown field '${key}'`, {
          reason: "ENTERPRISE_RESOURCE_INVALID",
          details: [{ path: `${label}.${key}`, issue: "unknown field (fail-closed, RL-LOCK-017)" }],
        });
      }
    }
    for (const key of required) {
      if (record[key] === undefined) {
        throw new ValidationError(`${label} is missing the required field '${key}'`, {
          reason: "ENTERPRISE_RESOURCE_INVALID",
          details: [{ path: `${label}.${key}`, issue: "required field missing" }],
        });
      }
    }
    return Object.freeze(record) as T;
  };
}

/** Enrollment journey wire resource. */
export interface EnrollmentWireResource {
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
}

/** Federation wire resource (reference-only fields, RL-LOCK-003). */
export interface FederationWireResource {
  readonly federationId: string;
  readonly tenantId: string;
  readonly protocol: string;
  readonly issuerReference: string;
  readonly state: string;
  readonly revision: number;
}

/** API-key wire resource (NO secretRef, NO material - RL-LOCK-016). */
export interface ApiKeyWireResource {
  readonly keyId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly lastRotatedAt?: string;
}

/** Issuance response: the key resource + the material shown ONCE. */
export interface ApiKeyIssuanceWireResource {
  readonly key: ApiKeyWireResource;
  /** "[REDACTED]" in every serialization except the one delivery to the customer. */
  readonly material: string;
}

/** Connector provisioning wire resource. */
export interface ConnectorProvisioningWireResource {
  readonly provisioningId: string;
  readonly enrollmentId: string;
  readonly connectorId: string;
  readonly capabilities: readonly string[];
  readonly operatingMode: string;
  readonly state: string;
  readonly revision: number;
}

/** Managed-edge enrollment wire resource. */
export interface ManagedEdgeEnrollmentWireResource {
  readonly managedEnrollmentId: string;
  readonly provisioningId: string;
  readonly deviceRef: string;
  readonly connectorId: string;
  readonly capabilitySnapshotDigest: string;
  readonly state: string;
  readonly enrolledAt: string;
  readonly revision: number;
}

/** Webhook endpoint wire resource. */
export interface WebhookEndpointWireResource {
  readonly endpointId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
}

/** Webhook delivery wire resource. */
export interface WebhookDeliveryWireResource {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly attemptedAt: string;
  readonly responseSummary?: string;
}

export const parseEnrollmentResource = resourceParser<EnrollmentWireResource>(
  "EnrollmentResource",
  ["enrollmentId", "organizationName", "state", "createdAt", "updatedAt", "revision"],
  ["tenantId", "verifiedAt", "rejectionReason", "cancelledAt", "activatedAt"],
);

export const parseFederationResource = resourceParser<FederationWireResource>(
  "FederationResource",
  ["federationId", "tenantId", "protocol", "issuerReference", "state", "revision"],
  [],
);

export const parseApiKeyResource = resourceParser<ApiKeyWireResource>(
  "ApiKeyResource",
  ["keyId", "name", "scopes", "status", "createdAt", "revision"],
  ["lastRotatedAt"],
);

export const parseConnectorProvisioningResource =
  resourceParser<ConnectorProvisioningWireResource>(
    "ConnectorProvisioningResource",
    [
      "provisioningId",
      "enrollmentId",
      "connectorId",
      "capabilities",
      "operatingMode",
      "state",
      "revision",
    ],
    [],
  );

export const parseManagedEdgeEnrollmentResource =
  resourceParser<ManagedEdgeEnrollmentWireResource>(
    "ManagedEdgeEnrollmentResource",
    [
      "managedEnrollmentId",
      "provisioningId",
      "deviceRef",
      "connectorId",
      "capabilitySnapshotDigest",
      "state",
      "enrolledAt",
      "revision",
    ],
    [],
  );

export const parseWebhookEndpointResource = resourceParser<WebhookEndpointWireResource>(
  "WebhookEndpointResource",
  ["endpointId", "url", "eventTypes", "status", "createdAt", "revision"],
  ["lastSuccessAt", "lastFailureAt"],
);

export const parseWebhookDeliveryResource = resourceParser<WebhookDeliveryWireResource>(
  "WebhookDeliveryResource",
  ["deliveryId", "endpointId", "eventId", "sequence", "outcome", "attemptedAt"],
  ["responseSummary"],
);

/** Validates that a scope list is a subset of the closed vocabulary. */
export function parseEnterpriseScopeList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("a scope list must be a non-empty array", {
      reason: "ENTERPRISE_SCOPES_INVALID",
      details: [{ path: "scopes", issue: "not a non-empty array" }],
    });
  }
  for (const scope of value) {
    if (!isEnterpriseApiScope(scope)) {
      throw new ValidationError("a scope is outside the closed service-authorization vocabulary", {
        reason: "ENTERPRISE_SCOPES_INVALID",
        details: [{ path: "scopes", issue: "outside the closed vocabulary" }],
      });
    }
  }
  return Object.freeze([...value]);
}

// ---------------------------------------------------------------------------
// List + issuance parsers (client-side fail-closed wrappers)
// ---------------------------------------------------------------------------

function parseResourceList<T>(
  label: string,
  parseOne: (value: unknown) => T,
): (value: unknown) => readonly T[] {
  return (value: unknown): readonly T[] => {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${label} must be an array`, {
        reason: "ENTERPRISE_RESOURCE_INVALID",
        details: [{ path: label, issue: "not an array" }],
      });
    }
    return Object.freeze(value.map((entry) => parseOne(entry)));
  };
}

export const parseEnrollmentResourceList = parseResourceList(
  "EnrollmentResourceList",
  parseEnrollmentResource,
);

export const parseFederationResourceList = parseResourceList(
  "FederationResourceList",
  parseFederationResource,
);

export const parseApiKeyResourceList = parseResourceList(
  "ApiKeyResourceList",
  parseApiKeyResource,
);

export const parseConnectorProvisioningResourceList = parseResourceList(
  "ConnectorProvisioningResourceList",
  parseConnectorProvisioningResource,
);

export const parseManagedEdgeEnrollmentResourceList = parseResourceList(
  "ManagedEdgeEnrollmentResourceList",
  parseManagedEdgeEnrollmentResource,
);

export const parseWebhookEndpointResourceList = parseResourceList(
  "WebhookEndpointResourceList",
  parseWebhookEndpointResource,
);

export const parseWebhookDeliveryResourceList = parseResourceList(
  "WebhookDeliveryResourceList",
  parseWebhookDeliveryResource,
);

/** Parses an API-key issuance response (key + material shown once). */
export function parseApiKeyIssuanceOrThrow(value: unknown): ApiKeyIssuanceWireResource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("ApiKeyIssuance must be an object with key and material", {
      reason: "ENTERPRISE_RESOURCE_INVALID",
      details: [{ path: "ApiKeyIssuance", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "key" && key !== "material") {
      throw new ValidationError(`ApiKeyIssuance rejected unknown field '${key}'`, {
        reason: "ENTERPRISE_RESOURCE_INVALID",
        details: [{ path: `ApiKeyIssuance.${key}`, issue: "unknown field" }],
      });
    }
  }
  if (typeof record["material"] !== "string" || record["material"].length === 0) {
    throw new ValidationError("ApiKeyIssuance.material must be the one-time material string", {
      reason: "ENTERPRISE_RESOURCE_INVALID",
      details: [{ path: "material", issue: "missing or empty" }],
    });
  }
  const key = parseApiKeyResource(record["key"]);
  return Object.freeze({ key, material: record["material"] as string });
}

/** Parses a webhook-endpoint registration response (endpoint + secret once). */
export function parseWebhookEndpointIssuanceOrThrow(value: unknown): {
  readonly endpoint: WebhookEndpointWireResource;
  readonly signingSecret: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("WebhookEndpointIssuance must be an object", {
      reason: "ENTERPRISE_RESOURCE_INVALID",
      details: [{ path: "WebhookEndpointIssuance", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "endpoint" && key !== "signingSecret") {
      throw new ValidationError(`WebhookEndpointIssuance rejected unknown field '${key}'`, {
        reason: "ENTERPRISE_RESOURCE_INVALID",
        details: [{ path: `WebhookEndpointIssuance.${key}`, issue: "unknown field" }],
      });
    }
  }
  if (typeof record["signingSecret"] !== "string" || record["signingSecret"].length === 0) {
    throw new ValidationError(
      "WebhookEndpointIssuance.signingSecret must be the one-time signing secret string",
      {
        reason: "ENTERPRISE_RESOURCE_INVALID",
        details: [{ path: "signingSecret", issue: "missing or empty" }],
      },
    );
  }
  const endpoint = parseWebhookEndpointResource(record["endpoint"]);
  return Object.freeze({ endpoint, signingSecret: record["signingSecret"] as string });
}
