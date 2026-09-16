/**
 * Connector provisioning + managed-edge enrollment tests (RL-063 over the
 * RL-044 contract).
 *
 * Proves: the negotiated capability set stays inside the RL-044 closed
 * vocabulary (used DIRECTLY, never redefined); the guaranteed degradation
 * floor (observation + user-guided actions only) still provisions honestly
 * with the `user-guided` operating mode; doctored operating modes fail
 * closed; and the managed-edge enrollment record carries publication
 * references + digest only (never credentials, never snapshot payload).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { fixtureTenantId } from "@roamlink/testkit";

import {
  applyConnectorProvisioningTransition,
  negotiateConnectorProvisioning,
  parseConnectorProvisioningRecord,
  parseManagedEdgeEnrollmentRecord,
} from "../src/connectors.js";

const AT = "2026-02-01T10:00:00.000Z";
const TENANT = fixtureTenantId();
const ENROLLMENT_ID = "70000000-0000-4000-8000-000000000001";
const PROVISIONING_ID = "70000000-0000-4000-8000-000000000002";

function provisioningInput() {
  return {
    provisioningId: PROVISIONING_ID,
    tenantId: TENANT,
    enrollmentId: ENROLLMENT_ID,
    connectorId: "acahat-mdm",
  };
}

describe("connector provisioning over the RL-044 closed vocabularies", () => {
  it("negotiates a full enterprise capability set", () => {
    const record = negotiateConnectorProvisioning(
      provisioningInput(),
      ["mdm-managed-configuration", "vpn-network-extension", "observation", "user-guided-actions"],
      ["mdm-managed-configuration", "vpn-network-extension", "observation", "user-guided-actions"],
      AT,
    );
    expect(record.state).toBe("provisioned");
    expect(record.operatingMode).toBe("enterprise");
    expect(record.capabilities).toContain("mdm-managed-configuration");
  });

  it("the degradation floor (observation + user-guided) still provisions", () => {
    const record = negotiateConnectorProvisioning(
      provisioningInput(),
      ["mdm-managed-configuration", "vpn-network-extension", "observation", "user-guided-actions"],
      ["observation", "user-guided-actions"],
      AT,
    );
    expect(record.state).toBe("provisioned");
    expect(record.operatingMode).toBe("user-guided");
    expect(record.capabilities).toEqual(["observation", "user-guided-actions"]);
  });

  it("an empty negotiation is an honest failure with a typed reason", () => {
    const record = negotiateConnectorProvisioning(
      provisioningInput(),
      ["mdm-managed-configuration"],
      ["observation", "user-guided-actions"],
      AT,
    );
    expect(record.state).toBe("failed");
    expect(record.failureReason).toBe("capability-negotiation-empty");
    expect(record.operatingMode).toBe("observation-only");
  });

  it("rejects capabilities outside the closed vocabulary (fail-closed)", () => {
    expect(() =>
      parseConnectorProvisioningRecord({
        provisioningId: PROVISIONING_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        enrollmentId: ENROLLMENT_ID,
        connectorId: "acahat-mdm",
        capabilities: ["cellular-baseband-control"],
        operatingMode: "enterprise",
        state: "provisioned",
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
  });

  it("a doctored operating mode fails closed (consistency with the stored set)", () => {
    expect(() =>
      parseConnectorProvisioningRecord({
        provisioningId: PROVISIONING_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        enrollmentId: ENROLLMENT_ID,
        connectorId: "acahat-mdm",
        capabilities: ["observation", "user-guided-actions"],
        operatingMode: "enterprise",
        state: "provisioned",
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
  });

  it("lifecycle transitions are closed and terminal states immutable", () => {
    const provisioned = negotiateConnectorProvisioning(
      provisioningInput(),
      ["observation"],
      ["observation", "user-guided-actions"],
      AT,
    );
    const revoked = applyConnectorProvisioningTransition(provisioned, "revoked", AT);
    expect(revoked.state).toBe("revoked");
    expect(() =>
      applyConnectorProvisioningTransition(revoked, "provisioned", AT),
    ).toThrowError(ValidationError);

    const failed = negotiateConnectorProvisioning(provisioningInput(), [], ["observation"], AT);
    expect(() => applyConnectorProvisioningTransition(failed, "provisioned", AT)).toThrowError(
      ValidationError,
    );
  });
});

describe("managed-edge enrollment records (the RL-062 publication landing)", () => {
  function managedInput(): Record<string, unknown> {
    return {
      managedEnrollmentId: "70000000-0000-4000-8000-000000000003",
      contractVersion: "0.1",
      tenantId: TENANT,
      provisioningId: PROVISIONING_ID,
      deviceRef: "device-7f3a",
      connectorId: "acahat-mdm",
      capabilitySnapshotDigest: "a".repeat(64),
      capabilitySnapshotSequence: 1,
      state: "enrolled",
      enrolledAt: AT,
      updatedAt: AT,
      revision: 1,
    };
  }

  it("parses a valid managed enrollment", () => {
    const record = parseManagedEdgeEnrollmentRecord(managedInput());
    expect(record.deviceRef).toBe("device-7f3a");
    expect(record.capabilitySnapshotDigest).toHaveLength(64);
  });

  it("rejects credential-shaped smuggling and non-digest references", () => {
    expect(() =>
      parseManagedEdgeEnrollmentRecord({ ...managedInput(), credential: "rlk_live_x.y" }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseManagedEdgeEnrollmentRecord({ ...managedInput(), capabilitySnapshotDigest: "not-hex" }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseManagedEdgeEnrollmentRecord({ ...managedInput(), capabilitySnapshotSequence: 0 }),
    ).toThrowError(ValidationError);
  });

  it("retirement requires its instant; other states reject it", () => {
    expect(() =>
      parseManagedEdgeEnrollmentRecord({ ...managedInput(), state: "retired" }),
    ).toThrowError(ValidationError);
    const retired = parseManagedEdgeEnrollmentRecord({
      ...managedInput(),
      state: "retired",
      retiredAt: AT,
    });
    expect(retired.retiredAt).toBe(AT);
  });
});
