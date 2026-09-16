/**
 * The platform action-executor seam (RL-043, spec/mobile.md "Platform
 * constraints", RL-LOCK-011/013).
 *
 * {@link PlatformActionExecutor} is the STABLE ADAPTER SEAM every
 * platform-specific implementation (iOS/Android/desktop/enterprise connector)
 * hangs behind. No platform type crosses it: a request is a
 * {@link import("@roamlink/edge").DeviceActionRequest} (capability requirement
 * + minimal platform-neutral parameters) and the outcome is one of the typed
 * variants of {@link PlatformExecutionOutcome}. Platform SDKs live on the
 * IMPLEMENTATION side of the seam only - Experience/Commerce core code never
 * sees them (RL-LOCK-013).
 *
 * EVIDENCE DISCIPLINE (RL-LOCK-011, spec/mobile.md "A local action cannot
 * claim physical success until the appropriate platform/ADCOS evidence is
 * available"):
 *  - a `succeeded` outcome MUST carry real platform evidence (kind !== "none");
 *    `parsePlatformExecutionOutcome` rejects anything less, and the adapter
 *    re-validates defensively - a success without evidence becomes a typed
 *    `failed` result, NEVER an executed claim;
 *  - `requires-guidance` means the platform can only complete the action with
 *    the user in the loop (unsupported control degrades to observation/manual
 *    guidance, spec/security.md "Fail-safe defaults");
 *  - `unsupported` / `failed` carry a closed-vocabulary reason.
 *
 * No AI, no best-effort guessing: the same request yields the same decision
 * for the same platform state (RL-LOCK-012).
 */
import { ValidationError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import {
  parseEdgePlatformEvidence,
  type DeviceActionRequest,
  type EdgePlatformEvidence,
} from "@roamlink/edge";

/**
 * Closed reason vocabulary for executor outcomes that are not a success.
 * Mirrors the RL-040 `DeviceActionResultReason` vocabulary so executor
 * failures map 1:1 onto honest device-action results without translation.
 */
export const PLATFORM_EXECUTOR_REASONS = [
  "capability-requires-permission",
  "capability-unavailable",
  "capability-unknown",
  "evidence-class-insufficient",
  "evidence-stale",
  "action-unsupported",
  "execution-degraded",
  "execution-failed",
] as const;

export type PlatformExecutorReason = (typeof PLATFORM_EXECUTOR_REASONS)[number];

/** The executor succeeded, with the platform evidence that proves it. */
export interface PlatformExecutionSucceeded {
  readonly outcome: "succeeded";
  /**
   * REQUIRED real platform evidence. `kind: "none"` here is a contract
   * violation that the adapter converts into a typed failure - physical
   * success is only ever declared with evidence (RL-LOCK-011).
   */
  readonly evidence: EdgePlatformEvidence;
}

/** The executor failed deterministically (e.g. the platform refused). */
export interface PlatformExecutionFailed {
  readonly outcome: "failed";
  readonly reason: PlatformExecutorReason;
  /** Bounded, non-secret explanation (never embeds payloads - RL-LOCK-016). */
  readonly detail?: string;
}

/**
 * The platform can only complete the action with the user in the loop, or the
 * control is restricted: degrade to observation/manual guidance.
 */
export interface PlatformExecutionRequiresGuidance {
  readonly outcome: "requires-guidance";
  readonly reason: PlatformExecutorReason;
  readonly detail?: string;
}

/** The platform adapter does not implement this capability at all. */
export interface PlatformExecutionUnsupported {
  readonly outcome: "unsupported";
  readonly reason: PlatformExecutorReason;
  readonly detail?: string;
}

export type PlatformExecutionOutcome =
  | PlatformExecutionSucceeded
  | PlatformExecutionFailed
  | PlatformExecutionRequiresGuidance
  | PlatformExecutionUnsupported;

/**
 * The stable seam. Implementations translate the platform-neutral request into
 * exactly ONE platform interaction and report the honest outcome. An
 * implementation MUST be side-effect-idempotent under the request's
 * `dedupeKey`: a replayed delivery of the same physical action must not
 * double-apply (RL-LOCK-014).
 */
export interface PlatformActionExecutor {
  /**
   * Executes one admitted action. The request has ALREADY passed the
   * capability gate when it reaches the executor (admission is the adapter's
   * job); the executor's own platform failures still surface as typed
   * non-success outcomes.
   */
  execute(request: DeviceActionRequest, at: string | UtcInstant): Promise<PlatformExecutionOutcome>;
  /**
   * Bounded, printable label identifying the platform adapter (diagnostics
   * only; never carries secrets - RL-LOCK-016).
   */
  readonly executorId: string;
}

/** Validated evaluation instant type alias for executor implementations. */
export type PlatformExecutionInstant = UtcInstant;

/** Re-exported validation helper for executor implementations. */
export function parseExecutorInstant(at: string | UtcInstant): UtcInstant {
  return parseUtcInstant(at);
}

const MAX_DETAIL_LENGTH = 256;

function isBoundedPrintable(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DETAIL_LENGTH) {
    return false;
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Fail-closed validation of an outcome produced by an unknown (e.g.
 * deserialized) executor: unknown fields, outcome values outside the closed
 * vocabulary, `succeeded` without real evidence, and non-success without a
 * reason are all rejected. Values are never echoed in errors (RL-LOCK-016).
 */
export function parsePlatformExecutionOutcome(value: unknown): PlatformExecutionOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(
      "PlatformExecutionOutcome must be an object with an outcome discriminator",
      {
        reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
        details: [{ path: "PlatformExecutionOutcome", issue: "not an object" }],
      },
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["outcome", "evidence", "reason", "detail"].includes(key)) {
      throw new ValidationError(
        "PlatformExecutionOutcome rejected an unknown field (the outcome carries exactly outcome, evidence?, reason?, detail?)",
        {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: key, issue: "unknown field" }],
        },
      );
    }
  }
  const outcome = record["outcome"];
  if (outcome === "succeeded") {
    if (record["evidence"] === undefined) {
      throw new ValidationError(
        "a succeeded executor outcome REQUIRES platform evidence - physical success is only declared with evidence (RL-LOCK-011)",
        {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: "evidence", issue: "missing on succeeded" }],
        },
      );
    }
    let evidence: EdgePlatformEvidence;
    try {
      evidence = parseEdgePlatformEvidence(record["evidence"]);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(error.message, {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: "evidence", issue: "not a valid platform-evidence payload" }],
        });
      }
      throw error;
    }
    if (evidence.kind === "none") {
      throw new ValidationError(
        "a succeeded executor outcome carries kind 'none' evidence - success without real evidence is never declarable (RL-LOCK-011)",
        {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: "evidence.kind", issue: "'none' cannot support a success claim" }],
        },
      );
    }
    if (record["reason"] !== undefined) {
      throw new ValidationError("a succeeded executor outcome carries no reason", {
        reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
        details: [{ path: "reason", issue: "present on succeeded" }],
      });
    }
    return Object.freeze({ outcome: "succeeded", evidence });
  }
  if (outcome === "failed" || outcome === "requires-guidance" || outcome === "unsupported") {
    const reason = record["reason"];
    if (
      typeof reason !== "string" ||
      !(PLATFORM_EXECUTOR_REASONS as readonly string[]).includes(reason)
    ) {
      throw new ValidationError(
        "non-success executor outcomes require a member of the closed executor reason vocabulary",
        {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: "reason", issue: "outside the closed vocabulary" }],
        },
      );
    }
    const detail = record["detail"];
    if (detail !== undefined && !isBoundedPrintable(detail)) {
      throw new ValidationError(
        "executor outcome detail must be a bounded, printable, non-secret string",
        {
          reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
          details: [{ path: "detail", issue: "out of bounds" }],
        },
      );
    }
    const typedReason = reason as PlatformExecutorReason;
    const withDetail = detail === undefined ? {} : { detail };
    if (outcome === "failed") {
      return Object.freeze({ outcome: "failed" as const, reason: typedReason, ...withDetail });
    }
    if (outcome === "requires-guidance") {
      return Object.freeze({
        outcome: "requires-guidance" as const,
        reason: typedReason,
        ...withDetail,
      });
    }
    return Object.freeze({
      outcome: "unsupported" as const,
      reason: typedReason,
      ...withDetail,
    });
  }
  throw new ValidationError(
    "executor outcome must be one of succeeded, failed, requires-guidance, unsupported",
    {
      reason: "PLATFORM_EXECUTION_OUTCOME_INVALID",
      details: [{ path: "outcome", issue: "outside the closed vocabulary" }],
    },
  );
}
