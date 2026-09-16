/**
 * Version-tolerance contract tests (RL-063, RL-LOCK-017).
 *
 * The enterprise contract discipline mirrors the other RoamLink contract
 * families: same MAJOR, MINOR not newer than the implemented minor. A record
 * from an OLDER minor parses; a NEWER minor (which may carry fields this
 * parser does not know) fails CLOSED with a diagnosable error; a different
 * MAJOR never parses. Additive changes are preferred and stay inside a
 * major; the failure mode is loud, never a silent field drop.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, parseContractVersion } from "@roamlink/contracts";
import { fixtureTenantId } from "@roamlink/testkit";

import {
  ENTERPRISE_CONTRACT_VERSION,
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "../src/version.js";
import {
  parseEnterpriseApiKeyRecord,
  enterpriseApiKeySecretName,
} from "../src/api-keys.js";
import { parseTenantFederationRecord } from "../src/federation.js";

const AT = "2026-02-01T10:00:00.000Z";

describe("enterprise contract version tolerance (RL-LOCK-017)", () => {
  it("implements contract version 0.1", () => {
    expect(ENTERPRISE_CONTRACT_VERSION).toBe("0.1");
    expect(describeEnterpriseContractVersionExpectation()).toContain("0");
    expect(describeEnterpriseContractVersionExpectation()).toContain("1");
  });

  it("accepts an OLDER minor from an older producer", () => {
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("0.0"))).toBe(true);
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("0.1"))).toBe(true);
  });

  it("fails CLOSED on a NEWER minor (unknown fields must never be dropped silently)", () => {
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("0.2"))).toBe(false);
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("0.99"))).toBe(false);
  });

  it("fails CLOSED on a different MAJOR (breaking changes require versioning)", () => {
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("1.0"))).toBe(false);
    expect(isEnterpriseRecordVersionCompatible(parseContractVersion("2.3"))).toBe(false);
  });

  it("records embed the contract version and reject incompatible ones at parse time", () => {
    const keyId = "80000000-0000-4000-8000-000000000001";
    const base = {
      keyId,
      tenantId: fixtureTenantId(),
      name: "ops-key",
      scopes: ["connectivity:read"],
      keyRef: { name: enterpriseApiKeySecretName(keyId), version: null },
      status: "active",
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    };
    // Older minor parses.
    expect(() =>
      parseEnterpriseApiKeyRecord({ ...base, contractVersion: "0.0" }),
    ).not.toThrow();
    // Newer minor fails closed with the diagnosable expectation.
    try {
      parseEnterpriseApiKeyRecord({ ...base, contractVersion: "0.2" });
      expect.unreachable("a newer minor must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(
        describeEnterpriseContractVersionExpectation(),
      );
    }
    // Different major fails closed.
    expect(() =>
      parseEnterpriseApiKeyRecord({ ...base, contractVersion: "1.0" }),
    ).toThrowError(ValidationError);
  });

  it("an additive change stays inside the SAME minor (schema additions parse)", () => {
    // A field ADDED within the implemented contract surface (e.g. the
    // managed-edge record's capabilitySnapshotSequence was added alongside
    // the digest) parses naturally; the discipline guards DRIFT, not growth.
    const federation = parseTenantFederationRecord({
      federationId: "80000000-0000-4000-8000-000000000002",
      contractVersion: "0.1",
      tenantId: fixtureTenantId(),
      protocol: "saml",
      issuerReference: "https://idp.example/saml",
      state: "configured",
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(federation.contractVersion).toBe("0.1");
  });
});
