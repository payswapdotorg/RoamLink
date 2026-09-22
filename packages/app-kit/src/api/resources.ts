/**
 * The public application API wire resources (RL-060/061, spec/api.md).
 *
 * Schema-first contract types + fail-closed parsers for every resource the
 * customer web app (RL-060) and the admin/operations console (RL-061) consume.
 * Responses expose RoamLink state plus relevant ADCOS REFERENCES/EVIDENCE and
 * never expose internal ADCOS implementation types (RL-LOCK-002/013;
 * spec/api.md "Provider leakage prohibition").
 *
 * State vocabularies are mirrored from the owning domain packages (each state
 * family stays a SEPARATE closed vocabulary - spec/data-model.md "State
 * separation"; a merged enum fails the conformance suite). The mirrors are
 * drift-guarded by tests against the domain definitions.
 */
import { ValidationError } from "@roamlink/contracts";

import {
  asArray,
  asBoolean,
  asEnum,
  asInstant,
  asNonNegativeInt,
  asNullableInstant,
  asNullableString,
  asNumberOrNull,
  asObject,
  asOptionalString,
  asPositiveInt,
  asString,
  arrayOf,
  rejectUnknownFields,
  requireFields,
} from "./parse-kit.js";

// --------------------------------------------------------------------------------
// Shared views
// --------------------------------------------------------------------------------

export const FRESHNESS_VIEW_STATES = ["FRESH", "STALE", "UNKNOWN"] as const;
export type FreshnessViewState = (typeof FRESHNESS_VIEW_STATES)[number];

/**
 * Freshness facts on the wire (RL-LOCK-010): observed/received/fresh-until
 * plus the evaluated state. Absent evidence presents as UNKNOWN - a valid
 * state, never a guess, never hidden.
 */
export interface FreshnessView {
  readonly observedAt: string | null;
  readonly receivedAt: string | null;
  readonly freshUntil: string | null;
  readonly freshnessState: FreshnessViewState;
}

/** Integer minor units + ISO-4217-style code (never floats). */
export interface MoneyView {
  readonly amountMinor: number;
  readonly currency: string;
}

export function parseFreshnessView(label: string, value: unknown): FreshnessView {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "observedAt",
    "receivedAt",
    "freshUntil",
    "freshnessState",
  ]);
  return Object.freeze({
    observedAt: asNullableInstant(`${label}.observedAt`, record["observedAt"]),
    receivedAt: asNullableInstant(`${label}.receivedAt`, record["receivedAt"]),
    freshUntil: asNullableInstant(`${label}.freshUntil`, record["freshUntil"]),
    freshnessState: asEnum(`${label}.freshnessState`, FRESHNESS_VIEW_STATES, record["freshnessState"]),
  });
}

function parseMoneyView(label: string, value: unknown): MoneyView {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["amountMinor", "currency"]);
  requireFields(label, record, ["amountMinor", "currency"]);
  const currency = asString(`${label}.currency`, record["currency"]);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError(`${label}.currency must be an ISO-4217-style code`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: `${label}.currency`, issue: "not a 3-letter uppercase code" }],
    });
  }
  return Object.freeze({
    amountMinor: asNonNegativeInt(`${label}.amountMinor`, record["amountMinor"]),
    currency,
  });
}

// --------------------------------------------------------------------------------
// Users / actor session
// --------------------------------------------------------------------------------

export interface UserResource {
  readonly userId: string;
  readonly displayName: string;
  readonly principalKind: "user" | "service";
}

/** The authenticated actor's scope + effective permissions in the tenant. */
export interface ActorSessionResource {
  readonly actorId: string;
  readonly userId: string | null;
  readonly tenantId: string;
  readonly scope: "user" | "organization";
  readonly role: "owner" | "admin" | "member" | null;
  readonly permissions: readonly string[];
}

export const ACCOUNT_PERMISSION_VOCABULARY = [
  "account:read",
  "account:manage",
  "org:read",
  "org:manage",
  "member:read",
  "member:invite",
  "member:manage",
  "owner:manage",
] as const;

function parseUserResourceAt(label: string, value: unknown): UserResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["userId", "displayName", "principalKind"]);
  requireFields(label, record, ["userId", "displayName", "principalKind"]);
  return Object.freeze({
    userId: asString(`${label}.userId`, record["userId"]),
    displayName: asString(`${label}.displayName`, record["displayName"]),
    principalKind: asEnum(`${label}.principalKind`, ["user", "service"], record["principalKind"]),
  });
}

export function parseActorSessionResource(value: unknown): ActorSessionResource {
  const label = "ActorSessionResource";
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "actorId",
    "userId",
    "tenantId",
    "scope",
    "role",
    "permissions",
  ]);
  requireFields(label, record, ["actorId", "tenantId", "scope", "permissions"]);
  const userId = record["userId"] === null ? null : asString(`${label}.userId`, record["userId"]);
  const role =
    record["role"] === null || record["role"] === undefined
      ? null
      : asEnum(`${label}.role`, ["owner", "admin", "member"], record["role"]);
  return Object.freeze({
    actorId: asString(`${label}.actorId`, record["actorId"]),
    userId,
    tenantId: asString(`${label}.tenantId`, record["tenantId"]),
    scope: asEnum(`${label}.scope`, ["user", "organization"], record["scope"]),
    role,
    permissions: arrayOf(
      `${label}.permissions`,
      record["permissions"],
      (elementLabel, element) =>
        asEnum(elementLabel, ACCOUNT_PERMISSION_VOCABULARY, element),
    ),
  });
}

// --------------------------------------------------------------------------------
// Devices (RL-010 surface)
// --------------------------------------------------------------------------------

export const DEVICE_RESOURCE_STATUSES = ["enrolled", "active", "suspended", "retired"] as const;
export type DeviceResourceStatus = (typeof DEVICE_RESOURCE_STATUSES)[number];

export const DEVICE_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;

export interface DeviceResource {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: (typeof DEVICE_PLATFORMS)[number];
  readonly status: DeviceResourceStatus;
  readonly ownership: { readonly userId?: string; readonly organizationId?: string };
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly capabilityFreshness: FreshnessView | null;
  readonly contextFreshness: FreshnessView | null;
}

function parseDeviceResourceAt(label: string, value: unknown): DeviceResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "deviceId",
    "name",
    "platform",
    "status",
    "ownership",
    "revision",
    "createdAt",
    "updatedAt",
    "capabilityFreshness",
    "contextFreshness",
  ]);
  requireFields(label, record, [
    "deviceId",
    "name",
    "platform",
    "status",
    "ownership",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  const ownership = asObject(`${label}.ownership`, record["ownership"]);
  rejectUnknownFields(`${label}.ownership`, ownership, ["userId", "organizationId"]);
  return Object.freeze({
    deviceId: asString(`${label}.deviceId`, record["deviceId"]),
    name: asString(`${label}.name`, record["name"]),
    platform: asEnum(`${label}.platform`, DEVICE_PLATFORMS, record["platform"]),
    status: asEnum(`${label}.status`, DEVICE_RESOURCE_STATUSES, record["status"]),
    ownership: Object.freeze({
      ...(ownership["userId"] !== undefined
        ? { userId: asString(`${label}.ownership.userId`, ownership["userId"]) }
        : {}),
      ...(ownership["organizationId"] !== undefined
        ? { organizationId: asString(`${label}.ownership.organizationId`, ownership["organizationId"]) }
        : {}),
    }),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
    capabilityFreshness:
      record["capabilityFreshness"] === null || record["capabilityFreshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.capabilityFreshness`, record["capabilityFreshness"]),
    contextFreshness:
      record["contextFreshness"] === null || record["contextFreshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.contextFreshness`, record["contextFreshness"]),
  });
}

// --------------------------------------------------------------------------------
// Device SIM & eSIM profiles (RL-115-F1 remediation, PA-001)
// --------------------------------------------------------------------------------

/**
 * The closed eSIM capability-name members this surface manages (a subset of
 * the §7 device capability vocabulary, spec/architecture.md §7 — the same
 * three names the domain-experience/edge closed vocabularies carry).
 */
export const ESIM_CAPABILITY_NAMES = [
  "esim_profile_install",
  "esim_profile_remove",
  "esim_profile_enable",
] as const;
export type EsimCapabilityName = (typeof ESIM_CAPABILITY_NAMES)[number];

/**
 * The platform-reported status per eSIM capability (mirrors the edge
 * capability-snapshot status vocabulary's members that reach this surface).
 * A status is evidence-backed metadata, never an action permission: acting
 * still passes the gate (RL-LOCK-011).
 */
export const ESIM_CAPABILITY_STATUSES = [
  "available",
  "requires-permission",
  "unavailable",
  "unknown",
] as const;
export type EsimCapabilityStatus = (typeof ESIM_CAPABILITY_STATUSES)[number];

/** The gate decisions the read may preview (mirrors the edge capability gate). */
export const ESIM_GATE_DECISIONS = ["allow", "deny", "degrade"] as const;
export type EsimGateDecision = (typeof ESIM_GATE_DECISIONS)[number];

/** The closed gate-reason vocabulary (mirrors the edge deny/degrade reasons). */
export const ESIM_GATE_REASONS = [
  "capability-requires-permission",
  "capability-unavailable",
  "capability-unknown",
  "evidence-class-insufficient",
  "evidence-stale",
] as const;
export type EsimGateReason = (typeof ESIM_GATE_REASONS)[number];

/**
 * The honest eSIM profile states. `install-requested` and `remove-requested`
 * are COMMANDED states: a command acceptance is never an installed profile
 * (the central truthfulness rule) — the platform confirmation flips them to
 * the confirmed states with evidence.
 */
export const ESIM_PROFILE_RESOURCE_STATES = [
  "install-requested",
  "enabled",
  "disabled",
  "remove-requested",
] as const;
export type EsimProfileState = (typeof ESIM_PROFILE_RESOURCE_STATES)[number];

/** The outstanding desired-state command kinds on a profile. */
export const ESIM_PENDING_COMMAND_KINDS = ["install", "remove", "enable", "disable"] as const;
export type EsimPendingCommandKind = (typeof ESIM_PENDING_COMMAND_KINDS)[number];

/** One eSIM capability's truth row: status, evidence, freshness, gate preview. */
export interface EsimCapabilityRowResource {
  readonly capability: EsimCapabilityName;
  readonly status: EsimCapabilityStatus;
  /** Evidence class backing the status (null when nothing was observed). */
  readonly evidenceClass: string | null;
  readonly freshness: FreshnessView | null;
  /** What the capability gate decides right now — before any action is offered. */
  readonly gate: {
    readonly decision: EsimGateDecision;
    /** The closed-vocabulary block reason; null on an allow. */
    readonly reason: EsimGateReason | null;
  };
}

/** One eSIM profile record with its honest evidence state. */
export interface EsimProfileResource {
  readonly profileId: string;
  readonly label: string;
  readonly state: EsimProfileState;
  /**
   * The platform evidence class backing the recorded state. Null while the
   * record is only COMMANDED (install/remove requested): a requested
   * install is not an installed profile.
   */
  readonly evidenceClass: string | null;
  readonly freshness: FreshnessView | null;
  readonly installedAt: string | null;
  /** The outstanding desired-state command, when the platform has not confirmed yet. */
  readonly pending: {
    readonly kind: EsimPendingCommandKind;
    readonly commandId: string;
    readonly requestedAt: string;
  } | null;
}

/**
 * The device-level SIM & Profiles read: the three eSIM capability truth
 * rows, the platform's install contract (whether installing requires
 * activation-code entry) and the profile inventory.
 */
export interface DeviceSimResource {
  readonly deviceId: string;
  readonly capabilities: readonly EsimCapabilityRowResource[];
  readonly installRequiresActivationCode: boolean;
  readonly profiles: readonly EsimProfileResource[];
}

function parseEsimCapabilityRowAt(label: string, value: unknown): EsimCapabilityRowResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "capability",
    "status",
    "evidenceClass",
    "freshness",
    "gate",
  ]);
  requireFields(label, record, ["capability", "status", "gate"]);
  const gate = asObject(`${label}.gate`, record["gate"]);
  rejectUnknownFields(`${label}.gate`, gate, ["decision", "reason"]);
  requireFields(`${label}.gate`, gate, ["decision"]);
  const decision = asEnum(`${label}.gate.decision`, ESIM_GATE_DECISIONS, gate["decision"]);
  const reason = gate["reason"];
  return Object.freeze({
    capability: asEnum(`${label}.capability`, ESIM_CAPABILITY_NAMES, record["capability"]),
    status: asEnum(`${label}.status`, ESIM_CAPABILITY_STATUSES, record["status"]),
    evidenceClass:
      record["evidenceClass"] === null || record["evidenceClass"] === undefined
        ? null
        : asString(`${label}.evidenceClass`, record["evidenceClass"]),
    freshness:
      record["freshness"] === null || record["freshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.freshness`, record["freshness"]),
    gate: Object.freeze({
      decision,
      // An allow gate carries no reason; a blocked gate always does.
      reason:
        decision === "allow"
          ? null
          : asEnum(`${label}.gate.reason`, ESIM_GATE_REASONS, reason ?? undefined),
    }),
  });
}

function parseEsimProfileAt(label: string, value: unknown): EsimProfileResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "profileId",
    "label",
    "state",
    "evidenceClass",
    "freshness",
    "installedAt",
    "pending",
  ]);
  requireFields(label, record, ["profileId", "label", "state"]);
  const state = asEnum(`${label}.state`, ESIM_PROFILE_RESOURCE_STATES, record["state"]);
  const rawPending = record["pending"];
  return Object.freeze({
    profileId: asString(`${label}.profileId`, record["profileId"]),
    label: asString(`${label}.label`, record["label"]),
    state,
    evidenceClass:
      record["evidenceClass"] === null || record["evidenceClass"] === undefined
        ? null
        : asString(`${label}.evidenceClass`, record["evidenceClass"]),
    freshness:
      record["freshness"] === null || record["freshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.freshness`, record["freshness"]),
    installedAt:
      record["installedAt"] === null || record["installedAt"] === undefined
        ? null
        : asInstant(`${label}.installedAt`, record["installedAt"]),
    pending:
      rawPending === null || rawPending === undefined
        ? null
        : parseEsimPendingAt(`${label}.pending`, rawPending),
  });
}

function parseEsimPendingAt(
  label: string,
  value: unknown,
): NonNullable<EsimProfileResource["pending"]> {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["kind", "commandId", "requestedAt"]);
  requireFields(label, record, ["kind", "commandId", "requestedAt"]);
  return Object.freeze({
    kind: asEnum(`${label}.kind`, ESIM_PENDING_COMMAND_KINDS, record["kind"]),
    commandId: asString(`${label}.commandId`, record["commandId"]),
    requestedAt: asInstant(`${label}.requestedAt`, record["requestedAt"]),
  });
}

export function parseDeviceSimResource(value: unknown): DeviceSimResource {
  const label = "DeviceSimResource";
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "deviceId",
    "capabilities",
    "installRequiresActivationCode",
    "profiles",
  ]);
  requireFields(label, record, [
    "deviceId",
    "capabilities",
    "installRequiresActivationCode",
    "profiles",
  ]);
  const capabilities = arrayOf(
    `${label}.capabilities`,
    record["capabilities"],
    parseEsimCapabilityRowAt,
  );
  if (capabilities.length !== ESIM_CAPABILITY_NAMES.length) {
    throw new ValidationError(
      `${label}.capabilities must carry exactly the three eSIM capability rows (esim_profile_install, esim_profile_remove, esim_profile_enable)`,
      {
        reason: "RESOURCE_INVALID",
        details: [
          { path: `${label}.capabilities`, issue: "not exactly the closed three-row set" },
        ],
      },
    );
  }
  return Object.freeze({
    deviceId: asString(`${label}.deviceId`, record["deviceId"]),
    capabilities,
    installRequiresActivationCode: asBoolean(
      `${label}.installRequiresActivationCode`,
      record["installRequiresActivationCode"],
    ),
    profiles: arrayOf(`${label}.profiles`, record["profiles"], parseEsimProfileAt),
  });
}

// --------------------------------------------------------------------------------
// Experience intents (RL-011/013 surface)
// --------------------------------------------------------------------------------

export const INTENT_RESOURCE_STATUSES = [
  "draft",
  "active",
  "superseded",
  "archived",
  "canceled",
] as const;
export type IntentResourceStatus = (typeof INTENT_RESOURCE_STATUSES)[number];

export const INTENT_VERSION_STATUSES = ["draft", "active", "superseded"] as const;

export const DERIVED_EXPERIENCE_STATUSES = [
  "experience_pending",
  "experience_supported",
  "experience_degraded",
  "experience_unresolved",
  "experience_closed",
] as const;
export type DerivedExperienceStatus = (typeof DERIVED_EXPERIENCE_STATUSES)[number];

export const INTENT_ACCESS_CLASSES = [
  "any_internet",
  "work_apps_only",
  "streaming",
  "low_power",
  "metered_cost_cap",
  "privacy_first",
  "regional_compliance",
] as const;
export type IntentAccessClass = (typeof INTENT_ACCESS_CLASSES)[number];

export interface IntentVersionSummary {
  readonly intentVersionId: string;
  readonly versionNumber: number;
  readonly status: (typeof INTENT_VERSION_STATUSES)[number];
  readonly rationale: string;
  readonly accessClasses: readonly IntentAccessClass[];
  readonly createdAt: string;
}

/** The explainable decision summary inlined into the intent resource. */
export interface ExperienceDecisionSummary {
  readonly decisionId: string;
  readonly derivedStatus: DerivedExperienceStatus;
  readonly computedAt: string;
  readonly subjectStatus: IntentResourceStatus;
  readonly inputFreshness: readonly FreshnessView[];
}

export interface ExperienceIntentResource {
  readonly intentId: string;
  readonly deviceId: string;
  readonly status: IntentResourceStatus;
  readonly revision: number;
  readonly supersededByIntentId?: string;
  readonly currentVersion: IntentVersionSummary | null;
  readonly versions: readonly IntentVersionSummary[];
  readonly decision: ExperienceDecisionSummary | null;
}

function parseIntentVersionSummary(label: string, value: unknown): IntentVersionSummary {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "intentVersionId",
    "versionNumber",
    "status",
    "rationale",
    "accessClasses",
    "createdAt",
  ]);
  requireFields(label, record, [
    "intentVersionId",
    "versionNumber",
    "status",
    "rationale",
    "accessClasses",
    "createdAt",
  ]);
  return Object.freeze({
    intentVersionId: asString(`${label}.intentVersionId`, record["intentVersionId"]),
    versionNumber: asPositiveInt(`${label}.versionNumber`, record["versionNumber"]),
    status: asEnum(`${label}.status`, INTENT_VERSION_STATUSES, record["status"]),
    rationale: asString(`${label}.rationale`, record["rationale"]),
    accessClasses: arrayOf(
      `${label}.accessClasses`,
      record["accessClasses"],
      (elementLabel, element) => asEnum(elementLabel, INTENT_ACCESS_CLASSES, element),
    ),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
  });
}

function parseDecisionSummary(label: string, value: unknown): ExperienceDecisionSummary {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "decisionId",
    "derivedStatus",
    "computedAt",
    "subjectStatus",
    "inputFreshness",
  ]);
  requireFields(label, record, [
    "decisionId",
    "derivedStatus",
    "computedAt",
    "subjectStatus",
    "inputFreshness",
  ]);
  return Object.freeze({
    decisionId: asString(`${label}.decisionId`, record["decisionId"]),
    derivedStatus: asEnum(
      `${label}.derivedStatus`,
      DERIVED_EXPERIENCE_STATUSES,
      record["derivedStatus"],
    ),
    computedAt: asInstant(`${label}.computedAt`, record["computedAt"]),
    subjectStatus: asEnum(`${label}.subjectStatus`, INTENT_RESOURCE_STATUSES, record["subjectStatus"]),
    inputFreshness: arrayOf(
      `${label}.inputFreshness`,
      record["inputFreshness"],
      parseFreshnessView,
    ),
  });
}

function parseExperienceIntentResourceAt(label: string, value: unknown): ExperienceIntentResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "intentId",
    "deviceId",
    "status",
    "revision",
    "supersededByIntentId",
    "currentVersion",
    "versions",
    "decision",
  ]);
  requireFields(label, record, ["intentId", "deviceId", "status", "revision", "versions"]);
  const supersededBy = asOptionalString(`${label}.supersededByIntentId`, record["supersededByIntentId"]);
  return Object.freeze({
    intentId: asString(`${label}.intentId`, record["intentId"]),
    deviceId: asString(`${label}.deviceId`, record["deviceId"]),
    status: asEnum(`${label}.status`, INTENT_RESOURCE_STATUSES, record["status"]),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    ...(supersededBy !== undefined ? { supersededByIntentId: supersededBy } : {}),
    currentVersion:
      record["currentVersion"] === null || record["currentVersion"] === undefined
        ? null
        : parseIntentVersionSummary(`${label}.currentVersion`, record["currentVersion"]),
    versions: arrayOf(`${label}.versions`, record["versions"], parseIntentVersionSummary),
    decision:
      record["decision"] === null || record["decision"] === undefined
        ? null
        : parseDecisionSummary(`${label}.decision`, record["decision"]),
  });
}

// --------------------------------------------------------------------------------
// Commerce: products / orders / subscriptions / payments / invoices
// --------------------------------------------------------------------------------

export const PRODUCT_RESOURCE_STATUSES = ["draft", "active", "retired"] as const;
export const BILLING_MODEL_VOCABULARY = ["one_time", "recurring"] as const;

export interface ProductVariantResource {
  readonly variantId: string;
  readonly name: string;
  readonly billingModel: (typeof BILLING_MODEL_VOCABULARY)[number];
  readonly price: MoneyView;
  readonly termDays?: number;
}

export interface ProductResource {
  readonly productId: string;
  readonly name: string;
  readonly description: string;
  readonly status: (typeof PRODUCT_RESOURCE_STATUSES)[number];
  readonly variants: readonly ProductVariantResource[];
}

function parseVariant(label: string, value: unknown): ProductVariantResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "variantId",
    "name",
    "billingModel",
    "price",
    "termDays",
  ]);
  requireFields(label, record, ["variantId", "name", "billingModel", "price"]);
  const termDays = record["termDays"];
  if (termDays !== undefined && (typeof termDays !== "number" || !Number.isInteger(termDays) || termDays < 1)) {
    throw new ValidationError(`${label}.termDays must be a positive integer when present`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: `${label}.termDays`, issue: "not a positive integer" }],
    });
  }
  return Object.freeze({
    variantId: asString(`${label}.variantId`, record["variantId"]),
    name: asString(`${label}.name`, record["name"]),
    billingModel: asEnum(`${label}.billingModel`, BILLING_MODEL_VOCABULARY, record["billingModel"]),
    price: parseMoneyView(`${label}.price`, record["price"]),
    ...(termDays !== undefined ? { termDays } : {}),
  });
}

function parseProductResource(label: string, value: unknown): ProductResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["productId", "name", "description", "status", "variants"]);
  requireFields(label, record, ["productId", "name", "description", "status", "variants"]);
  return Object.freeze({
    productId: asString(`${label}.productId`, record["productId"]),
    name: asString(`${label}.name`, record["name"]),
    description: asString(`${label}.description`, record["description"]),
    status: asEnum(`${label}.status`, PRODUCT_RESOURCE_STATUSES, record["status"]),
    variants: arrayOf(`${label}.variants`, record["variants"], parseVariant),
  });
}

export const ORDER_RESOURCE_STATUSES = ["draft", "placed", "completed", "cancelled"] as const;
export type OrderResourceStatus = (typeof ORDER_RESOURCE_STATUSES)[number];

export interface OrderLineResource {
  readonly lineId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPrice: MoneyView;
}

export interface OrderResource {
  readonly orderId: string;
  readonly status: OrderResourceStatus;
  readonly lines: readonly OrderLineResource[];
  readonly total: MoneyView;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseOrderLine(label: string, value: unknown): OrderLineResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["lineId", "productId", "variantId", "quantity", "unitPrice"]);
  requireFields(label, record, ["lineId", "productId", "variantId", "quantity", "unitPrice"]);
  return Object.freeze({
    lineId: asString(`${label}.lineId`, record["lineId"]),
    productId: asString(`${label}.productId`, record["productId"]),
    variantId: asString(`${label}.variantId`, record["variantId"]),
    quantity: asPositiveInt(`${label}.quantity`, record["quantity"]),
    unitPrice: parseMoneyView(`${label}.unitPrice`, record["unitPrice"]),
  });
}

function parseOrderResourceAt(label: string, value: unknown): OrderResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "orderId",
    "status",
    "lines",
    "total",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  requireFields(label, record, ["orderId", "status", "lines", "total", "revision", "createdAt", "updatedAt"]);
  return Object.freeze({
    orderId: asString(`${label}.orderId`, record["orderId"]),
    status: asEnum(`${label}.status`, ORDER_RESOURCE_STATUSES, record["status"]),
    lines: arrayOf(`${label}.lines`, record["lines"], parseOrderLine),
    total: parseMoneyView(`${label}.total`, record["total"]),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
  });
}

export const SUBSCRIPTION_RESOURCE_STATUSES = [
  "pending",
  "active",
  "suspended",
  "cancelled",
  "expired",
  "superseded",
] as const;
export type SubscriptionResourceStatus = (typeof SUBSCRIPTION_RESOURCE_STATUSES)[number];

export interface SubscriptionResource {
  readonly subscriptionId: string;
  readonly orderId: string;
  readonly variantId: string;
  readonly status: SubscriptionResourceStatus;
  readonly revision: number;
  readonly periodStart: string;
  readonly periodEnd?: string;
}

function parseSubscriptionResourceAt(label: string, value: unknown): SubscriptionResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "subscriptionId",
    "orderId",
    "variantId",
    "status",
    "revision",
    "periodStart",
    "periodEnd",
  ]);
  requireFields(label, record, [
    "subscriptionId",
    "orderId",
    "variantId",
    "status",
    "revision",
    "periodStart",
  ]);
  return Object.freeze({
    subscriptionId: asString(`${label}.subscriptionId`, record["subscriptionId"]),
    orderId: asString(`${label}.orderId`, record["orderId"]),
    variantId: asString(`${label}.variantId`, record["variantId"]),
    status: asEnum(`${label}.status`, SUBSCRIPTION_RESOURCE_STATUSES, record["status"]),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    periodStart: asInstant(`${label}.periodStart`, record["periodStart"]),
    ...(record["periodEnd"] !== undefined
      ? { periodEnd: asInstant(`${label}.periodEnd`, record["periodEnd"]) }
      : {}),
  });
}

export const CUSTOMER_PAYMENT_RESOURCE_STATES = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type CustomerPaymentResourceState = (typeof CUSTOMER_PAYMENT_RESOURCE_STATES)[number];

export interface PaymentResource {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: MoneyView;
  readonly state: CustomerPaymentResourceState;
  readonly recordedAt: string;
}

function parsePaymentResourceAt(label: string, value: unknown): PaymentResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["paymentId", "orderId", "amount", "state", "recordedAt"]);
  requireFields(label, record, ["paymentId", "orderId", "amount", "state", "recordedAt"]);
  return Object.freeze({
    paymentId: asString(`${label}.paymentId`, record["paymentId"]),
    orderId: asString(`${label}.orderId`, record["orderId"]),
    amount: parseMoneyView(`${label}.amount`, record["amount"]),
    state: asEnum(`${label}.state`, CUSTOMER_PAYMENT_RESOURCE_STATES, record["state"]),
    recordedAt: asInstant(`${label}.recordedAt`, record["recordedAt"]),
  });
}

export const CUSTOMER_INVOICE_RESOURCE_STATES = ["issued", "reconciled", "voided"] as const;
export type CustomerInvoiceResourceState = (typeof CUSTOMER_INVOICE_RESOURCE_STATES)[number];

export interface InvoiceResource {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amount: MoneyView;
  readonly state: CustomerInvoiceResourceState;
  readonly provenanceSummary: {
    readonly succeededPayments: number;
    readonly succeededRefunds: number;
  };
  readonly issuedAt: string;
  readonly reconciledAt?: string;
}

function parseInvoiceResourceAt(label: string, value: unknown): InvoiceResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "invoiceId",
    "orderId",
    "amount",
    "state",
    "provenanceSummary",
    "issuedAt",
    "reconciledAt",
  ]);
  requireFields(label, record, [
    "invoiceId",
    "orderId",
    "amount",
    "state",
    "provenanceSummary",
    "issuedAt",
  ]);
  const provenance = asObject(`${label}.provenanceSummary`, record["provenanceSummary"]);
  rejectUnknownFields(`${label}.provenanceSummary`, provenance, ["succeededPayments", "succeededRefunds"]);
  return Object.freeze({
    invoiceId: asString(`${label}.invoiceId`, record["invoiceId"]),
    orderId: asString(`${label}.orderId`, record["orderId"]),
    amount: parseMoneyView(`${label}.amount`, record["amount"]),
    state: asEnum(`${label}.state`, CUSTOMER_INVOICE_RESOURCE_STATES, record["state"]),
    provenanceSummary: Object.freeze({
      succeededPayments: asNonNegativeInt(
        `${label}.provenanceSummary.succeededPayments`,
        provenance["succeededPayments"],
      ),
      succeededRefunds: asNonNegativeInt(
        `${label}.provenanceSummary.succeededRefunds`,
        provenance["succeededRefunds"],
      ),
    }),
    issuedAt: asInstant(`${label}.issuedAt`, record["issuedAt"]),
    ...(record["reconciledAt"] !== undefined
      ? { reconciledAt: asInstant(`${label}.reconciledAt`, record["reconciledAt"]) }
      : {}),
  });
}

// --------------------------------------------------------------------------------
// The connectivity read (spec/api.md "Connectivity read API")
// --------------------------------------------------------------------------------

export const DELIVERY_EVIDENCE_RESOURCE_STATES = ["UNEVIDENCED", "EVIDENCED"] as const;
export type DeliveryEvidenceResourceState = (typeof DELIVERY_EVIDENCE_RESOURCE_STATES)[number];

export const REFERENCE_RESOURCE_STATUSES = ["active", "retired", "none"] as const;

export const CANONICAL_RESOURCE_TYPE_VOCABULARY = [
  "connectivity_intent",
  "connectivity_contract",
  "connectivity_lease",
  "contract_usage",
  "contract_assurance",
  "webhook_endpoint",
] as const;

/**
 * The honest connectivity view of one commercial subject: its own commercial
 * state, its reference lifecycle, its delivery-evidence state and the linked
 * evidence's freshness facts - side by side, with NO combined/derived opaque
 * status field (spec/data-model.md "State separation"; the combining happens
 * only in read models that expose the underlying states/evidence, never hide
 * them).
 */
export interface SubjectConnectivityResource {
  readonly subjectType: "order" | "subscription";
  readonly subjectId: string;
  readonly commercialState: string;
  readonly referenceStatus: (typeof REFERENCE_RESOURCE_STATUSES)[number];
  readonly deliveryEvidenceState: DeliveryEvidenceResourceState;
  readonly evidence: {
    readonly evidenceClass: string;
    readonly canonicalResourceType: (typeof CANONICAL_RESOURCE_TYPE_VOCABULARY)[number];
    readonly canonicalResourceId: string;
    readonly sourceVersion: number | null;
    readonly eventId: string | null;
    readonly payloadDigest: string;
    readonly freshness: FreshnessView & { readonly recordedFreshnessState: FreshnessViewState };
  } | null;
}

/** Per-device observation freshness (device observations are inputs, not truth). */
export interface DeviceObservationResource {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilityFreshness: FreshnessView | null;
  readonly contextFreshness: FreshnessView | null;
  readonly lastObservedAt: string | null;
}

/**
 * The answer to "what connectivity do I currently have?": authoritative ADCOS
 * projections (as delivery evidence through the reference model), device
 * observations, and freshness metadata - aggregated, never collapsed
 * (RL-LOCK-010; spec/api.md).
 */
export interface ConnectivityOverviewResource {
  readonly presentedAt: string;
  readonly subjects: readonly SubjectConnectivityResource[];
  readonly deviceObservations: readonly DeviceObservationResource[];
}

function parseSubjectConnectivity(label: string, value: unknown): SubjectConnectivityResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "subjectType",
    "subjectId",
    "commercialState",
    "referenceStatus",
    "deliveryEvidenceState",
    "evidence",
  ]);
  requireFields(label, record, [
    "subjectType",
    "subjectId",
    "commercialState",
    "referenceStatus",
    "deliveryEvidenceState",
  ]);
  const rawEvidence = record["evidence"];
  let evidence: SubjectConnectivityResource["evidence"] = null;
  if (rawEvidence !== null && rawEvidence !== undefined) {
    const evidenceRecord = asObject(`${label}.evidence`, rawEvidence);
    rejectUnknownFields(`${label}.evidence`, evidenceRecord, [
      "evidenceClass",
      "canonicalResourceType",
      "canonicalResourceId",
      "sourceVersion",
      "eventId",
      "payloadDigest",
      "freshness",
    ]);
    requireFields(`${label}.evidence`, evidenceRecord, [
      "evidenceClass",
      "canonicalResourceType",
      "canonicalResourceId",
      "payloadDigest",
      "freshness",
    ]);
    const freshnessRecord = asObject(`${label}.evidence.freshness`, evidenceRecord["freshness"]);
    rejectUnknownFields(`${label}.evidence.freshness`, freshnessRecord, [
      "observedAt",
      "receivedAt",
      "freshUntil",
      "freshnessState",
      "recordedFreshnessState",
    ]);
    requireFields(`${label}.evidence.freshness`, freshnessRecord, [
      "freshnessState",
      "recordedFreshnessState",
    ]);
    evidence = Object.freeze({
      evidenceClass: asString(`${label}.evidence.evidenceClass`, evidenceRecord["evidenceClass"]),
      canonicalResourceType: asEnum(
        `${label}.evidence.canonicalResourceType`,
        CANONICAL_RESOURCE_TYPE_VOCABULARY,
        evidenceRecord["canonicalResourceType"],
      ),
      canonicalResourceId: asString(
        `${label}.evidence.canonicalResourceId`,
        evidenceRecord["canonicalResourceId"],
      ),
      sourceVersion:
        evidenceRecord["sourceVersion"] === null || evidenceRecord["sourceVersion"] === undefined
          ? null
          : asPositiveInt(`${label}.evidence.sourceVersion`, evidenceRecord["sourceVersion"]),
      eventId:
        evidenceRecord["eventId"] === null || evidenceRecord["eventId"] === undefined
          ? null
          : asString(`${label}.evidence.eventId`, evidenceRecord["eventId"]),
      payloadDigest: asString(`${label}.evidence.payloadDigest`, evidenceRecord["payloadDigest"]),
      freshness: Object.freeze({
        observedAt: asNullableInstant(
          `${label}.evidence.freshness.observedAt`,
          freshnessRecord["observedAt"],
        ),
        receivedAt: asNullableInstant(
          `${label}.evidence.freshness.receivedAt`,
          freshnessRecord["receivedAt"],
        ),
        freshUntil: asNullableInstant(
          `${label}.evidence.freshness.freshUntil`,
          freshnessRecord["freshUntil"],
        ),
        freshnessState: asEnum(
          `${label}.evidence.freshness.freshnessState`,
          FRESHNESS_VIEW_STATES,
          freshnessRecord["freshnessState"],
        ),
        recordedFreshnessState: asEnum(
          `${label}.evidence.freshness.recordedFreshnessState`,
          FRESHNESS_VIEW_STATES,
          freshnessRecord["recordedFreshnessState"],
        ),
      }),
    });
  }
  return Object.freeze({
    subjectType: asEnum(`${label}.subjectType`, ["order", "subscription"], record["subjectType"]),
    subjectId: asString(`${label}.subjectId`, record["subjectId"]),
    commercialState: asString(`${label}.commercialState`, record["commercialState"]),
    referenceStatus: asEnum(`${label}.referenceStatus`, REFERENCE_RESOURCE_STATUSES, record["referenceStatus"]),
    deliveryEvidenceState: asEnum(
      `${label}.deliveryEvidenceState`,
      DELIVERY_EVIDENCE_RESOURCE_STATES,
      record["deliveryEvidenceState"],
    ),
    evidence,
  });
}

function parseDeviceObservation(label: string, value: unknown): DeviceObservationResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "deviceId",
    "deviceName",
    "capabilityFreshness",
    "contextFreshness",
    "lastObservedAt",
  ]);
  requireFields(label, record, ["deviceId", "deviceName"]);
  return Object.freeze({
    deviceId: asString(`${label}.deviceId`, record["deviceId"]),
    deviceName: asString(`${label}.deviceName`, record["deviceName"]),
    capabilityFreshness:
      record["capabilityFreshness"] === null || record["capabilityFreshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.capabilityFreshness`, record["capabilityFreshness"]),
    contextFreshness:
      record["contextFreshness"] === null || record["contextFreshness"] === undefined
        ? null
        : parseFreshnessView(`${label}.contextFreshness`, record["contextFreshness"]),
    lastObservedAt: asNullableInstant(`${label}.lastObservedAt`, record["lastObservedAt"]),
  });
}

export function parseConnectivityOverviewResource(value: unknown): ConnectivityOverviewResource {
  const label = "ConnectivityOverviewResource";
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["presentedAt", "subjects", "deviceObservations"]);
  requireFields(label, record, ["presentedAt", "subjects", "deviceObservations"]);
  return Object.freeze({
    presentedAt: asInstant(`${label}.presentedAt`, record["presentedAt"]),
    subjects: arrayOf(`${label}.subjects`, record["subjects"], parseSubjectConnectivity),
    deviceObservations: arrayOf(
      `${label}.deviceObservations`,
      record["deviceObservations"],
      parseDeviceObservation,
    ),
  });
}

// --------------------------------------------------------------------------------
// Notifications + support cases (RL-014 surface)
// --------------------------------------------------------------------------------

export const NOTIFICATION_RESOURCE_STATES = [
  "pending",
  "delivered",
  "failed",
  "read",
  "suppressed",
] as const;
export const NOTIFICATION_RESOURCE_TOPICS = [
  "order",
  "payment",
  "invoice",
  "refund",
  "subscription",
  "connectivity",
  "support",
  "system",
] as const;
export const NOTIFICATION_RESOURCE_SEVERITIES = ["info", "warning", "critical"] as const;
export const NOTIFICATION_RESOURCE_CHANNELS = ["in_app", "email", "push", "webhook"] as const;

export interface NotificationResource {
  readonly notificationId: string;
  readonly recipientUserId: string;
  readonly topic: (typeof NOTIFICATION_RESOURCE_TOPICS)[number];
  readonly severity: (typeof NOTIFICATION_RESOURCE_SEVERITIES)[number];
  readonly title: string;
  readonly body: string;
  readonly state: (typeof NOTIFICATION_RESOURCE_STATES)[number];
  readonly source: {
    readonly origin: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly transition: string;
    readonly eventId: string;
    readonly occurredAt: string;
  };
  readonly related: readonly {
    readonly kind: string;
    readonly id: string;
    readonly evidence?: {
      readonly freshnessState: FreshnessViewState;
      readonly observedAt: string | null;
      readonly receivedAt: string | null;
      readonly freshUntil: string | null;
      readonly evidenceClass: string;
      readonly canonicalResourceType: string;
      readonly canonicalResourceId: string;
    };
  }[];
  readonly channels: readonly {
    readonly channel: (typeof NOTIFICATION_RESOURCE_CHANNELS)[number];
    readonly outcome: "delivered" | "failed";
    readonly detail?: string;
    readonly attemptedAt: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseNotificationResourceAt(label: string, value: unknown): NotificationResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "notificationId",
    "recipientUserId",
    "topic",
    "severity",
    "title",
    "body",
    "state",
    "source",
    "related",
    "channels",
    "createdAt",
    "updatedAt",
  ]);
  requireFields(label, record, [
    "notificationId",
    "recipientUserId",
    "topic",
    "severity",
    "title",
    "body",
    "state",
    "source",
    "related",
    "channels",
    "createdAt",
    "updatedAt",
  ]);
  const source = asObject(`${label}.source`, record["source"]);
  rejectUnknownFields(`${label}.source`, source, [
    "origin",
    "aggregateType",
    "aggregateId",
    "transition",
    "eventId",
    "occurredAt",
  ]);
  const related = asArray(`${label}.related`, record["related"]).map((entry, index) => {
    const relatedLabel = `${label}.related[${index}]`;
    const relatedRecord = asObject(relatedLabel, entry);
    rejectUnknownFields(relatedLabel, relatedRecord, ["kind", "id", "evidence"]);
    const rawEvidence = relatedRecord["evidence"];
    let evidence: NotificationResource["related"][number]["evidence"];
    if (rawEvidence !== undefined) {
      const evidenceRecord = asObject(`${relatedLabel}.evidence`, rawEvidence);
      rejectUnknownFields(`${relatedLabel}.evidence`, evidenceRecord, [
        "freshnessState",
        "observedAt",
        "receivedAt",
        "freshUntil",
        "evidenceClass",
        "canonicalResourceType",
        "canonicalResourceId",
      ]);
      evidence = Object.freeze({
        freshnessState: asEnum(
          `${relatedLabel}.evidence.freshnessState`,
          FRESHNESS_VIEW_STATES,
          evidenceRecord["freshnessState"],
        ),
        observedAt: asNullableInstant(`${relatedLabel}.evidence.observedAt`, evidenceRecord["observedAt"]),
        receivedAt: asNullableInstant(`${relatedLabel}.evidence.receivedAt`, evidenceRecord["receivedAt"]),
        freshUntil: asNullableInstant(`${relatedLabel}.evidence.freshUntil`, evidenceRecord["freshUntil"]),
        evidenceClass: asString(`${relatedLabel}.evidence.evidenceClass`, evidenceRecord["evidenceClass"]),
        canonicalResourceType: asString(
          `${relatedLabel}.evidence.canonicalResourceType`,
          evidenceRecord["canonicalResourceType"],
        ),
        canonicalResourceId: asString(
          `${relatedLabel}.evidence.canonicalResourceId`,
          evidenceRecord["canonicalResourceId"],
        ),
      });
    }
    return Object.freeze({
      kind: asString(`${relatedLabel}.kind`, relatedRecord["kind"]),
      id: asString(`${relatedLabel}.id`, relatedRecord["id"]),
      ...(evidence !== undefined ? { evidence } : {}),
    });
  });
  const channels = asArray(`${label}.channels`, record["channels"]).map((entry, index) => {
    const channelLabel = `${label}.channels[${index}]`;
    const channelRecord = asObject(channelLabel, entry);
    rejectUnknownFields(channelLabel, channelRecord, ["channel", "outcome", "detail", "attemptedAt"]);
    return Object.freeze({
      channel: asEnum(`${channelLabel}.channel`, NOTIFICATION_RESOURCE_CHANNELS, channelRecord["channel"]),
      outcome: asEnum(`${channelLabel}.outcome`, ["delivered", "failed"], channelRecord["outcome"]),
      ...(channelRecord["detail"] !== undefined
        ? { detail: asString(`${channelLabel}.detail`, channelRecord["detail"]) }
        : {}),
      attemptedAt: asInstant(`${channelLabel}.attemptedAt`, channelRecord["attemptedAt"]),
    });
  });
  return Object.freeze({
    notificationId: asString(`${label}.notificationId`, record["notificationId"]),
    recipientUserId: asString(`${label}.recipientUserId`, record["recipientUserId"]),
    topic: asEnum(`${label}.topic`, NOTIFICATION_RESOURCE_TOPICS, record["topic"]),
    severity: asEnum(`${label}.severity`, NOTIFICATION_RESOURCE_SEVERITIES, record["severity"]),
    title: asString(`${label}.title`, record["title"]),
    body: asString(`${label}.body`, record["body"]),
    state: asEnum(`${label}.state`, NOTIFICATION_RESOURCE_STATES, record["state"]),
    source: Object.freeze({
      origin: asString(`${label}.source.origin`, source["origin"]),
      aggregateType: asString(`${label}.source.aggregateType`, source["aggregateType"]),
      aggregateId: asString(`${label}.source.aggregateId`, source["aggregateId"]),
      transition: asString(`${label}.source.transition`, source["transition"]),
      eventId: asString(`${label}.source.eventId`, source["eventId"]),
      occurredAt: asInstant(`${label}.source.occurredAt`, source["occurredAt"]),
    }),
    related: Object.freeze(related),
    channels: Object.freeze(channels),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
  });
}

export const SUPPORT_CASE_RESOURCE_STATES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;
export const SUPPORT_CASE_RESOURCE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const SUPPORT_CASE_TRANSITION_VOCABULARY = [
  "startProgress",
  "resolve",
  "close",
  "cancel",
] as const;

export interface SupportCaseResource {
  readonly caseId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: (typeof SUPPORT_CASE_RESOURCE_STATES)[number];
  readonly priority: (typeof SUPPORT_CASE_RESOURCE_PRIORITIES)[number];
  readonly createdByUserId: string;
  readonly relatedRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly messages: readonly {
    readonly messageId: string;
    readonly authorUserId: string;
    readonly body: string;
    readonly visibility: "customer" | "internal";
    readonly sentAt: string;
  }[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseSupportCaseResourceAt(label: string, value: unknown): SupportCaseResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "caseId",
    "subject",
    "description",
    "status",
    "priority",
    "createdByUserId",
    "relatedRefs",
    "messages",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  requireFields(label, record, [
    "caseId",
    "subject",
    "description",
    "status",
    "priority",
    "createdByUserId",
    "relatedRefs",
    "messages",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  return Object.freeze({
    caseId: asString(`${label}.caseId`, record["caseId"]),
    subject: asString(`${label}.subject`, record["subject"]),
    description: asString(`${label}.description`, record["description"]),
    status: asEnum(`${label}.status`, SUPPORT_CASE_RESOURCE_STATES, record["status"]),
    priority: asEnum(`${label}.priority`, SUPPORT_CASE_RESOURCE_PRIORITIES, record["priority"]),
    createdByUserId: asString(`${label}.createdByUserId`, record["createdByUserId"]),
    relatedRefs: arrayOf(`${label}.relatedRefs`, record["relatedRefs"], (refLabel, ref) => {
      const refRecord = asObject(refLabel, ref);
      rejectUnknownFields(refLabel, refRecord, ["kind", "id"]);
      return Object.freeze({
        kind: asString(`${refLabel}.kind`, refRecord["kind"]),
        id: asString(`${refLabel}.id`, refRecord["id"]),
      });
    }),
    messages: arrayOf(`${label}.messages`, record["messages"], (messageLabel, message) => {
      const messageRecord = asObject(messageLabel, message);
      rejectUnknownFields(messageLabel, messageRecord, [
        "messageId",
        "authorUserId",
        "body",
        "visibility",
        "sentAt",
      ]);
      return Object.freeze({
        messageId: asString(`${messageLabel}.messageId`, messageRecord["messageId"]),
        authorUserId: asString(`${messageLabel}.authorUserId`, messageRecord["authorUserId"]),
        body: asString(`${messageLabel}.body`, messageRecord["body"]),
        visibility: asEnum(
          `${messageLabel}.visibility`,
          ["customer", "internal"],
          messageRecord["visibility"],
        ),
        sentAt: asInstant(`${messageLabel}.sentAt`, messageRecord["sentAt"]),
      });
    }),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
  });
}

// --------------------------------------------------------------------------------
// Admin surfaces (RL-061)
// --------------------------------------------------------------------------------

export const ORGANIZATION_RESOURCE_STATUSES = ["active", "suspended"] as const;
export const MEMBERSHIP_ROLES_VOCABULARY = ["owner", "admin", "member"] as const;
export const MEMBERSHIP_STATUSES_VOCABULARY = ["active", "revoked"] as const;

export interface OrganizationResource {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: (typeof ORGANIZATION_RESOURCE_STATUSES)[number];
  readonly members: readonly {
    readonly userId: string;
    readonly role: (typeof MEMBERSHIP_ROLES_VOCABULARY)[number];
    readonly status: (typeof MEMBERSHIP_STATUSES_VOCABULARY)[number];
  }[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseOrganizationResourceAt(label: string, value: unknown): OrganizationResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "tenantId",
    "organizationId",
    "name",
    "status",
    "members",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  requireFields(label, record, [
    "tenantId",
    "organizationId",
    "name",
    "status",
    "members",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  return Object.freeze({
    tenantId: asString(`${label}.tenantId`, record["tenantId"]),
    organizationId: asString(`${label}.organizationId`, record["organizationId"]),
    name: asString(`${label}.name`, record["name"]),
    status: asEnum(`${label}.status`, ORGANIZATION_RESOURCE_STATUSES, record["status"]),
    members: arrayOf(`${label}.members`, record["members"], (memberLabel, member) => {
      const memberRecord = asObject(memberLabel, member);
      rejectUnknownFields(memberLabel, memberRecord, ["userId", "role", "status"]);
      return Object.freeze({
        userId: asString(`${memberLabel}.userId`, memberRecord["userId"]),
        role: asEnum(`${memberLabel}.role`, MEMBERSHIP_ROLES_VOCABULARY, memberRecord["role"]),
        status: asEnum(`${memberLabel}.status`, MEMBERSHIP_STATUSES_VOCABULARY, memberRecord["status"]),
      });
    }),
    revision: asPositiveInt(`${label}.revision`, record["revision"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
  });
}

export const AUDIT_EVENT_CATEGORIES_VOCABULARY = [
  "auth",
  "secret-access",
  "authority-decision",
  "admin-override",
] as const;
export const AUDIT_EVENT_OUTCOMES_VOCABULARY = ["allowed", "denied", "degraded", "failed"] as const;

export interface AuditEventResource {
  readonly eventId: string;
  readonly sequence: number;
  readonly category: (typeof AUDIT_EVENT_CATEGORIES_VOCABULARY)[number];
  readonly action: string;
  readonly outcome: (typeof AUDIT_EVENT_OUTCOMES_VOCABULARY)[number];
  readonly actorId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly commandId?: string;
  readonly target?: string;
  readonly occurredAt: string;
  readonly detail?: string;
  readonly prevDigest: string | null;
  readonly digest: string;
}

export interface AuditEventListResource {
  readonly events: readonly AuditEventResource[];
  readonly chain: {
    readonly verified: boolean;
    readonly verifiedCount?: number;
    readonly brokenAtSequence?: number;
  };
}

function parseAuditEventResource(label: string, value: unknown): AuditEventResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "eventId",
    "sequence",
    "category",
    "action",
    "outcome",
    "actorId",
    "tenantId",
    "correlationId",
    "commandId",
    "target",
    "occurredAt",
    "detail",
    "prevDigest",
    "digest",
  ]);
  requireFields(label, record, [
    "eventId",
    "sequence",
    "category",
    "action",
    "outcome",
    "actorId",
    "correlationId",
    "occurredAt",
    "prevDigest",
    "digest",
  ]);
  const digestPattern = /^[0-9a-f]{64}$/;
  const digest = asString(`${label}.digest`, record["digest"]);
  if (!digestPattern.test(digest)) {
    throw new ValidationError(`${label}.digest must be a lowercase 64-char hex digest`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: `${label}.digest`, issue: "not a SHA-256 hex digest" }],
    });
  }
  const prevDigest = record["prevDigest"];
  if (prevDigest !== null && typeof prevDigest === "string" && !digestPattern.test(prevDigest)) {
    throw new ValidationError(`${label}.prevDigest must be null or a lowercase 64-char hex digest`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: `${label}.prevDigest`, issue: "not a SHA-256 hex digest" }],
    });
  }
  return Object.freeze({
    eventId: asString(`${label}.eventId`, record["eventId"]),
    sequence: asPositiveInt(`${label}.sequence`, record["sequence"]),
    category: asEnum(
      `${label}.category`,
      AUDIT_EVENT_CATEGORIES_VOCABULARY,
      record["category"],
    ),
    action: asString(`${label}.action`, record["action"]),
    outcome: asEnum(`${label}.outcome`, AUDIT_EVENT_OUTCOMES_VOCABULARY, record["outcome"]),
    actorId: asString(`${label}.actorId`, record["actorId"]),
    ...(record["tenantId"] !== undefined
      ? { tenantId: asString(`${label}.tenantId`, record["tenantId"]) }
      : {}),
    correlationId: asString(`${label}.correlationId`, record["correlationId"]),
    ...(record["commandId"] !== undefined
      ? { commandId: asString(`${label}.commandId`, record["commandId"]) }
      : {}),
    ...(record["target"] !== undefined
      ? { target: asString(`${label}.target`, record["target"]) }
      : {}),
    occurredAt: asInstant(`${label}.occurredAt`, record["occurredAt"]),
    ...(record["detail"] !== undefined
      ? { detail: asString(`${label}.detail`, record["detail"]) }
      : {}),
    prevDigest: prevDigest === null ? null : asNullableString(`${label}.prevDigest`, prevDigest),
    digest,
  });
}

export function parseAuditEventListResource(value: unknown): AuditEventListResource {
  const label = "AuditEventListResource";
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["events", "chain"]);
  requireFields(label, record, ["events", "chain"]);
  const chain = asObject(`${label}.chain`, record["chain"]);
  rejectUnknownFields(`${label}.chain`, chain, ["verified", "verifiedCount", "brokenAtSequence"]);
  requireFields(`${label}.chain`, chain, ["verified"]);
  return Object.freeze({
    events: arrayOf(`${label}.events`, record["events"], parseAuditEventResource),
    chain: Object.freeze({
      verified: asBoolean(`${label}.chain.verified`, chain["verified"]),
      ...(chain["verifiedCount"] !== undefined
        ? { verifiedCount: asPositiveInt(`${label}.chain.verifiedCount`, chain["verifiedCount"]) }
        : {}),
      ...(chain["brokenAtSequence"] !== undefined
        ? {
            brokenAtSequence: asPositiveInt(
              `${label}.chain.brokenAtSequence`,
              chain["brokenAtSequence"],
            ),
          }
        : {}),
    }),
  });
}

export const RECONCILIATION_JOB_RESOURCE_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
] as const;
export const RECONCILIATION_TRIGGER_VOCABULARY = [
  "scheduled",
  "startup",
  "manual",
  "crash-recovery",
] as const;
export const RECONCILIATION_ACTION_TYPE_VOCABULARY = [
  "FRESHNESS_SWEEP",
  "INBOX_DRAIN",
  "DISCOVERY",
  "CANONICAL_REFRESH",
] as const;
export const RECONCILIATION_ACTION_OUTCOME_VOCABULARY = [
  "REPAIRED",
  "ALREADY_CONSISTENT",
  "DEGRADED_STALE",
  "DEGRADED_UNKNOWN",
  "CANONICAL_ABSENT",
  "DEFERRED",
  "FAILED",
] as const;

export interface ReconciliationJobResource {
  readonly jobId: string;
  readonly status: (typeof RECONCILIATION_JOB_RESOURCE_STATUSES)[number];
  readonly trigger: (typeof RECONCILIATION_TRIGGER_VOCABULARY)[number];
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly actions: readonly {
    readonly actionType: (typeof RECONCILIATION_ACTION_TYPE_VOCABULARY)[number];
    readonly outcome: (typeof RECONCILIATION_ACTION_OUTCOME_VOCABULARY)[number];
    readonly targetType?: string;
    readonly targetId?: string;
    readonly detail?: string;
    readonly at: string;
  }[];
}

function parseReconciliationJobResourceAt(label: string, value: unknown): ReconciliationJobResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "jobId",
    "status",
    "trigger",
    "commandId",
    "correlationId",
    "idempotencyKey",
    "createdAt",
    "startedAt",
    "completedAt",
    "actions",
  ]);
  requireFields(label, record, [
    "jobId",
    "status",
    "trigger",
    "commandId",
    "correlationId",
    "idempotencyKey",
    "createdAt",
    "actions",
  ]);
  return Object.freeze({
    jobId: asString(`${label}.jobId`, record["jobId"]),
    status: asEnum(
      `${label}.status`,
      RECONCILIATION_JOB_RESOURCE_STATUSES,
      record["status"],
    ),
    trigger: asEnum(`${label}.trigger`, RECONCILIATION_TRIGGER_VOCABULARY, record["trigger"]),
    commandId: asString(`${label}.commandId`, record["commandId"]),
    correlationId: asString(`${label}.correlationId`, record["correlationId"]),
    idempotencyKey: asString(`${label}.idempotencyKey`, record["idempotencyKey"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    ...(record["startedAt"] !== undefined
      ? { startedAt: asInstant(`${label}.startedAt`, record["startedAt"]) }
      : {}),
    ...(record["completedAt"] !== undefined
      ? { completedAt: asInstant(`${label}.completedAt`, record["completedAt"]) }
      : {}),
    actions: arrayOf(`${label}.actions`, record["actions"], (actionLabel, action) => {
      const actionRecord = asObject(actionLabel, action);
      rejectUnknownFields(actionLabel, actionRecord, [
        "actionType",
        "outcome",
        "targetType",
        "targetId",
        "detail",
        "at",
      ]);
      requireFields(actionLabel, actionRecord, ["actionType", "outcome", "at"]);
      return Object.freeze({
        actionType: asEnum(
          `${actionLabel}.actionType`,
          RECONCILIATION_ACTION_TYPE_VOCABULARY,
          actionRecord["actionType"],
        ),
        outcome: asEnum(
          `${actionLabel}.outcome`,
          RECONCILIATION_ACTION_OUTCOME_VOCABULARY,
          actionRecord["outcome"],
        ),
        ...(actionRecord["targetType"] !== undefined
          ? { targetType: asString(`${actionLabel}.targetType`, actionRecord["targetType"]) }
          : {}),
        ...(actionRecord["targetId"] !== undefined
          ? { targetId: asString(`${actionLabel}.targetId`, actionRecord["targetId"]) }
          : {}),
        ...(actionRecord["detail"] !== undefined
          ? { detail: asString(`${actionLabel}.detail`, actionRecord["detail"]) }
          : {}),
        at: asInstant(`${actionLabel}.at`, actionRecord["at"]),
      });
    }),
  });
}

export const SLO_HEALTH_STATES = ["within-budget", "at-risk", "exhausted", "no-data"] as const;
export const OVERALL_HEALTH_STATES = ["healthy", "degraded", "down"] as const;

/**
 * The projection-freshness/health dashboard surface (observability SLO
 * surfaces): per-projection freshness facts, per-SLO evaluations and the
 * aggregated overall health. `no-data` is never healthy (fail-safe defaults).
 */
export interface ProjectionHealthResource {
  readonly projections: readonly {
    readonly projectionId: string;
    readonly canonicalResourceType: (typeof CANONICAL_RESOURCE_TYPE_VOCABULARY)[number];
    readonly canonicalResourceId: string;
    readonly freshness: FreshnessView;
    readonly evidenceClass: string;
    readonly projectionVersion: number;
    readonly payloadDigest: string;
  }[];
  readonly slos: readonly {
    readonly name: string;
    readonly state: (typeof SLO_HEALTH_STATES)[number];
    readonly burnRate: number | null;
    readonly budgetRemainingRatio: number | null;
    readonly total: number;
    readonly bad: number;
  }[];
  readonly overallHealth: (typeof OVERALL_HEALTH_STATES)[number];
  readonly presentedAt: string;
}

export function parseProjectionHealthResource(value: unknown): ProjectionHealthResource {
  const label = "ProjectionHealthResource";
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["projections", "slos", "overallHealth", "presentedAt"]);
  requireFields(label, record, ["projections", "slos", "overallHealth", "presentedAt"]);
  return Object.freeze({
    projections: arrayOf(`${label}.projections`, record["projections"], (projLabel, proj) => {
      const projRecord = asObject(projLabel, proj);
      rejectUnknownFields(projLabel, projRecord, [
        "projectionId",
        "canonicalResourceType",
        "canonicalResourceId",
        "freshness",
        "evidenceClass",
        "projectionVersion",
        "payloadDigest",
      ]);
      requireFields(projLabel, projRecord, [
        "projectionId",
        "canonicalResourceType",
        "canonicalResourceId",
        "freshness",
        "evidenceClass",
        "projectionVersion",
        "payloadDigest",
      ]);
      return Object.freeze({
        projectionId: asString(`${projLabel}.projectionId`, projRecord["projectionId"]),
        canonicalResourceType: asEnum(
          `${projLabel}.canonicalResourceType`,
          CANONICAL_RESOURCE_TYPE_VOCABULARY,
          projRecord["canonicalResourceType"],
        ),
        canonicalResourceId: asString(`${projLabel}.canonicalResourceId`, projRecord["canonicalResourceId"]),
        freshness: parseFreshnessView(`${projLabel}.freshness`, projRecord["freshness"]),
        evidenceClass: asString(`${projLabel}.evidenceClass`, projRecord["evidenceClass"]),
        projectionVersion: asPositiveInt(`${projLabel}.projectionVersion`, projRecord["projectionVersion"]),
        payloadDigest: asString(`${projLabel}.payloadDigest`, projRecord["payloadDigest"]),
      });
    }),
    slos: arrayOf(`${label}.slos`, record["slos"], (sloLabel, slo) => {
      const sloRecord = asObject(sloLabel, slo);
      rejectUnknownFields(sloLabel, sloRecord, [
        "name",
        "state",
        "burnRate",
        "budgetRemainingRatio",
        "total",
        "bad",
      ]);
      requireFields(sloLabel, sloRecord, ["name", "state", "total", "bad"]);
      return Object.freeze({
        name: asString(`${sloLabel}.name`, sloRecord["name"]),
        state: asEnum(`${sloLabel}.state`, SLO_HEALTH_STATES, sloRecord["state"]),
        burnRate: asNumberOrNull(`${sloLabel}.burnRate`, sloRecord["burnRate"]),
        budgetRemainingRatio: asNumberOrNull(
          `${sloLabel}.budgetRemainingRatio`,
          sloRecord["budgetRemainingRatio"],
        ),
        total: asNonNegativeInt(`${sloLabel}.total`, sloRecord["total"]),
        bad: asNonNegativeInt(`${sloLabel}.bad`, sloRecord["bad"]),
      });
    }),
    overallHealth: asEnum(`${label}.overallHealth`, OVERALL_HEALTH_STATES, record["overallHealth"]),
    presentedAt: asInstant(`${label}.presentedAt`, record["presentedAt"]),
  });
}

// --------------------------------------------------------------------------------
// List wrappers + exported collection parsers
// --------------------------------------------------------------------------------

export interface OrderDetailResource {
  readonly order: OrderResource;
  readonly payments: readonly PaymentResource[];
  readonly invoices: readonly InvoiceResource[];
}

function parseOrderDetailResourceAt(label: string, value: unknown): OrderDetailResource {
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["order", "payments", "invoices"]);
  requireFields(label, record, ["order", "payments", "invoices"]);
  return Object.freeze({
    order: parseOrderResourceAt(`${label}.order`, record["order"]),
    payments: arrayOf(`${label}.payments`, record["payments"], parsePaymentResourceAt),
    invoices: arrayOf(`${label}.invoices`, record["invoices"], parseInvoiceResourceAt),
  });
}

/** Parses a list of devices. */
export function parseDeviceList(value: unknown): readonly DeviceResource[] {
  return arrayOf("DeviceList", value, parseDeviceResourceAt);
}

/** Parses a list of experience intents. */
export function parseExperienceIntentList(value: unknown): readonly ExperienceIntentResource[] {
  return arrayOf("ExperienceIntentList", value, parseExperienceIntentResourceAt);
}

/** Parses a single experience intent. */
export function parseExperienceIntentResource(value: unknown): ExperienceIntentResource {
  return parseExperienceIntentResourceAt("ExperienceIntentResource", value);
}

/** Parses a list of products. */
export function parseProductList(value: unknown): readonly ProductResource[] {
  return arrayOf("ProductList", value, parseProductResource);
}

/** Parses a list of orders. */
export function parseOrderList(value: unknown): readonly OrderResource[] {
  return arrayOf("OrderList", value, parseOrderResourceAt);
}

/** Parses a single order detail (order + payments + invoices). */
export function parseOrderDetailResource(value: unknown): OrderDetailResource {
  return parseOrderDetailResourceAt("OrderDetailResource", value);
}

/** Parses a list of subscriptions. */
export function parseSubscriptionList(value: unknown): readonly SubscriptionResource[] {
  return arrayOf("SubscriptionList", value, parseSubscriptionResourceAt);
}

/** Parses a single device. */
export function parseDeviceResource(value: unknown): DeviceResource {
  return parseDeviceResourceAt("DeviceResource", value);
}

/** Parses a list of notifications. */
export function parseNotificationList(value: unknown): readonly NotificationResource[] {
  return arrayOf("NotificationList", value, parseNotificationResourceAt);
}

/** Parses a single notification. */
export function parseNotificationResource(value: unknown): NotificationResource {
  return parseNotificationResourceAt("NotificationResource", value);
}

/** Parses a list of support cases. */
export function parseSupportCaseList(value: unknown): readonly SupportCaseResource[] {
  return arrayOf("SupportCaseList", value, parseSupportCaseResourceAt);
}

/** Parses a single support case. */
export function parseSupportCaseResource(value: unknown): SupportCaseResource {
  return parseSupportCaseResourceAt("SupportCaseResource", value);
}

/** Parses a list of organizations. */
export function parseOrganizationList(value: unknown): readonly OrganizationResource[] {
  return arrayOf("OrganizationList", value, parseOrganizationResourceAt);
}

/** Parses a single organization. */
export function parseOrganizationResource(value: unknown): OrganizationResource {
  return parseOrganizationResourceAt("OrganizationResource", value);
}

/** Parses a list of reconciliation jobs. */
export function parseReconciliationJobList(value: unknown): readonly ReconciliationJobResource[] {
  return arrayOf("ReconciliationJobList", value, parseReconciliationJobResourceAt);
}

/** Parses a single user. */
export function parseUserResource(value: unknown): UserResource {
  return parseUserResourceAt("UserResource", value);
}
