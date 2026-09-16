/**
 * Deterministic in-memory stores + the organization-registrar fake (RL-063).
 *
 * Test/dev-only reference implementations of the enterprise ports. The
 * {@link InMemoryOrganizationRegistrar} proves the authority discipline: it
 * provisions organizations through the same "call the auth boundary" shape
 * production uses - this package only CALLS that port and never creates
 * organization state itself (RL-LOCK-003/019). Records are deeply frozen by
 * their parsers already; stores append/replace under caller-supplied ids;
 * tenant-scoped reads MISS on cross-tenant access (no existence oracle).
 */
import { randomUUID } from "node:crypto";
import { ConflictError, parseTenantId } from "@roamlink/contracts";
import type { InMemorySecrets } from "@roamlink/secrets";

import type { EnterpriseEnrollmentRecord } from "./enrollment.js";
import type { TenantFederationRecord } from "./federation.js";
import type { EnterpriseApiKeyRecord, EnterpriseSecretRegistrar } from "./api-keys.js";
import type { ConnectorProvisioningRecord, ManagedEdgeEnrollmentRecord } from "./connectors.js";
import type { WebhookEndpointRecord, WebhookDeliveryRecord } from "./webhooks.js";
import type { WebhookEndpointStore, WebhookDeliveryStore } from "./webhooks.js";

// ---------------------------------------------------------------------------
// The organization registrar port + fake
// ---------------------------------------------------------------------------

/**
 * The port through which enrollment provisions the organization boundary.
 * Production binds the auth domain; this package only CALLS it - the
 * tenant/organization aggregates remain owned by @roamlink/auth.
 */
export interface OrganizationRegistrar {
  provisionOrganization(input: {
    readonly organizationName: string;
    readonly requestedBy: string;
  }): Promise<{ readonly tenantId: string; readonly organizationId: string }>;
}

/** The deterministic registrar fake (no identity authority beyond shape). */
export class InMemoryOrganizationRegistrar implements OrganizationRegistrar {
  readonly #tenants: string[] = [];

  async provisionOrganization(input: {
    readonly organizationName: string;
    readonly requestedBy: string;
  }): Promise<{ readonly tenantId: string; readonly organizationId: string }> {
    // Tenant ids use the auth domain's `org:<uuid>` grammar.
    const organizationId = randomUUID();
    const tenantId = `org:${organizationId}`;
    this.#tenants.push(tenantId);
    void input; // shape parity only - identity validation is the auth boundary's job
    return { tenantId, organizationId };
  }

  provisionedTenantIds(): readonly string[] {
    return Object.freeze([...this.#tenants]);
  }
}

// ---------------------------------------------------------------------------
// Enrollment journey store
// ---------------------------------------------------------------------------

/** In-memory enrollment store (id keyed; records frozen by their parser). */
export class InMemoryEnrollmentStore {
  readonly #byId = new Map<string, EnterpriseEnrollmentRecord>();

  async save(record: EnterpriseEnrollmentRecord): Promise<void> {
    const existing = this.#byId.get(record.enrollmentId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the enrollment store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.enrollmentId, record);
  }

  async get(enrollmentId: string): Promise<EnterpriseEnrollmentRecord | null> {
    return this.#byId.get(enrollmentId) ?? null;
  }

  async list(): Promise<readonly EnterpriseEnrollmentRecord[]> {
    return Object.freeze([...this.#byId.values()]);
  }
}

// ---------------------------------------------------------------------------
// Tenant federation store
// ---------------------------------------------------------------------------

/** In-memory federation store (tenant-scoped reads fail closed on mismatch). */
export class InMemoryFederationStore {
  readonly #byId = new Map<string, TenantFederationRecord>();

  async save(record: TenantFederationRecord): Promise<void> {
    const existing = this.#byId.get(record.federationId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the federation store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.federationId, record);
  }

  async get(federationId: string, tenantId: string): Promise<TenantFederationRecord | null> {
    const record = this.#byId.get(federationId);
    if (record === undefined) return null;
    if (record.tenantId !== parseTenantId(tenantId)) return null; // cross-tenant miss
    return record;
  }

  async listByTenant(tenantId: string): Promise<readonly TenantFederationRecord[]> {
    const tenant = parseTenantId(tenantId);
    return Object.freeze([...this.#byId.values()].filter((record) => record.tenantId === tenant));
  }
}

// ---------------------------------------------------------------------------
// API key store (key-id keyed; material lives in the secrets boundary)
// ---------------------------------------------------------------------------

/** In-memory API-key store. */
export class InMemoryApiKeyStore {
  readonly #byId = new Map<string, EnterpriseApiKeyRecord>();

  async save(record: EnterpriseApiKeyRecord): Promise<void> {
    const existing = this.#byId.get(record.keyId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the API-key store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.keyId, record);
  }

  async get(keyId: string, tenantId: string): Promise<EnterpriseApiKeyRecord | null> {
    const record = this.#byId.get(keyId);
    if (record === undefined) return null;
    if (record.tenantId !== parseTenantId(tenantId)) return null; // cross-tenant miss
    return record;
  }

  async listByTenant(tenantId: string): Promise<readonly EnterpriseApiKeyRecord[]> {
    const tenant = parseTenantId(tenantId);
    return Object.freeze([...this.#byId.values()].filter((record) => record.tenantId === tenant));
  }

  /**
   * The owning tenant of a key id (for material authentication, where only
   * the embedded key id is known). Null when the key id is unknown.
   */
  async tenantOfKey(keyId: string): Promise<string | null> {
    const record = this.#byId.get(keyId);
    return record?.tenantId ?? null;
  }

  /** All tenants holding a key with this id (at most one by construction). */
  async listAllTenantsWithKey(keyId: string): Promise<readonly string[]> {
    const tenant = await this.tenantOfKey(keyId);
    return tenant === null ? [] : [tenant];
  }
}

// ---------------------------------------------------------------------------
// Connector provisioning + managed-edge enrollment stores
// ---------------------------------------------------------------------------

/** In-memory connector-provisioning store. */
export class InMemoryConnectorProvisioningStore {
  readonly #byId = new Map<string, ConnectorProvisioningRecord>();

  async save(record: ConnectorProvisioningRecord): Promise<void> {
    const existing = this.#byId.get(record.provisioningId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the provisioning store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.provisioningId, record);
  }

  async get(provisioningId: string, tenantId: string): Promise<ConnectorProvisioningRecord | null> {
    const record = this.#byId.get(provisioningId);
    if (record === undefined) return null;
    if (record.tenantId !== parseTenantId(tenantId)) return null;
    return record;
  }

  async listByTenant(tenantId: string): Promise<readonly ConnectorProvisioningRecord[]> {
    const tenant = parseTenantId(tenantId);
    return Object.freeze([...this.#byId.values()].filter((record) => record.tenantId === tenant));
  }
}

/** In-memory managed-edge enrollment store. */
export class InMemoryManagedEdgeEnrollmentStore {
  readonly #byId = new Map<string, ManagedEdgeEnrollmentRecord>();

  async save(record: ManagedEdgeEnrollmentRecord): Promise<void> {
    const existing = this.#byId.get(record.managedEnrollmentId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the managed-enrollment store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.managedEnrollmentId, record);
  }

  async get(managedEnrollmentId: string, tenantId: string): Promise<ManagedEdgeEnrollmentRecord | null> {
    const record = this.#byId.get(managedEnrollmentId);
    if (record === undefined) return null;
    if (record.tenantId !== parseTenantId(tenantId)) return null;
    return record;
  }

  async listByTenant(tenantId: string): Promise<readonly ManagedEdgeEnrollmentRecord[]> {
    const tenant = parseTenantId(tenantId);
    return Object.freeze([...this.#byId.values()].filter((record) => record.tenantId === tenant));
  }

  async findByDeviceRef(tenantId: string, deviceRef: string): Promise<ManagedEdgeEnrollmentRecord | null> {
    const all = await this.listByTenant(tenantId);
    return (
      all.find((record) => record.deviceRef === deviceRef && record.state === "enrolled") ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook endpoint + delivery stores
// ---------------------------------------------------------------------------

/** The in-memory endpoint store (revision-checked saves). */
export class InMemoryWebhookEndpointStore implements WebhookEndpointStore {
  readonly #byId = new Map<string, WebhookEndpointRecord>();

  async save(record: WebhookEndpointRecord): Promise<void> {
    const existing = this.#byId.get(record.endpointId);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new ConflictError("the endpoint store refuses non-advancing revisions", {
        reason: "ENTERPRISE_STORE_STALE_WRITE",
      });
    }
    this.#byId.set(record.endpointId, record);
  }

  async get(endpointId: string): Promise<WebhookEndpointRecord | null> {
    return this.#byId.get(endpointId) ?? null;
  }

  async listByTenant(tenantId: string): Promise<readonly WebhookEndpointRecord[]> {
    const tenant = parseTenantId(tenantId);
    return Object.freeze([...this.#byId.values()].filter((record) => record.tenantId === tenant));
  }
}

/**
 * The in-memory delivery store. Retains the canonical payload per event id
 * so bounded retries re-deliver the byte-exact envelope.
 */
export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly #attempts: WebhookDeliveryRecord[] = [];
  readonly #payloads = new Map<string, string>();

  async append(record: WebhookDeliveryRecord, canonicalPayload: string): Promise<void> {
    this.#attempts.push(record);
    if (!this.#payloads.has(record.eventId)) {
      this.#payloads.set(record.eventId, canonicalPayload);
    }
  }

  async listByEndpoint(endpointId: string): Promise<readonly WebhookDeliveryRecord[]> {
    return Object.freeze(this.#attempts.filter((record) => record.endpointId === endpointId));
  }

  async listByEvent(endpointId: string, eventId: string): Promise<readonly WebhookDeliveryRecord[]> {
    return Object.freeze(
      this.#attempts.filter(
        (record) => record.endpointId === endpointId && record.eventId === eventId,
      ),
    );
  }

  async payloadOf(eventId: string): Promise<string | null> {
    return this.#payloads.get(eventId) ?? null;
  }

  attempts(): readonly WebhookDeliveryRecord[] {
    return Object.freeze([...this.#attempts]);
  }
}

// ---------------------------------------------------------------------------
// Secrets-boundary adapters
// ---------------------------------------------------------------------------

/**
 * The provisioning adapter over the in-memory secrets fake: registers and
 * rotates API-key/webhook material through the RL-050 boundary shape.
 */
export class InMemorySecretRegistrarAdapter implements EnterpriseSecretRegistrar {
  readonly #secrets: InMemorySecrets;

  constructor(secrets: InMemorySecrets) {
    this.#secrets = secrets;
  }

  async register(name: string, material: string): Promise<number> {
    return this.#secrets.register(name, material);
  }

  async rotate(name: string, material: string): Promise<number> {
    return this.#secrets.rotate(name, material);
  }
}
