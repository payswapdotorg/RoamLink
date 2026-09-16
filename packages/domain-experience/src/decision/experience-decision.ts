/**
 * The ExperienceDecision read model (RL-013, spec/data-model.md
 * "Experience" aggregates: ExperienceDecision).
 *
 * The EXPLAINABLE DECISION SURFACE: given an ExperienceIntent (plus its
 * current immutable version) and the device's latest capability/context
 * snapshots, produce an immutable decision snapshot that answers "what
 * experience state does this customer have, and why" with every outcome
 * factor traceable to the input evidence that produced it.
 *
 * Invariants (RL-LOCK-004/005/010 + spec/data-model.md "State separation"):
 *  - READ-ONLY: the builder never mutates domain state and never writes to a
 *    repository; it is a pure projection of its arguments.
 *  - The decision REFERENCES the authoritative intent status (subject.intentStatus)
 *    and derives a SEPARATE read-side status; a derived status never
 *    overwrites or reinterprets authoritative state.
 *  - Decisions reference and explain; they do NOT authorize connectivity:
 *    no path/session/routing claim is made or implied. The derived status is
 *    an EXPERIENCE status, never a connectivity status.
 *  - Every input carries a digest, provenance (source authority, evidence
 *    class), freshness evaluated at an EXPLICIT instant, and a deterministic
 *    evidence weight (STALE/UNKNOWN evidence contributes weight 0).
 *  - Immutable snapshot: deeply frozen, with explicit computedAt. Rebuilding
 *    from the same inputs at the same instant produces an identical record.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  makeFreshness,
  parseContractVersion,
  parseExperienceDecisionId,
  parseExperienceIntentId,
  parseExperienceIntentVersionId,
  parseRevision,
  parseUtcInstant,
  type ContractVersion,
  type Digest,
  type EvidenceClass,
  type ExperienceDecisionId,
  type ExperienceIntentVersionId,
  type Freshness,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import type {
  DeviceCapabilitySnapshotPlain,
  DeviceCapabilityStatus,
} from "../capability/device-capability-snapshot.js";
import type { DeviceCapabilityName } from "../capability/device-capability-name.js";
import type { DeviceContextSnapshotPlain } from "../device/device-context-snapshot.js";
import type {
  ExperienceIntentRecord,
  ExperienceIntentStatus,
  ExperienceIntentVersionRecord,
} from "../intent/experience-intent.js";
import type { AccessClassName } from "../intent/access-class.js";
import {
  DOMAIN_EXPERIENCE_CONTRACT_VERSION,
  describeDomainExperienceVersionExpectation,
  isDomainExperienceRecordVersionCompatible,
} from "../version.js";
import type { DerivedExperienceStatus } from "./derived-status.js";
import { parseDerivedExperienceStatus } from "./derived-status.js";
import { EVIDENCE_CLASS_WEIGHTS, evidenceWeight, weakestEvidenceClass } from "./evidence-weight.js";

// ---------------------------------------------------------------------------
// Input/output contracts
// ---------------------------------------------------------------------------

/** A tenant-tagged capability snapshot as stored by the registry ports. */
export type CapabilitySnapshotInput = DeviceCapabilitySnapshotPlain & {
  readonly tenantId: TenantId;
};

/** The three input kinds a decision can be computed from. */
export const DECISION_INPUT_KINDS = [
  "experience-intent",
  "device-capability-snapshot",
  "device-context-snapshot",
] as const;

export type DecisionInputKind = (typeof DECISION_INPUT_KINDS)[number];

export function isDecisionInputKind(value: unknown): value is DecisionInputKind {
  return typeof value === "string" && (DECISION_INPUT_KINDS as readonly string[]).includes(value);
}

/** The closed factor-code vocabulary (explainability surface). */
export const DECISION_FACTOR_CODES = [
  "intent.status",
  "evidence.capability",
  "evidence.context",
  "access_class.device_evidence",
  "access_class.external",
  "capability.limitation",
  "capability.permission_required",
  "constraint.hard",
] as const;

export type DecisionFactorCode = (typeof DECISION_FACTOR_CODES)[number];

export function isDecisionFactorCode(value: unknown): value is DecisionFactorCode {
  return typeof value === "string" && (DECISION_FACTOR_CODES as readonly string[]).includes(value);
}

/** What a factor contributes to the derived status. */
export const DECISION_FACTOR_OUTCOMES = ["supports", "limits", "unknown"] as const;

export type DecisionFactorOutcome = (typeof DECISION_FACTOR_OUTCOMES)[number];

export function isDecisionFactorOutcome(value: unknown): value is DecisionFactorOutcome {
  return (
    typeof value === "string" && (DECISION_FACTOR_OUTCOMES as readonly string[]).includes(value)
  );
}

/** One recorded input: provenance + digest + freshness + weight. */
export interface DecisionInputRef {
  readonly kind: DecisionInputKind;
  readonly recordId: string;
  /** Deterministic digest of the input record (canonical JSON). */
  readonly digest: Digest;
  /** RoamLink owns all three input kinds (ADCOS projections are NOT inputs here). */
  readonly sourceAuthority: "roamlink";
  readonly evidenceClass: EvidenceClass;
  /**
   * Freshness evaluated at the decision instant. Absent for the intent input:
   * authoritative RoamLink state is not freshness-bound (it is truth, not an
   * observation) - only observation inputs carry freshness.
   */
  readonly freshness?: Freshness;
  /** Deterministic evidence weight (0 for stale/unknown evidence). */
  readonly weight: number;
}

/** One explainability factor: what it is, what it means, which input proved it. */
export interface DecisionFactor {
  readonly code: DecisionFactorCode;
  readonly outcome: DecisionFactorOutcome;
  /** Bounded, printable, value-free explanation (safe to render/log). */
  readonly detail: string;
  /** The input the factor was derived from (absent for intent-status factors). */
  readonly inputRef?: { readonly kind: DecisionInputKind; readonly recordId: string };
}

/** The immutable decision snapshot. */
export interface ExperienceDecisionRecord {
  readonly decisionId: ExperienceDecisionId;
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly computedAt: UtcInstant;
  readonly subject: {
    readonly intentId: ExperienceIntentRecord["intentId"];
    readonly intentVersionId: ExperienceIntentVersionId;
    readonly versionNumber: Revision;
    readonly deviceId?: string;
    /** The AUTHORITATIVE intent status, referenced (never replaced). */
    readonly intentStatus: ExperienceIntentStatus;
  };
  readonly inputs: readonly DecisionInputRef[];
  readonly derivedStatus: DerivedExperienceStatus;
  readonly factors: readonly DecisionFactor[];
}

/** Builder input: everything the decision is a function of. */
export interface ExperienceDecisionInput {
  readonly decisionId: string;
  readonly intent: ExperienceIntentRecord;
  readonly intentVersion: ExperienceIntentVersionRecord;
  readonly capabilitySnapshot?: CapabilitySnapshotInput | null;
  readonly contextSnapshot?: DeviceContextSnapshotPlain | null;
  /** The evaluation instant (explicit; tests inject the testkit clock). */
  readonly at: UtcInstant | string;
}

// ---------------------------------------------------------------------------
// Access-class -> device-capability relevance (DERIVED, explainable)
// ---------------------------------------------------------------------------

/**
 * Which device capabilities are RELEVANT to serving a preferred access
 * class, from the closed 11-name capability vocabulary. Access classes with
 * no device-side control claim (wired, satellite) map to an empty list:
 * they are provided by external access technology and device capability
 * evidence does not apply (no network facts are invented, RL-LOCK-005).
 */
export const ACCESS_CLASS_CAPABILITY_RELEVANCE: Readonly<
  Record<AccessClassName, readonly DeviceCapabilityName[]>
> = Object.freeze({
  trusted_wifi: Object.freeze(["wifi_observation", "wifi_control"] as const),
  open_wifi: Object.freeze(["wifi_observation", "wifi_control"] as const),
  hotspot: Object.freeze(["wifi_observation"] as const),
  home_cellular: Object.freeze(["cellular_data_sim_selection"] as const),
  roaming_cellular: Object.freeze(["cellular_data_sim_selection"] as const),
  wired: Object.freeze([] as const),
  satellite: Object.freeze([] as const),
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function field(label: string, issue: string): never {
  throw new ValidationError(`ExperienceDecision rejected: ${label} - ${issue}`, {
    reason: "EXPERIENCE_DECISION_INVALID",
    details: [{ path: label, issue }],
  });
}

function capabilityStatusOf(
  snapshot: CapabilitySnapshotInput,
  name: DeviceCapabilityName,
): DeviceCapabilityStatus {
  return snapshot.capabilities[name]?.status ?? "unknown";
}

interface EvidenceState {
  readonly state: "absent" | "fresh" | "stale" | "unproven";
  readonly input?: DecisionInputRef;
}

function capabilityEvidenceState(
  snapshot: CapabilitySnapshotInput | null | undefined,
  at: UtcInstant,
): EvidenceState {
  if (snapshot === null || snapshot === undefined) {
    return { state: "absent" };
  }
  const classes = Object.values(snapshot.capabilities).map((entry) => entry.evidenceClass);
  const evidenceClass = weakestEvidenceClass(classes);
  const freshness = makeFreshness(
    {
      observedAt: snapshot.observedAt,
      // The registry record carries a single instant; a durable adapter
      // records the true received-at separately (RL-LOCK-010).
      receivedAt: snapshot.observedAt,
      freshUntil: snapshot.freshUntil,
    },
    at,
  );
  const input: DecisionInputRef = Object.freeze({
    kind: "device-capability-snapshot",
    recordId: snapshot.snapshotId,
    digest: canonicalJsonDigest(snapshot as unknown as Parameters<typeof canonicalJsonDigest>[0]),
    sourceAuthority: "roamlink",
    evidenceClass,
    freshness,
    weight: evidenceWeight(evidenceClass, freshness),
  });
  return {
    state:
      freshness.freshnessState === "FRESH"
        ? "fresh"
        : freshness.freshnessState === "STALE"
          ? "stale"
          : "unproven",
    input,
  };
}

function contextEvidenceState(
  snapshot: DeviceContextSnapshotPlain | null | undefined,
  at: UtcInstant,
): EvidenceState {
  if (snapshot === null || snapshot === undefined) {
    return { state: "absent" };
  }
  // The context snapshot is a minimized device observation (RL-010).
  const evidenceClass: EvidenceClass = "OBSERVED";
  const freshness = makeFreshness(
    {
      observedAt: snapshot.observedAt,
      receivedAt: snapshot.observedAt,
      freshUntil: snapshot.freshUntil,
    },
    at,
  );
  const input: DecisionInputRef = Object.freeze({
    kind: "device-context-snapshot",
    recordId: snapshot.snapshotId,
    digest: canonicalJsonDigest(snapshot as unknown as Parameters<typeof canonicalJsonDigest>[0]),
    sourceAuthority: "roamlink",
    evidenceClass,
    freshness,
    weight: evidenceWeight(evidenceClass, freshness),
  });
  return {
    state:
      freshness.freshnessState === "FRESH"
        ? "fresh"
        : freshness.freshnessState === "STALE"
          ? "stale"
          : "unproven",
    input,
  };
}

// ---------------------------------------------------------------------------
// Factor construction (deterministic order)
// ---------------------------------------------------------------------------

function intentStatusFactor(status: ExperienceIntentStatus): DecisionFactor {
  if (status === "active") {
    return {
      code: "intent.status",
      outcome: "supports",
      detail: "the intent is active",
    };
  }
  if (status === "draft") {
    return {
      code: "intent.status",
      outcome: "limits",
      detail: "the intent is still a draft (not activated)",
    };
  }
  return {
    code: "intent.status",
    outcome: "limits",
    detail: `the intent is terminal (${status})`,
  };
}

function evidenceFactor(
  code: "evidence.capability" | "evidence.context",
  evidence: EvidenceState,
): DecisionFactor {
  const inputRef =
    evidence.input !== undefined
      ? { kind: evidence.input.kind, recordId: evidence.input.recordId }
      : undefined;
  switch (evidence.state) {
    case "fresh":
      return {
        code,
        outcome: "supports",
        detail: "device evidence is fresh",
        ...(inputRef !== undefined ? { inputRef } : {}),
      };
    case "stale":
      return {
        code,
        outcome: "limits",
        detail: "device evidence is stale (known prior state; freshness expired)",
        ...(inputRef !== undefined ? { inputRef } : {}),
      };
    case "unproven":
      return {
        code,
        outcome: "unknown",
        detail: "device evidence carries no freshness guarantee",
        ...(inputRef !== undefined ? { inputRef } : {}),
      };
    default:
      return { code, outcome: "unknown", detail: "no device evidence was provided" };
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds the immutable decision snapshot. Pure: a function of its arguments
 * evaluated at the explicit instant `at`. The output is deeply frozen.
 */
export function buildExperienceDecision(input: ExperienceDecisionInput): ExperienceDecisionRecord {
  if (input === null || typeof input !== "object") {
    field("$", "input must be an object");
  }
  if (input.intent === null || typeof input.intent !== "object") {
    field("intent", "must be an ExperienceIntent record");
  }
  if (input.intentVersion === null || typeof input.intentVersion !== "object") {
    field("intentVersion", "must be an ExperienceIntentVersion record");
  }
  const decisionId = parseExperienceDecisionId(input.decisionId);
  const at = parseUtcInstant(input.at);
  const intent = input.intent;
  const version = input.intentVersion;

  if (version.intentId !== intent.intentId) {
    field("intentVersion.intentId", "the version record must belong to the intent");
  }
  if (version.tenantId !== intent.tenantId) {
    field("intentVersion.tenantId", "the version record must belong to the intent's tenant");
  }
  if (version.versionNumber !== intent.currentVersionNumber) {
    field(
      "intentVersion.versionNumber",
      "the decision must be computed from the intent's CURRENT version",
    );
  }
  if (version.intentVersionId !== intent.currentVersionId) {
    field(
      "intentVersion.intentVersionId",
      "the decision must be computed from the intent's CURRENT version",
    );
  }

  const capability =
    input.capabilitySnapshot === undefined || input.capabilitySnapshot === null
      ? null
      : input.capabilitySnapshot;
  const context =
    input.contextSnapshot === undefined || input.contextSnapshot === null
      ? null
      : input.contextSnapshot;

  if (intent.deviceId === undefined && (capability !== null || context !== null)) {
    field(
      "capabilitySnapshot/contextSnapshot",
      "device evidence requires an intent with a target device (the intent names no device)",
    );
  }
  if (capability !== null) {
    if (capability.tenantId !== intent.tenantId) {
      field("capabilitySnapshot.tenantId", "the snapshot must belong to the intent's tenant");
    }
    if (capability.deviceId !== intent.deviceId) {
      field("capabilitySnapshot.deviceId", "the snapshot must belong to the intent's target device");
    }
  }
  if (context !== null) {
    if (context.tenantId !== intent.tenantId) {
      field("contextSnapshot.tenantId", "the snapshot must belong to the intent's tenant");
    }
    if (context.deviceId !== intent.deviceId) {
      field("contextSnapshot.deviceId", "the snapshot must belong to the intent's target device");
    }
  }

  // --- inputs (deterministic order: intent, capability, context) -----------
  const inputs: DecisionInputRef[] = [
    Object.freeze({
      kind: "experience-intent",
      recordId: version.intentVersionId,
      digest: version.payloadDigest,
      sourceAuthority: "roamlink",
      // The intent version is a deterministic record of authoritative state.
      evidenceClass: "DERIVED",
      weight: EVIDENCE_CLASS_WEIGHTS.DERIVED,
    }),
  ];

  const capabilityEvidence = capabilityEvidenceState(capability, at);
  if (capabilityEvidence.input !== undefined) {
    inputs.push(capabilityEvidence.input);
  }
  const contextEvidence = contextEvidenceState(context, at);
  if (contextEvidence.input !== undefined) {
    inputs.push(contextEvidence.input);
  }

  // --- factors (deterministic order) ----------------------------------------
  const factors: DecisionFactor[] = [intentStatusFactor(intent.status)];

  const statusOfCapability = (name: DeviceCapabilityName): DeviceCapabilityStatus =>
    capability !== null ? capabilityStatusOf(capability, name) : "unknown";

  const payload = version.payload;
  const preferred = payload.preferences.preferredAccessClasses;
  const capabilityUsable = capabilityEvidence.state === "fresh";

  for (const accessClass of preferred) {
    const relevant = ACCESS_CLASS_CAPABILITY_RELEVANCE[accessClass];
    if (relevant.length === 0) {
      factors.push({
        code: "access_class.external",
        outcome: "unknown",
        detail: `${accessClass} is provided by external access technology; device capability evidence does not apply`,
      });
      continue;
    }
    const capabilityRef =
      capabilityEvidence.input !== undefined
        ? {
            kind: capabilityEvidence.input.kind,
            recordId: capabilityEvidence.input.recordId,
          }
        : undefined;
    if (!capabilityUsable) {
      factors.push({
        code: "access_class.device_evidence",
        outcome: "unknown",
        detail: `device capability evidence for ${accessClass} is unavailable, stale or unproven`,
        ...(capabilityRef !== undefined ? { inputRef: capabilityRef } : {}),
      });
      continue;
    }
    const statuses = relevant.map((name) => ({ name, status: statusOfCapability(name) }));
    if (statuses.some((s) => s.status === "unavailable")) {
      const blocked = statuses.filter((s) => s.status === "unavailable").map((s) => s.name);
      factors.push({
        code: "capability.limitation",
        outcome: "limits",
        detail: `${accessClass} cannot be served on this device (${blocked.join(", ")} unavailable)`,
        ...(capabilityRef !== undefined ? { inputRef: capabilityRef } : {}),
      });
      continue;
    }
    if (statuses.some((s) => s.status === "requires-permission")) {
      const gated = statuses.filter((s) => s.status === "requires-permission").map((s) => s.name);
      factors.push({
        code: "capability.permission_required",
        outcome: "limits",
        detail: `${accessClass} requires a platform permission grant (${gated.join(", ")})`,
        ...(capabilityRef !== undefined ? { inputRef: capabilityRef } : {}),
      });
      continue;
    }
    if (statuses.some((s) => s.status === "unknown")) {
      factors.push({
        code: "access_class.device_evidence",
        outcome: "unknown",
        detail: `${accessClass} support is unproven (capability evidence incomplete)`,
        ...(capabilityRef !== undefined ? { inputRef: capabilityRef } : {}),
      });
      continue;
    }
    factors.push({
      code: "access_class.device_evidence",
      outcome: "supports",
      detail: `${accessClass} is servable from current device capability evidence`,
      ...(capabilityRef !== undefined ? { inputRef: capabilityRef } : {}),
    });
  }

  if (capability !== null || context !== null) {
    factors.push(evidenceFactor("evidence.capability", capabilityEvidence));
    factors.push(evidenceFactor("evidence.context", contextEvidence));
  }

  const hard = payload.hardConstraints;
  if (hard.requireEncryptedTransport) {
    factors.push({
      code: "constraint.hard",
      outcome: "limits",
      detail: "encrypted transport is a hard requirement",
    });
  }
  if (hard.forbidRoaming) {
    factors.push({
      code: "constraint.hard",
      outcome: "limits",
      detail: "roaming cellular is forbidden (hard constraint)",
    });
  }
  if (hard.forbidOpenWifi) {
    factors.push({
      code: "constraint.hard",
      outcome: "limits",
      detail: "open Wi-Fi is forbidden (hard constraint)",
    });
  }

  // --- derived status (read-side only; never overwrites the intent status) --
  const limitingCapability =
    capabilityUsable &&
    factors.some(
      (f) =>
        (f.code === "capability.limitation" || f.code === "capability.permission_required") &&
        f.outcome === "limits",
    );

  let derivedStatus: DerivedExperienceStatus;
  if (intent.status === "draft") {
    derivedStatus = "experience_pending";
  } else if (intent.status === "superseded" || intent.status === "archived" || intent.status === "canceled") {
    derivedStatus = "experience_closed";
  } else if (
    capabilityEvidence.state === "stale" ||
    contextEvidence.state === "stale" ||
    limitingCapability
  ) {
    derivedStatus = "experience_degraded";
  } else if (
    capabilityEvidence.state === "fresh" &&
    !limitingCapability &&
    (contextEvidence.state === "fresh" || contextEvidence.state === "absent")
  ) {
    derivedStatus = "experience_supported";
  } else {
    derivedStatus = "experience_unresolved";
  }

  return Object.freeze({
    decisionId,
    contractVersion: DOMAIN_EXPERIENCE_CONTRACT_VERSION,
    tenantId: intent.tenantId,
    computedAt: at,
    subject: Object.freeze({
      intentId: intent.intentId,
      intentVersionId: version.intentVersionId,
      versionNumber: version.versionNumber,
      ...(intent.deviceId !== undefined ? { deviceId: intent.deviceId } : {}),
      intentStatus: intent.status,
    }),
    inputs: Object.freeze(inputs),
    derivedStatus,
    factors: Object.freeze(factors),
  });
}

// ---------------------------------------------------------------------------
// Round-trip (read models may be persisted as immutable snapshots)
// ---------------------------------------------------------------------------

const ALLOWED_RECORD_FIELDS = new Set([
  "decisionId",
  "contractVersion",
  "tenantId",
  "computedAt",
  "subject",
  "inputs",
  "derivedStatus",
  "factors",
]);

const ALLOWED_SUBJECT_FIELDS = new Set([
  "intentId",
  "intentVersionId",
  "versionNumber",
  "deviceId",
  "intentStatus",
]);

const ALLOWED_INPUT_FIELDS = new Set([
  "kind",
  "recordId",
  "digest",
  "sourceAuthority",
  "evidenceClass",
  "freshness",
  "weight",
]);

const ALLOWED_FACTOR_FIELDS = new Set(["code", "outcome", "detail", "inputRef"]);

/**
 * Validating round-trip from an unknown (e.g. JSON-parsed) value. Re-freezes;
 * rejects unknown fields, non-member vocabularies and malformed references.
 */
export function parseExperienceDecision(value: unknown): ExperienceDecisionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_RECORD_FIELDS.has(key)) {
      field(key, "unknown field (the decision record vocabulary is closed)");
    }
  }
  const contractVersion = parseContractVersion(record["contractVersion"]);
  if (!isDomainExperienceRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeDomainExperienceVersionExpectation());
  }
  const subjectRaw = record["subject"];
  if (subjectRaw === null || typeof subjectRaw !== "object" || Array.isArray(subjectRaw)) {
    field("subject", "must be an object");
  }
  const subjectRecord = subjectRaw as Record<string, unknown>;
  for (const key of Object.keys(subjectRecord)) {
    if (!ALLOWED_SUBJECT_FIELDS.has(key)) {
      field(`subject.${key}`, "unknown field (fail-closed, RL-LOCK-017)");
    }
  }
  const subject = Object.freeze({
    intentId: parseExperienceIntentId(subjectRecord["intentId"]),
    intentVersionId: parseExperienceIntentVersionId(subjectRecord["intentVersionId"]),
    versionNumber: parseRevision(subjectRecord["versionNumber"]),
    ...(subjectRecord["deviceId"] !== undefined
      ? { deviceId: String(subjectRecord["deviceId"]) }
      : {}),
    intentStatus: subjectRecord["intentStatus"] as ExperienceIntentStatus,
  });

  const inputsRaw = record["inputs"];
  if (!Array.isArray(inputsRaw)) {
    field("inputs", "must be an array of decision input references");
  }
  const inputs: DecisionInputRef[] = [];
  for (const [index, raw] of inputsRaw.entries()) {
    const inputRecord = raw as Record<string, unknown>;
    if (inputRecord === null || typeof inputRecord !== "object") {
      field(`inputs[${index}]`, "must be an object");
    }
    for (const key of Object.keys(inputRecord)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(`inputs[${index}].${key}`, "unknown field (fail-closed)");
      }
    }
    if (!isDecisionInputKind(inputRecord["kind"])) {
      field(`inputs[${index}].kind`, "must be a decision input kind");
    }
    if (inputRecord["sourceAuthority"] !== "roamlink") {
      field(`inputs[${index}].sourceAuthority`, "must be 'roamlink' for all current input kinds");
    }
    if (typeof inputRecord["weight"] !== "number") {
      field(`inputs[${index}].weight`, "must be a number");
    }
    inputs.push({
      kind: inputRecord["kind"],
      recordId: String(inputRecord["recordId"]),
      digest: String(inputRecord["digest"]) as Digest,
      sourceAuthority: "roamlink",
      evidenceClass: String(inputRecord["evidenceClass"]) as EvidenceClass,
      ...(inputRecord["freshness"] !== undefined
        ? { freshness: inputRecord["freshness"] as Freshness }
        : {}),
      weight: inputRecord["weight"],
    });
  }

  const factorsRaw = record["factors"];
  if (!Array.isArray(factorsRaw)) {
    field("factors", "must be an array of decision factors");
  }
  const factors: DecisionFactor[] = [];
  for (const [index, raw] of factorsRaw.entries()) {
    const factorRecord = raw as Record<string, unknown>;
    if (factorRecord === null || typeof factorRecord !== "object") {
      field(`factors[${index}]`, "must be an object");
    }
    for (const key of Object.keys(factorRecord)) {
      if (!ALLOWED_FACTOR_FIELDS.has(key)) {
        field(`factors[${index}].${key}`, "unknown field (fail-closed)");
      }
    }
    if (!isDecisionFactorCode(factorRecord["code"])) {
      field(`factors[${index}].code`, "must be a decision factor code");
    }
    if (!isDecisionFactorOutcome(factorRecord["outcome"])) {
      field(`factors[${index}].outcome`, "must be supports, limits or unknown");
    }
    factors.push({
      code: factorRecord["code"],
      outcome: factorRecord["outcome"],
      detail: String(factorRecord["detail"]),
      ...(factorRecord["inputRef"] !== undefined
        ? {
            inputRef: {
              kind: (factorRecord["inputRef"] as Record<string, unknown>)["kind"] as DecisionInputKind,
              recordId: String((factorRecord["inputRef"] as Record<string, unknown>)["recordId"]),
            },
          }
        : {}),
    });
  }

  return Object.freeze({
    decisionId: parseExperienceDecisionId(record["decisionId"]),
    contractVersion,
    tenantId: parseTenantIdOf(record["tenantId"]),
    computedAt: parseUtcInstant(record["computedAt"]),
    subject,
    inputs: Object.freeze(inputs),
    derivedStatus: parseDerivedExperienceStatus(record["derivedStatus"]),
    factors: Object.freeze(factors),
  });
}

function parseTenantIdOf(value: unknown): TenantId {
  if (typeof value !== "string" || !value.startsWith("org:") && !value.startsWith("usr:")) {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
  return value as TenantId;
}
