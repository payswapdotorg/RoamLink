import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isTenantId,
  organizationIdOfTenant,
  parseActorId,
  parseTenantId,
  tenantIdFromOrganization,
  tenantIdFromUser,
  tenantScopeOf,
  userIdOfTenant,
  type TenantId,
} from "../src/ids/tenant.js";
import { parseOrganizationId, parseUserId, type OrganizationId } from "../src/ids/roamlink-ids.js";
import { ValidationError } from "../src/errors/errors.js";

const ORG = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const USER = "0b9a4e2f-6d5b-4f0e-9a2c-1f8e7d6c5b4a";

describe("TenantId (organization/customer boundary)", () => {
  it("derives organization and user tenants and round-trips them", () => {
    const orgId = parseOrganizationId(ORG);
    const userId = parseUserId(USER);
    const orgTenant = tenantIdFromOrganization(orgId);
    const userTenant = tenantIdFromUser(userId);

    expectTypeOf(orgTenant).toEqualTypeOf<TenantId>();
    expect(parseTenantId(orgTenant)).toBe(orgTenant);
    expect(parseTenantId(userTenant)).toBe(userTenant);
    expect(tenantScopeOf(orgTenant)).toBe("organization");
    expect(tenantScopeOf(userTenant)).toBe("user");
    expect(organizationIdOfTenant(orgTenant)).toBe(orgId);
    expect(userIdOfTenant(orgTenant)).toBeUndefined();
    expect(userIdOfTenant(userTenant)).toBe(userId);
    expect(organizationIdOfTenant(userTenant)).toBeUndefined();
  });

  it("rejects malformed tenant ids", () => {
    for (const bad of [
      "",
      ORG, // bare uuid without scope prefix
      "team:" + ORG,
      "org:",
      "usr:not-a-uuid",
      "ORG:" + ORG, // case-sensitive prefix
      "org:" + ORG + "x",
      42,
      null,
    ]) {
      expect(() => parseTenantId(bad), `shape: '${String(bad)}'`).toThrowError(ValidationError);
      expect(isTenantId(bad)).toBe(false);
    }
  });

  it("tenant ids are not organization ids at compile time", () => {
    const tenant = tenantIdFromOrganization(parseOrganizationId(ORG));
    // @ts-expect-error TenantId is a distinct nominal type
    const asOrg: OrganizationId = tenant;
    expect(typeof asOrg).toBe("string");
  });
});

describe("ActorId", () => {
  it("parses safe actor references", () => {
    const actor = parseActorId("service-reconciler");
    expect(actor).toBe("service-reconciler");
    expect(parseActorId(USER)).toBe(USER);
  });

  it("rejects malformed actor ids", () => {
    for (const bad of ["", "with space", "a".repeat(256), 42]) {
      expect(() => parseActorId(bad), `shape: '${String(bad)}'`).toThrowError(ValidationError);
    }
  });
});
