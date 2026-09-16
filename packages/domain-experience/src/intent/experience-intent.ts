/**
 * ExperienceIntent + ExperienceIntentVersion (RL-011, spec/data-model.md
 * "Versioning": "Experience intents are immutable versions linked by a
 * supersession chain").
 *
 * The VERSION is the immutable truth: payload, payload digest, creator
 * rationale, creation instant and the `supersedes` link to the previous
 * version. The INTENT is the mutable header: status, current-version
 * pointer and the optimistic-concurrency revision (Wave-0 Revision, used by
 * services as the CAS token via the command envelope's intentVersion).
 *
 * State machine (validated transitions only):
 *
 *   draft ──activate──> active ──supersede──> superseded ──archive──> archived
 *     │                   │                                             (terminal)
 *     ├──cancel──> canceled│(terminal)
 *     └──archive──> archived
 *
 *  - activate: draft -> active (requires at least one version - always true:
 *    intents are created WITH version 1);
 *  - cancel: draft|active -> canceled (terminal);
 *  - archive: draft|active|superseded -> archived (terminal);
 *  - supersede: active -> superseded (intent-level replacement; names the
 *    successor intent);
 *  - appendVersion: draft|active only - creates version N+1 with
 *    supersedes = current version id (version-level supersession chain).
 *
 * NO ADCOS types (RL-LOCK-007): compilation to ADCOS ConnectivityIntent is
 * RL-012 (Wave 2) and lives outside the aggregate.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  parseExperienceIntentId,
  parseExperienceIntentVersionId,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  tenantIdFromUser,
  type Digest,
  type ExperienceIntentId,
  type ExperienceIntentVersionId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import type { DeviceId } from "@roamlink/contracts";
import { parseDeviceId } from "@roamlink/contracts";
import type { ExperienceIntentPayload } from "./intent-payload.js";
import { parseExperienceIntentPayload } from "./intent-payload.js";
import type { SafeText } from "./rationale.js";
import { parseRationale } from "./rationale.js";

export const EXPERIENCE_INTENT_STATUSES = [
  "draft",
  "active",
  "superseded",
  "archived",
  "canceled",
] as const;

export type ExperienceIntentStatus = (typeof EXPERIENCE_INTENT_STATUSES)[number];

export function isExperienceIntentStatus(value: unknown): value is ExperienceIntentStatus {
  return (
    typeof value === "string" && (EXPERIENCE_INTENT_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// ExperienceIntentVersion (immutable)
// ---------------------------------------------------------------------------

/** Serialized (plain) form of an immutable intent version. */
export interface ExperienceIntentVersionRecord {
  readonly tenantId: TenantId;
  readonly intentVersionId: ExperienceIntentVersionId;
  readonly intentId: ExperienceIntentId;
  /** 1-based position in the version chain (monotonic). */
  readonly versionNumber: Revision;
  readonly payload: ExperienceIntentPayload;
  /** Deterministic SHA-256 over the canonical payload JSON. */
  readonly payloadDigest: Digest;
  /** Bounded, printable creator rationale (why this version). */
  readonly rationale?: SafeText;
  /** The previous version in the supersession chain; undefined for v1. */
  readonly supersedes?: ExperienceIntentVersionId;
  readonly createdAt: UtcInstant;
}

/** Input accepted by the {@link ExperienceIntentVersion} constructor. */
export interface ExperienceIntentVersionInput {
  readonly tenantId: string;
  readonly intentVersionId: string;
  readonly intentId: string;
  readonly versionNumber: number;
  readonly payload: unknown;
  readonly rationale?: string;
  readonly supersedes?: string;
  readonly createdAt: string;
}

const ALLOWED_VERSION_FIELDS = new Set([
  "tenantId",
  "intentVersionId",
  "intentId",
  "versionNumber",
  "payload",
  "rationale",
  "supersedes",
  "createdAt",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntentVersion rejected: ${label} - ${issue}`, {
    reason: "INTENT_VERSION_INVALID",
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

/** Deterministic digest of a parsed payload (canonical JSON, Wave-0). */
export function digestOfIntentPayload(payload: ExperienceIntentPayload): Digest {
  return canonicalJsonDigest(payload);
}

/**
 * An immutable intent version. Frozen deeply; a new payload is always a NEW
 * version linked via `supersedes`.
 */
export class ExperienceIntentVersion {
  readonly tenantId: TenantId;
  readonly intentVersionId: ExperienceIntentVersionId;
  readonly intentId: ExperienceIntentId;
  readonly versionNumber: Revision;
  readonly payload: ExperienceIntentPayload;
  readonly payloadDigest: Digest;
  declare readonly rationale?: SafeText;
  declare readonly supersedes?: ExperienceIntentVersionId;
  readonly createdAt: UtcInstant;

  constructor(input: ExperienceIntentVersionInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_VERSION_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.tenantId = parseField("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'", () =>
      parseTenantId(input.tenantId),
    );
    this.intentVersionId = parseField(
      "intentVersionId",
      "must be a canonical lowercase UUID",
      () => parseExperienceIntentVersionId(input.intentVersionId),
    );
    this.intentId = parseField("intentId", "must be a canonical lowercase UUID", () =>
      parseExperienceIntentId(input.intentId),
    );
    if (typeof input.versionNumber !== "number" || !Number.isInteger(input.versionNumber) || input.versionNumber < 1) {
      field("versionNumber", "must be a positive integer (1-based chain position)");
    }
    this.versionNumber = input.versionNumber as Revision;
    this.payload = parseField("payload", "must be a valid intent payload", () =>
      parseExperienceIntentPayload(input.payload),
    );
    this.payloadDigest = digestOfIntentPayload(this.payload);
    if (input.rationale !== undefined) {
      this.rationale = parseRationale(input.rationale);
    }
    if (input.supersedes !== undefined) {
      this.supersedes = parseField("supersedes", "must be a canonical lowercase UUID when present", () =>
        parseExperienceIntentVersionId(input.supersedes),
      );
    }
    if (this.versionNumber === 1 && this.supersedes !== undefined) {
      field("supersedes", "version 1 starts the chain and supersedes nothing");
    }
    if (this.versionNumber > 1 && this.supersedes === undefined) {
      field("supersedes", "versions after the first must name the version they supersede");
    }
    this.createdAt = parseField(
      "createdAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.createdAt),
    );
    Object.freeze(this);
  }

  toRecord(): ExperienceIntentVersionRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      intentVersionId: this.intentVersionId,
      intentId: this.intentId,
      versionNumber: this.versionNumber,
      payload: this.payload,
      payloadDigest: this.payloadDigest,
      ...(this.rationale !== undefined ? { rationale: this.rationale } : {}),
      ...(this.supersedes !== undefined ? { supersedes: this.supersedes } : {}),
      createdAt: this.createdAt,
    });
  }

  static fromRecord(record: ExperienceIntentVersionRecord): ExperienceIntentVersion {
    return new ExperienceIntentVersion({
      tenantId: record.tenantId,
      intentVersionId: record.intentVersionId,
      intentId: record.intentId,
      versionNumber: record.versionNumber,
      payload: record.payload,
      ...(record.rationale !== undefined ? { rationale: record.rationale } : {}),
      ...(record.supersedes !== undefined ? { supersedes: record.supersedes } : {}),
      createdAt: record.createdAt,
    });
  }
}

// ---------------------------------------------------------------------------
// ExperienceIntent (mutable header over the immutable version chain)
// ---------------------------------------------------------------------------

/** Serialized (plain) form of the intent header. */
export interface ExperienceIntentRecord {
  readonly tenantId: TenantId;
  readonly intentId: ExperienceIntentId;
  readonly ownerUserId: UserId;
  /** Optional target device; must reference a non-retired device in-tenant. */
  readonly deviceId?: DeviceId;
  readonly status: ExperienceIntentStatus;
  readonly currentVersionId: ExperienceIntentVersionId;
  readonly currentVersionNumber: Revision;
  /** Set when superseded: the successor intent. */
  readonly supersededBy?: ExperienceIntentId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link ExperienceIntent} constructor. */
export interface ExperienceIntentInput {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly deviceId?: string;
  readonly status: string;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  readonly supersededBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INTENT_FIELDS = new Set([
  "intentId",
  "ownerUserId",
  "deviceId",
  "status",
  "currentVersionId",
  "currentVersionNumber",
  "supersededBy",
  "createdAt",
  "updatedAt",
  "revision",
]);

function intentField(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntent rejected: ${label} - ${issue}`, {
    reason: "EXPERIENCE_INTENT_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The mutable intent header. Transitions return NEW frozen instances with
 * the revision bumped; version appends return the new version alongside.
 */
export class ExperienceIntent {
  readonly tenantId: TenantId;
  readonly intentId: ExperienceIntentId;
  readonly ownerUserId: UserId;
  declare readonly deviceId?: DeviceId;
  readonly status: ExperienceIntentStatus;
  readonly currentVersionId: ExperienceIntentVersionId;
  readonly currentVersionNumber: Revision;
  declare readonly supersededBy?: ExperienceIntentId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: ExperienceIntentInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      intentField("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INTENT_FIELDS.has(key)) {
        intentField(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.intentId = parseField("intentId", "must be a canonical lowercase UUID", () =>
      parseExperienceIntentId(input.intentId),
    ) ?? intentField("intentId", "unreachable");
    this.ownerUserId = parseField("ownerUserId", "must be a canonical lowercase UUID", () =>
      parseUserId(input.ownerUserId),
    );
    this.tenantId = tenantIdFromUser(this.ownerUserId);
    if (input.deviceId !== undefined) {
      this.deviceId = parseField("deviceId", "must be a canonical lowercase UUID when present", () =>
        parseDeviceId(input.deviceId),
      );
    }
    if (!isExperienceIntentStatus(input.status)) {
      intentField("status", "must be draft, active, superseded, archived or canceled");
    }
    this.status = input.status;
    this.currentVersionId = parseField(
      "currentVersionId",
      "must be a canonical lowercase UUID",
      () => parseExperienceIntentVersionId(input.currentVersionId),
    );
    if (
      typeof input.currentVersionNumber !== "number" ||
      !Number.isInteger(input.currentVersionNumber) ||
      input.currentVersionNumber < 1
    ) {
      intentField("currentVersionNumber", "must be a positive integer");
    }
    this.currentVersionNumber = input.currentVersionNumber as Revision;
    if (input.supersededBy !== undefined) {
      this.supersededBy = parseField(
        "supersededBy",
        "must be a canonical lowercase UUID when present",
        () => parseExperienceIntentId(input.supersededBy),
      );
      if (this.supersededBy === this.intentId) {
        intentField("supersededBy", "an intent cannot supersede itself");
      }
      if (this.status !== "superseded" && this.status !== "archived") {
        intentField(
          "supersededBy",
          "only a superseded intent names a successor (preserved through archiving)",
        );
      }
    }
    if (this.status === "superseded" && this.supersededBy === undefined) {
      intentField("supersededBy", "a superseded intent must name its successor");
    }
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
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      intentField("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /**
   * Appends the next immutable version (draft/active only). Returns the new
   * version record plus the bumped header; the caller persists both.
   */
  appendVersion(input: {
    readonly intentVersionId: string;
    readonly payload: unknown;
    readonly rationale?: string;
    readonly at: UtcInstant;
  }): { readonly intent: ExperienceIntent; readonly version: ExperienceIntentVersion } {
    if (this.status !== "draft" && this.status !== "active") {
      intentField(
        "status",
        "versions may only be appended to a draft or active intent (superseded/archived/canceled intents are frozen)",
      );
    }
    const version = new ExperienceIntentVersion({
      tenantId: this.tenantId,
      intentVersionId: input.intentVersionId,
      intentId: this.intentId,
      versionNumber: this.currentVersionNumber + 1,
      payload: input.payload,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      supersedes: this.currentVersionId,
      createdAt: input.at,
    });
    const intent = new ExperienceIntent({
      intentId: this.intentId,
      ownerUserId: this.ownerUserId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      status: this.status,
      currentVersionId: version.intentVersionId,
      currentVersionNumber: version.versionNumber,
      ...(this.supersededBy !== undefined ? { supersededBy: this.supersededBy } : {}),
      createdAt: this.createdAt,
      updatedAt: input.at,
      revision: this.revision + 1,
    });
    return Object.freeze({ intent, version });
  }

  /** draft -> active. */
  activate(at: UtcInstant): ExperienceIntent {
    if (this.status !== "draft") {
      intentField("status", "only a draft intent can be activated");
    }
    return this.with({ status: "active", updatedAt: at });
  }

  /** draft|active -> canceled (terminal). */
  cancel(at: UtcInstant): ExperienceIntent {
    if (this.status !== "draft" && this.status !== "active") {
      intentField("status", "only a draft or active intent can be canceled");
    }
    return this.with({ status: "canceled", updatedAt: at });
  }

  /** draft|active|superseded -> archived (terminal). */
  archive(at: UtcInstant): ExperienceIntent {
    if (this.status === "archived" || this.status === "canceled") {
      intentField("status", "an archived or canceled intent is terminal");
    }
    return this.with({ status: "archived", updatedAt: at });
  }

  /** active -> superseded, naming the successor intent. */
  supersede(successorIntentId: string, at: UtcInstant): ExperienceIntent {
    if (this.status !== "active") {
      intentField("status", "only an active intent can be superseded");
    }
    return this.with({ status: "superseded", supersededBy: successorIntentId, updatedAt: at });
  }

  private with(overrides: {
    status?: ExperienceIntentStatus;
    supersededBy?: string;
    updatedAt?: UtcInstant;
  }): ExperienceIntent {
    return new ExperienceIntent({
      intentId: this.intentId,
      ownerUserId: this.ownerUserId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      status: overrides.status ?? this.status,
      currentVersionId: this.currentVersionId,
      currentVersionNumber: this.currentVersionNumber,
      ...(overrides.supersededBy !== undefined
        ? { supersededBy: overrides.supersededBy }
        : this.supersededBy !== undefined
          ? { supersededBy: this.supersededBy }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): ExperienceIntentRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      intentId: this.intentId,
      ownerUserId: this.ownerUserId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      status: this.status,
      currentVersionId: this.currentVersionId,
      currentVersionNumber: this.currentVersionNumber,
      ...(this.supersededBy !== undefined ? { supersededBy: this.supersededBy } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: ExperienceIntentRecord): ExperienceIntent {
    return new ExperienceIntent({
      intentId: record.intentId,
      ownerUserId: record.ownerUserId,
      ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      status: record.status,
      currentVersionId: record.currentVersionId,
      currentVersionNumber: record.currentVersionNumber,
      ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}
