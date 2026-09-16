/**
 * Enterprise connector capability vocabulary + negotiation (RL-044,
 * spec/mobile.md "Enterprise edge", spec/architecture.md §8).
 *
 * The CLOSED capability vocabulary names exactly what spec/mobile.md lists:
 * "Enterprise deployment may use MDM-managed configuration, system
 * extensions, VPN/network extensions or an enterprise connector when
 * supported. The architecture must still work when only observation and
 * user-guided actions are available."
 *
 * `observation` and `user-guided-actions` are therefore ALWAYS meaningful
 * requests (they are the guaranteed degradation floor), while the four
 * enterprise capabilities are conditional on MDM/connector support.
 *
 * {@link negotiateConnectorCapabilities} is a PURE capability negotiation:
 * granted = requested ∩ available; denied entries carry a typed reason and
 * the fallback capability that keeps the architecture working (graceful
 * degradation - never a silent capability guess, RL-LOCK-011 spirit).
 * Enterprise integrations may observe and request connectivity but cannot
 * create a second path/session authority (spec/architecture.md §8).
 */
import { ValidationError } from "@roamlink/contracts";

export const ENTERPRISE_CONNECTOR_CAPABILITIES = [
  "mdm-managed-configuration",
  "system-extension",
  "vpn-network-extension",
  "enterprise-connector",
  "observation",
  "user-guided-actions",
] as const;

export type EnterpriseConnectorCapability = (typeof ENTERPRISE_CONNECTOR_CAPABILITIES)[number];

/**
 * The capabilities that require MDM/enterprise support (the conditional set);
 * the remaining two are the guaranteed degradation floor.
 */
export const CONDITIONAL_ENTERPRISE_CONNECTOR_CAPABILITIES: readonly EnterpriseConnectorCapability[] =
  Object.freeze([
    "mdm-managed-configuration",
    "system-extension",
    "vpn-network-extension",
    "enterprise-connector",
  ]);

export function isEnterpriseConnectorCapability(
  value: unknown,
): value is EnterpriseConnectorCapability {
  return (
    typeof value === "string" &&
    (ENTERPRISE_CONNECTOR_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Parses a capability; offending values are never echoed (RL-LOCK-016). */
export function parseEnterpriseConnectorCapability(
  value: unknown,
): EnterpriseConnectorCapability {
  if (!isEnterpriseConnectorCapability(value)) {
    throw new ValidationError(
      "value is not a member of the closed enterprise-connector capability vocabulary (mdm-managed-configuration, system-extension, vpn-network-extension, enterprise-connector, observation, user-guided-actions)",
      {
        reason: "CONNECTOR_CAPABILITY_INVALID",
        details: [
          { path: "EnterpriseConnectorCapability", issue: "outside the closed vocabulary" },
        ],
      },
    );
  }
  return value;
}

/** Parses a deduplicated capability set (empty is valid: nothing supported). */
export function parseEnterpriseConnectorCapabilitySet(
  values: readonly unknown[],
): readonly EnterpriseConnectorCapability[] {
  if (!Array.isArray(values)) {
    throw new ValidationError("a capability set must be an array", {
      reason: "CONNECTOR_CAPABILITY_INVALID",
      details: [{ path: "EnterpriseConnectorCapabilitySet", issue: "not an array" }],
    });
  }
  const seen = new Set<EnterpriseConnectorCapability>();
  for (const value of values) {
    const capability = parseEnterpriseConnectorCapability(value);
    seen.add(capability);
  }
  return Object.freeze([...seen]);
}

/** Typed reasons a requested capability was not granted. */
export const CONNECTOR_NEGOTIATION_DENY_REASONS = [
  "capability-not-supported-by-connector",
] as const;

export type ConnectorNegotiationDenyReason =
  (typeof CONNECTOR_NEGOTIATION_DENY_REASONS)[number];

/** One denied request, with the fallback that keeps the architecture working. */
export interface ConnectorCapabilityDenial {
  readonly capability: EnterpriseConnectorCapability;
  readonly reason: ConnectorNegotiationDenyReason;
  /**
   * The guaranteed degradation floor capability that replaces the denied one
   * ("observation" or "user-guided-actions") - graceful degradation with an
   * explicit path, never a silent downgrade.
   */
  readonly fallback: "observation" | "user-guided-actions";
}

/**
 * The effective operating mode after negotiation:
 *  - `enterprise`: at least one enterprise capability is granted;
 *  - `user-guided`: no enterprise capability, but observation AND
 *    user-guided actions are granted (the spec's "only observation and
 *    user-guided actions are available" mode);
 *  - `observation-only`: only observation remains (the hard floor).
 */
export const CONNECTOR_OPERATING_MODES = [
  "enterprise",
  "user-guided",
  "observation-only",
] as const;

export type ConnectorOperatingMode = (typeof CONNECTOR_OPERATING_MODES)[number];

/** The result of one capability negotiation. */
export interface ConnectorNegotiationResult {
  readonly granted: readonly EnterpriseConnectorCapability[];
  readonly denials: readonly ConnectorCapabilityDenial[];
  readonly operatingMode: ConnectorOperatingMode;
  /** Number of requested entries outside the closed vocabulary (never echoed). */
  readonly invalidRequestCount: number;
}

/**
 * PURE capability negotiation. `requested` entries are validated against the
 * closed vocabulary (outside = counted as invalid, not thrown - negotiation
 * stays total so a misconfigured enterprise request degrades instead of
 * crashing the edge; offending values are never echoed, RL-LOCK-016).
 */
export function negotiateConnectorCapabilities(
  requested: readonly unknown[],
  available: readonly EnterpriseConnectorCapability[],
): ConnectorNegotiationResult {
  const availableSet = new Set(parseEnterpriseConnectorCapabilitySet(available));
  const granted: EnterpriseConnectorCapability[] = [];
  const denials: ConnectorCapabilityDenial[] = [];
  const grantedSet = new Set<EnterpriseConnectorCapability>();
  const denialSet = new Set<EnterpriseConnectorCapability>();
  let invalidRequestCount = 0;

  for (const value of requested) {
    if (!isEnterpriseConnectorCapability(value)) {
      invalidRequestCount += 1;
      continue;
    }
    if (availableSet.has(value)) {
      if (!grantedSet.has(value)) {
        granted.push(value);
        grantedSet.add(value);
      }
      continue; // duplicates are idempotent
    }
    if (!denialSet.has(value)) {
      denialSet.add(value);
      denials.push({
        capability: value,
        reason: "capability-not-supported-by-connector",
        fallback: value === "user-guided-actions" ? "observation" : "user-guided-actions",
      });
    }
  }

  const hasEnterprise = CONDITIONAL_ENTERPRISE_CONNECTOR_CAPABILITIES.some((capability) =>
    grantedSet.has(capability),
  );
  let operatingMode: ConnectorOperatingMode;
  if (hasEnterprise) {
    operatingMode = "enterprise";
  } else if (grantedSet.has("observation") && grantedSet.has("user-guided-actions")) {
    operatingMode = "user-guided";
  } else if (grantedSet.has("observation")) {
    operatingMode = "observation-only";
  } else {
    // Nothing granted at all: the honest floor is still observation-only
    // IF observation is available; otherwise the connector is unusable and
    // the mode is observation-only with zero granted capabilities.
    operatingMode = "observation-only";
  }

  return Object.freeze({
    granted: Object.freeze(granted),
    denials: Object.freeze(denials),
    operatingMode,
    invalidRequestCount,
  });
}
