/**
 * Compiler stages 6-8 — deterministic canonical serialization, digest
 * generation, ADCOS ConnectivityIntent command creation
 * (RL-012, spec/adcos-integration.md §4.6-§4.8).
 *
 * The canonical model is the technology-neutral compiled intent in EXACTLY
 * the shape the ADCOS integration surface (RL-031) documents for its
 * normalized intent model:
 *
 *   { requirements: [{dimension, classification, statement}...],
 *     validity: {start, end},
 *     termination: {actor, on_expiry},
 *     hard_constraints: [{dimension, statement}...] }
 *
 * Because both sides use the Wave-0 canonical JSON (sorted keys, JSON-native
 * values) and the same deterministic ordering rules, the digest computed
 * here equals the digest the integration surface computes over the
 * re-normalized command payload — one content identity across the boundary.
 *
 * The command payload (stage 8) is the STRUCTURAL intent-command input: the
 * field vocabulary matches the integration-side closed schema exactly
 * (sourceIntentId, sourceIntentVersionId, sourceIntentVersionNumber, actorId,
 * tenantId, requirements, validity, termination) so the RL-031 adapter can
 * consume the compiler output without any experience-side knowledge. The
 * compiler does NOT invent service properties, pricing terms or execution
 * scopes — those belong to later composition, never to intent compilation.
 *
 * The idempotency key and correlation id derivations mirror the
 * integration-side defaults (`idem.intent.<versionId>.<digest16>`,
 * `corr.intent.<versionId>`) so a compiled command and its submitted draft
 * agree on defaults.
 */
import {
  CommandEnvelope,
  ValidationError,
  canonicalJsonDigest,
  canonicalizeJson,
  parseActorId,
  parseCorrelationId,
  parseIdempotencyKey,
  type CanonicalJsonValue,
  type CommandEnvelopeInput,
  type Digest,
  type Revision,
} from "@roamlink/contracts";

import type { CompilerPolicyDecision, CompilerRequirementStatement } from "./requirement.js";
import type { NormalizedIntentPolicy } from "./policy.js";
import type { ValidatedCompilationInput } from "./validate-compilation-input.js";
import {
  INTENT_COMPILER_CONTRACT_VERSION,
} from "./version.js";

/** The closed field set of the compiler's command payload (stage 8). */
export const CONNECTIVITY_INTENT_COMMAND_FIELDS = [
  "sourceIntentId",
  "sourceIntentVersionId",
  "sourceIntentVersionNumber",
  "actorId",
  "tenantId",
  "requirements",
  "validity",
  "termination",
] as const;

/** The structural ADCOS-bound intent command payload (RL-031-consumable). */
export interface ConnectivityIntentCommandPayload {
  /** The ExperienceIntent the command was compiled from (traceability). */
  readonly sourceIntentId: string;
  /** The immutable intent version the command was compiled from. */
  readonly sourceIntentVersionId: string;
  /** The 1-based version number in the supersession chain. */
  readonly sourceIntentVersionNumber: number;
  readonly actorId: string;
  readonly tenantId: string;
  readonly requirements: readonly CompilerRequirementStatement[];
  readonly validity: { readonly start: string; readonly end: string };
  readonly termination: { readonly actor: string; readonly onExpiry: string };
}

/** The compiled model (audit + RL-013 explainability input). */
export interface CompiledIntentModel {
  readonly contractVersion: typeof INTENT_COMPILER_CONTRACT_VERSION;
  readonly source: {
    readonly intentId: string;
    readonly intentVersionId: string;
    readonly versionNumber: number;
    readonly tenantId: string;
  };
  readonly requirements: readonly CompilerRequirementStatement[];
  readonly hardRequirements: readonly CompilerRequirementStatement[];
  readonly softRequirements: readonly CompilerRequirementStatement[];
  readonly policyDecisions: readonly CompilerPolicyDecision[];
  readonly validity: { readonly start: string; readonly end: string };
  readonly termination: { readonly actor: string; readonly onExpiry: string };
}

/** The full compiler output: model + canonical bytes + digest + command. */
export interface CompiledIntentCommand {
  readonly model: CompiledIntentModel;
  /** The canonical model value (the exact digest input). */
  readonly canonicalModel: CanonicalJsonValue;
  /** Deterministic canonical JSON of the canonical model (stage 6). */
  readonly canonicalJson: string;
  /** Deterministic SHA-256 digest of the canonical model (stage 7). */
  readonly digest: Digest;
  /** The structural intent-command payload (stage 8). */
  readonly payload: ConnectivityIntentCommandPayload;
  /** The full §5 command envelope (RL-LOCK-014). */
  readonly envelope: CommandEnvelope;
}

function stage(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntentCompiler rejected: ${label} - ${issue}`, {
    reason: "INTENT_COMPILATION_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Stage 6 input: builds the canonical model value from the normalized policy. */
export function buildCanonicalModel(policy: NormalizedIntentPolicy): CanonicalJsonValue {
  return {
    requirements: policy.requirements.map((r) => ({
      dimension: r.dimension,
      classification: r.classification,
      statement: r.statement,
    })),
    validity: { start: policy.validity.start, end: policy.validity.end },
    termination: {
      actor: policy.validity.termination.actor,
      on_expiry: policy.validity.termination.onExpiry,
    },
    hard_constraints: policy.hardRequirements.map((r) => ({
      dimension: r.dimension,
      statement: r.statement,
    })),
  };
}

/** Deterministic digest over the canonical model (stage 7). */
export function digestOfCanonicalModel(canonicalModel: CanonicalJsonValue): Digest {
  return canonicalJsonDigest(canonicalModel);
}

/** Deterministically derives the idempotency key for a compiled command. */
export function deriveCompiledIdempotencyKey(
  sourceIntentVersionId: string,
  digest: Digest,
): string {
  return parseIdempotencyKey(`idem.intent.${sourceIntentVersionId}.${digest.slice(0, 16)}`);
}

/** Deterministically derives the default correlation id for a compiled command. */
export function deriveCompiledCorrelationId(sourceIntentVersionId: string): string {
  return parseCorrelationId(`corr.intent.${sourceIntentVersionId}`);
}

/** Stage 8: builds the structural command payload. */
export function buildCommandPayload(
  input: ValidatedCompilationInput,
  policy: NormalizedIntentPolicy,
): ConnectivityIntentCommandPayload {
  return Object.freeze({
    sourceIntentId: input.intent.intentId,
    sourceIntentVersionId: input.version.intentVersionId,
    sourceIntentVersionNumber: input.version.versionNumber,
    actorId: input.actorId,
    tenantId: input.intent.tenantId,
    requirements: policy.requirements,
    validity: Object.freeze({
      start: policy.validity.start,
      end: policy.validity.end,
    }),
    termination: Object.freeze({
      actor: policy.validity.termination.actor,
      onExpiry: policy.validity.termination.onExpiry,
    }),
  });
}

/** Stage 8: builds the §5 command envelope. */
export function buildCommandEnvelope(
  input: ValidatedCompilationInput,
  digest: Digest,
): CommandEnvelope {
  const envelopeInput: CommandEnvelopeInput = {
    commandId: input.commandId,
    correlationId: input.correlationId ?? deriveCompiledCorrelationId(input.version.intentVersionId),
    idempotencyKey: input.idempotencyKey ?? deriveCompiledIdempotencyKey(input.version.intentVersionId, digest),
    actorId: parseActorId(input.actorId),
    tenantId: input.intent.tenantId,
    intentVersion: input.version.versionNumber as Revision,
    createdAt: input.at,
    retry: { attempt: input.attempt },
  };
  return new CommandEnvelope(envelopeInput);
}

/** The compiled audit model (everything EXCEPT the canonical bytes/digest). */
export function buildCompiledModel(
  input: ValidatedCompilationInput,
  policy: NormalizedIntentPolicy,
): CompiledIntentModel {
  return Object.freeze({
    contractVersion: INTENT_COMPILER_CONTRACT_VERSION,
    source: Object.freeze({
      intentId: input.intent.intentId,
      intentVersionId: input.version.intentVersionId,
      versionNumber: input.version.versionNumber,
      tenantId: input.intent.tenantId,
    }),
    requirements: policy.requirements,
    hardRequirements: policy.hardRequirements,
    softRequirements: policy.softRequirements,
    policyDecisions: policy.policyDecisions,
    validity: Object.freeze({
      start: policy.validity.start,
      end: policy.validity.end,
    }),
    termination: Object.freeze({
      actor: policy.validity.termination.actor,
      onExpiry: policy.validity.termination.onExpiry,
    }),
  });
}

/**
 * Stages 6-8 over an already-validated input and normalized policy: canonical
 * serialization, digest, then command + envelope construction. Deterministic:
 * identical inputs always produce byte-identical canonical JSON, the same
 * digest and the same derived envelope defaults.
 */
export function serializeDigestAndCreateCommand(
  input: ValidatedCompilationInput,
  policy: NormalizedIntentPolicy,
): CompiledIntentCommand {
  if (policy.requirements.length === 0) {
    stage("requirements", "a compiled intent must carry at least one requirement statement");
  }
  const canonicalModel = buildCanonicalModel(policy);
  const canonicalJson = canonicalizeJson(canonicalModel);
  const digest = digestOfCanonicalModel(canonicalModel);
  const envelope = buildCommandEnvelope(input, digest);
  return Object.freeze({
    model: buildCompiledModel(input, policy),
    canonicalModel,
    canonicalJson,
    digest,
    payload: buildCommandPayload(input, policy),
    envelope,
  });
}

/** Validates an unknown value as a structural command payload (closed fields). */
export function parseConnectivityIntentCommandPayload(
  value: unknown,
): ConnectivityIntentCommandPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    stage("payload", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CONNECTIVITY_INTENT_COMMAND_FIELDS as readonly string[]).includes(key)) {
      stage(`payload.${key}`, "unknown field (the compiler payload vocabulary is closed)");
    }
  }
  for (const field of CONNECTIVITY_INTENT_COMMAND_FIELDS) {
    if (record[field] === undefined) {
      stage(`payload.${field}`, "is required");
    }
  }
  return value as ConnectivityIntentCommandPayload;
}
