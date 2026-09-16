/**
 * Local experience-policy evaluation (RL-043, spec/mobile.md "Edge
 * desired-state loop": `local context -> evaluate RoamLink experience policy
 * -> produce desired experience action -> ...`).
 *
 * {@link LocalExperiencePolicy} is the PORT for the policy that decides what
 * the edge WANTS on the device. It consumes the privacy-classified local
 * context (the RL-010 `DeviceContextSnapshot`, @roamlink/domain-experience)
 * and produces desired experience actions. It is deliberately DUMB about
 * platform capability: capability availability is decided ONLY by the
 * admission gate (./admission.ts) against evidence - a policy may want
 * anything, the gate decides what the device can do (RL-LOCK-011). No AI, no
 * heuristics: a deterministic policy is a pure function of its inputs
 * (RL-LOCK-012 - AI may propose preferences but never authorizes actions).
 *
 * PRIVACY (spec/mobile.md "Device privacy"): collection is purpose-limited,
 * configurable and minimized; location and network identifiers receive
 * stricter controls. The reference policy enforces the consent gate for
 * RESTRICTED context data: a desired action that declares a fine-location
 * dependency is DEFERRED with a typed reason when the context snapshot records
 * no explicit consent - never silently dropped and never satisfied with
 * un-consented restricted data.
 */
import { ValidationError, parseIdempotencyKey, type UtcInstant } from "@roamlink/contracts";
import type { DeviceContextSnapshotPlain } from "@roamlink/domain-experience";
import {
  parseDeviceActionParameters,
  parseEdgeCapabilityName,
  type DeviceActionParameters,
  type EdgeCapabilityName,
} from "@roamlink/edge";

/** The local context a policy evaluates against. */
export interface LocalPolicyContext {
  /** The privacy-classified device context snapshot, when one is available. */
  readonly contextSnapshot?: DeviceContextSnapshotPlain;
}

/** A desired experience action produced by a policy. */
export interface DesiredExperienceAction {
  /** Closed-vocabulary capability the desired action targets. */
  readonly capability: EdgeCapabilityName;
  /** Minimal, typed, platform-neutral action parameters. */
  readonly parameters: DeviceActionParameters;
  /** Physical action dedupe key (RL-LOCK-014 - a physical action applies once). */
  readonly dedupeKey: string;
}

/** Typed reasons a desired action was deferred instead of produced. */
export const POLICY_DEFER_REASONS = [
  "fine-location-consent-absent",
  "context-snapshot-unavailable",
] as const;

export type PolicyDeferReason = (typeof POLICY_DEFER_REASONS)[number];

/** A desired action the policy could not produce, with the typed reason. */
export interface DeferredDesiredAction {
  readonly capability: EdgeCapabilityName;
  readonly dedupeKey: string;
  readonly reason: PolicyDeferReason;
}

/** The outcome of one policy evaluation. */
export interface PolicyEvaluationResult {
  readonly produced: readonly DesiredExperienceAction[];
  readonly deferred: readonly DeferredDesiredAction[];
}

/** The policy port: pure, deterministic, side-effect free. */
export interface LocalExperiencePolicy {
  evaluate(context: LocalPolicyContext, at: UtcInstant): PolicyEvaluationResult;
}

/**
 * A desired-action template. `requiresFineLocation: true` declares that the
 * action can only be justified by consented RESTRICTED context (e.g. joining a
 * known network near the user's fine location) - the privacy classification of
 * `DeviceContextSnapshot` (restricted == fine location) is the authority.
 */
export interface DesiredActionTemplate {
  readonly capability: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  /** When true, the action is deferred unless fine-location consent is granted. */
  readonly requiresFineLocation?: boolean;
}

/**
 * Deterministic template-driven reference policy. Templates are validated at
 * construction (capability names against the closed vocabulary, parameters
 * through the RL-040 parameter parser); evaluation is a pure filter:
 *
 *  - templates without privacy dependencies are always produced;
 *  - a template with `requiresFineLocation` is produced ONLY when a context
 *    snapshot exists AND records explicit fine-location consent;
 *  - otherwise it is DEFERRED with the typed reason (honest, diagnosable -
 *    never a silent drop and never satisfied with restricted data).
 */
export function createDesiredActionPolicy(
  templates: readonly DesiredActionTemplate[],
): LocalExperiencePolicy {
  const validated = templates.map((template) => {
    if (template === null || typeof template !== "object") {
      throw new ValidationError("a desired-action template must be an object", {
        reason: "POLICY_TEMPLATE_INVALID",
        details: [{ path: "DesiredActionTemplate", issue: "not an object" }],
      });
    }
    const capability = template.capability;
    if (typeof capability !== "string") {
      throw new ValidationError("a desired-action template needs a capability name", {
        reason: "POLICY_TEMPLATE_INVALID",
        details: [{ path: "capability", issue: "not a string" }],
      });
    }
    if (template.requiresFineLocation !== undefined && typeof template.requiresFineLocation !== "boolean") {
      throw new ValidationError("requiresFineLocation must be a boolean when present", {
        reason: "POLICY_TEMPLATE_INVALID",
        details: [{ path: "requiresFineLocation", issue: "not a boolean" }],
      });
    }
    const parsedCapability = parseEdgeCapabilityName(capability);
    const parameters = parseDeviceActionParameters(template.parameters);
    const dedupeKey = parseIdempotencyKey(template.dedupeKey);
    return Object.freeze({
      capability: parsedCapability,
      parameters,
      dedupeKey,
      requiresFineLocation: template.requiresFineLocation ?? false,
    });
  });

  return {
    evaluate(context: LocalPolicyContext, _at: UtcInstant): PolicyEvaluationResult {
      const produced: DesiredExperienceAction[] = [];
      const deferred: DeferredDesiredAction[] = [];
      for (const template of validated) {
        if (template.requiresFineLocation) {
          const snapshot = context.contextSnapshot;
          if (snapshot === undefined) {
            deferred.push({
              capability: template.capability,
              dedupeKey: template.dedupeKey,
              reason: "context-snapshot-unavailable",
            });
            continue;
          }
          if (snapshot.consent.fineLocationGranted !== true) {
            deferred.push({
              capability: template.capability,
              dedupeKey: template.dedupeKey,
              reason: "fine-location-consent-absent",
            });
            continue;
          }
        }
        produced.push({
          capability: template.capability,
          parameters: template.parameters,
          dedupeKey: template.dedupeKey,
        });
      }
      return Object.freeze({
        produced: Object.freeze(produced),
        deferred: Object.freeze(deferred),
      });
    },
  };
}
