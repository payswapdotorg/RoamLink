/**
 * The enterprise API-key service (RL-063): scoped service authorization
 * through the secrets boundary.
 *
 * Composes the pure key record functions with the stores, the secrets
 * boundary and the audit stream. Authentication locates the record from the
 * embedded key id, then verifies the presented material in constant time
 * through the resolver (RL-050) - material never persists anywhere the
 * record, audit or logs can reach (RL-LOCK-016). Every security-relevant
 * mutation (issue/rotate/revoke) appends an audit event; commands are
 * idempotency-key aware (RL-LOCK-014).
 */
import {
  ConflictError,
  DomainError,
  NotFoundError,
  UnauthorizedError,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";
import type { AuditLog } from "@roamlink/audit";
import type { SecretsResolver } from "@roamlink/secrets";

import {
  enterpriseApiKeyIdFromMaterial,
  issueEnterpriseApiKey,
  revokeEnterpriseApiKey,
  rotateEnterpriseApiKey,
  verifyEnterpriseApiKeyMaterial,
  type EnterpriseApiKeyIssuance,
  type EnterpriseApiKeyRecord,
  type EnterpriseApiScope,
  type EnterpriseSecretRegistrar,
  type ServiceAuthorizationDecision,
} from "./api-keys.js";
import { authorizeServiceRequest } from "./api-keys.js";
import type { EnterpriseCommandContext } from "./onboarding.js";
import type { InMemoryApiKeyStore } from "./stores.js";

/** Options for {@link EnterpriseApiKeyService}. */
export interface EnterpriseApiKeyServiceOptions {
  readonly keys: InMemoryApiKeyStore;
  readonly registrar: EnterpriseSecretRegistrar;
  readonly secrets: SecretsResolver;
  readonly audit: AuditLog;
  /** Key-id source; inject a deterministic generator in tests. */
  readonly keyIdGenerator: () => string;
}

/**
 * Scoped API-key management + authentication. `authenticate` returns the
 * verified record (service authorization then runs
 * {@link authorizeServiceRequest} per request scope, fail-closed).
 */
export class EnterpriseApiKeyService {
  readonly #options: EnterpriseApiKeyServiceOptions;
  readonly #issued = new Map<string, EnterpriseApiKeyIssuance>();

  constructor(options: EnterpriseApiKeyServiceOptions) {
    if (options === null || typeof options !== "object") {
      throw new DomainError("EnterpriseApiKeyServiceOptions must be an object", {
        reason: "ENTERPRISE_SERVICE_INVALID",
      });
    }
    this.#options = options;
  }

  /**
   * Issues a new key for a tenant. Idempotent per command: replaying the
   * idempotency key replays the ORIGINAL issuance (material included) with
   * no additional effect.
   */
  async issue(
    input: {
      readonly tenantId: string;
      readonly name: string;
      readonly scopes: readonly string[];
    },
    context: EnterpriseCommandContext,
    at: UtcInstant | string,
  ): Promise<EnterpriseApiKeyIssuance> {
    const instant = parseUtcInstant(at);
    const replay = this.#issued.get(context.idempotencyKey);
    if (replay !== undefined) {
      if (replay.record.tenantId !== input.tenantId) {
        throw new ConflictError(
          "this idempotency key was already used for a different tenant (RL-LOCK-014)",
          { reason: "ENTERPRISE_IDEMPOTENCY_CONFLICT" },
        );
      }
      return replay;
    }
    const issuance = await issueEnterpriseApiKey(
      {
        keyId: this.#options.keyIdGenerator(),
        tenantId: input.tenantId,
        name: input.name,
        scopes: input.scopes,
      },
      this.#options.registrar,
      instant,
    );
    await this.#options.keys.save(issuance.record);
    await this.#audit("enterprise.api-key.issued", "allowed", context, issuance.record, instant);
    this.#issued.set(context.idempotencyKey, issuance);
    return issuance;
  }

  /** Rotates an active key (material shown once; record pins the new version). */
  async rotate(
    keyId: string,
    tenantId: string,
    context: EnterpriseCommandContext,
    at: UtcInstant | string,
  ): Promise<EnterpriseApiKeyIssuance> {
    const instant = parseUtcInstant(at);
    const current = await this.#require(keyId, tenantId);
    const issuance = await rotateEnterpriseApiKey(current, this.#options.registrar, instant);
    await this.#options.keys.save(issuance.record);
    await this.#audit("enterprise.api-key.rotated", "allowed", context, issuance.record, instant);
    return issuance;
  }

  /** Revokes a key (idempotent; the record check fails closed thereafter). */
  async revoke(
    keyId: string,
    tenantId: string,
    context: EnterpriseCommandContext,
    at: UtcInstant | string,
  ): Promise<EnterpriseApiKeyRecord> {
    const instant = parseUtcInstant(at);
    const current = await this.#require(keyId, tenantId);
    const next = revokeEnterpriseApiKey(current, instant);
    if (next !== current) {
      await this.#options.keys.save(next);
      await this.#audit("enterprise.api-key.revoked", "denied", context, next, instant);
    }
    return next;
  }

  /**
   * Authenticates presented key material: locates the record from the
   * embedded key id, then verifies the material through the secrets boundary
   * in constant time. Any failure is a typed UnauthorizedError naming ONLY
   * the deny reason (RL-LOCK-016).
   */
  async authenticate(presentedMaterial: string): Promise<EnterpriseApiKeyRecord> {
    const keyId = enterpriseApiKeyIdFromMaterial(presentedMaterial);
    const record = await this.#options.keys.get(keyId, await this.#tenantOf(keyId));
    if (record === null) {
      // Cross-tenant misses and unknown keys are indistinguishable by design.
      throw new NotFoundError("the enterprise API key does not exist", {
        reason: "ENTERPRISE_API_KEY_NOT_FOUND",
      });
    }
    await verifyEnterpriseApiKeyMaterial(record, presentedMaterial, this.#options.secrets);
    return record;
  }

  /** Scoped service authorization over an authenticated key (fail-closed). */
  authorize(record: EnterpriseApiKeyRecord, requiredScope: EnterpriseApiScope): ServiceAuthorizationDecision {
    return authorizeServiceRequest(record, requiredScope);
  }

  async get(keyId: string, tenantId: string): Promise<EnterpriseApiKeyRecord | null> {
    return this.#options.keys.get(keyId, tenantId);
  }

  async listByTenant(tenantId: string): Promise<readonly EnterpriseApiKeyRecord[]> {
    return this.#options.keys.listByTenant(tenantId);
  }

  async #require(keyId: string, tenantId: string): Promise<EnterpriseApiKeyRecord> {
    const record = await this.#options.keys.get(keyId, tenantId);
    if (record === null) {
      throw new NotFoundError("the enterprise API key does not exist in this tenant", {
        reason: "ENTERPRISE_API_KEY_NOT_FOUND",
      });
    }
    return record;
  }

  /**
   * The tenant scope for material lookup. The material EMBEDS the key id;
   * the store is keyed per tenant, so authenticate resolves the tenant by
   * scanning for the key id's owning record (an in-memory convenience; the
   * production durable store indexes key-id -> tenant directly).
   */
  async #tenantOf(keyId: string): Promise<string> {
    const tenants = await this.#options.keys.listAllTenantsWithKey(keyId);
    if (tenants.length === 0) {
      // An unknown key is indistinguishable from a wrong material at the
      // API boundary (401, no existence oracle).
      throw new UnauthorizedError("the presented enterprise API key is not valid", {
        reason: "ENTERPRISE_API_KEY_DENIED",
        details: [{ path: "material", issue: "material-mismatch" }],
      });
    }
    return tenants[0] as string;
  }

  async #audit(
    action: string,
    outcome: "allowed" | "denied",
    context: EnterpriseCommandContext,
    record: EnterpriseApiKeyRecord,
    at: UtcInstant,
  ): Promise<void> {
    await this.#options.audit.append({
      category: "auth",
      action,
      outcome,
      actorId: context.actorId,
      tenantId: record.tenantId,
      correlationId: context.correlationId,
      commandId: context.commandId,
      target: record.keyId,
      occurredAt: at,
    });
  }
}
