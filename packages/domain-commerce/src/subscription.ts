/**
 * The Subscription aggregate (RL-021, spec/data-model.md "Commerce").
 *
 * A Subscription tracks a customer's COMMERCIAL ENTITLEMENT TERM: which
 * variant was bought, for how many days, from which order line, and its
 * commercial lifecycle. It does NOT track connectivity delivery
 * (RL-LOCK-008 "payment is not delivery"): no reservation, session, path,
 * usage or settlement state lives here, and a subscription never authorizes
 * connectivity - the commerce-to-connectivity reference model is Wave 3
 * (RL-023) and runs through the intent compilation (RL-012), never through
 * this aggregate.
 *
 * `customer_subscription_state` is its own vocabulary (spec/data-model.md
 * "State separation"); payment state (RL-022, Wave 3) is a SEPARATE enum
 * and may only be combined read-side.
 *
 * State machine (validated transitions only, terminal states: cancelled,
 * expired, superseded):
 *
 *   pending ──activate──> active ──complete-term──> expired (terminal)
 *      │                   │  ^                        ^
 *      │                   │  └──────resume────────────┘ (via suspended)
 *      │                   v
 *      │               suspended
 *      │                   │
 *      ├──cancel──────────┴──> cancelled (terminal)
 *      └──supersede──────────> superseded (terminal, points at the successor)
 *
 * ACTIVATION starts the commercial term: `startAt` = the activation instant,
 * `endAt` = startAt + termDays (pure arithmetic on the caller-supplied
 * instant - no ambient clock). `expire` requires the term to have actually
 * elapsed (`at >= endAt`).
 *
 * SUPERSESSION of subscription changes: a plan change does NOT mutate the
 * old subscription's commercial terms - it marks them `superseded` with an
 * explicit `supersededBy` forward pointer and creates a NEW subscription
 * carrying a `supersedes` back pointer. The chain is auditable exactly like
 * ExperienceIntent versions; historical terms are never silently rewritten.
 */
import {
  ValidationError,
  epochMsOf,
  parseContractVersion,
  utcInstantFromEpochMs,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ContractVersion,
  type OrderId,
  type OrderLineId,
  type ProductVariantId,
  type Revision,
  type SubscriptionId,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "suspended",
  "cancelled",
  "expired",
  "superseded",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/** The typed, explicit subscription transitions. */
export const SUBSCRIPTION_TRANSITIONS = [
  "activate",
  "suspend",
  "resume",
  "cancel",
  "expire",
  "supersede",
] as const;

export type SubscriptionTransition = (typeof SUBSCRIPTION_TRANSITIONS)[number];

export const MAX_SUBSCRIPTION_TERM_DAYS = 3650;
const DAY_MS = 86_400_000;
export const MAX_NOTE_LENGTH = 280;

/** Serialized (plain) form of a subscription. */
export interface SubscriptionRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly subscriptionId: SubscriptionId;
  readonly ownerUserId: UserId;
  readonly variantId: ProductVariantId;
  readonly variantSku: string;
  readonly billingModel: string;
  /** Commercial entitlement term snapshotted from the variant (days). */
  readonly termDays: number;
  /** Present only when created from an order (the commercial origin). */
  readonly originOrderId?: OrderId;
  readonly originOrderLineId?: OrderLineId;
  readonly status: SubscriptionStatus;
  /** Commercial term bounds; set at activation. */
  readonly startAt?: UtcInstant;
  readonly endAt?: UtcInstant;
  /** Back pointer: this subscription replaced that one (supersession). */
  readonly supersedes?: SubscriptionId;
  /** Forward pointer: that subscription replaced this one (supersession). */
  readonly supersededBy?: SubscriptionId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Subscription} constructor. */
export interface SubscriptionInput {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly variantId: string;
  readonly variantSku: string;
  readonly billingModel: string;
  readonly termDays: number;
  readonly originOrderId?: string;
  readonly originOrderLineId?: string;
  readonly status: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly supersedes?: string;
  readonly supersededBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "subscriptionId",
  "tenantId",
  "ownerUserId",
  "variantId",
  "variantSku",
  "billingModel",
  "termDays",
  "originOrderId",
  "originOrderLineId",
  "status",
  "startAt",
  "endAt",
  "supersedes",
  "supersededBy",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Subscription rejected: ${label} - ${issue}`, {
    reason: "SUBSCRIPTION_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The Subscription aggregate. Frozen deeply; transitions return new
 * instances with the revision bumped.
 */
export class Subscription {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly subscriptionId: SubscriptionId;
  readonly ownerUserId: UserId;
  readonly variantId: ProductVariantId;
  readonly variantSku: string;
  readonly billingModel: string;
  readonly termDays: number;
  declare readonly originOrderId?: OrderId;
  declare readonly originOrderLineId?: OrderLineId;
  readonly status: SubscriptionStatus;
  declare readonly startAt?: UtcInstant;
  declare readonly endAt?: UtcInstant;
  declare readonly supersedes?: SubscriptionId;
  declare readonly supersededBy?: SubscriptionId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: SubscriptionInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the subscription vocabulary is closed; no connectivity/delivery fields exist on commerce records, RL-LOCK-008)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    this.subscriptionId = parseUuidField<SubscriptionId>(input.subscriptionId, "subscriptionId");
    this.tenantId = parseTenantField(input.tenantId);
    this.ownerUserId = parseUserField(input.ownerUserId);
    this.variantId = parseVariantField(input.variantId);
    if (typeof input.variantSku !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.variantSku)) {
      field("variantSku", "must be the variant's slug (letter/digit start, then [a-z0-9-], max 64)");
    }
    this.variantSku = input.variantSku;
    if (input.billingModel !== "one_time" && input.billingModel !== "recurring") {
      field("billingModel", "must be one_time or recurring (snapshotted from the variant)");
    }
    this.billingModel = input.billingModel;
    if (
      typeof input.termDays !== "number" ||
      !Number.isInteger(input.termDays) ||
      input.termDays < 1 ||
      input.termDays > MAX_SUBSCRIPTION_TERM_DAYS
    ) {
      field("termDays", `must be an integer between 1 and ${MAX_SUBSCRIPTION_TERM_DAYS} (the commercial term)`);
    }
    this.termDays = input.termDays;
    if (input.originOrderId !== undefined) {
      this.originOrderId = parseOrderRefField<OrderId>(input.originOrderId, "originOrderId");
    }
    if (input.originOrderLineId !== undefined) {
      this.originOrderLineId = parseOrderRefField<OrderLineId>(input.originOrderLineId, "originOrderLineId");
    }
    if ((input.originOrderId === undefined) !== (input.originOrderLineId === undefined)) {
      field("originOrderId", "origin order and origin line references appear together or not at all");
    }
    if (!isSubscriptionStatus(input.status)) {
      field("status", "must be pending, active, suspended, cancelled, expired or superseded");
    }
    this.status = input.status;
    if (input.startAt !== undefined) {
      this.startAt = parseInstantField(input.startAt, "startAt");
    }
    if (input.endAt !== undefined) {
      this.endAt = parseInstantField(input.endAt, "endAt");
    }
    if ((input.startAt === undefined) !== (input.endAt === undefined)) {
      field("startAt", "the commercial term bounds appear together or not at all");
    }
    if (this.startAt !== undefined && this.endAt !== undefined && this.endAt < this.startAt) {
      field("endAt", "the term end must not precede the term start");
    }
    if (this.status === "active" && this.startAt === undefined) {
      field("startAt", "an active subscription must carry its commercial term bounds");
    }
    if (this.status === "expired" && this.startAt === undefined) {
      field("startAt", "an expired subscription must carry its completed term bounds");
    }
    if (input.supersedes !== undefined) {
      this.supersedes = parseUuidField<SubscriptionId>(input.supersedes, "supersedes");
    }
    if (input.supersededBy !== undefined) {
      this.supersededBy = parseUuidField<SubscriptionId>(input.supersededBy, "supersededBy");
    }
    if (this.status === "superseded" && this.supersededBy === undefined) {
      field("supersededBy", "a superseded subscription must point at its successor");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /**
   * pending -> active. Activation STARTS the commercial term: startAt = at,
   * endAt = at + termDays (pure arithmetic, no ambient clock).
   */
  activate(at: UtcInstant): Subscription {
    if (this.status !== "pending") {
      field("status", "only a pending subscription can be activated");
    }
    const startAt = at;
    const endAt = utcInstantPlusDays(at, this.termDays);
    return this.with({ status: "active", startAt, endAt, updatedAt: at });
  }

  /** active -> suspended (a temporary commercial halt; no connectivity claim). */
  suspend(at: UtcInstant): Subscription {
    if (this.status !== "active") {
      field("status", "only an active subscription can be suspended");
    }
    return this.with({ status: "suspended", updatedAt: at });
  }

  /** suspended -> active. The term bounds never change on resume. */
  resume(at: UtcInstant): Subscription {
    if (this.status !== "suspended") {
      field("status", "only a suspended subscription can be resumed");
    }
    if (this.startAt !== undefined && this.endAt !== undefined && at > this.endAt) {
      field("status", "the commercial term has already elapsed; resume cannot extend it (start a new subscription)");
    }
    return this.with({ status: "active", updatedAt: at });
  }

  /** pending|active|suspended -> cancelled (terminal). */
  cancel(at: UtcInstant): Subscription {
    if (this.status !== "pending" && this.status !== "active" && this.status !== "suspended") {
      field("status", "a cancelled, expired or superseded subscription is terminal");
    }
    return this.with({ status: "cancelled", updatedAt: at });
  }

  /** active -> expired (terminal). The term must have actually elapsed. */
  expire(at: UtcInstant): Subscription {
    if (this.status !== "active") {
      field("status", "only an active subscription can expire");
    }
    if (this.endAt === undefined || at < this.endAt) {
      field("endAt", "a subscription can only expire once its commercial term has elapsed");
    }
    return this.with({ status: "expired", updatedAt: at });
  }

  /**
   * active|suspended -> superseded (terminal). The successor pointer is
   * validated by the service (same tenant, same owner); this aggregate only
   * records the explicit forward reference.
   */
  supersede(supersededBy: SubscriptionId, at: UtcInstant): Subscription {
    if (this.status !== "active" && this.status !== "suspended") {
      field("status", "only an active or suspended subscription can be superseded (a cancelled, expired or already-superseded subscription is terminal)");
    }
    return this.with({ status: "superseded", supersededBy, updatedAt: at });
  }

  /** The next subscription state after a typed transition (read-side helper). */
  static transitionFrom(
    status: SubscriptionStatus,
    transition: SubscriptionTransition,
  ): SubscriptionStatus {
    switch (transition) {
      case "activate":
        return status === "pending" ? "active" : field("status", "only a pending subscription can be activated");
      case "suspend":
        return status === "active" ? "suspended" : field("status", "only an active subscription can be suspended");
      case "resume":
        return status === "suspended" ? "active" : field("status", "only a suspended subscription can be resumed");
      case "cancel":
        return status === "pending" || status === "active" || status === "suspended"
          ? "cancelled"
          : field("status", "a terminal subscription cannot be cancelled");
      case "expire":
        return status === "active" ? "expired" : field("status", "only an active subscription can expire");
      case "supersede":
        return status === "active" || status === "suspended"
          ? "superseded"
          : field("status", "only an active or suspended subscription can be superseded");
    }
  }

  private with(overrides: {
    status?: SubscriptionStatus;
    startAt?: UtcInstant;
    endAt?: UtcInstant;
    supersededBy?: SubscriptionId;
    updatedAt?: UtcInstant;
  }): Subscription {
    return new Subscription({
      subscriptionId: this.subscriptionId,
      tenantId: this.tenantId,
      ownerUserId: this.ownerUserId,
      variantId: this.variantId,
      variantSku: this.variantSku,
      billingModel: this.billingModel,
      termDays: this.termDays,
      ...(this.originOrderId !== undefined ? { originOrderId: this.originOrderId } : {}),
      ...(this.originOrderLineId !== undefined
        ? { originOrderLineId: this.originOrderLineId }
        : {}),
      status: overrides.status ?? this.status,
      ...(overrides.startAt !== undefined
        ? { startAt: overrides.startAt }
        : this.startAt !== undefined
          ? { startAt: this.startAt }
          : {}),
      ...(overrides.endAt !== undefined
        ? { endAt: overrides.endAt }
        : this.endAt !== undefined
          ? { endAt: this.endAt }
          : {}),
      ...(this.supersedes !== undefined ? { supersedes: this.supersedes } : {}),
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

  toRecord(): SubscriptionRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      subscriptionId: this.subscriptionId,
      ownerUserId: this.ownerUserId,
      variantId: this.variantId,
      variantSku: this.variantSku,
      billingModel: this.billingModel,
      termDays: this.termDays,
      ...(this.originOrderId !== undefined ? { originOrderId: this.originOrderId } : {}),
      ...(this.originOrderLineId !== undefined
        ? { originOrderLineId: this.originOrderLineId }
        : {}),
      status: this.status,
      ...(this.startAt !== undefined ? { startAt: this.startAt } : {}),
      ...(this.endAt !== undefined ? { endAt: this.endAt } : {}),
      ...(this.supersedes !== undefined ? { supersedes: this.supersedes } : {}),
      ...(this.supersededBy !== undefined ? { supersededBy: this.supersededBy } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: SubscriptionRecord): Subscription {
    return new Subscription({
      subscriptionId: record.subscriptionId,
      tenantId: record.tenantId,
      ownerUserId: record.ownerUserId,
      variantId: record.variantId,
      variantSku: record.variantSku,
      billingModel: record.billingModel,
      termDays: record.termDays,
      ...(record.originOrderId !== undefined ? { originOrderId: record.originOrderId } : {}),
      ...(record.originOrderLineId !== undefined
        ? { originOrderLineId: record.originOrderLineId }
        : {}),
      status: record.status,
      ...(record.startAt !== undefined ? { startAt: record.startAt } : {}),
      ...(record.endAt !== undefined ? { endAt: record.endAt } : {}),
      ...(record.supersedes !== undefined ? { supersedes: record.supersedes } : {}),
      ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored subscription record's contract version (fail-closed). */
export function assertSubscriptionRecordVersion(record: SubscriptionRecord): void {
  const version = parseContractVersion(record.contractVersion);
  if (!isDomainCommerceRecordVersionCompatible(version)) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

/** Pure day arithmetic on UTC instants (no month/calendar semantics). */
export function utcInstantPlusDays(instant: UtcInstant, days: number): UtcInstant {
  if (!Number.isInteger(days) || days < 0 || days > MAX_SUBSCRIPTION_TERM_DAYS) {
    throw new ValidationError("term arithmetic rejected: days - must be an integer between 0 and the term maximum", {
      reason: "SUBSCRIPTION_INVALID",
      details: [{ path: "days", issue: "out of the supported term range" }],
    });
  }
  return utcInstantFromEpochMs(epochMsOf(instant) + days * DAY_MS);
}

// --- shared field parsers (keep error reason SUBSCRIPTION_INVALID) ------------

function parseUuidField<T extends string>(value: string, label: string): T {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field(label, "must be a canonical lowercase UUID");
  }
  return value as T;
}

function parseVariantField(value: string): ProductVariantId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field("variantId", "must be a canonical lowercase UUID (the subscribed variant)");
  }
  return value as ProductVariantId;
}

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseUserField(value: string): UserId {
  try {
    return parseUserId(value);
  } catch {
    field("ownerUserId", "must be a canonical lowercase UUID (the subscribing customer)");
  }
}

function parseOrderRefField<T extends string>(value: string, label: string): T {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    field(label, "must be a canonical lowercase UUID (the commercial origin)");
  }
  return value as T;
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}
