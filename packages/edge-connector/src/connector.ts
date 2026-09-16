/**
 * The enterprise edge connector port (RL-044, spec/mobile.md "Enterprise
 * edge", spec/architecture.md §8).
 *
 * The typed contract an enterprise edge integration implements: MDM-managed
 * configuration, system extensions, VPN/network extensions or an enterprise
 * connector WHEN SUPPORTED - with the invariant that the architecture still
 * works when only observation and user-guided actions are available (the
 * guaranteed degradation floor of the capability negotiation).
 *
 * The port is deliberately credential-safe: configuration delivery and
 * capability negotiation carry no secrets; credentials exist only as typed,
 * short-lived, device-bound, narrowly scoped, revocable grants
 * (./credential.ts, spec/security.md "Credential rules"). An enterprise
 * connector may observe and request connectivity but NEVER creates a second
 * path/session authority (spec/architecture.md §8, RL-LOCK-004/005).
 */
import type { UtcInstant } from "@roamlink/contracts";

import type {
  ConnectorNegotiationResult,
  EnterpriseConnectorCapability,
} from "./capability.js";
import type { EnterpriseConfiguration } from "./configuration.js";
import type {
  EdgeCredentialGrant,
  EdgeCredentialScope,
  EdgeCredentialUsage,
} from "./credential.js";

/** A request for a credential grant. */
export interface EdgeCredentialRequest {
  /** The device the grant binds to. */
  readonly deviceRef: string;
  /** Narrowly scoped: non-empty, closed vocabulary. */
  readonly scopes: readonly EdgeCredentialScope[];
  /**
   * Requested lifetime in whole milliseconds (1s..24h; the connector may
   * grant LESS, never more - short-lived by contract).
   */
  readonly ttlMs: number;
  /** Secret NAME the grant references (a reference, never material). */
  readonly secretName: string;
}

/** The enterprise edge connector contract. */
export interface EnterpriseEdgeConnector {
  /** Bounded, printable connector label (diagnostics; never secrets). */
  readonly connectorId: string;
  /** The capabilities this connector currently supports (closed vocabulary). */
  availableCapabilities(): readonly EnterpriseConnectorCapability[];
  /**
   * PURE capability negotiation (graceful degradation: denied entries carry
   * the fallback capability; the floor is observation + user-guided actions).
   */
  negotiate(requested: readonly unknown[]): ConnectorNegotiationResult;
  /**
   * The current MDM-managed configuration, when the connector supports
   * `mdm-managed-configuration` and one has been delivered. Null otherwise -
   * an honest miss, never a fabricated configuration.
   */
  retrieveConfiguration(at: UtcInstant | string): Promise<EnterpriseConfiguration | null>;
  /**
   * Requests a credential grant for a device. The connector grants at most
   * the requested lifetime and scopes; issuing is refused (typed) when the
   * connector does not support credential-bearing operation.
   */
  requestCredential(
    request: EdgeCredentialRequest,
    at: UtcInstant | string,
  ): Promise<EdgeCredentialGrant>;
  /**
   * Validates a grant for one scoped use (expiry, revocation, device
   * binding, scope membership - all fail closed with typed reasons).
   */
  useCredential(
    grantId: string,
    scope: EdgeCredentialScope,
    deviceRef: string,
    at: UtcInstant | string,
  ): Promise<EdgeCredentialUsage>;
  /**
   * Revokes a grant. Revocation is immediate and idempotent; the revoked
   * grant keeps its history (issuedAt, revokedAt) for audit.
   */
  revokeCredential(grantId: string, at: UtcInstant | string): Promise<EdgeCredentialGrant>;
}
