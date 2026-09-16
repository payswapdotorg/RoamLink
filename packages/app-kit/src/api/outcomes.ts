/**
 * Mutation outcome stages (RL-060/061, spec/api.md "Command semantics").
 *
 * A mutation acknowledgement must clearly distinguish `accepted` from
 * `executed`, `executed` from `delivered`, and `delivered` from
 * `billable-final` (RL-LOCK-008 "payment is not delivery"; spec/architecture.md
 * §10 failure semantics: "Customer payment, order acceptance, reservation,
 * path activity, delivered traffic, and billable finality are separate
 * states").
 *
 * These four stages are therefore SEPARATE, individually-absent-or-present
 * facts on the acknowledgement - never a single collapsed enum. Presence is
 * structural: a later stage may only be present when every earlier stage is.
 * The UI renders each stage with its own timestamp (or an explicit "not
 * reached" marker); it never reduces them to one status word.
 */
import {
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  parseUtcInstant,
  ValidationError,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
} from "@roamlink/contracts";

/** The closed, ordered mutation-outcome vocabulary (spec/api.md). */
export const MUTATION_OUTCOME_STAGES = [
  "accepted",
  "executed",
  "delivered",
  "billable-final",
] as const;

export type MutationOutcomeStage = (typeof MUTATION_OUTCOME_STAGES)[number];

export function isMutationOutcomeStage(value: unknown): value is MutationOutcomeStage {
  return (
    typeof value === "string" &&
    (MUTATION_OUTCOME_STAGES as readonly string[]).includes(value)
  );
}

export function parseMutationOutcomeStage(value: unknown): MutationOutcomeStage {
  if (!isMutationOutcomeStage(value)) {
    throw new ValidationError(
      "value is not a member of the closed mutation-outcome stage vocabulary (accepted, executed, delivered, billable-final)",
      {
        reason: "MUTATION_STAGE_INVALID",
        details: [{ path: "MutationOutcomeStage", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** The resource a command created or mutated (present once locatable). */
export interface AffectedResourceRef {
  /** Resource kind label, e.g. "device", "experience_intent", "order". */
  readonly type: string;
  readonly id: string;
  /** The resource revision AFTER the command, when the resource is versioned. */
  readonly version?: number;
}

/**
 * The command/resource acknowledgement returned by every mutation endpoint.
 *
 * Every stage is an independent UTC instant that is ABSENT until the stage is
 * actually reached; the parser enforces structural presence ordering
 * (delivered implies executed implies accepted; billable-final implies all).
 * A command that tops out at `executed` (e.g. a device metadata update) simply
 * never carries deliveredAt/billableFinalAt - the honest shape, never a
 * shortened one.
 */
export interface MutationAcknowledgement {
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  /** When the boundary accepted the command (always present). */
  readonly acceptedAt: string;
  /** When RoamLink applied the command to its own state. */
  readonly executedAt?: string;
  /**
   * When delivery evidence for the affected subject was linked (from the
   * commerce-to-connectivity reference model) - NOT when an order was paid
   * (RL-LOCK-008).
   */
  readonly deliveredAt?: string;
  /** When commerce finality was reached (e.g. the invoice reconciled). */
  readonly billableFinalAt?: string;
  readonly resource?: AffectedResourceRef;
}

export interface MutationAcknowledgementInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
  readonly executedAt?: string;
  readonly deliveredAt?: string;
  readonly billableFinalAt?: string;
  readonly resource?: {
    readonly type: string;
    readonly id: string;
    readonly version?: number;
  };
}

function field(label: string, issue: string): never {
  throw new ValidationError(`MutationAcknowledgement rejected: ${label} - ${issue}`, {
    reason: "MUTATION_ACK_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseInstant(value: unknown, label: string): string {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant string with an explicit zone designator");
  }
}

/**
 * Fail-closed parser for a mutation acknowledgement. Rejects unknown fields,
 * invalid ids/timestamps, and structurally impossible stage combinations
 * (a stage present while an earlier stage is absent can only mean a
 * collapsed/merged pipeline - the exact bug this contract exists to prevent).
 */
export function parseMutationAcknowledgement(value: unknown): MutationAcknowledgement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "commandId",
    "correlationId",
    "idempotencyKey",
    "acceptedAt",
    "executedAt",
    "deliveredAt",
    "billableFinalAt",
    "resource",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field(key, "unknown field (the acknowledgement carries exactly its contract fields)");
    }
  }

  let commandId: CommandId;
  try {
    commandId = parseCommandId(record["commandId"]);
  } catch {
    field("commandId", "must be a canonical lowercase UUID");
  }
  let correlationId: CorrelationId;
  try {
    correlationId = parseCorrelationId(record["correlationId"]);
  } catch {
    field("correlationId", "must be a non-empty safe reference string");
  }
  let idempotencyKey: IdempotencyKey;
  try {
    idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
  } catch {
    field("idempotencyKey", "must be a non-empty safe reference string");
  }
  if (record["acceptedAt"] === undefined) {
    field("acceptedAt", "is required (every command is accepted before anything else)");
  }
  const acceptedAt = parseInstant(record["acceptedAt"], "acceptedAt");

  const rawExecuted = record["executedAt"];
  const rawDelivered = record["deliveredAt"];
  const rawBillable = record["billableFinalAt"];
  if (rawExecuted === undefined && (rawDelivered !== undefined || rawBillable !== undefined)) {
    field("deliveredAt", "may not be present without executedAt (stages never collapse or skip)");
  }
  if (rawDelivered === undefined && rawBillable !== undefined) {
    field("billableFinalAt", "may not be present without deliveredAt (stages never collapse or skip)");
  }
  const executedAt = rawExecuted === undefined ? undefined : parseInstant(rawExecuted, "executedAt");
  const deliveredAt =
    rawDelivered === undefined ? undefined : parseInstant(rawDelivered, "deliveredAt");
  const billableFinalAt =
    rawBillable === undefined ? undefined : parseInstant(rawBillable, "billableFinalAt");

  const rawResource = record["resource"];
  let resource: AffectedResourceRef | undefined;
  if (rawResource !== undefined) {
    if (rawResource === null || typeof rawResource !== "object" || Array.isArray(rawResource)) {
      field("resource", "must be an object with type/id/version");
    }
    const resourceRecord = rawResource as Record<string, unknown>;
    for (const key of Object.keys(resourceRecord)) {
      if (!["type", "id", "version"].includes(key)) {
        field(`resource.${key}`, "unknown field");
      }
    }
    if (typeof resourceRecord["type"] !== "string" || resourceRecord["type"].length === 0) {
      field("resource.type", "must be a non-empty resource kind label");
    }
    if (typeof resourceRecord["id"] !== "string" || resourceRecord["id"].length === 0) {
      field("resource.id", "must be a non-empty resource id");
    }
    const version = resourceRecord["version"];
    if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
      field("resource.version", "must be a positive integer when present");
    }
    resource = {
      type: resourceRecord["type"],
      id: resourceRecord["id"],
      ...(version !== undefined ? { version } : {}),
    };
  }

  return Object.freeze({
    commandId,
    correlationId,
    idempotencyKey,
    acceptedAt,
    ...(executedAt !== undefined ? { executedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(billableFinalAt !== undefined ? { billableFinalAt } : {}),
    ...(resource !== undefined ? { resource } : {}),
  });
}

/**
 * The highest outcome stage RECORDED so far. Presentation helper ONLY - it
 * never replaces per-stage rendering (the UI components always render every
 * stage with its own timestamp; this exists for ordering/labels in lists).
 */
export function highestRecordedStage(
  ack: MutationAcknowledgement,
): MutationOutcomeStage {
  if (ack.billableFinalAt !== undefined) return "billable-final";
  if (ack.deliveredAt !== undefined) return "delivered";
  if (ack.executedAt !== undefined) return "executed";
  return "accepted";
}
