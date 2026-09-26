/**
 * The enterprise workspace source bindings (PA-026 — the enterprise runtime
 * completion).
 *
 * THE AUTHORITY LAW (the handoff's hard rule, held here): the enterprise
 * DOMAIN packages (@roamlink/enterprise) own the enrollment/policy/connector/
 * integration state machines. This module BINDS their records through the
 * service's ports — it never re-implements or shadows their logic:
 *
 *  - the RECORD VALIDATION is the domain's own fail-closed parsers
 *    (parseEnterpriseEnrollmentRecord / parseOrganizationPolicyRecord /
 *    parseEnterpriseIntegrationStatusRecord / parseConnectorProvisioningRecord),
 *    consumed directly — a record this service cannot parse as a domain record
 *    fails closed, never a guessed projection;
 *  - the PERSISTENCE is the SHARED PERSISTENCE PORT the service is already
 *    constructed with (the same @roamlink/persistence records-port partitions
 *    `api-commands` and `adcos-reconciliation-jobs` live in — the partition
 *    name is data, so the enterprise partitions land additively with no schema
 *    change, infra/migrations/0002);
 *  - the WRITE-side adapters mirror the domain stores' OWN port semantics
 *    (revision-advancing saves; tenant-scoped reads MISS on cross-tenant
 *    access — no existence oracle) exactly as packages/enterprise's reference
 *    stores (stores.ts) define them; the domain's in-memory stores stay the
 *    test/dev reference implementations, these are the shared-persistence
 *    implementations of the SAME ports.
 *
 * THE PROJECTION LAW (unchanged): a served enterprise fact is a real fact of
 * the bound state. An EXECUTED command creates the fact (the worker seam's
 * enterprise executors persist these records through the SAME adapters when
 * the command plane executes an enterprise command); the upstream organization
 * administration publishes the read-only policy/integration observations into
 * their partitions. A partition that holds nothing for the acting tenant
 * serves the contract's honest NULL section — "an absent section is not an
 * assertion".
 */
import { ConflictError, NotFoundError, type CanonicalJsonValue } from "@roamlink/contracts";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import {
  parseConnectorProvisioningRecord,
  parseEnterpriseEnrollmentRecord,
  parseEnterpriseIntegrationStatusRecord,
  parseOrganizationPolicyRecord,
  type ConnectorProvisioningRecord,
  type EnterpriseEnrollmentRecord,
  type EnterpriseIntegrationStatusRecord,
  type OrganizationPolicyRecord,
} from "@roamlink/enterprise";

// The domain's own record shapes (re-exported for the compositions that
// bind these sources — the types belong to @roamlink/enterprise, never here).
export type {
  ConnectorProvisioningRecord,
  EnterpriseEnrollmentRecord,
  EnterpriseIntegrationStatusRecord,
  OrganizationPolicyRecord,
} from "@roamlink/enterprise";

// --------------------------------------------------------------------------------
// The records-port partitions (shared persistence; additive by design)
// --------------------------------------------------------------------------------

/** The enrollment journey records (RL-063; the domain's own state machine). */
export const ENTERPRISE_ENROLLMENT_REPOSITORY = "enterprise-enrollments";

/** The read-only organization policy records (PA-007; upstream-administered). */
export const ENTERPRISE_POLICY_REPOSITORY = "enterprise-policies";

/** The read-only SSO/SCIM/MDM integration status records (PA-008). */
export const ENTERPRISE_INTEGRATION_REPOSITORY = "enterprise-integrations";

/** The connector provisioning records (RL-063/RL-044; execution-written). */
export const CONNECTOR_PROVISIONING_REPOSITORY = "enterprise-connector-provisionings";

/** Fails closed on a record the domain's own parser rejects (never a guess). */
function enterpriseRecordCorrupt(what: string): never {
  throw new NotFoundError(
    `an enterprise record partition is corrupt (failing closed): ${what}`,
    { reason: "ENTERPRISE_RECORD_CORRUPT" },
  );
}

// --------------------------------------------------------------------------------
// The read-side source ports (what the workspace read composes over)
// --------------------------------------------------------------------------------

/**
 * The enterprise sources the workspace read binds. Each source is the READ
 * side of a domain-owned store; the default binding (see
 * {@link createPersistenceEnterpriseSources}) serves the shared persistence's
 * committed records through the domain's own parsers.
 */
export interface EnterpriseWorkspaceSources {
  /** The enrollment journey records (all tenants; the read scopes them). */
  readonly enrollments: EnterpriseEnrollmentSource;
  /** The organization policy read records (all tenants; the read scopes them). */
  readonly policies: EnterprisePolicySource;
  /** The integration status records (all tenants; the read scopes them). */
  readonly integrations: EnterpriseIntegrationSource;
  /** The connector provisioning records (tenant-scoped reads miss cross-tenant). */
  readonly connectorProvisioning: ConnectorProvisioningSource;
}

/** Lists enrollment journey records (the domain's store read shape). */
export interface EnterpriseEnrollmentSource {
  list(): Promise<readonly EnterpriseEnrollmentRecord[]>;
}

/** Lists organization policy read records (the domain's store read shape). */
export interface EnterprisePolicySource {
  list(): Promise<readonly OrganizationPolicyRecord[]>;
}

/** Lists integration status records (the domain's store read shape). */
export interface EnterpriseIntegrationSource {
  list(): Promise<readonly EnterpriseIntegrationStatusRecord[]>;
}

/**
 * Reads one connector provisioning record in a tenant scope (a cross-tenant
 * read MISSES — the domain store's own no-existence-oracle law).
 */
export interface ConnectorProvisioningSource {
  get(provisioningId: string, tenantId: string): Promise<ConnectorProvisioningRecord | null>;
}

// --------------------------------------------------------------------------------
// The write-side store ports (the domain stores' shapes, persistence-backed)
// --------------------------------------------------------------------------------

/**
 * The enrollment journey store port — structurally the domain's
 * InMemoryEnrollmentStore shape (packages/enterprise stores.ts), so the
 * domain's own services and the worker seam's enterprise executors compose
 * over EITHER implementation. Saves refuse non-advancing revisions (the
 * domain store's own law, mirrored — never a silent overwrite).
 */
export interface EnterpriseEnrollmentStore {
  save(record: EnterpriseEnrollmentRecord): Promise<void>;
  get(enrollmentId: string): Promise<EnterpriseEnrollmentRecord | null>;
  list(): Promise<readonly EnterpriseEnrollmentRecord[]>;
}

/**
 * The connector provisioning store port — structurally the domain's
 * InMemoryConnectorProvisioningStore shape. Saves refuse non-advancing
 * revisions; tenant-scoped reads MISS on cross-tenant access.
 */
export interface ConnectorProvisioningStore {
  save(record: ConnectorProvisioningRecord): Promise<void>;
  get(provisioningId: string, tenantId: string): Promise<ConnectorProvisioningRecord | null>;
  listByTenant(tenantId: string): Promise<readonly ConnectorProvisioningRecord[]>;
}

// --------------------------------------------------------------------------------
// The shared-persistence implementations
// --------------------------------------------------------------------------------

/**
 * The persistence-backed enrollment journey store: the domain's frozen record
 * (validated by its own parser on every read) persisted at the record's
 * enrollmentId, CAS-guarded by the records port's version token. The save law
 * mirrors the domain store's: a non-advancing revision is the typed refusal.
 */
export function createPersistenceEnrollmentStore(
  persistence: UnitOfWorkFactory & PersistenceReader,
): EnterpriseEnrollmentStore {
  return {
    async save(record: EnterpriseEnrollmentRecord): Promise<void> {
      const unitOfWork = await persistence.begin();
      try {
        const stored = await unitOfWork.records(ENTERPRISE_ENROLLMENT_REPOSITORY).get(
          record.enrollmentId,
        );
        if (stored !== null) {
          const existing = parseStoredEnrollment(stored.value);
          if (record.revision <= existing.revision) {
            throw new ConflictError(
              "the enrollment store refuses non-advancing revisions",
              { reason: "ENTERPRISE_STORE_STALE_WRITE" },
            );
          }
          await unitOfWork
            .records(ENTERPRISE_ENROLLMENT_REPOSITORY)
            .compareAndSwap(record.enrollmentId, stored.version, record as unknown as CanonicalJsonValue);
        } else {
          await unitOfWork
            .records(ENTERPRISE_ENROLLMENT_REPOSITORY)
            .insert(record.enrollmentId, record as unknown as CanonicalJsonValue);
        }
        await unitOfWork.commit();
      } catch (error) {
        await unitOfWork.rollback();
        throw error;
      }
    },
    async get(enrollmentId: string): Promise<EnterpriseEnrollmentRecord | null> {
      const stored = await persistence.records(ENTERPRISE_ENROLLMENT_REPOSITORY).get(enrollmentId);
      return stored === null ? null : parseStoredEnrollment(stored.value);
    },
    async list(): Promise<readonly EnterpriseEnrollmentRecord[]> {
      const records = await persistence.records(ENTERPRISE_ENROLLMENT_REPOSITORY).list();
      return records.map((record) => parseStoredEnrollment(record.value));
    },
  };
}

/**
 * The persistence-backed connector provisioning store (the domain's store
 * shape over the records port; same laws as the enrollment store).
 */
export function createPersistenceConnectorProvisioningStore(
  persistence: UnitOfWorkFactory & PersistenceReader,
): ConnectorProvisioningStore {
  return {
    async save(record: ConnectorProvisioningRecord): Promise<void> {
      const unitOfWork = await persistence.begin();
      try {
        const stored = await unitOfWork.records(CONNECTOR_PROVISIONING_REPOSITORY).get(
          record.provisioningId,
        );
        if (stored !== null) {
          const existing = parseStoredProvisioning(stored.value);
          if (record.revision <= existing.revision) {
            throw new ConflictError(
              "the provisioning store refuses non-advancing revisions",
              { reason: "ENTERPRISE_STORE_STALE_WRITE" },
            );
          }
          await unitOfWork
            .records(CONNECTOR_PROVISIONING_REPOSITORY)
            .compareAndSwap(record.provisioningId, stored.version, record as unknown as CanonicalJsonValue);
        } else {
          await unitOfWork
            .records(CONNECTOR_PROVISIONING_REPOSITORY)
            .insert(record.provisioningId, record as unknown as CanonicalJsonValue);
        }
        await unitOfWork.commit();
      } catch (error) {
        await unitOfWork.rollback();
        throw error;
      }
    },
    async get(provisioningId: string, tenantId: string): Promise<ConnectorProvisioningRecord | null> {
      const stored = await persistence
        .records(CONNECTOR_PROVISIONING_REPOSITORY)
        .get(provisioningId);
      if (stored === null) return null;
      const record = parseStoredProvisioning(stored.value);
      if (record.tenantId !== tenantId) return null; // cross-tenant miss (no oracle)
      return record;
    },
    async listByTenant(tenantId: string): Promise<readonly ConnectorProvisioningRecord[]> {
      const records = await persistence.records(CONNECTOR_PROVISIONING_REPOSITORY).list();
      return records
        .map((record) => parseStoredProvisioning(record.value))
        .filter((record) => record.tenantId === tenantId);
    },
  };
}

/**
 * The DEFAULT enterprise source binding: the shared persistence's committed
 * enterprise partitions, every record validated through the DOMAIN's own
 * fail-closed parsers (the authority — this service never re-validates a
 * domain record against rules of its own).
 */
export function createPersistenceEnterpriseSources(
  persistence: PersistenceReader,
): EnterpriseWorkspaceSources {
  return {
    enrollments: {
      list: async (): Promise<readonly EnterpriseEnrollmentRecord[]> => {
        const records = await persistence.records(ENTERPRISE_ENROLLMENT_REPOSITORY).list();
        return records.map((record) => parseStoredEnrollment(record.value));
      },
    },
    policies: {
      list: async (): Promise<readonly OrganizationPolicyRecord[]> => {
        const records = await persistence.records(ENTERPRISE_POLICY_REPOSITORY).list();
        return records.map((record) => parseStoredPolicy(record.value));
      },
    },
    integrations: {
      list: async (): Promise<readonly EnterpriseIntegrationStatusRecord[]> => {
        const records = await persistence.records(ENTERPRISE_INTEGRATION_REPOSITORY).list();
        return records.map((record) => parseStoredIntegration(record.value));
      },
    },
    connectorProvisioning: {
      get: async (
        provisioningId: string,
        tenantId: string,
      ): Promise<ConnectorProvisioningRecord | null> => {
        const stored = await persistence
          .records(CONNECTOR_PROVISIONING_REPOSITORY)
          .get(provisioningId);
        if (stored === null) return null;
        const record = parseStoredProvisioning(stored.value);
        if (record.tenantId !== tenantId) return null; // cross-tenant miss
        return record;
      },
    },
  };
}

// --------------------------------------------------------------------------------
// The domain parsers (fail-closed on anything the domain rejects)
// --------------------------------------------------------------------------------

function parseStoredEnrollment(value: unknown): EnterpriseEnrollmentRecord {
  try {
    return parseEnterpriseEnrollmentRecord(value);
  } catch (error) {
    enterpriseRecordCorrupt(
      `an enrollment record is not a domain enrollment record (${error instanceof Error ? error.name : "unknown error"})`,
    );
  }
}

function parseStoredPolicy(value: unknown): OrganizationPolicyRecord {
  try {
    return parseOrganizationPolicyRecord(value);
  } catch (error) {
    enterpriseRecordCorrupt(
      `a policy record is not a domain policy record (${error instanceof Error ? error.name : "unknown error"})`,
    );
  }
}

function parseStoredIntegration(value: unknown): EnterpriseIntegrationStatusRecord {
  try {
    return parseEnterpriseIntegrationStatusRecord(value);
  } catch (error) {
    enterpriseRecordCorrupt(
      `an integration record is not a domain integration record (${error instanceof Error ? error.name : "unknown error"})`,
    );
  }
}

function parseStoredProvisioning(value: unknown): ConnectorProvisioningRecord {
  try {
    return parseConnectorProvisioningRecord(value);
  } catch (error) {
    enterpriseRecordCorrupt(
      `a connector provisioning record is not a domain provisioning record (${error instanceof Error ? error.name : "unknown error"})`,
    );
  }
}
