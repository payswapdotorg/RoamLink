/**
 * Organization aggregate (RL-004, spec/data-model.md).
 *
 * An Organization is an enterprise tenant root: its tenant is
 * `org:<OrganizationId>` (Wave-0 TenantId). Enterprise integrations (SSO/SCIM/
 * MDM, spec/architecture.md §8) attach LATER - RL-004 owns only the account
 * lifecycle: active <-> suspended, with the suspended state reactivatable
 * through the sanctioned authorization escape (see authorization.ts).
 *
 * Immutable record semantics like User: transitions return new frozen
 * instances with the revision bumped for optimistic concurrency.
 */
import {
  ValidationError,
  parseOrganizationId,
  parseRevision,
  parseUtcInstant,
  tenantIdFromOrganization,
  type OrganizationId,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { parseSafeLabel, type SafeLabel } from "./contact.js";

export const ORGANIZATION_STATUSES = ["active", "suspended"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return typeof value === "string" && (ORGANIZATION_STATUSES as readonly string[]).includes(value);
}

/** Serialized (plain) form of an organization record. */
export interface OrganizationRecord {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly name: SafeLabel;
  readonly status: OrganizationStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Organization} constructor. */
export interface OrganizationInput {
  readonly organizationId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "organizationId",
  "name",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Organization rejected: ${label} - ${issue}`, {
    reason: "ORGANIZATION_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

/**
 * The Organization aggregate. Deeply frozen; transitions return new instances.
 */
export class Organization {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly name: SafeLabel;
  readonly status: OrganizationStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: OrganizationInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.organizationId = parseField(
      "organizationId",
      "must be a canonical lowercase UUID",
      () => parseOrganizationId(input.organizationId),
    );
    this.tenantId = tenantIdFromOrganization(this.organizationId);
    this.name = parseField("name", "must be a bounded printable organization name", () =>
      parseSafeLabel(input.name, "Organization.name"),
    );
    if (!isOrganizationStatus(input.status)) {
      field("status", "must be 'active' or 'suspended'");
    }
    this.status = input.status;
    this.createdAt = parseField(
      "createdAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.createdAt),
    );
    this.updatedAt = parseField(
      "updatedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.updatedAt),
    );
    this.revision = parseField(
      "revision",
      "must be a positive integer (optimistic-concurrency token)",
      () => parseRevision(input.revision),
    );
    Object.freeze(this);
  }

  /** Suspends the organization (active -> suspended; blocks member access). */
  suspend(at: UtcInstant): Organization {
    if (this.status !== "active") {
      field("status", "only an active organization can be suspended");
    }
    return this.with({ status: "suspended", updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  /** Reactivates the organization (suspended -> active). */
  activate(at: UtcInstant): Organization {
    if (this.status !== "suspended") {
      field("status", "only a suspended organization can be activated");
    }
    return this.with({ status: "active", updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  /** Renames the organization. */
  rename(name: string, at: UtcInstant): Organization {
    return this.with({
      name: parseSafeLabel(name, "Organization.name"),
      updatedAt: at,
      revision: parseRevision(this.revision + 1),
    });
  }

  private with(overrides: {
    name?: SafeLabel;
    status?: OrganizationStatus;
    updatedAt?: UtcInstant;
    revision?: Revision;
  }): Organization {
    return new Organization({
      organizationId: this.organizationId,
      name: overrides.name ?? this.name,
      status: overrides.status ?? this.status,
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: overrides.revision ?? this.revision,
    });
  }

  toRecord(): OrganizationRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      organizationId: this.organizationId,
      name: this.name,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: OrganizationRecord): Organization {
    return new Organization({
      organizationId: record.organizationId,
      name: record.name,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}
