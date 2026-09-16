/**
 * User aggregate (RL-004, spec/data-model.md "Experience" aggregates).
 *
 * A User is a RoamLink account principal and the root of a personal tenant
 * `usr:<UserId>` (Wave-0 TenantId). The record is immutable: every transition
 * returns a NEW frozen instance with the revision bumped, so persistence can
 * compare-and-swap (RL-003-compatible optimistic concurrency).
 *
 * No ADCOS fields exist on this aggregate (RL-LOCK-003): ADCOS identity is a
 * distinct domain connected only through explicit integration credentials in
 * later waves.
 */
import {
  ValidationError,
  parseRevision,
  parseUserId,
  parseUtcInstant,
  tenantIdFromUser,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { parseEmailAddress, parseSafeLabel, type EmailAddress, type SafeLabel } from "./contact.js";

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && (USER_STATUSES as readonly string[]).includes(value);
}

/** Serialized (plain) form of a user record. */
export interface UserRecord {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly displayName: SafeLabel;
  readonly status: UserStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  /** Optimistic-concurrency token; 1 on creation (Wave-0 Revision). */
  readonly revision: Revision;
}

/** Input accepted by the {@link User} constructor (raw strings, validated inside). */
export interface UserInput {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "userId",
  "email",
  "displayName",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`User rejected: ${label} - ${issue}`, {
    reason: "USER_INVALID",
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

function parseUserStatus(value: unknown): UserStatus {
  if (!isUserStatus(value)) {
    field("status", "must be 'active' or 'suspended'");
  }
  return value;
}

/**
 * The User aggregate. Deeply frozen; transitions return new instances with
 * the revision bumped (never mutate in place).
 */
export class User {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly displayName: SafeLabel;
  readonly status: UserStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: UserInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.userId = parseField("userId", "must be a canonical lowercase UUID", () =>
      parseUserId(input.userId),
    );
    this.tenantId = tenantIdFromUser(this.userId);
    this.email = parseField("email", "must be a bounded, well-formed email address", () =>
      parseEmailAddress(input.email),
    );
    this.displayName = parseField("displayName", "must be a bounded printable display label", () =>
      parseSafeLabel(input.displayName, "User.displayName"),
    );
    this.status = parseUserStatus(input.status);
    this.createdAt = parseField("createdAt", "must be a UTC instant with a zone designator", () =>
      parseUtcInstant(input.createdAt),
    );
    this.updatedAt = parseField("updatedAt", "must be a UTC instant with a zone designator", () =>
      parseUtcInstant(input.updatedAt),
    );
    this.revision = parseField(
      "revision",
      "must be a positive integer (optimistic-concurrency token)",
      () => parseRevision(input.revision),
    );
    Object.freeze(this);
  }

  /** Suspends the account (active -> suspended). */
  suspend(at: UtcInstant): User {
    if (this.status !== "active") {
      field("status", "only an active user can be suspended");
    }
    return this.with({ status: "suspended", updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  /** Reactivates the account (suspended -> active). */
  reactivate(at: UtcInstant): User {
    if (this.status !== "suspended") {
      field("status", "only a suspended user can be reactivated");
    }
    return this.with({ status: "active", updatedAt: at, revision: parseRevision(this.revision + 1) });
  }

  /** Renames the account (display label only; identity fields are immutable). */
  changeDisplayName(displayName: string, at: UtcInstant): User {
    return this.with({
      displayName: parseSafeLabel(displayName, "User.displayName"),
      updatedAt: at,
      revision: parseRevision(this.revision + 1),
    });
  }

  private with(overrides: {
    status?: UserStatus;
    displayName?: SafeLabel;
    updatedAt?: UtcInstant;
    revision?: Revision;
  }): User {
    return new User({
      userId: this.userId,
      email: this.email,
      displayName: overrides.displayName ?? this.displayName,
      status: overrides.status ?? this.status,
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: overrides.revision ?? this.revision,
    });
  }

  toRecord(): UserRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      userId: this.userId,
      email: this.email,
      displayName: this.displayName,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: UserRecord): User {
    return new User({
      userId: record.userId,
      email: record.email,
      displayName: record.displayName,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}
