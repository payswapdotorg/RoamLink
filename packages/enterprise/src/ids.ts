/**
 * Enterprise-domain opaque identifiers (RL-063, spec/data-model.md
 * "Identity rules": RoamLink IDs are opaque, globally unique and never reused
 * for ADCOS NodeID/session/path/provider ids).
 */
import { parseCanonicalUuidAs, type Branded } from "@roamlink/contracts";

/** Identity of an enterprise enrollment journey record. */
export type EnterpriseEnrollmentId = Branded<"EnterpriseEnrollmentId">;

export function parseEnterpriseEnrollmentId(value: unknown): EnterpriseEnrollmentId {
  return parseCanonicalUuidAs<EnterpriseEnrollmentId>(value, "EnterpriseEnrollmentId");
}

/** Identity of a tenant federation link record. */
export type TenantFederationId = Branded<"TenantFederationId">;

export function parseTenantFederationId(value: unknown): TenantFederationId {
  return parseCanonicalUuidAs<TenantFederationId>(value, "TenantFederationId");
}

/** Identity of an enterprise API key record (NOT the key material). */
export type EnterpriseApiKeyId = Branded<"EnterpriseApiKeyId">;

export function parseEnterpriseApiKeyId(value: unknown): EnterpriseApiKeyId {
  return parseCanonicalUuidAs<EnterpriseApiKeyId>(value, "EnterpriseApiKeyId");
}

/** Identity of a connector provisioning record. */
export type ConnectorProvisioningId = Branded<"ConnectorProvisioningId">;

export function parseConnectorProvisioningId(value: unknown): ConnectorProvisioningId {
  return parseCanonicalUuidAs<ConnectorProvisioningId>(value, "ConnectorProvisioningId");
}

/** Identity of a managed-edge device enrollment record. */
export type ManagedEdgeEnrollmentId = Branded<"ManagedEdgeEnrollmentId">;

export function parseManagedEdgeEnrollmentId(value: unknown): ManagedEdgeEnrollmentId {
  return parseCanonicalUuidAs<ManagedEdgeEnrollmentId>(value, "ManagedEdgeEnrollmentId");
}

/** Identity of a customer webhook endpoint registration. */
export type WebhookEndpointId = Branded<"WebhookEndpointId">;

export function parseWebhookEndpointId(value: unknown): WebhookEndpointId {
  return parseCanonicalUuidAs<WebhookEndpointId>(value, "WebhookEndpointId");
}

/** Identity of an organization policy read record. */
export type EnterprisePolicyId = Branded<"EnterprisePolicyId">;

export function parseEnterprisePolicyId(value: unknown): EnterprisePolicyId {
  return parseCanonicalUuidAs<EnterprisePolicyId>(value, "EnterprisePolicyId");
}

/** Identity of one webhook delivery attempt record. */
export type WebhookDeliveryId = Branded<"WebhookDeliveryId">;

export function parseWebhookDeliveryId(value: unknown): WebhookDeliveryId {
  return parseCanonicalUuidAs<WebhookDeliveryId>(value, "WebhookDeliveryId");
}
