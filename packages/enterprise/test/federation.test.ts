/**
 * Tenant federation reference-only tests (RL-063, RL-LOCK-003).
 *
 * NEGATIVE PROOFS: the federation record is structurally incapable of
 * carrying identity material or authenticating anyone. Every attempt to
 * smuggle credentials, user directories, ADCOS node ids, session material or
 * any other identity semantics fails closed as an unknown field. There is no
 * verify/authenticate function on this surface by construction - validating
 * federated assertions is the auth boundary's concern, out of scope here.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { fixtureTenantId } from "@roamlink/testkit";

import {
  federationReferenceView,
  parseTenantFederationRecord,
  setTenantFederationState,
} from "../src/federation.js";

const AT = "2026-02-01T10:00:00.000Z";

function baseInput(): Record<string, unknown> {
  return {
    federationId: "00000000-0000-4000-8000-000000000001",
    contractVersion: "0.1",
    tenantId: fixtureTenantId(),
    protocol: "oidc",
    issuerReference: "https://idp.acahat.example/oidc",
    state: "configured",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  };
}

describe("tenant federation is REFERENCE-ONLY (RL-LOCK-003)", () => {
  it("parses a valid reference-only record", () => {
    const record = parseTenantFederationRecord(baseInput());
    expect(record.protocol).toBe("oidc");
    expect(record.issuerReference).toBe("https://idp.acahat.example/oidc");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("rejects every identity-material smuggling attempt as an unknown field", () => {
    const attempts: readonly (readonly [string, unknown])[] = [
      ["adcosNodeId", "node-77"],
      ["nodeId", "adcos-node-77"],
      ["credentials", { clientSecret: "abc" }],
      ["clientSecret", "super-secret-value"],
      ["apiToken", "tok_live_1234567890"],
      ["userDirectory", [{ userId: "u-1", email: "a@b.c" }]],
      ["sessionMaterial", { sessionId: "s-1" }],
      ["assertion", "eyJhbGciOiJSUz.unsigned.jwt"],
      ["publicKey", "-----BEGIN PUBLIC KEY-----"],
      ["verifiedUsers", 12],
    ];
    for (const [key, value] of attempts) {
      const input = { ...baseInput(), [key]: value };
      expect(() => parseTenantFederationRecord(input), `field '${key}'`).toThrowError(
        ValidationError,
      );
    }
  });

  it("rejects protocols outside the closed vocabulary", () => {
    expect(() => parseTenantFederationRecord({ ...baseInput(), protocol: "ldap" })).toThrowError(
      ValidationError,
    );
  });

  it("rejects issuer references that are not bounded URI-formatted locators", () => {
    expect(() =>
      parseTenantFederationRecord({ ...baseInput(), issuerReference: "not a url" }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseTenantFederationRecord({ ...baseInput(), issuerReference: "ftp://idp.example" }),
    ).toThrowError(ValidationError);
  });

  it("the reference view exposes references only - nothing that authenticates", () => {
    const record = parseTenantFederationRecord(baseInput());
    const view = federationReferenceView(record);
    expect(Object.keys(view).sort()).toEqual([
      "federationId",
      "issuerReference",
      "protocol",
      "state",
      "tenantId",
    ]);
  });

  it("lifecycle toggles are configured <-> disabled only", () => {
    const record = parseTenantFederationRecord(baseInput());
    const disabled = setTenantFederationState(record, "disabled", AT);
    expect(disabled.state).toBe("disabled");
    expect(disabled.revision).toBe(2);
    expect(setTenantFederationState(disabled, "disabled", AT)).toBe(disabled);
  });
});
