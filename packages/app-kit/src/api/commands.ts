/**
 * Mutation request payloads (RL-060/061 command surfaces).
 *
 * Each mutation has ONE typed request payload, validated client-side before
 * it ever reaches the wire (fast, honest failures - the server re-validates
 * everything fail-closed; client validation is UX, not authority). Payloads
 * are plain JSON objects with exactly the documented fields.
 */
import { ValidationError } from "@roamlink/contracts";

import { DEVICE_PLATFORMS, INTENT_ACCESS_CLASSES } from "./resources.js";
import type { IntentAccessClass } from "./resources.js";

export interface EnrollDeviceRequest {
  readonly name: string;
  readonly platform: (typeof DEVICE_PLATFORMS)[number];
}

export interface UpdateDeviceRequest {
  readonly deviceId: string;
  readonly name?: string;
  readonly platform?: (typeof DEVICE_PLATFORMS)[number];
}

export interface RetireDeviceRequest {
  readonly deviceId: string;
}

/**
 * Install-command payload (RL-115-F1 remediation, PA-001). The activation
 * code is the carrier-issued install credential the platform's install
 * contract requires when `DeviceSimResource.installRequiresActivationCode`
 * is true; it rides the command body like any other typed payload.
 */
export interface InstallEsimProfileRequest {
  readonly deviceId: string;
  readonly activationCode: string;
}

/** Remove-command payload (the profile id rides the path; see client). */
export interface RemoveEsimProfileRequest {
  readonly deviceId: string;
  readonly profileId: string;
}

/** Enable/disable-command payload (one capability, one desired state). */
export interface EnableEsimProfileRequest {
  readonly deviceId: string;
  readonly profileId: string;
  readonly enabled: boolean;
}

export interface CreateExperienceIntentRequest {
  readonly deviceId: string;
  readonly rationale: string;
  readonly accessClasses: readonly IntentAccessClass[];
}

export interface SupersedeExperienceIntentRequest {
  readonly intentId: string;
  readonly rationale: string;
  readonly accessClasses: readonly IntentAccessClass[];
}

export interface ActivateExperienceIntentRequest {
  readonly intentId: string;
}

export interface OrderLineRequest {
  readonly variantId: string;
  readonly quantity: number;
}

export interface PlaceOrderRequest {
  readonly lines: readonly OrderLineRequest[];
}

export interface CancelOrderRequest {
  readonly orderId: string;
}

export interface CompleteOrderRequest {
  readonly orderId: string;
}

export interface RecordPaymentRequest {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface MarkNotificationReadRequest {
  readonly notificationId: string;
}

export interface CreateSupportCaseRequest {
  readonly subject: string;
  readonly description: string;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly relatedRefs?: readonly { readonly kind: string; readonly id: string }[];
}

export interface AdvanceSupportCaseRequest {
  readonly caseId: string;
  readonly transition: "startProgress" | "resolve" | "close" | "cancel";
}

export interface SuspendOrganizationRequest {
  readonly tenantId: string;
}

export interface ReactivateOrganizationRequest {
  readonly tenantId: string;
}

export interface TriggerReconciliationRequest {
  readonly trigger: "scheduled" | "startup" | "manual" | "crash-recovery";
}

function invalid(label: string, issue: string): never {
  throw new ValidationError(`request payload rejected: ${label} - ${issue}`, {
    reason: "REQUEST_PAYLOAD_INVALID",
    details: [{ path: label, issue }],
  });
}

function requireString(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(label, "must be a non-empty string");
  }
  return value;
}

function optionalString(label: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(label, value);
}

function requireEnum<T extends string>(label: string, vocabulary: readonly T[], value: unknown): T {
  if (typeof value !== "string" || !(vocabulary as readonly string[]).includes(value)) {
    invalid(label, `must be one of: ${vocabulary.join(", ")}`);
  }
  return value as T;
}

function requireId(label: string, value: unknown): string {
  const id = requireString(label, value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    invalid(label, "must be a canonical lowercase UUID");
  }
  return id;
}

function requirePositiveInt(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(label, "must be a positive integer");
  }
  return value;
}

function requireCurrency(label: string, value: unknown): string {
  const currency = requireString(label, value);
  if (!/^[A-Z]{3}$/.test(currency)) {
    invalid(label, "must be an ISO-4217-style code");
  }
  return currency;
}

/** Validates + serializes an enroll-device payload. */
export function enrollDeviceBody(request: EnrollDeviceRequest): string {
  return JSON.stringify({
    name: requireString("EnrollDeviceRequest.name", request?.name),
    platform: requireEnum("EnrollDeviceRequest.platform", DEVICE_PLATFORMS, request?.platform),
  });
}

/** Validates + serializes an update-device payload. */
export function updateDeviceBody(request: UpdateDeviceRequest): string {
  const name = optionalString("UpdateDeviceRequest.name", request?.name);
  const platform =
    request?.platform === undefined
      ? undefined
      : requireEnum("UpdateDeviceRequest.platform", DEVICE_PLATFORMS, request.platform);
  if (name === undefined && platform === undefined) {
    invalid("UpdateDeviceRequest", "at least one of name/platform must change");
  }
  return JSON.stringify({
    ...(name !== undefined ? { name } : {}),
    ...(platform !== undefined ? { platform } : {}),
  });
}

/** Validates a retire-device payload (id rides the path, body is empty). */
export function validateRetireDevice(request: RetireDeviceRequest): string {
  return requireId("RetireDeviceRequest.deviceId", request?.deviceId);
}

/**
 * Validates + serializes an install-eSIM-profile payload. The activation
 * code is validated as a non-empty string only: it is an opaque,
 * carrier-issued credential whose shape RoamLink does not own (no carrier
 * semantics, spec/authority-model.md — value-free errors, RL-LOCK-016).
 */
export function installEsimProfileBody(request: InstallEsimProfileRequest): string {
  return JSON.stringify({
    activationCode: requireString("InstallEsimProfileRequest.activationCode", request?.activationCode),
  });
}

/** Validates a remove-eSIM-profile payload (ids ride the path). */
export function validateRemoveEsimProfile(request: RemoveEsimProfileRequest): { deviceId: string; profileId: string } {
  return {
    deviceId: requireId("RemoveEsimProfileRequest.deviceId", request?.deviceId),
    profileId: requireId("RemoveEsimProfileRequest.profileId", request?.profileId),
  };
}

/** Validates an enable-eSIM-profile payload (ids ride the path; the body carries the desired state). */
export function validateEnableEsimProfileRequest(request: EnableEsimProfileRequest): { deviceId: string; profileId: string } {
  return {
    deviceId: requireId("EnableEsimProfileRequest.deviceId", request?.deviceId),
    profileId: requireId("EnableEsimProfileRequest.profileId", request?.profileId),
  };
}

/** Validates + serializes an enable-eSIM-profile payload. */
export function enableEsimProfileBody(request: EnableEsimProfileRequest): string {
  requireId("EnableEsimProfileRequest.profileId", request?.profileId);
  if (typeof request?.enabled !== "boolean") {
    invalid("EnableEsimProfileRequest.enabled", "must be a boolean");
  }
  return JSON.stringify({ enabled: request.enabled });
}

function validateAccessClasses(label: string, value: unknown): readonly IntentAccessClass[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(label, "must be a non-empty array of access classes");
  }
  return Object.freeze(
    value.map((entry) => requireEnum(`${label}[]`, INTENT_ACCESS_CLASSES, entry)),
  );
}

/** Validates + serializes a create-intent payload. */
export function createExperienceIntentBody(request: CreateExperienceIntentRequest): string {
  return JSON.stringify({
    deviceId: requireId("CreateExperienceIntentRequest.deviceId", request?.deviceId),
    rationale: requireString("CreateExperienceIntentRequest.rationale", request?.rationale),
    accessClasses: validateAccessClasses(
      "CreateExperienceIntentRequest.accessClasses",
      request?.accessClasses,
    ),
  });
}

/** Validates + serializes a supersede-intent payload. */
export function supersedeExperienceIntentBody(request: SupersedeExperienceIntentRequest): string {
  requireId("SupersedeExperienceIntentRequest.intentId", request?.intentId);
  return JSON.stringify({
    rationale: requireString("SupersedeExperienceIntentRequest.rationale", request?.rationale),
    accessClasses: validateAccessClasses(
      "SupersedeExperienceIntentRequest.accessClasses",
      request?.accessClasses,
    ),
  });
}

/** Validates an activate-intent payload (id rides the path). */
export function validateActivateExperienceIntent(request: ActivateExperienceIntentRequest): string {
  return requireId("ActivateExperienceIntentRequest.intentId", request?.intentId);
}

/** Validates + serializes a place-order payload. */
export function placeOrderBody(request: PlaceOrderRequest): string {
  if (!Array.isArray(request?.lines) || request.lines.length === 0) {
    invalid("PlaceOrderRequest.lines", "must be a non-empty array");
  }
  const lines = request.lines.map((line, index) => {
    if (line === null || typeof line !== "object") {
      invalid(`PlaceOrderRequest.lines[${index}]`, "must be an object");
    }
    return {
      variantId: requireId(`PlaceOrderRequest.lines[${index}].variantId`, line.variantId),
      quantity: requirePositiveInt(`PlaceOrderRequest.lines[${index}].quantity`, line.quantity),
    };
  });
  return JSON.stringify({ lines });
}

/** Validates a cancel-order payload (id rides the path). */
export function validateCancelOrder(request: CancelOrderRequest): string {
  return requireId("CancelOrderRequest.orderId", request?.orderId);
}

/** Validates a complete-order payload (id rides the path). */
export function validateCompleteOrder(request: CompleteOrderRequest): string {
  return requireId("CompleteOrderRequest.orderId", request?.orderId);
}

/** Validates + serializes a record-payment payload. */
export function recordPaymentBody(request: RecordPaymentRequest): string {
  return JSON.stringify({
    orderId: requireId("RecordPaymentRequest.orderId", request?.orderId),
    amountMinor: requirePositiveInt("RecordPaymentRequest.amountMinor", request?.amountMinor),
    currency: requireCurrency("RecordPaymentRequest.currency", request?.currency),
  });
}

/** Validates a mark-notification-read payload (id rides the path). */
export function validateMarkNotificationRead(request: MarkNotificationReadRequest): string {
  return requireId("MarkNotificationReadRequest.notificationId", request?.notificationId);
}

/** Validates + serializes a create-support-case payload. */
export function createSupportCaseBody(request: CreateSupportCaseRequest): string {
  if (!Array.isArray(request?.relatedRefs) && request?.relatedRefs !== undefined) {
    invalid("CreateSupportCaseRequest.relatedRefs", "must be an array when present");
  }
  const relatedRefs = (request?.relatedRefs ?? []).map((ref, index) => {
    requireString(`CreateSupportCaseRequest.relatedRefs[${index}].kind`, ref?.kind);
    requireString(`CreateSupportCaseRequest.relatedRefs[${index}].id`, ref?.id);
    return { kind: ref.kind, id: ref.id };
  });
  return JSON.stringify({
    subject: requireString("CreateSupportCaseRequest.subject", request?.subject),
    description: requireString("CreateSupportCaseRequest.description", request?.description),
    priority: requireEnum(
      "CreateSupportCaseRequest.priority",
      ["low", "normal", "high", "urgent"],
      request?.priority,
    ),
    relatedRefs,
  });
}

/** Validates + serializes an advance-support-case payload. */
export function advanceSupportCaseBody(request: AdvanceSupportCaseRequest): string {
  requireId("AdvanceSupportCaseRequest.caseId", request?.caseId);
  return JSON.stringify({
    transition: requireEnum(
      "AdvanceSupportCaseRequest.transition",
      ["startProgress", "resolve", "close", "cancel"],
      request?.transition,
    ),
  });
}

/** Validates a suspend-organization payload (id rides the path). */
export function validateSuspendOrganization(request: SuspendOrganizationRequest): string {
  const tenantId = requireString("SuspendOrganizationRequest.tenantId", request?.tenantId);
  if (!/^org:[0-9a-f-]{36}$/.test(tenantId)) {
    invalid("SuspendOrganizationRequest.tenantId", "must be an 'org:<uuid>' tenant reference");
  }
  return tenantId;
}

/** Validates a reactivate-organization payload (id rides the path). */
export function validateReactivateOrganization(request: ReactivateOrganizationRequest): string {
  const tenantId = requireString("ReactivateOrganizationRequest.tenantId", request?.tenantId);
  if (!/^org:[0-9a-f-]{36}$/.test(tenantId)) {
    invalid("ReactivateOrganizationRequest.tenantId", "must be an 'org:<uuid>' tenant reference");
  }
  return tenantId;
}

/** Validates + serializes a trigger-reconciliation payload. */
export function triggerReconciliationBody(request: TriggerReconciliationRequest): string {
  return JSON.stringify({
    trigger: requireEnum(
      "TriggerReconciliationRequest.trigger",
      ["scheduled", "startup", "manual", "crash-recovery"],
      request?.trigger,
    ),
  });
}
