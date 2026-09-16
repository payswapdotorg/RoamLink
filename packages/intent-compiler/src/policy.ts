/**
 * Compiler stages 2-5 — policy normalization, hard/soft classification,
 * privacy/service constraint mapping, validity-window calculation
 * (RL-012, spec/adcos-integration.md §4.2-§4.5).
 *
 * Everything here is a PURE translation of the ExperienceIntentPayload into
 * technology-neutral requirement statements. The compiler may translate,
 * prioritize and explain — it may NOT invent network facts (RL-LOCK-005/007):
 * every emitted statement is traceable to an explicit payload field.
 *
 * Translation table (source -> requirement):
 *   usageProfile                    -> usage    soft  {profile}
 *   preferences.costSensitivity     -> cost     soft  {sensitivity}
 *   preferences.reliability         -> reliability soft {level}          [service]
 *   preferences.latency             -> latency  soft  {sensitivity}       [service]
 *   preferences.privacySensitivity  -> privacy  soft  {sensitivity}      [privacy]
 *   preferredAccessClasses[i]       -> technology soft {preferredAccessClass, rank}
 *   hardConstraints.requireEncryptedTransport -> privacy hard {transportEncryption:"required"}
 *   hardConstraints.forbidRoaming   -> technology hard {forbiddenAccessClass:"roaming_cellular"}
 *   hardConstraints.forbidOpenWifi  -> technology hard {forbiddenAccessClass:"open_wifi"}
 *   travelWindow                    -> validity {start,end} + termination policy
 *
 * Policy normalization also RESOLVES CONTRADICTIONS deterministically: a hard
 * constraint forbidding an access class removes that class from the soft
 * preference ranking (hard wins), and the drop is recorded as a
 * {@link CompilerPolicyDecision} so explainability and audits can show why.
 */
import {
  ValidationError,
  canonicalizeJson,
  compareUtcInstants,
  type UtcInstant,
} from "@roamlink/contracts";
import type {
  ExperienceIntentPayload,
} from "@roamlink/domain-experience";

import type {
  CompilerPolicyDecision,
  CompilerRequirementStatement,
  IntentDimension,
  RequirementClassification,
} from "./requirement.js";
import { parseCompilerRequirementStatement } from "./requirement.js";

/**
 * The deterministic termination policy every compiled intent carries: the
 * customer owns the intent (they expressed it), and when the validity window
 * expires the derived resources are released rather than silently renewed.
 * Renewal is an explicit customer act (a new intent version), never a
 * compiler default.
 */
export const COMPILER_TERMINATION_POLICY = Object.freeze({
  actor: "customer",
  onExpiry: "release",
} as const);

/** The calculated validity window + termination policy (stage 5 output). */
export interface CalculatedValidityWindow {
  readonly start: UtcInstant;
  readonly end: UtcInstant;
  readonly termination: { readonly actor: "customer"; readonly onExpiry: "release" };
}

/** The normalized policy: classified requirements + decisions + window. */
export interface NormalizedIntentPolicy {
  readonly requirements: readonly CompilerRequirementStatement[];
  readonly hardRequirements: readonly CompilerRequirementStatement[];
  readonly softRequirements: readonly CompilerRequirementStatement[];
  readonly policyDecisions: readonly CompilerPolicyDecision[];
  readonly validity: CalculatedValidityWindow;
}

function stage(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntentCompiler rejected: ${label} - ${issue}`, {
    reason: "INTENT_COMPILATION_INVALID",
    details: [{ path: label, issue }],
  });
}

function requirement(
  dimension: IntentDimension,
  classification: RequirementClassification,
  statement: Record<string, unknown>,
): CompilerRequirementStatement {
  return parseCompilerRequirementStatement({
    dimension,
    classification,
    statement: Object.freeze({ ...statement }),
  });
}

/**
 * Classification rank for deterministic ordering: hard requirements sort
 * before soft within a dimension.
 */
function classificationRank(classification: RequirementClassification): number {
  return classification === "hard" ? 0 : 1;
}

/**
 * Stages 2-4: normalize the payload into classified, technology-neutral
 * requirement statements. Deterministic ordering (dimension, then hard
 * first, then canonical statement JSON) means input representation NEVER
 * affects the output order — or the digest computed from it.
 */
export function normalizeIntentPolicy(
  payload: ExperienceIntentPayload,
): Omit<NormalizedIntentPolicy, "validity"> {
  const decisions: CompilerPolicyDecision[] = [];
  const requirements: CompilerRequirementStatement[] = [];

  // --- stage 2: policy normalization (preferences -> soft statements) --------
  requirements.push(requirement("usage", "soft", { profile: payload.usageProfile }));
  decisions.push({
    kind: "preference-translated",
    dimension: "usage",
    source: "usageProfile",
  });

  requirements.push(
    requirement("cost", "soft", { sensitivity: payload.preferences.costSensitivity }),
  );
  decisions.push({
    kind: "preference-translated",
    dimension: "cost",
    source: "preferences.costSensitivity",
  });

  // Contradiction resolution: a forbidden access class is removed from the
  // preference ranking (hard wins over soft, deterministically).
  const forbiddenClasses = new Set<string>();
  if (payload.hardConstraints.forbidRoaming) {
    forbiddenClasses.add("roaming_cellular");
  }
  if (payload.hardConstraints.forbidOpenWifi) {
    forbiddenClasses.add("open_wifi");
  }
  const rankedClasses: string[] = [];
  for (const accessClass of payload.preferences.preferredAccessClasses) {
    if (forbiddenClasses.has(accessClass)) {
      decisions.push({
        kind: "dropped-contradictory-preference",
        accessClass,
        because: accessClass === "roaming_cellular" ? "forbidRoaming" : "forbidOpenWifi",
      });
      continue;
    }
    rankedClasses.push(accessClass);
  }
  // Preferred access classes are PREFERENCES ONLY (RL-LOCK-007): they always
  // compile to SOFT technology statements, never constraints.
  for (const [index, accessClass] of rankedClasses.entries()) {
    requirements.push(
      requirement("technology", "soft", {
        preferredAccessClass: accessClass,
        rank: index + 1,
      }),
    );
  }

  // --- stage 3: hard/soft constraint classification ---------------------------
  // The three boolean hard constraints are refuse-to-trade requirements and
  // compile to HARD statements in their home dimensions.
  if (payload.hardConstraints.requireEncryptedTransport) {
    requirements.push(requirement("privacy", "hard", { transportEncryption: "required" }));
  }
  if (payload.hardConstraints.forbidRoaming) {
    requirements.push(requirement("technology", "hard", { forbiddenAccessClass: "roaming_cellular" }));
  }
  if (payload.hardConstraints.forbidOpenWifi) {
    requirements.push(requirement("technology", "hard", { forbiddenAccessClass: "open_wifi" }));
  }

  // --- stage 4: privacy/service constraint mapping ---------------------------
  // Privacy mapping: privacy sensitivity -> soft privacy statement (the
  // encryption hard constraint was placed in the privacy dimension above).
  requirements.push(
    requirement("privacy", "soft", { sensitivity: payload.preferences.privacySensitivity }),
  );
  decisions.push({
    kind: "preference-translated",
    dimension: "privacy",
    source: "preferences.privacySensitivity",
  });
  // Service mapping: reliability and latency are the service-quality family.
  requirements.push(requirement("reliability", "soft", { level: payload.preferences.reliability }));
  decisions.push({
    kind: "preference-translated",
    dimension: "reliability",
    source: "preferences.reliability",
  });
  requirements.push(requirement("latency", "soft", { sensitivity: payload.preferences.latency }));
  decisions.push({
    kind: "preference-translated",
    dimension: "latency",
    source: "preferences.latency",
  });

  // Deterministic ordering (identical rules to the integration-side
  // normalization, so a re-normalized payload yields the same order).
  const sorted = [...requirements].sort((a, b) => {
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    if (a.classification !== b.classification) {
      return classificationRank(a.classification) - classificationRank(b.classification);
    }
    const aJson = canonicalizeJson(a.statement);
    const bJson = canonicalizeJson(b.statement);
    return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
  });

  return Object.freeze({
    requirements: Object.freeze(sorted),
    hardRequirements: Object.freeze(sorted.filter((r) => r.classification === "hard")),
    softRequirements: Object.freeze(sorted.filter((r) => r.classification === "soft")),
    policyDecisions: Object.freeze(decisions),
  });
}

/**
 * Stage 5: validity-window calculation.
 *
 * The travel window becomes the command's validity window verbatim (the
 * payload parser already guarantees start < end and a duration bound of 366
 * days). The compiler adds one rule of its own: a window that has FULLY
 * elapsed at the compile instant is rejected — a command for the past would
 * be dead on arrival and silently useless.
 */
export function calculateValidityWindow(
  payload: ExperienceIntentPayload,
  at: UtcInstant,
): CalculatedValidityWindow {
  const { start, end } = payload.travelWindow;
  if (compareUtcInstants(start, end) >= 0) {
    stage("travelWindow", "start must be strictly before end");
  }
  if (compareUtcInstants(end, at) <= 0) {
    stage(
      "travelWindow",
      "the validity window has fully elapsed at the compile instant; a command for the past is dead on arrival - revise the intent instead",
    );
  }
  return Object.freeze({
    start,
    end,
    termination: COMPILER_TERMINATION_POLICY,
  });
}

/** Stages 2-5 combined: the full normalized policy. */
export function normalizePolicy(
  payload: ExperienceIntentPayload,
  at: UtcInstant,
): NormalizedIntentPolicy {
  const normalized = normalizeIntentPolicy(payload);
  return Object.freeze({
    ...normalized,
    validity: calculateValidityWindow(payload, at),
  });
}
