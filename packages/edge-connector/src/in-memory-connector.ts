/**
 * Deterministic in-memory {@link EnterpriseEdgeConnector} fake (RL-044).
 *
 * Test/dev-only reference implementation of the connector contract: no MDM,
 * no VPN stack, no real credentials. The fake enforces the CONTRACT
 * semantics exactly - capability negotiation over the closed vocabulary,
 * configuration delivery (typed, secret-free, expiry-aware) and the full
 * credential lifecycle (short-lived, device-bound, narrowly scoped,
 * revocable) - so contract-level behavior is provable without any platform
 * code (spec/mobile.md "Enterprise edge"; the real connector arrives with
 * the Wave-4/5 platform work).
 */
import {
  NotFoundError,
  ValidationError,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  negotiateConnectorCapabilities,
  parseEnterpriseConnectorCapabilitySet,
  type ConnectorNegotiationResult,
  type EnterpriseConnectorCapability,
} from "./capability.js";
import {
  isEnterpriseConfigurationApplicable,
  parseEnterpriseConfiguration,
  type EnterpriseConfiguration,
  type EnterpriseConfigurationInput,
} from "./configuration.js";
import {
  evaluateEdgeCredentialGrant,
  parseEdgeCredentialGrant,
  parseEdgeCredentialGrantId,
  parseEdgeCredentialScope,
  type EdgeCredentialGrant,
  type EdgeCredentialGrantId,
  type EdgeCredentialScope,
  type EdgeCredentialUsage,
} from "./credential.js";
import type { EdgeCredentialRequest, EnterpriseEdgeConnector } from "./connector.js";

/** Options for {@link InMemoryEnterpriseEdgeConnector}. */
export interface InMemoryEnterpriseEdgeConnectorOptions {
  readonly connectorId?: string;
  /** The capabilities the fake connector supports (default: the floor only). */
  readonly capabilities?: readonly EnterpriseConnectorCapability[];
  /** Deliveries staged for `retrieveConfiguration` (latest applicable wins). */
  readonly configurations?: readonly EnterpriseConfigurationInput[];
  /** Default granted TTL when a request asks for more (default 1h). */
  readonly defaultGrantTtlMs?: number;
  /** Grant-id source; inject a deterministic generator in tests. */
  readonly grantIdGenerator?: () => string;
}

/**
 * The deterministic fake connector. All operations take explicit UTC
 * instants; grants are tracked in a registry keyed by grant id.
 */
export class InMemoryEnterpriseEdgeConnector implements EnterpriseEdgeConnector {
  readonly connectorId: string;
  readonly #capabilities: readonly EnterpriseConnectorCapability[];
  readonly #configurations: EnterpriseConfiguration[] = [];
  readonly #grants = new Map<EdgeCredentialGrantId, EdgeCredentialGrant>();
  readonly #grantIdGenerator: () => string;
  readonly #defaultGrantTtlMs: number;

  constructor(options: InMemoryEnterpriseEdgeConnectorOptions = {}) {
    this.connectorId = options.connectorId ?? "in-memory-enterprise-connector";
    this.#capabilities = parseEnterpriseConnectorCapabilitySet(
      options.capabilities ?? ["observation", "user-guided-actions"],
    );
    this.#grantIdGenerator =
      options.grantIdGenerator ??
      (() => {
        throw new ValidationError(
          "the fake connector needs a deterministic grantIdGenerator in tests (or inject randomUUID in local dev)",
          {
            reason: "FAKE_CONNECTOR_WIRING_INVALID",
            details: [{ path: "grantIdGenerator", issue: "not provided" }],
          });
      });
    this.#defaultGrantTtlMs = options.defaultGrantTtlMs ?? 60 * 60 * 1000;
    for (const input of options.configurations ?? []) {
      this.#configurations.push(parseEnterpriseConfiguration(input));
    }
  }

  availableCapabilities(): readonly EnterpriseConnectorCapability[] {
    return this.#capabilities;
  }

  negotiate(requested: readonly unknown[]): ConnectorNegotiationResult {
    return negotiateConnectorCapabilities(requested, this.#capabilities);
  }

  async retrieveConfiguration(at: UtcInstant | string): Promise<EnterpriseConfiguration | null> {
    const instant = parseUtcInstant(at);
    if (!this.#capabilities.includes("mdm-managed-configuration")) {
      return null; // honest miss: configuration delivery is not supported
    }
    let latest: EnterpriseConfiguration | null = null;
    for (const configuration of this.#configurations) {
      if (!isEnterpriseConfigurationApplicable(configuration, instant)) continue;
      if (
        latest === null ||
        configuration.revision > latest.revision ||
        (configuration.revision === latest.revision &&
          configuration.issuedAt > latest.issuedAt)
      ) {
        latest = configuration;
      }
    }
    return latest;
  }

  async requestCredential(
    request: EdgeCredentialRequest,
    at: UtcInstant | string,
  ): Promise<EdgeCredentialGrant> {
    const instant = parseUtcInstant(at);
    if (request === null || typeof request !== "object") {
      throw new ValidationError("an edge credential request must be an object", {
        reason: "EDGE_CREDENTIAL_REQUEST_INVALID",
        details: [{ path: "EdgeCredentialRequest", issue: "not an object" }],
      });
    }
    // Credential-bearing operation requires an enterprise capability: the
    // degradation floor (observation + user-guided actions) issues NOTHING.
    const hasEnterprise = this.#capabilities.some((capability) =>
      (["enterprise-connector", "mdm-managed-configuration", "system-extension", "vpn-network-extension"] as const).includes(
        capability as "enterprise-connector" | "mdm-managed-configuration" | "system-extension" | "vpn-network-extension",
      ),
    );
    if (!hasEnterprise) {
      throw new ValidationError(
        "the connector does not support credential-bearing operation (observation/user-guided only); refusing to issue a grant",
        {
          reason: "EDGE_CREDENTIAL_REQUEST_UNSUPPORTED",
          details: [{ path: "connector", issue: "no enterprise capability" }],
        },
      );
    }
    if (!Array.isArray(request.scopes) || request.scopes.length === 0) {
      throw new ValidationError("an edge credential request must carry at least one scope", {
        reason: "EDGE_CREDENTIAL_REQUEST_INVALID",
        details: [{ path: "scopes", issue: "empty" }],
      });
    }
    const scopes = request.scopes.map((scope) => parseEdgeCredentialScope(scope));
    if (
      typeof request.ttlMs !== "number" ||
      !Number.isInteger(request.ttlMs) ||
      request.ttlMs < 1_000 ||
      request.ttlMs > 24 * 60 * 60 * 1000
    ) {
      throw new ValidationError(
        "the requested credential lifetime must be an integer between 1s and 24h",
        {
          reason: "EDGE_CREDENTIAL_REQUEST_INVALID",
          details: [{ path: "ttlMs", issue: "out of bounds" }],
        },
      );
    }
    // Short-lived by contract: grant the REQUESTED lifetime or the default,
    // whichever is SHORTER - never more than requested.
    const grantedTtl = Math.min(request.ttlMs, this.#defaultGrantTtlMs);
    const grant = parseEdgeCredentialGrant({
      grantId: this.#grantIdGenerator(),
      contractVersion: "0.1",
      deviceRef: request.deviceRef,
      scopes: [...new Set(scopes)],
      issuedAt: instant,
      expiresAt: new Date(Date.parse(instant) + grantedTtl).toISOString(),
      revokedAt: null,
      secretRef: { name: request.secretName, version: null },
    });
    this.#grants.set(grant.grantId, grant);
    return grant;
  }

  async useCredential(
    grantId: string,
    scope: EdgeCredentialScope,
    deviceRef: string,
    at: UtcInstant | string,
  ): Promise<EdgeCredentialUsage> {
    const instant = parseUtcInstant(at);
    const id = parseEdgeCredentialGrantId(grantId);
    const grant = this.#grants.get(id);
    if (grant === undefined) {
      throw new NotFoundError("no credential grant exists under this id", {
        reason: "EDGE_CREDENTIAL_GRANT_NOT_FOUND",
      });
    }
    return evaluateEdgeCredentialGrant(grant, scope, deviceRef, instant);
  }

  async revokeCredential(grantId: string, at: UtcInstant | string): Promise<EdgeCredentialGrant> {
    const instant = parseUtcInstant(at);
    const id = parseEdgeCredentialGrantId(grantId);
    const grant = this.#grants.get(id);
    if (grant === undefined) {
      throw new NotFoundError("no credential grant exists under this id", {
        reason: "EDGE_CREDENTIAL_GRANT_NOT_FOUND",
      });
    }
    if (grant.revokedAt !== null) {
      return grant; // idempotent revocation
    }
    const revoked = parseEdgeCredentialGrant({
      ...grant,
      revokedAt: instant,
    });
    this.#grants.set(id, revoked);
    return revoked;
  }

  /** All grants ever issued (frozen snapshot; tests/diagnostics). */
  grants(): readonly EdgeCredentialGrant[] {
    return Object.freeze([...this.#grants.values()]);
  }

  /** Stages an additional configuration delivery (tests). */
  stageConfiguration(input: EnterpriseConfigurationInput): EnterpriseConfiguration {
    const parsed = parseEnterpriseConfiguration(input);
    this.#configurations.push(parsed);
    return parsed;
  }
}
