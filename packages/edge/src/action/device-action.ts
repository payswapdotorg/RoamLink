/**
 * Device action contracts (RL-040 - TYPES ONLY; platform adapters are
 * RL-043, Wave 3).
 *
 * A {@link DeviceActionRequest} is what the edge wants to DO on the device:
 * an explicit capability requirement, minimal typed parameters, a Wave-0
 * command envelope (RL-LOCK-014 correlation/idempotency) and a physical
 * action dedupe key (re-running after reconnect must not double-apply).
 *
 * A {@link DeviceActionResult} is the honest outcome record. PHYSICAL SUCCESS
 * ("executed-observed") IS ONLY DECLARABLE WITH PLATFORM EVIDENCE
 * (RL-LOCK-011; spec/mobile.md honesty rules) - the constructor rejects an
 * `executed-observed` result without a real evidence payload, and
 * {@link deviceActionResultFromGate} makes gate-blocked outcomes
 * honest-by-construction: a denied gate can only produce `unsupported`, a
 * degraded gate only `degraded` - never a fabricated success.
 */
import {
  CommandEnvelope,
  DomainError,
  ValidationError,
  parseIdempotencyKey,
  parseUtcInstant,
  type CommandEnvelopeInput,
  type CommandEnvelopePlain,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  makeEdgeCapabilityRequirement,
  type CapabilityGateDecision,
  type EdgeCapabilityRequirement,
  type EdgeCapabilityRequirementInput,
} from "../capability/capability-gating.js";
import {
  parseEdgePlatformEvidence,
  type EdgePlatformEvidence,
} from "../capability/evidence.js";
import { parseDeviceActionId, type DeviceActionId } from "../ids.js";

// ---------------------------------------------------------------------------
// Parameters (typed, minimal, platform-neutral)
// ---------------------------------------------------------------------------

export type DeviceActionParameterValue = string | number | boolean | null;

export type DeviceActionParameters = Readonly<Record<string, DeviceActionParameterValue>>;

const PARAMETER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_PARAMETERS = 32;
const MAX_PARAMETER_STRING_LENGTH = 256;

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses and freezes minimal, platform-neutral action parameters. Keys are
 * safe labels; values are bounded JSON primitives only - no nested objects,
 * no arrays, no unbounded strings, no secrets (RL-LOCK-016). Platform
 * adapters (RL-043) interpret the parameters for their capability.
 */
export function parseDeviceActionParameters(value: unknown): DeviceActionParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("DeviceActionParameters must be an object", {
      reason: "DEVICE_ACTION_PARAMETERS_INVALID",
      details: [{ path: "DeviceActionParameters", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > MAX_PARAMETERS) {
    throw new ValidationError(`DeviceActionParameters must carry at most ${MAX_PARAMETERS} entries`, {
      reason: "DEVICE_ACTION_PARAMETERS_INVALID",
      details: [{ path: "DeviceActionParameters", issue: "too many entries" }],
    });
  }
  const parsed: Record<string, DeviceActionParameterValue> = {};
  for (const key of keys) {
    if (!PARAMETER_KEY_PATTERN.test(key)) {
      throw new ValidationError(
        "DeviceActionParameters keys must be safe labels (1-64 chars, starts alphanumeric, then [A-Za-z0-9_.-] only)",
        {
          reason: "DEVICE_ACTION_PARAMETERS_INVALID",
          details: [{ path: "DeviceActionParameters", issue: `key '${key}' is not a safe label` }],
        },
      );
    }
    const raw = record[key];
    if (raw === undefined) {
      throw new ValidationError(
        "DeviceActionParameters must not carry explicit undefined values (omit the key instead)",
        {
          reason: "DEVICE_ACTION_PARAMETERS_INVALID",
          details: [{ path: `DeviceActionParameters`, issue: "explicit undefined value" }],
        },
      );
    }
    if (raw === null || typeof raw === "boolean") {
      parsed[key] = raw;
      continue;
    }
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) {
        throw new ValidationError("DeviceActionParameters numbers must be finite", {
          reason: "DEVICE_ACTION_PARAMETERS_INVALID",
          details: [{ path: "DeviceActionParameters", issue: "non-finite number value" }],
        });
      }
      parsed[key] = raw;
      continue;
    }
    if (typeof raw === "string") {
      if (raw.length > MAX_PARAMETER_STRING_LENGTH || hasControlCharacter(raw)) {
        throw new ValidationError(
          `DeviceActionParameters string values must be at most ${MAX_PARAMETER_STRING_LENGTH} chars and control-character free`,
          {
            reason: "DEVICE_ACTION_PARAMETERS_INVALID",
            details: [{ path: "DeviceActionParameters", issue: "string value out of bounds" }],
          },
        );
      }
      parsed[key] = raw;
      continue;
    }
    throw new ValidationError(
      "DeviceActionParameters values must be string, number, boolean or null (no nested structures, no secrets)",
      {
        reason: "DEVICE_ACTION_PARAMETERS_INVALID",
        details: [{ path: "DeviceActionParameters", issue: "unsupported value type" }],
      },
    );
  }
  return Object.freeze(parsed);
}

// ---------------------------------------------------------------------------
// DeviceActionRequest
// ---------------------------------------------------------------------------

/** Input accepted by the {@link DeviceActionRequest} constructor. */
export interface DeviceActionRequestInput {
  readonly actionId: string;
  readonly capabilityRequirement: EdgeCapabilityRequirementInput;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly command: CommandEnvelopeInput | CommandEnvelopePlain | CommandEnvelope;
  readonly dedupeKey: string;
}

/** Serialized (plain) form of a device action request. */
export interface DeviceActionRequestPlain {
  readonly actionId: DeviceActionId;
  readonly capabilityRequirement: EdgeCapabilityRequirement;
  readonly parameters: DeviceActionParameters;
  readonly command: CommandEnvelopePlain;
  readonly dedupeKey: IdempotencyKey;
}

const ALLOWED_REQUEST_FIELDS = new Set([
  "actionId",
  "capabilityRequirement",
  "parameters",
  "command",
  "dedupeKey",
]);

function requestField(label: string, issue: string): never {
  throw new ValidationError(`DeviceActionRequest rejected: ${label} - ${issue}`, {
    reason: "DEVICE_ACTION_REQUEST_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * A validated, immutable device action request. The command envelope is the
 * Wave-0 idempotent-command carrier; `dedupeKey` additionally dedupes the
 * PHYSICAL device-side action across retries/reconnects (e.g. an eSIM
 * profile must not be installed twice when the outbox re-delivers).
 */
export class DeviceActionRequest {
  readonly actionId: DeviceActionId;
  readonly capabilityRequirement: EdgeCapabilityRequirement;
  readonly parameters: DeviceActionParameters;
  readonly command: CommandEnvelope;
  readonly dedupeKey: IdempotencyKey;

  constructor(input: DeviceActionRequestInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      requestField("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_REQUEST_FIELDS.has(key)) {
        requestField(key, "unknown field (the request carries exactly its contract fields)");
      }
    }

    let actionId: DeviceActionId;
    try {
      actionId = parseDeviceActionId(input.actionId);
    } catch {
      requestField("actionId", "must be a canonical lowercase UUID");
    }
    let capabilityRequirement: EdgeCapabilityRequirement;
    try {
      capabilityRequirement = makeEdgeCapabilityRequirement(input.capabilityRequirement);
    } catch (error) {
      if (error instanceof ValidationError) {
        requestField("capabilityRequirement", error.message);
      }
      throw error;
    }
    let parameters: DeviceActionParameters;
    try {
      parameters = parseDeviceActionParameters(input.parameters);
    } catch {
      requestField("parameters", "must be minimal, typed action parameters (bounded JSON primitives)");
    }
    if (input.command === null || typeof input.command !== "object") {
      requestField("command", "must be a Wave-0 command envelope");
    }
    let command: CommandEnvelope;
    try {
      command =
        input.command instanceof CommandEnvelope
          ? input.command
          : new CommandEnvelope(input.command as CommandEnvelopeInput);
    } catch {
      requestField("command", "must be a valid Wave-0 command envelope");
    }
    let dedupeKey: IdempotencyKey;
    try {
      dedupeKey = parseIdempotencyKey(input.dedupeKey);
    } catch {
      requestField("dedupeKey", "must be a non-empty safe reference string");
    }

    this.actionId = actionId;
    this.capabilityRequirement = capabilityRequirement;
    this.parameters = parameters;
    this.command = command;
    this.dedupeKey = dedupeKey;
    Object.freeze(this);
  }

  /** Plain, serializable form with exactly the contract fields. */
  toPlain(): DeviceActionRequestPlain {
    return Object.freeze({
      actionId: this.actionId,
      capabilityRequirement: this.capabilityRequirement,
      parameters: this.parameters,
      command: this.command.toPlain(),
      dedupeKey: this.dedupeKey,
    });
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): DeviceActionRequest {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      requestField("$", "fromPlain expects an object");
    }
    return new DeviceActionRequest(value as DeviceActionRequestInput);
  }
}

// ---------------------------------------------------------------------------
// DeviceActionResult
// ---------------------------------------------------------------------------

export const DEVICE_ACTION_STATUSES = [
  "accepted",
  "executed-observed",
  "degraded",
  "unsupported",
  "failed",
] as const;

export type DeviceActionStatus = (typeof DEVICE_ACTION_STATUSES)[number];

export function isDeviceActionStatus(value: unknown): value is DeviceActionStatus {
  return (
    typeof value === "string" && (DEVICE_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

export function parseDeviceActionStatus(value: unknown): DeviceActionStatus {
  if (!isDeviceActionStatus(value)) {
    throw new ValidationError(
      "value is not a member of the closed device-action status vocabulary (accepted, executed-observed, degraded, unsupported, failed)",
      {
        reason: "DEVICE_ACTION_RESULT_INVALID",
        details: [{ path: "DeviceActionStatus", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

export const DEVICE_ACTION_RESULT_REASONS = [
  "capability-requires-permission",
  "capability-unavailable",
  "capability-unknown",
  "evidence-class-insufficient",
  "evidence-stale",
  "action-unsupported",
  "execution-degraded",
  "execution-failed",
] as const;

export type DeviceActionResultReason = (typeof DEVICE_ACTION_RESULT_REASONS)[number];

export function isDeviceActionResultReason(value: unknown): value is DeviceActionResultReason {
  return (
    typeof value === "string" &&
    (DEVICE_ACTION_RESULT_REASONS as readonly string[]).includes(value)
  );
}

export function parseDeviceActionResultReason(value: unknown): DeviceActionResultReason {
  if (!isDeviceActionResultReason(value)) {
    throw new ValidationError(
      "value is not a member of the closed device-action result-reason vocabulary",
      {
        reason: "DEVICE_ACTION_RESULT_INVALID",
        details: [{ path: "DeviceActionResultReason", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Input accepted by the {@link DeviceActionResult} constructor. */
export interface DeviceActionResultInput {
  readonly actionId: string;
  readonly status: string;
  readonly completedAt: string;
  readonly evidence?: { readonly kind: string; readonly source?: string; readonly detail?: string };
  readonly reason?: string;
  readonly detail?: string;
  readonly gateDecision?: CapabilityGateDecision;
}

/** Serialized (plain) form of a device action result. */
export interface DeviceActionResultPlain {
  readonly actionId: DeviceActionId;
  readonly status: DeviceActionStatus;
  readonly completedAt: UtcInstant;
  /** Required for `executed-observed`; forbidden for `accepted`; optional otherwise. */
  readonly evidence?: EdgePlatformEvidence;
  /** Required for `degraded`, `unsupported` and `failed`; forbidden otherwise. */
  readonly reason?: DeviceActionResultReason;
  readonly detail?: string;
  /** The gate decision that produced this result, when the action was gate-blocked or degraded. */
  readonly gateDecision?: CapabilityGateDecision;
}

const ALLOWED_RESULT_FIELDS = new Set([
  "actionId",
  "status",
  "completedAt",
  "evidence",
  "reason",
  "detail",
  "gateDecision",
]);

const MAX_RESULT_DETAIL_LENGTH = 256;

function resultField(label: string, issue: string): never {
  throw new ValidationError(`DeviceActionResult rejected: ${label} - ${issue}`, {
    reason: "DEVICE_ACTION_RESULT_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * The honest device action outcome. Constructor-enforced honesty rules
 * (RL-LOCK-011, spec/mobile.md "A local action cannot claim physical success
 * until the appropriate platform/ADCOS evidence is available"):
 *
 *  - `executed-observed` REQUIRES real platform evidence (kind !== "none")
 *    and carries no reason;
 *  - `accepted` (queued/accepted for execution) carries NEITHER evidence NOR
 *    reason - acceptance is not physical success;
 *  - `degraded` / `unsupported` / `failed` REQUIRE a closed-vocabulary reason;
 *  - any attached evidence must be real (kind !== "none").
 */
export class DeviceActionResult {
  readonly actionId: DeviceActionId;
  readonly status: DeviceActionStatus;
  readonly completedAt: UtcInstant;
  declare readonly evidence?: EdgePlatformEvidence;
  declare readonly reason?: DeviceActionResultReason;
  declare readonly detail?: string;
  declare readonly gateDecision?: CapabilityGateDecision;

  constructor(input: DeviceActionResultInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      resultField("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_RESULT_FIELDS.has(key)) {
        resultField(key, "unknown field (the result carries exactly its contract fields)");
      }
    }

    let actionId: DeviceActionId;
    try {
      actionId = parseDeviceActionId(input.actionId);
    } catch {
      resultField("actionId", "must be a canonical lowercase UUID");
    }
    const status = (() => {
      try {
        return parseDeviceActionStatus(input.status);
      } catch {
        resultField("status", "must be a member of the closed device-action status vocabulary");
      }
    })();
    let completedAt: UtcInstant;
    try {
      completedAt = parseUtcInstant(input.completedAt);
    } catch {
      resultField("completedAt", "must be a UTC instant with an explicit zone designator");
    }

    let evidence: EdgePlatformEvidence | undefined;
    if (input.evidence !== undefined) {
      try {
        evidence = parseEdgePlatformEvidence(input.evidence);
      } catch {
        resultField("evidence", "must be a typed, minimal platform-evidence payload");
      }
    }
    let reason: DeviceActionResultReason | undefined;
    if (input.reason !== undefined) {
      if (!isDeviceActionResultReason(input.reason)) {
        resultField("reason", "must be a member of the closed device-action result-reason vocabulary");
      }
      reason = input.reason;
    }
    if (input.detail !== undefined) {
      if (
        typeof input.detail !== "string" ||
        input.detail.length === 0 ||
        input.detail.length > MAX_RESULT_DETAIL_LENGTH ||
        hasControlCharacter(input.detail)
      ) {
        resultField("detail", "must be a printable, non-secret string of 1-256 chars");
      }
    }
    if (input.gateDecision !== undefined) {
      const decision = (input.gateDecision as CapabilityGateDecision).decision;
      if (decision !== "allow" && decision !== "deny" && decision !== "degrade") {
        resultField("gateDecision", "must be an allow/deny/degrade capability gate decision");
      }
    }

    // --- honesty rules -------------------------------------------------------
    if (status === "executed-observed") {
      if (evidence === undefined) {
        resultField(
          "evidence",
          "executed-observed REQUIRES platform evidence - physical success is only declared with evidence (RL-LOCK-011)",
        );
      }
      if (reason !== undefined) {
        resultField("reason", "executed-observed carries no result reason");
      }
    }
    if (status === "accepted") {
      if (evidence !== undefined) {
        resultField("evidence", "accepted is a queue/adapter decision, not physical success - no evidence attaches");
      }
      if (reason !== undefined) {
        resultField("reason", "accepted carries no result reason");
      }
    }
    if (status === "degraded" || status === "unsupported" || status === "failed") {
      if (reason === undefined) {
        resultField("reason", `${status} requires a machine-readable reason`);
      }
    }
    if (evidence !== undefined && evidence.kind === "none") {
      resultField(
        "evidence",
        "result evidence must be real platform evidence (kind 'none' is only valid inside capability snapshots)",
      );
    }

    this.actionId = actionId;
    this.status = status;
    this.completedAt = completedAt;
    if (evidence !== undefined) this.evidence = evidence;
    if (reason !== undefined) this.reason = reason;
    if (input.detail !== undefined) this.detail = input.detail;
    if (input.gateDecision !== undefined) this.gateDecision = input.gateDecision;
    Object.freeze(this);
  }

  /** Plain, serializable form (optional fields present only when set). */
  toPlain(): DeviceActionResultPlain {
    const plain: DeviceActionResultPlain = Object.freeze({
      actionId: this.actionId,
      status: this.status,
      completedAt: this.completedAt,
      ...(this.evidence !== undefined ? { evidence: this.evidence } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.gateDecision !== undefined ? { gateDecision: this.gateDecision } : {}),
    });
    return plain;
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): DeviceActionResult {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      resultField("$", "fromPlain expects an object");
    }
    return new DeviceActionResult(value as DeviceActionResultInput);
  }
}

/**
 * Derives the honest result for a NON-allowing gate decision: deny ->
 * `unsupported` (the action was never attempted), degrade -> `degraded`,
 * both carrying the gate's reason and the gate decision for traceability.
 *
 * An ALLOW gate throws: an allowed decision does not produce a result - the
 * action must be executed and its physical success recorded with platform
 * evidence (RL-LOCK-011).
 */
export function deviceActionResultFromGate(
  actionId: DeviceActionId,
  gate: CapabilityGateDecision,
  at: UtcInstant | string,
): DeviceActionResult {
  const completedAt = parseUtcInstant(at);
  if (gate.decision === "allow") {
    throw new DomainError(
      "an allowed gate decision does not produce a device-action result; execute the action and record platform evidence (RL-LOCK-011)",
      { reason: "GATE_ALLOWED_NO_RESULT" },
    );
  }
  const status: DeviceActionStatus = gate.decision === "deny" ? "unsupported" : "degraded";
  return new DeviceActionResult({
    actionId,
    status,
    completedAt,
    reason: gate.reason,
    detail: gate.detail,
    gateDecision: gate,
  });
}
