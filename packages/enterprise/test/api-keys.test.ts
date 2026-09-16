/**
 * Enterprise API-key tests (RL-063, RL-LOCK-016).
 *
 * Proves: closed-vocabulary scoping with a fail-closed authorization truth
 * table; rotation semantics through the secrets boundary (version appended,
 * active pointer moves, pinned consumers keep working until retirement);
 * revocation; and the NO-LEAK proofs - key material never appears in record
 * JSON, audit events, or error messages (checked with the RL-054 secret
 * scanner, the repository's sanctioned enforcement point).
 */
import { describe, expect, it } from "vitest";
import { ConflictError, UnauthorizedError, ValidationError } from "@roamlink/contracts";
import { InMemoryAuditLog } from "@roamlink/audit";
import { InMemorySecrets } from "@roamlink/secrets";
import { assertNoSecretMaterial, scanForSecretMaterial } from "@roamlink/retention";
import { fixtureActorId, fixtureTenantId } from "@roamlink/testkit";

import {
  authorizeServiceRequest,
  enterpriseApiKeyIdFromMaterial,
  enterpriseApiKeySecretName,
  generateEnterpriseApiKeyMaterial,
  issueEnterpriseApiKey,
  parseEnterpriseApiKeyRecord,
  revokeEnterpriseApiKey,
  rotateEnterpriseApiKey,
  verifyEnterpriseApiKeyMaterial,
} from "../src/api-keys.js";
import { EnterpriseApiKeyService } from "../src/api-key-service.js";
import { InMemoryApiKeyStore, InMemorySecretRegistrarAdapter } from "../src/stores.js";

const AT = "2026-02-01T10:00:00.000Z";
const LATER = "2026-02-01T11:00:00.000Z";
const TENANT = fixtureTenantId();

let keyCounter = 0;
function nextKeyId(): string {
  keyCounter += 1;
  return `10000000-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`;
}

function harness() {
  const secrets = new InMemorySecrets();
  const registrar = new InMemorySecretRegistrarAdapter(secrets);
  const keys = new InMemoryApiKeyStore();
  const audit = new InMemoryAuditLog();
  const service = new EnterpriseApiKeyService({
    keys,
    registrar,
    secrets,
    audit,
    keyIdGenerator: nextKeyId,
  });
  return { secrets, registrar, keys, audit, service };
}

function commandContext(seed: number) {
  return {
    commandId: `20000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
    correlationId: "corr-api-key-1",
    idempotencyKey: `idem-key-${seed}`,
    actorId: fixtureActorId(1),
  };
}

describe("the service-authorization truth table (fail-closed scoping)", () => {
  it("allows exactly the granted scopes on an active key", () => {
    const record = parseEnterpriseApiKeyRecord({
      keyId: nextKeyId(),
      contractVersion: "0.1",
      tenantId: TENANT,
      name: "ops-key",
      scopes: ["connectivity:read", "devices:read"],
      keyRef: { name: enterpriseApiKeySecretName(nextKeyId()), version: null },
      status: "active",
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(authorizeServiceRequest(record, "connectivity:read").decision).toBe("allow");
    expect(authorizeServiceRequest(record, "devices:read").decision).toBe("allow");
    expect(authorizeServiceRequest(record, "orders:read")).toEqual({
      decision: "deny",
      reason: "scope-not-granted",
    });
  });

  it("denies revoked keys even for granted scopes (the record check fails first)", () => {
    const keyId = nextKeyId();
    const record = parseEnterpriseApiKeyRecord({
      keyId,
      contractVersion: "0.1",
      tenantId: TENANT,
      name: "ops-key",
      scopes: ["connectivity:read"],
      keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
      status: "revoked",
      revokedAt: LATER,
      createdAt: AT,
      updatedAt: LATER,
      revision: 2,
    });
    expect(authorizeServiceRequest(record, "connectivity:read")).toEqual({
      decision: "deny",
      reason: "key-revoked",
    });
  });

  it("rejects empty scope sets at parse time (ambient authority is forbidden)", () => {
    const keyId = nextKeyId();
    expect(() =>
      parseEnterpriseApiKeyRecord({
        keyId,
        contractVersion: "0.1",
        tenantId: TENANT,
        name: "ops-key",
        scopes: [],
        keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
        status: "active",
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseEnterpriseApiKeyRecord({
        keyId,
        contractVersion: "0.1",
        tenantId: TENANT,
        name: "ops-key",
        scopes: ["not:a:scope"],
        keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
        status: "active",
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
  });
});

describe("issuance, verification and rotation through the secrets boundary", () => {
  it("issues material ONCE, wrapped in SecretMaterial, registered behind the boundary", async () => {
    const { secrets, registrar } = harness();
    const keyId = nextKeyId();
    const issuance = await issueEnterpriseApiKey(
      { keyId, tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      registrar,
      AT,
    );
    expect(issuance.record.keyRef.name).toBe(enterpriseApiKeySecretName(keyId));
    expect(issuance.record.keyRef.version).toBeNull();
    expect(issuance.material.toJSON()).toBe("[REDACTED]");
    expect(secrets.activeVersionOf(issuance.record.keyRef.name)).toBe(1);

    // The material verifies; a wrong material is a typed denial.
    await verifyEnterpriseApiKeyMaterial(
      issuance.record,
      issuance.material.value,
      secrets,
    );
    await expect(
      verifyEnterpriseApiKeyMaterial(issuance.record, "rlk_live_wrong.wrong", secrets),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("rotation appends a secret version, moves the active pointer and re-points the record", async () => {
    const { secrets, registrar } = harness();
    const keyId = nextKeyId();
    const first = await issueEnterpriseApiKey(
      { keyId, tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      registrar,
      AT,
    );
    const second = await rotateEnterpriseApiKey(first.record, registrar, LATER);
    expect(secrets.activeVersionOf(first.record.keyRef.name)).toBe(2);
    expect(second.record.keyRef.version).toBe(2);
    expect(second.record.lastRotatedAt).toBe(LATER);

    // The NEW material verifies through the re-pointed record.
    await verifyEnterpriseApiKeyMaterial(second.record, second.material.value, secrets);

    // A consumer PINNED to version 1 keeps working with the old material
    // until that version is retired (rotation-aware versioning).
    const pinned = parseEnterpriseApiKeyRecord({
      ...first.record,
      keyRef: { name: first.record.keyRef.name, version: 1 },
    });
    await verifyEnterpriseApiKeyMaterial(pinned, first.material.value, secrets);

    // After retiring version 1, the old pinned reference fails typed.
    secrets.retire(first.record.keyRef.name, 1);
    await expect(
      verifyEnterpriseApiKeyMaterial(pinned, first.material.value, secrets),
    ).rejects.toThrowError(UnauthorizedError);
  });

  it("refuses to rotate a revoked key and makes revocation idempotent", async () => {
    const { registrar } = harness();
    const keyId = nextKeyId();
    const issuance = await issueEnterpriseApiKey(
      { keyId, tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      registrar,
      AT,
    );
    const revoked = revokeEnterpriseApiKey(issuance.record, LATER);
    expect(revoked.status).toBe("revoked");
    expect(revokeEnterpriseApiKey(revoked, LATER)).toBe(revoked);
    await expect(rotateEnterpriseApiKey(revoked, registrar, LATER)).rejects.toThrowError(
      ConflictError,
    );
  });

  it("generated material embeds a recoverable key id", () => {
    const keyId = "30000000-0000-4000-8000-000000000001";
    const material = generateEnterpriseApiKeyMaterial(keyId);
    expect(material.startsWith("rlk_live_")).toBe(true);
    expect(enterpriseApiKeyIdFromMaterial(material)).toBe(keyId);
    expect(() => enterpriseApiKeyIdFromMaterial("not-a-roamlink-key")).toThrowError(
      UnauthorizedError,
    );
  });
});

describe("no-leak proofs (RL-LOCK-016)", () => {
  it("key material never appears in records, audit events or errors", async () => {
    const { secrets, keys, audit, service } = harness();
    const issuance = await service.issue(
      { tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      commandContext(1),
      AT,
    );
    const material = issuance.material.value;

    // 1. The persisted record serializes secret-free.
    const recordJson = JSON.stringify(issuance.record);
    assertNoSecretMaterial(JSON.parse(recordJson), "ApiKeyRecord");
    expect(recordJson.includes(material)).toBe(false);

    // 2. Store contents never carry the material.
    for (const key of await keys.listByTenant(TENANT)) {
      const json = JSON.stringify(key);
      expect(json.includes(material)).toBe(false);
      expect(scanForSecretMaterial(JSON.parse(json))).toEqual([]);
    }

    // 3. Audit events never carry the material.
    for (const event of await audit.events()) {
      const json = JSON.stringify(event.toPlain ? event.toPlain() : event);
      expect(json.includes(material)).toBe(false);
    }

    // 4. Denial error messages never carry the material.
    let denialMessage = "";
    try {
      await verifyEnterpriseApiKeyMaterial(
        issuance.record,
        "rlk_live_tampered.attempt",
        secrets,
      );
    } catch (error) {
      denialMessage = (error as Error).message;
    }
    expect(denialMessage.length).toBeGreaterThan(0);
    expect(denialMessage.includes(material)).toBe(false);
    expect(scanForSecretMaterial({ message: denialMessage })).toEqual([]);
  });

  it("replaying an issuance idempotency key replays the original material-free-of-side-effects", async () => {
    const { keys } = harness();
    void keys;
    const { service } = harness();
    const first = await service.issue(
      { tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      commandContext(31),
      AT,
    );
    const replay = await service.issue(
      { tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read"] },
      commandContext(31),
      LATER,
    );
    expect(replay.record.keyId).toBe(first.record.keyId);
    expect(replay.material.value).toBe(first.material.value);
  });

  it("the key service authenticates valid material and locates the record", async () => {
    const { service } = harness();
    const issuance = await service.issue(
      { tenantId: TENANT, name: "ops-key", scopes: ["connectivity:read", "orders:read"] },
      commandContext(41),
      AT,
    );
    const authenticated = await service.authenticate(issuance.material.value);
    expect(authenticated.keyId).toBe(issuance.record.keyId);
    const decision = service.authorize(authenticated, "orders:read");
    expect(decision.decision).toBe("allow");
    const denied = service.authorize(authenticated, "webhooks:manage");
    expect(denied.decision).toBe("deny");
    await expect(service.authenticate("rlk_live_0000.deadbeef")).rejects.toThrowError();
  });
});

describe("record parsing discipline", () => {
  it("rejects unknown fields (material can never become a field)", () => {
    const keyId = nextKeyId();
    const input = {
      keyId,
      contractVersion: "0.1",
      tenantId: TENANT,
      name: "ops-key",
      scopes: ["connectivity:read"],
      keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
      status: "active",
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
      material: "rlk_live_leaked.abcdef",
    };
    expect(() => parseEnterpriseApiKeyRecord(input)).toThrowError(ValidationError);
  });

  it("revoked records must carry their revocation instant", () => {
    const keyId = nextKeyId();
    const input = {
      keyId,
      contractVersion: "0.1",
      tenantId: TENANT,
      name: "ops-key",
      scopes: ["connectivity:read"],
      keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
      status: "revoked",
      createdAt: AT,
      updatedAt: LATER,
      revision: 2,
    };
    expect(() => parseEnterpriseApiKeyRecord(input)).toThrowError(ValidationError);
  });
});
