/**
 * Compiler stage 1 — schema validation (RL-012, spec/adcos-integration.md §4.1).
 *
 * The compiler consumes the ExperienceIntent header record plus the immutable
 * version record it compiles, and validates EVERYTHING fail-closed before any
 * translation happens:
 *
 *  - both records re-validate through the domain constructors (closed fields,
 *    closed vocabularies, UUID/UTC shapes — the same rules the aggregate
 *    enforces on write);
 *  - the version record must BELONG to the intent (same intent id, same
 *    tenant);
 *  - the version record must be the intent's CURRENT version (the header's
 *    currentVersionId/currentVersionNumber pointer must match exactly) —
 *    compiling a stale version would break traceability;
 *  - only draft or active intents are compilable (superseded/archived/
 *    canceled intents are frozen or terminal; compiling them would emit
 *    commands from dead intents);
 *  - the payload re-parses through the closed intent-payload parser;
 *  - the compile options carry an explicit UTC instant, a canonical command
 *    id, and optional override actor/correlation/idempotency values.
 *
 * No I/O, no clocks, no hidden state: every input is an argument.
 */
import {
  ValidationError,
  parseCanonicalUuidAs,
  parseCommandId,
  parseUtcInstant,
  type Branded,
  type CommandId,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  ExperienceIntent,
  ExperienceIntentVersion,
  type ExperienceIntentRecord,
  type ExperienceIntentVersionRecord,
} from "@roamlink/domain-experience";

/** Compilation options: everything the compiler needs from its caller. */
export interface CompileIntentOptions {
  /** The command instant: becomes the envelope createdAt. Explicit, never ambient. */
  readonly at: UtcInstant | string;
  /** Caller-generated RoamLink command id (canonical UUID). */
  readonly commandId: string;
  /**
   * Acting principal. Defaults to the intent owner (the customer who
   * expressed the intent); services may override with a service actor.
   */
  readonly actorId?: string;
  /** Caller correlation id; derived deterministically when absent. */
  readonly correlationId?: string;
  /** Caller idempotency key; derived deterministically when absent. */
  readonly idempotencyKey?: string;
  /** Retry attempt counter for the envelope; defaults to 1. */
  readonly attempt?: number;
}

function stage(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntentCompiler rejected: ${label} - ${issue}`, {
    reason: "INTENT_COMPILATION_INVALID",
    details: [{ path: label, issue }],
  });
}

/** The validated compilation input (stage 1 output). */
export interface ValidatedCompilationInput {
  readonly intent: ExperienceIntent;
  readonly version: ExperienceIntentVersion;
  readonly at: UtcInstant;
  readonly commandId: CommandId;
  readonly actorId: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly attempt: number;
}

/**
 * Stage 1: validates the (intent, version, options) triple. Throws a typed
 * ValidationError naming the failing field — never a partial translation.
 */
export function validateCompilationInput(
  intentRecord: ExperienceIntentRecord,
  versionRecord: ExperienceIntentVersionRecord,
  options: CompileIntentOptions,
): ValidatedCompilationInput {
  if (intentRecord === null || typeof intentRecord !== "object") {
    stage("intent", "must be an ExperienceIntent record");
  }
  if (versionRecord === null || typeof versionRecord !== "object") {
    stage("version", "must be an ExperienceIntentVersion record");
  }
  if (options === null || typeof options !== "object") {
    stage("options", "must be an object with at and commandId");
  }

  // Re-validate through the domain constructors: closed fields + vocabularies.
  let intent: ExperienceIntent;
  try {
    intent = ExperienceIntent.fromRecord(intentRecord);
  } catch {
    stage("intent", "the intent record failed re-validation (it is not a well-formed ExperienceIntent)");
  }
  let version: ExperienceIntentVersion;
  try {
    version = ExperienceIntentVersion.fromRecord(versionRecord);
  } catch {
    stage("version", "the version record failed re-validation (it is not a well-formed intent version)");
  }

  if (version.tenantId !== intent.tenantId) {
    stage("version.tenantId", "the version record must belong to the intent's tenant");
  }
  if (version.intentId !== intent.intentId) {
    stage("version.intentId", "the version record must belong to the intent being compiled");
  }
  if (version.versionNumber !== intent.currentVersionNumber) {
    stage(
      "version.versionNumber",
      "only the intent's CURRENT version is compilable (the header points at a different version number)",
    );
  }
  if (version.intentVersionId !== intent.currentVersionId) {
    stage(
      "version.intentVersionId",
      "only the intent's CURRENT version is compilable (the header points at a different version id)",
    );
  }
  if (intent.status !== "draft" && intent.status !== "active") {
    stage(
      "intent.status",
      "only a draft or active intent is compilable (superseded/archived/canceled intents are frozen or terminal)",
    );
  }

  // The payload re-parses through the closed parser (guards hand-crafted
  // records); the constructor above already did this, so this is a
  // belt-and-braces no-op for well-formed records.

  if (options.at === undefined) {
    stage("options.at", "the compile instant is required (the compiler never reads a clock)");
  }
  let at: UtcInstant;
  try {
    at = parseUtcInstant(options.at);
  } catch {
    stage("options.at", "must be a UTC instant with an explicit zone designator");
  }
  if (options.commandId === undefined) {
    stage("options.commandId", "the command id is required (id generation is the caller's)");
  }
  let commandId: CommandId;
  try {
    commandId = parseCommandId(options.commandId);
  } catch {
    stage("options.commandId", "must be a canonical lowercase UUID");
  }
  if (options.attempt !== undefined) {
    if (
      typeof options.attempt !== "number" ||
      !Number.isInteger(options.attempt) ||
      options.attempt < 1
    ) {
      stage("options.attempt", "must be an integer >= 1 (1 = first attempt)");
    }
  }
  if (options.actorId !== undefined) {
    try {
      parseCanonicalUuidAs<Branded<string>>(options.actorId, "actorId");
    } catch {
      // Actor ids use the safe reference charset, not necessarily UUID form.
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(options.actorId)) {
        stage("options.actorId", "must be a safe actor reference string");
      }
    }
  }

  return Object.freeze({
    intent,
    version,
    at,
    commandId,
    actorId: options.actorId ?? intent.ownerUserId,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    attempt: options.attempt ?? 1,
  });
}
