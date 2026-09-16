/**
 * Audit event adapters (RL-051).
 *
 * Structural-typing bridges from OTHER packages' notification shapes to audit
 * {@link AuditEventInput}s - WITHOUT importing those packages (dependency
 * direction stays contracts-only; RL-LOCK-019). TypeScript is structural, so
 * a real `SecretAccessNotification` from @roamlink/secrets or a
 * `CapabilityGateDecision` from @roamlink/edge satisfies these parameter
 * types directly.
 */
import type { AuditEventInput, AuditEventOutcome } from "./audit-event.js";

/**
 * Structural shape of @roamlink/secrets' `SecretAccessNotification`
 * (value-free by construction there; only reference metadata arrives here).
 */
export interface SecretAccessNotificationLike {
  readonly ref: { readonly name: string; readonly version: number | null };
  readonly resolvedVersion: number | null;
  readonly outcome:
    | "resolved"
    | "unknown"
    | "version-unknown"
    | "retired"
    | "unavailable"
    | "forbidden"
    | "invalid-material";
  readonly at: string;
}

/** Maps a secret-resolution outcome to the audit outcome vocabulary. */
function outcomeForSecretAccess(outcome: SecretAccessNotificationLike["outcome"]): AuditEventOutcome {
  switch (outcome) {
    case "resolved":
      return "allowed";
    case "forbidden":
      return "denied";
    default:
      return "failed";
  }
}

/**
 * Builds a `secret-access` audit event input from a secrets-boundary access
 * notification. The secret NAME travels as the event target (a safe label,
 * never the value - RL-LOCK-016); the reference and outcome land in `detail`.
 */
export function auditEventFromSecretAccess(input: {
  readonly notification: SecretAccessNotificationLike;
  readonly actorId: string;
  readonly correlationId: string;
  readonly tenantId?: string;
  readonly commandId?: string;
}): AuditEventInput {
  const { notification } = input;
  const requested = notification.ref.version === null ? "active" : `v${notification.ref.version}`;
  const resolved =
    notification.resolvedVersion === null ? "none" : `v${notification.resolvedVersion}`;
  return {
    category: "secret-access",
    action: "secret.resolve",
    outcome: outcomeForSecretAccess(notification.outcome),
    actorId: input.actorId,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    correlationId: input.correlationId,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    target: notification.ref.name,
    occurredAt: notification.at,
    detail: `requested ${requested}, resolved ${resolved}, outcome ${notification.outcome}`,
  };
}

/**
 * Structural shape of @roamlink/edge's `CapabilityGateDecision` (the fields
 * the audit taxonomy needs; evidence payloads never cross into audit).
 */
export interface AuthorityDecisionLike {
  readonly decision: "allow" | "deny" | "degrade";
  readonly capability: string;
  readonly reason?: string;
}

/** Maps a gate decision to the audit outcome vocabulary. */
function outcomeForAuthorityDecision(decision: AuthorityDecisionLike["decision"]): AuditEventOutcome {
  switch (decision) {
    case "allow":
      return "allowed";
    case "deny":
      return "denied";
    case "degrade":
      return "degraded";
  }
}

/**
 * Builds an `authority-decision` audit event input from an edge capability
 * gate decision (RL-LOCK-011: capability evidence decisions are
 * security-relevant and must be auditable). The capability name is folded
 * into the action label (underscores become dashes to satisfy the safe-label
 * grammar); the reason rides `detail`.
 */
export function auditEventFromAuthorityDecision(input: {
  readonly decision: AuthorityDecisionLike;
  readonly actorId: string;
  readonly correlationId: string;
  readonly tenantId?: string;
  readonly commandId?: string;
  readonly target?: string;
  readonly occurredAt: string;
}): AuditEventInput {
  const { decision } = input;
  const actionCapability = decision.capability.replace(/_/g, "-");
  return {
    category: "authority-decision",
    action: `capability.${actionCapability}.gate`,
    outcome: outcomeForAuthorityDecision(decision.decision),
    actorId: input.actorId,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    correlationId: input.correlationId,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    occurredAt: input.occurredAt,
    ...(decision.reason !== undefined ? { detail: `reason ${decision.reason}` } : {}),
  };
}
