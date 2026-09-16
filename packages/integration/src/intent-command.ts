/**
 * The ADCOS intent command mapping (RL-031, spec/adcos-integration.md §4+§5).
 *
 * This module implements the intent-submission HALF of the compile pipeline:
 * it maps a RoamLink-side, structurally-typed intent command input onto the
 * ADCOS v2 `intent_create` request and the full §5 command envelope, with
 * DETERMINISM as the hard contract:
 *
 *   same input (+ same instant + same generated ids) -> same normalized
 *   model, same canonical bytes, same digest, same idempotency key.
 *
 * The input is deliberately STRUCTURAL (plain JSON shapes, no imports from
 * @roamlink/domain-experience): the ExperienceIntent -> intent-command
 * compilation is RL-012 (Wave 2 Worker A, owns the experience domain); this
 * package owns the ADCOS-side mapping and never touches the domain aggregate
 * (RL-LOCK-019 disjoint ownership; RL-LOCK-007 mapping is explicit and
 * versioned).
 *
 * Pipeline performed here (§4, minus the domain-side preference translation
 * that belongs to RL-012):
 *   1. schema validation (closed vocabularies, closed fields, UUID/UTC
 *      shapes, bounded validity window);
 *   2. policy normalization (requirement dedupe + deterministic ordering);
 *   3. hard/soft constraint classification (hard requirements additionally
 *      populate the v2 `hard_constraints` field);
 *   4. validity-window calculation (normalized UTC window; `recorded_at` =
 *      the command instant);
 *   5. deterministic canonical serialization + SHA-256 digest
 *      (@roamlink/contracts canonical JSON);
 *   6. ADCOS ConnectivityIntent command creation (the closed v2 request
 *      schema) + §5 command envelope construction.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  canonicalizeJson,
  compareUtcInstants,
  parseActorId,
  parseCanonicalUuidAs,
  parseIdempotencyKey,
  parseTenantId,
  parseUtcInstant,
  type Branded,
  type CanonicalJsonValue,
  type CommandEnvelopeInput,
  type Digest,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import { CommandEnvelope } from "@roamlink/contracts";
import { parseAdcosContractRef } from "@roamlink/contracts";
import { parseAdcosIntentRequest, type AdcosIntentRequest } from "@roamlink/adcos";

// --------------------------------------------------------------------------------
// The ADCOS-bound intent dimension vocabulary (closed)
// --------------------------------------------------------------------------------

/**
 * The technology-neutral intent dimensions RoamLink can express to ADCOS
 * (spec/architecture.md §3: locality, reliability, latency, cost, privacy and
 * validity; technology/mobility/usage close the compiler's surface). The
 * ExperienceIntent vocabulary translation is RL-012's concern; this is the
 * integration-side, ADCOS-bound vocabulary.
 */
export const INTENT_DIMENSIONS = [
  "locality",
  "reliability",
  "latency",
  "cost",
  "privacy",
  "technology",
  "mobility",
  "usage",
] as const;

export type IntentDimension = (typeof INTENT_DIMENSIONS)[number];

export function isIntentDimension(value: unknown): value is IntentDimension {
  return typeof value === "string" && (INTENT_DIMENSIONS as readonly string[]).includes(value);
}

/** Hard = refuse-to-trade; soft = preference the authority may weigh (§4.3). */
export const REQUIREMENT_CLASSIFICATIONS = ["hard", "soft"] as const;

export type RequirementClassification = (typeof REQUIREMENT_CLASSIFICATIONS)[number];

export function isRequirementClassification(value: unknown): value is RequirementClassification {
  return (
    typeof value === "string" && (REQUIREMENT_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/** One classified, technology-neutral requirement statement. */
export interface IntentRequirementStatement {
  readonly dimension: IntentDimension;
  readonly classification: RequirementClassification;
  /** The normalized constraint/preference payload (canonical JSON value). */
  readonly statement: CanonicalJsonValue;
}

/** The RoamLink-side validity window (bounded UTC interval). */
export interface IntentValidityWindowInput {
  readonly start: string;
  readonly end: string;
}

/** The termination policy mapped into the v2 `termination` mapping. */
export interface IntentTerminationPolicyInput {
  /** Who may terminate the intent's derived resources. */
  readonly actor: "customer" | "roamlink" | "adcos";
  /** What happens when the validity window expires. */
  readonly onExpiry: "release" | "renew";
}

export const INTENT_TERMINATION_ACTORS = ["customer", "roamlink", "adcos"] as const;
export const INTENT_TERMINATION_EXPIRY_POLICIES = ["release", "renew"] as const;

/** Maximum validity-window duration (366 days, mirroring the domain bound). */
export const MAX_INTENT_VALIDITY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const INTENT_COMMAND_FIELDS = [
  "sourceIntentId",
  "sourceIntentVersionId",
  "sourceIntentVersionNumber",
  "actorId",
  "tenantId",
  "requirements",
  "validity",
  "termination",
  "beneficiaries",
  "serviceProperties",
  "usagePricingTerms",
  "assuranceObligations",
  "executionScope",
  "supersededContract",
] as const;

const REQUIREMENT_FIELDS = ["dimension", "classification", "statement"] as const;

function field(label: string, issue: string): never {
  throw new ValidationError(`IntentCommandInput rejected: ${label} - ${issue}`, {
    reason: "INTENT_COMMAND_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseStatement(value: unknown, label: string): CanonicalJsonValue {
  if (value === undefined) {
    field(label, "is required (a requirement always carries a statement)");
  }
  try {
    canonicalizeJson(value);
  } catch {
    field(label, "must be a canonicalizable JSON value");
  }
  return value as CanonicalJsonValue;
}

// --------------------------------------------------------------------------------
// The intent command input (the compiler-facing contract)
// --------------------------------------------------------------------------------

/**
 * The ADCOS-bound intent command input. Produced by the ExperienceIntent
 * compiler (RL-012) or composed by the integration surface; carries the §5
 * actor/tenant/provenance fields so the mapping can build the command
 * envelope with full traceability (source intent id + version are preserved
 * end-to-end).
 */
export interface IntentCommandInput {
  /** The ExperienceIntent the command was compiled from (traceability). */
  readonly sourceIntentId: string;
  /** The immutable intent version the command was compiled from. */
  readonly sourceIntentVersionId: string;
  /** The 1-based version number in the supersession chain. */
  readonly sourceIntentVersionNumber: number;
  readonly actorId: string;
  readonly tenantId: string;
  readonly requirements: readonly IntentRequirementStatement[];
  readonly validity: IntentValidityWindowInput;
  readonly termination: IntentTerminationPolicyInput;
  readonly beneficiaries?: CanonicalJsonValue;
  readonly serviceProperties?: CanonicalJsonValue;
  readonly usagePricingTerms?: CanonicalJsonValue;
  readonly assuranceObligations?: CanonicalJsonValue;
  readonly executionScope?: CanonicalJsonValue;
  /** The ADCOS contract this intent supersedes, when replacing one. */
  readonly supersededContract?: string;
}

// --------------------------------------------------------------------------------
// Normalization (steps 1-3 of the pipeline)
// --------------------------------------------------------------------------------

/** The normalized, deterministically ordered intent model. */
export interface NormalizedIntentCommand {
  readonly requirements: readonly IntentRequirementStatement[];
  readonly validity: { readonly start: UtcInstant; readonly end: UtcInstant };
  readonly termination: IntentTerminationPolicyInput;
  readonly hardRequirements: readonly IntentRequirementStatement[];
  readonly softRequirements: readonly IntentRequirementStatement[];
}

function classificationRank(classification: RequirementClassification): number {
  return classification === "hard" ? 0 : 1;
}

/**
 * Validates and normalizes an intent command input:
 *  - schema validation (closed fields/vocabularies, bounded window);
 *  - requirement dedupe (identical dimension+classification+statement);
 *  - deterministic ordering: dimension, then classification (hard first),
 *    then the canonical JSON of the statement - so input ordering NEVER
 *    affects the digest.
 */
export function normalizeIntentCommand(input: IntentCommandInput): NormalizedIntentCommand {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    field("$", "must be an object");
  }
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(INTENT_COMMAND_FIELDS as readonly string[]).includes(key)) {
      field(key, "unknown field (the intent-command vocabulary is closed)");
    }
  }

  try {
    parseCanonicalUuidAs<Branded<string>>(input.sourceIntentId, "sourceIntentId");
  } catch {
    field("sourceIntentId", "must be a canonical lowercase UUID (the source ExperienceIntent id)");
  }
  try {
    parseCanonicalUuidAs<Branded<string>>(input.sourceIntentVersionId, "sourceIntentVersionId");
  } catch {
    field("sourceIntentVersionId", "must be a canonical lowercase UUID (the source intent version id)");
  }
  if (
    typeof input.sourceIntentVersionNumber !== "number" ||
    !Number.isInteger(input.sourceIntentVersionNumber) ||
    input.sourceIntentVersionNumber < 1
  ) {
    field("sourceIntentVersionNumber", "must be a positive integer (1-based version chain position)");
  }
  try {
    parseActorId(input.actorId);
  } catch {
    field("actorId", "must be a safe actor reference");
  }
  try {
    parseTenantId(input.tenantId);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }

  if (!Array.isArray(input.requirements)) {
    field("requirements", "must be a list of requirement statements");
  }
  const seen = new Set<string>();
  const requirements: IntentRequirementStatement[] = [];
  for (const [index, raw] of (input.requirements as readonly unknown[]).entries()) {
    const label = `requirements[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      field(label, "must be an object");
    }
    const statementRecord = raw as Record<string, unknown>;
    for (const key of Object.keys(statementRecord)) {
      if (!(REQUIREMENT_FIELDS as readonly string[]).includes(key)) {
        field(`${label}.${key}`, "unknown field (the requirement vocabulary is closed)");
      }
    }
    if (!isIntentDimension(statementRecord["dimension"])) {
      field(`${label}.dimension`, `must be one of: ${INTENT_DIMENSIONS.join(", ")}`);
    }
    if (!isRequirementClassification(statementRecord["classification"])) {
      field(`${label}.classification`, "must be 'hard' or 'soft'");
    }
    const statement = parseStatement(statementRecord["statement"], `${label}.statement`);
    const requirement: IntentRequirementStatement = Object.freeze({
      dimension: statementRecord["dimension"],
      classification: statementRecord["classification"],
      statement,
    });
    const identity = canonicalizeJson({
      dimension: requirement.dimension,
      classification: requirement.classification,
      statement: requirement.statement,
    });
    if (seen.has(identity)) {
      // duplicate identical statements are dropped (policy normalization)
      continue;
    }
    seen.add(identity);
    requirements.push(requirement);
  }
  requirements.sort((a, b) => {
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    if (a.classification !== b.classification) {
      return classificationRank(a.classification) - classificationRank(b.classification);
    }
    const aJson = canonicalizeJson(a.statement);
    const bJson = canonicalizeJson(b.statement);
    return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
  });

  const validityRaw = input.validity;
  if (validityRaw === null || typeof validityRaw !== "object" || Array.isArray(validityRaw)) {
    field("validity", "must be an object with start and end UTC instants");
  }
  for (const key of Object.keys(validityRaw as unknown as Record<string, unknown>)) {
    if (!["start", "end"].includes(key)) {
      field(`validity.${key}`, "unknown field (the validity window is start/end only)");
    }
  }
  let start: UtcInstant;
  let end: UtcInstant;
  try {
    start = parseUtcInstant((validityRaw as unknown as Record<string, unknown>)["start"]);
    end = parseUtcInstant((validityRaw as unknown as Record<string, unknown>)["end"]);
  } catch {
    field("validity", "start and end must be UTC instants with explicit zone designators");
  }
  if (compareUtcInstants(start, end) >= 0) {
    field("validity", "start must be strictly before end");
  }
  if (new Date(end).getTime() - new Date(start).getTime() > MAX_INTENT_VALIDITY_WINDOW_MS) {
    field("validity", `the window duration must not exceed ${MAX_INTENT_VALIDITY_WINDOW_MS} ms (366 days)`);
  }

  const terminationRaw = input.termination;
  if (terminationRaw === null || typeof terminationRaw !== "object" || Array.isArray(terminationRaw)) {
    field("termination", "must be an object with actor and onExpiry");
  }
  for (const key of Object.keys(terminationRaw as unknown as Record<string, unknown>)) {
    if (!["actor", "onExpiry"].includes(key)) {
      field(`termination.${key}`, "unknown field (the termination policy vocabulary is closed)");
    }
  }
  if (
    !(INTENT_TERMINATION_ACTORS as readonly string[]).includes(
      (terminationRaw as unknown as Record<string, unknown>)["actor"] as unknown as string,
    )
  ) {
    field("termination.actor", "must be customer, roamlink or adcos");
  }
  if (
    !(INTENT_TERMINATION_EXPIRY_POLICIES as readonly string[]).includes(
      (terminationRaw as unknown as Record<string, unknown>)["onExpiry"] as unknown as string,
    )
  ) {
    field("termination.onExpiry", "must be release or renew");
  }
  const termination: IntentTerminationPolicyInput = {
    actor: (terminationRaw as unknown as Record<string, unknown>)["actor"] as IntentTerminationPolicyInput["actor"],
    onExpiry: (terminationRaw as unknown as Record<string, unknown>)["onExpiry"] as IntentTerminationPolicyInput["onExpiry"],
  };

  for (const [key, value] of Object.entries({
    beneficiaries: input.beneficiaries,
    serviceProperties: input.serviceProperties,
    usagePricingTerms: input.usagePricingTerms,
    assuranceObligations: input.assuranceObligations,
    executionScope: input.executionScope,
  })) {
    if (value !== undefined) {
      parseStatement(value, key);
    }
  }
  if (input.supersededContract !== undefined) {
    try {
      parseAdcosContractRef(input.supersededContract);
    } catch {
      field("supersededContract", "must be a safe ADCOS contract reference");
    }
  }
  const hardRequirements = requirements.filter((r) => r.classification === "hard");
  const softRequirements = requirements.filter((r) => r.classification === "soft");
  return Object.freeze({
    requirements: Object.freeze(requirements),
    validity: Object.freeze({ start, end }),
    termination: Object.freeze(termination),
    hardRequirements: Object.freeze(hardRequirements),
    softRequirements: Object.freeze(softRequirements),
  });
}

// --------------------------------------------------------------------------------
// Digest + request construction (steps 4-6)
// --------------------------------------------------------------------------------

/** The digest input: the normalized intent model, canonical JSON. */
export function canonicalIntentModel(normalized: NormalizedIntentCommand): CanonicalJsonValue {
  return {
    requirements: normalized.requirements.map((r) => ({
      dimension: r.dimension,
      classification: r.classification,
      statement: r.statement,
    })),
    validity: { start: normalized.validity.start, end: normalized.validity.end },
    termination: { actor: normalized.termination.actor, on_expiry: normalized.termination.onExpiry },
    hard_constraints: normalized.hardRequirements.map((r) => ({
      dimension: r.dimension,
      statement: r.statement,
    })),
  };
}

/** Deterministic digest over the normalized intent model (§4.6-4.7). */
export function intentCommandDigest(normalized: NormalizedIntentCommand): Digest {
  return canonicalJsonDigest(canonicalIntentModel(normalized));
}

/** Deterministically derives the idempotency key for an intent command. */
export function deriveIntentIdempotencyKey(
  sourceIntentVersionId: string,
  digest: Digest,
): string {
  const key = `idem.intent.${sourceIntentVersionId}.${digest.slice(0, 16)}`;
  return parseIdempotencyKey(key);
}

/** Deterministically derives the default correlation id for an intent command. */
export function deriveIntentCorrelationId(sourceIntentVersionId: string): string {
  return `corr.intent.${sourceIntentVersionId}`;
}

/** The deterministic mapping output: v2 request + envelope + digest. */
export interface IntentCommandDraft {
  /** The validated v2 intent_create request body (closed schema). */
  readonly request: AdcosIntentRequest;
  /** The full §5 command envelope (RL-LOCK-014). */
  readonly envelope: CommandEnvelope;
  /** Digest of the normalized intent model (deterministic). */
  readonly intentDigest: Digest;
  /** The normalized model (audit/projection input). */
  readonly normalized: NormalizedIntentCommand;
}

export interface CompileIntentCommandOptions {
  /** The command instant: becomes `recorded_at` and the envelope createdAt. */
  readonly at: UtcInstant | string;
  /** The RoamLink command id (UUID); required (id generation is the caller's). */
  readonly commandId: string;
  /** Optional caller correlation id; derived from the source version when absent. */
  readonly correlationId?: string;
  /** Optional caller idempotency key; derived deterministically when absent. */
  readonly idempotencyKey?: string;
  /** Retry metadata for the envelope; defaults to attempt 1. */
  readonly attempt?: number;
}

function requirementList(normalized: NormalizedIntentCommand): CanonicalJsonValue {
  return normalized.requirements.map((r) => ({
    dimension: r.dimension,
    classification: r.classification,
    statement: r.statement,
  }));
}

function hardConstraintsValue(normalized: NormalizedIntentCommand): CanonicalJsonValue | undefined {
  if (normalized.hardRequirements.length === 0) return undefined;
  return normalized.hardRequirements.map((r) => ({
    dimension: r.dimension,
    statement: r.statement,
  }));
}

/**
 * The deterministic intent-command mapping (§4): normalized input -> closed
 * v2 request + full §5 envelope. Same input, instant and ids ALWAYS produce
 * byte-identical output (canonical JSON everywhere).
 */
export function compileIntentCommand(
  input: IntentCommandInput,
  options: CompileIntentCommandOptions,
): IntentCommandDraft {
  const normalized = normalizeIntentCommand(input);
  const at = parseUtcInstant(options.at);
  const digest = intentCommandDigest(normalized);

  const envelopeInput: CommandEnvelopeInput = {
    commandId: options.commandId,
    correlationId: options.correlationId ?? deriveIntentCorrelationId(input.sourceIntentVersionId),
    idempotencyKey: options.idempotencyKey ?? deriveIntentIdempotencyKey(input.sourceIntentVersionId, digest),
    actorId: input.actorId,
    tenantId: input.tenantId,
    intentVersion: input.sourceIntentVersionNumber as Revision,
    createdAt: at,
    retry: { attempt: options.attempt ?? 1 },
  };
  const envelope = new CommandEnvelope(envelopeInput);

  const hardConstraints = hardConstraintsValue(normalized);
  const requestInput: Record<string, unknown> = {
    requirements: requirementList(normalized),
    validity: { start: normalized.validity.start, end: normalized.validity.end },
    termination: {
      actor: normalized.termination.actor,
      on_expiry: normalized.termination.onExpiry,
    },
    recorded_at: at,
    ...(hardConstraints !== undefined ? { hard_constraints: hardConstraints } : {}),
    ...(input.beneficiaries !== undefined ? { beneficiaries: input.beneficiaries } : {}),
    ...(input.serviceProperties !== undefined ? { service_properties: input.serviceProperties } : {}),
    ...(input.usagePricingTerms !== undefined ? { usage_pricing_terms: input.usagePricingTerms } : {}),
    ...(input.assuranceObligations !== undefined ? { assurance_obligations: input.assuranceObligations } : {}),
    ...(input.executionScope !== undefined ? { execution_scope: input.executionScope } : {}),
    ...(input.supersededContract !== undefined ? { superseded_contract: input.supersededContract } : {}),
  };
  // Validate through the boundary's closed v2 schema (throws typed
  // ValidationError on any contract violation before any I/O happens).
  const request = parseAdcosIntentRequest(requestInput);

  return Object.freeze({
    request,
    envelope,
    intentDigest: digest,
    normalized,
  });
}

/** Records why the previous attempt of an intent command failed. */
export interface IntentCommandLastErrorInput {
  /** UPPER_SNAKE_CASE reason code of the previous failure. */
  readonly reason: string;
  /** RoamLink error kind of the previous failure. */
  readonly kind: string;
  readonly occurredAt: string;
}

/**
 * Builds the retry draft for a failed attempt: SAME command id, SAME
 * idempotency key, SAME request bytes - only the retry metadata changes
 * (attempt + 1, last error recorded). This is what makes retries safe after
 * timeout, connection loss or duplicate delivery (RL-LOCK-014).
 */
export function retryIntentCommand(
  draft: IntentCommandDraft,
  input: IntentCommandInput,
  lastError: IntentCommandLastErrorInput,
): IntentCommandDraft {
  const attempt = draft.envelope.retry.attempt + 1;
  // Re-derive the mapping from the SAME input and verify the digest is
  // unchanged: an idempotency key must never be reused for a different
  // payload (RL-LOCK-014) - a mismatch fails loudly, never silently.
  const rebuilt = compileIntentCommand(input, {
    at: draft.envelope.createdAt,
    commandId: draft.envelope.commandId,
    correlationId: draft.envelope.correlationId,
    idempotencyKey: draft.envelope.idempotencyKey,
    attempt,
  });
  if (rebuilt.intentDigest !== draft.intentDigest) {
    throw new ValidationError(
      "retryIntentCommand: the retried input maps to a different intent digest; an idempotency key must never be reused for a different payload (RL-LOCK-014)",
      {
        reason: "INTENT_COMMAND_RETRY_MISMATCH",
        details: [{ path: "intentDigest", issue: "the retry payload differs from the original command" }],
      },
    );
  }
  const envelope = new CommandEnvelope({
    commandId: draft.envelope.commandId,
    correlationId: draft.envelope.correlationId,
    idempotencyKey: draft.envelope.idempotencyKey,
    actorId: draft.envelope.actorId,
    tenantId: draft.envelope.tenantId,
    ...(draft.envelope.intentVersion !== undefined
      ? { intentVersion: draft.envelope.intentVersion }
      : {}),
    ...(draft.envelope.orderVersion !== undefined
      ? { orderVersion: draft.envelope.orderVersion }
      : {}),
    createdAt: draft.envelope.createdAt,
    retry: {
      attempt,
      lastError: {
        reason: lastError.reason,
        kind: lastError.kind,
        occurredAt: parseUtcInstant(lastError.occurredAt),
      },
    },
  });
  return Object.freeze({ ...draft, envelope });
}
