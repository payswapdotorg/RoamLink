/**
 * RL-044 credential tests: contract-level credential isolation semantics -
 * short-lived, device-bound, narrowly scoped, revocable (spec/security.md
 * "Credential rules", RL-LOCK-016). Fail-closed on every axis; a credential
 * that passes validation it should not is a test failure (RL-LOCK-018).
 */
import { describe, expect, it } from "vitest";
import { UnauthorizedError, ValidationError } from "@roamlink/contracts";
import { fixtureUtcInstant } from "@roamlink/testkit";

import {
  InMemoryEnterpriseEdgeConnector,
  evaluateEdgeCredentialGrant,
  parseEdgeCredentialGrant,
  parseEdgeCredentialSecretRef,
} from "../src/index.js";
import type { EdgeCredentialGrant } from "../src/index.js";

const T0 = fixtureUtcInstant();
const T_PLUS_30M = fixtureUtcInstant(30 * 60 * 1000);
const T_PLUS_1H = fixtureUtcInstant(60 * 60 * 1000);
const DEVICE = "device-enrollment-ref-1";
const OTHER_DEVICE = "device-enrollment-ref-2";

let grantSeed = 1;
function grantId(): string {
  const seed = grantSeed++;
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function grantInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    grantId: grantId(),
    contractVersion: "0.1",
    deviceRef: DEVICE,
    scopes: ["observation-upload"],
    issuedAt: T0,
    expiresAt: T_PLUS_1H,
    revokedAt: null,
    secretRef: { name: "EDGE_SYNC_TOKEN", version: null },
    ...overrides,
  };
}

describe("parseEdgeCredentialGrant (shape + lifetime invariants)", () => {
  it("parses a valid grant and freezes it", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(Object.isFrozen(grant)).toBe(true);
    expect(grant.deviceRef).toBe(DEVICE);
    expect(grant.scopes).toEqual(["observation-upload"]);
    expect(grant.secretRef).toEqual({ name: "EDGE_SYNC_TOKEN", version: null });
  });

  it("REQUIRES an expiry (short-lived by contract)", () => {
    const { expiresAt: _expired, ...withoutExpiry } = grantInput();
    expect(() => parseEdgeCredentialGrant(withoutExpiry)).toThrowError(/expiry is REQUIRED/);
  });

  it("rejects a lifetime beyond the 24h bound", () => {
    expect(() =>
      parseEdgeCredentialGrant(
        grantInput({ expiresAt: fixtureUtcInstant(25 * 60 * 60 * 1000) }),
      ),
    ).toThrowError(/short-lived/);
  });

  it("rejects an expiry at or before issuance", () => {
    expect(() => parseEdgeCredentialGrant(grantInput({ expiresAt: T0 }))).toThrowError(
      /strictly after issuedAt/,
    );
  });

  it("rejects empty scopes and out-of-vocabulary scopes", () => {
    expect(() => parseEdgeCredentialGrant(grantInput({ scopes: [] }))).toThrowError(
      /at least one scope/,
    );
    expect(() =>
      parseEdgeCredentialGrant(grantInput({ scopes: ["god-mode"] })),
    ).toThrowError(/closed credential-scope vocabulary/);
  });

  it("rejects a revocation before issuance", () => {
    expect(() =>
      parseEdgeCredentialGrant(
        grantInput({ revokedAt: fixtureUtcInstant(-1_000) }),
      ),
    ).toThrowError(/must not precede issuance/);
  });

  it("the secret reference is a REFERENCE, never material (RL-LOCK-016)", () => {
    expect(() =>
      parseEdgeCredentialGrant(
        grantInput({ secretRef: { name: "not a valid name!", version: null } }),
      ),
    ).toThrowError(/key material is never a field/);
    expect(() =>
      parseEdgeCredentialGrant(
        grantInput({ secretRef: { name: "EDGE_TOKEN", version: 0 } }),
      ),
    ).toThrowError(/positive integer or null/);
    expect(parseEdgeCredentialSecretRef({ name: "EDGE_TOKEN", version: 3 })).toEqual({
      name: "EDGE_TOKEN",
      version: 3,
    });
    // The serialized grant never contains a secret VALUE slot at all.
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(Object.keys(JSON.parse(JSON.stringify(grant)))).toEqual([
      "grantId",
      "contractVersion",
      "deviceRef",
      "scopes",
      "issuedAt",
      "expiresAt",
      "revokedAt",
      "secretRef",
    ]);
  });
});

describe("evaluateEdgeCredentialGrant (runtime checks, all fail-closed)", () => {
  it("allows a valid, in-window, correctly-bound, correctly-scoped use", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    const usage = evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, T_PLUS_30M);
    expect(usage.scope).toBe("observation-upload");
    expect(usage.grantId).toBe(grant.grantId);
  });

  it("denies an expired grant (typed)", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, T_PLUS_1H),
    ).toThrowError(/expired/);
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, T_PLUS_1H),
    ).toThrowError(UnauthorizedError);
  });

  it("denies use before issuance (not-yet-valid, typed)", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, fixtureUtcInstant(-1_000)),
    ).toThrowError(/not yet valid/);
  });

  it("denies a revoked grant immediately (revocable, typed)", () => {
    const grant = parseEdgeCredentialGrant(
      grantInput({ revokedAt: T_PLUS_30M }),
    );
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, T_PLUS_30M),
    ).toThrowError(/revoked/);
  });

  it("denies a use before revocation still works (revocation is forward-effective)", () => {
    const grant = parseEdgeCredentialGrant(grantInput({ revokedAt: T_PLUS_30M }));
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", DEVICE, T0),
    ).not.toThrow();
  });

  it("denies a cross-device use (device binding, typed)", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "observation-upload", OTHER_DEVICE, T_PLUS_30M),
    ).toThrowError(/bound to a different device/);
  });

  it("denies an ungranted scope (narrowly scoped, typed)", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    expect(() =>
      evaluateEdgeCredentialGrant(grant, "action-submit", DEVICE, T_PLUS_30M),
    ).toThrowError(/scope was not granted/);
    expect(() => evaluateEdgeCredentialGrant(grant, "action-submit", DEVICE, T0)).toThrowError(
      /closed credential-scope vocabulary|scope was not granted/,
    );
  });

  it("deny reasons are the closed five, value-free (RL-LOCK-016)", () => {
    const grant = parseEdgeCredentialGrant(grantInput());
    let message = "";
    try {
      evaluateEdgeCredentialGrant(grant, "action-submit", OTHER_DEVICE, T_PLUS_30M);
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedError);
      message = (error as UnauthorizedError).message;
    }
    expect(message).not.toContain(String(grant.grantId));
    expect(message).not.toContain("EDGE_SYNC_TOKEN");
  });
});

describe("the in-memory fake connector - credential lifecycle", () => {
  function enterpriseConnector(): InMemoryEnterpriseEdgeConnector {
    return new InMemoryEnterpriseEdgeConnector({
      capabilities: ["enterprise-connector", "observation", "user-guided-actions"],
      grantIdGenerator: grantId,
      defaultGrantTtlMs: 60 * 60 * 1000, // 1h cap
    });
  }

  it("issues a short-lived, device-bound, scoped grant and validates its use", async () => {
    const connector = enterpriseConnector();
    const grant = await connector.requestCredential(
      { deviceRef: DEVICE, scopes: ["observation-upload"], ttlMs: 60 * 60 * 1000, secretName: "EDGE_SYNC_TOKEN" },
      T0,
    );
    expect(grant.expiresAt).toBe(T_PLUS_1H);
    const usage = await connector.useCredential(grant.grantId, "observation-upload", DEVICE, T_PLUS_30M);
    expect(usage.scope).toBe("observation-upload");
  });

  it("never grants MORE lifetime than requested (short-lived cap)", async () => {
    const connector = enterpriseConnector();
    const grant = await connector.requestCredential(
      { deviceRef: DEVICE, scopes: ["action-submit"], ttlMs: 4 * 60 * 60 * 1000, secretName: "EDGE_ACTION_TOKEN" },
      T0,
    );
    expect(grant.expiresAt).toBe(T_PLUS_1H); // capped at the connector default
  });

  it("refuses to issue grants on the degradation floor (observation/user-guided only)", async () => {
    const connector = new InMemoryEnterpriseEdgeConnector({
      capabilities: ["observation", "user-guided-actions"],
      grantIdGenerator: grantId,
    });
    await expect(
      connector.requestCredential(
        { deviceRef: DEVICE, scopes: ["observation-upload"], ttlMs: 60_000, secretName: "X" },
        T0,
      ),
    ).rejects.toMatchObject({ reason: "EDGE_CREDENTIAL_REQUEST_UNSUPPORTED" });
  });

  it("validates request shape (scopes, ttl bounds)", async () => {
    const connector = enterpriseConnector();
    await expect(
      connector.requestCredential(
        { deviceRef: DEVICE, scopes: [], ttlMs: 60_000, secretName: "X" } as never,
        T0,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      connector.requestCredential(
        { deviceRef: DEVICE, scopes: ["observation-upload"], ttlMs: 48 * 60 * 60 * 1000, secretName: "X" },
        T0,
      ),
    ).rejects.toMatchObject({ reason: "EDGE_CREDENTIAL_REQUEST_INVALID" });
  });

  it("revocation is immediate and idempotent, and revoked grants stop working", async () => {
    const connector = enterpriseConnector();
    const grant = await connector.requestCredential(
      { deviceRef: DEVICE, scopes: ["observation-upload"], ttlMs: 60 * 60 * 1000, secretName: "EDGE_SYNC_TOKEN" },
      T0,
    );
    await expect(
      connector.useCredential(grant.grantId, "observation-upload", DEVICE, T_PLUS_30M),
    ).resolves.toBeTruthy();

    const revoked = await connector.revokeCredential(grant.grantId, T_PLUS_30M);
    expect(revoked.revokedAt).toBe(T_PLUS_30M);
    await expect(
      connector.useCredential(grant.grantId, "observation-upload", DEVICE, T_PLUS_30M),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Idempotent: revoking again returns the same history-preserving grant.
    const again = await connector.revokeCredential(grant.grantId, T_PLUS_1H);
    expect(again.revokedAt).toBe(T_PLUS_30M);
  });

  it("unknown grants are a typed not-found", async () => {
    const connector = enterpriseConnector();
    await expect(
      connector.useCredential(grantId(), "observation-upload", DEVICE, T0),
    ).rejects.toMatchObject({ reason: "EDGE_CREDENTIAL_GRANT_NOT_FOUND" });
  });

  it("expired grants stop validating after their TTL", async () => {
    const connector = enterpriseConnector();
    const grant: EdgeCredentialGrant = await connector.requestCredential(
      { deviceRef: DEVICE, scopes: ["diagnostics-upload"], ttlMs: 60_000, secretName: "EDGE_DIAG_TOKEN" },
      T0,
    );
    await expect(
      connector.useCredential(grant.grantId, "diagnostics-upload", DEVICE, fixtureUtcInstant(59_000)),
    ).resolves.toBeTruthy();
    await expect(
      connector.useCredential(grant.grantId, "diagnostics-upload", DEVICE, fixtureUtcInstant(60_000)),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
