import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isOrganizationId,
  isUserId,
  parseOrderId,
  parseOrganizationId,
  parseUserId,
  type OrganizationId,
  type UserId,
} from "../src/ids/roamlink-ids.js";
import { isAdcosIntentRef, parseAdcosIntentRef, type AdcosIntentRef } from "../src/ids/foreign-refs.js";
import { ValidationError } from "../src/errors/errors.js";

const VALID = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

describe("RoamLink opaque IDs", () => {
  it("parses a canonical lowercase UUID", () => {
    const userId = parseUserId(VALID);
    expect(userId).toBe(VALID);
    expect(isUserId(userId)).toBe(true);
  });

  it("returns nominally branded values", () => {
    const userId = parseUserId(VALID);
    expectTypeOf(userId).toEqualTypeOf<UserId>();
    // branded values are still strings at runtime
    const asString: string = userId;
    expect(asString).toBe(VALID);
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(() => parseUserId(bad), `value: ${typeof bad}`).toThrowError(ValidationError);
    }
  });

  it("rejects malformed UUID shapes without repairing them", () => {
    const malformed = [
      "",
      "not-a-uuid",
      "6f9619ff8b86d011b42d00c04fc964ff", // no hyphens
      "6F9619FF-8B86-D011-B42D-00C04FC964FF", // uppercase
      "{6f9619ff-8b86-d011-b42d-00c04fc964ff}", // braced
      "urn:uuid:6f9619ff-8b86-d011-b42d-00c04fc964ff", // URN
      "6f9619ff-8b86-d011-b42d-00c04fc964ff ", // trailing whitespace
      " 6f9619ff-8b86-d011-b42d-00c04fc964ff", // leading whitespace
      "6f9619ff-8b86-d011-b42d-00c04fc964fg", // non-hex tail
      "6f9619ff-8b86-d011-b42d-00c04fc964f", // too short
    ];
    for (const value of malformed) {
      expect(() => parseUserId(value), `shape: '${String(value).trim()}'`).toThrowError(ValidationError);
    }
  });

  it("rejects the nil UUID as an entity id", () => {
    expect(() => parseUserId("00000000-0000-0000-0000-000000000000")).toThrowError(ValidationError);
  });

  it("never echoes the offending value in error messages (RL-LOCK-016)", () => {
    const sentinel = "SECRET-LIKE-ID-VALUE";
    let message = "";
    try {
      parseUserId(sentinel);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(sentinel);
    expect(message).toContain("UserId");
  });

  it("nominal branding keeps id kinds from interchanging at compile time", () => {
    const userId = parseUserId(VALID);
    // @ts-expect-error UserId is not assignable to OrganizationId (nominal brand)
    const asOrg: OrganizationId = userId;
    expect(asOrg).toBe(userId); // only reachable because the test lies to the compiler on purpose
  });

  it("guards narrow to the branded type", () => {
    const value: unknown = VALID;
    if (isUserId(value)) {
      expectTypeOf(value).toEqualTypeOf<UserId>();
    }
    expect(isUserId("garbage")).toBe(false);
    expect(isOrganizationId(42)).toBe(false);
  });

  it("parsers exist for every RoamLink-owned aggregate id", async () => {
    const module = await import("../src/ids/roamlink-ids.js");
    const expected = [
      "parseUserId",
      "parseOrganizationId",
      "parseMembershipId",
      "parseDeviceId",
      "parseDeviceCapabilitySnapshotId",
      "parseDeviceContextSnapshotId",
      "parseExperienceIntentId",
      "parseExperienceIntentVersionId",
      "parseExperienceDecisionId",
      "parseNotificationId",
      "parseProductId",
      "parseProductVariantId",
      "parseOrderId",
      "parseOrderLineId",
      "parseSubscriptionId",
      "parseCustomerPaymentId",
      "parseCustomerInvoiceId",
      "parseCustomerRefundId",
    ];
    for (const name of expected) {
      expect(typeof module[name as keyof typeof module]).toBe("function");
    }
    expect(parseOrderId(VALID)).toBe(VALID);
    expect(parseOrganizationId(VALID)).toBe(VALID);
  });
});

describe("foreign refs vs RoamLink ids (RL-LOCK-003)", () => {
  it("parses safe foreign reference strings", () => {
    const ref = parseAdcosIntentRef("adcos-intent-123");
    expect(ref).toBe("adcos-intent-123");
    expectTypeOf(ref).toEqualTypeOf<AdcosIntentRef>();
    expect(isAdcosIntentRef(ref)).toBe(true);
    // ADCOS canonical ids and UUIDs are both acceptable ref shapes
    expect(parseAdcosIntentRef(VALID)).toBe(VALID);
    expect(parseAdcosIntentRef("adcos:offer:42")).toBe("adcos:offer:42");
  });

  it("rejects unsafe foreign reference strings", () => {
    for (const bad of ["", " leading", "trailing ", "with space", "-starts-with-dash", "a".repeat(256), "ünïcode", "slash/forbidden", "hash#tag"]) {
      expect(() => parseAdcosIntentRef(bad), `shape: '${bad}'`).toThrowError(ValidationError);
    }
  });

  it("is not interchangeable with RoamLink ids at compile time", () => {
    const userId = parseUserId(VALID);
    const ref = parseAdcosIntentRef("adcos-intent-123");
    // @ts-expect-error foreign refs are never RoamLink ids (RL-LOCK-003)
    const asUser: UserId = ref;
    // @ts-expect-error RoamLink ids are never foreign refs
    const asRef: AdcosIntentRef = userId;
    expect(asUser).toBeDefined();
    expect(asRef).toBeDefined();
  });

  it("all named foreign reference parsers exist and validate", async () => {
    const module = await import("../src/ids/foreign-refs.js");
    const expected = [
      "parseAdcosIntentRef",
      "parseAdcosContractRef",
      "parseAdcosLeaseRef",
      "parseAdcosResourceId",
      "parseAdcosOfferRef",
      "parseAdcosReservationRef",
      "parseAdcosSessionRef",
      "parseAdcosPathRef",
      "parseAdcosEventId",
      "parseAdcosDeliveryId",
    ];
    for (const name of expected) {
      const parse = module[name as keyof typeof module] as (v: unknown) => string;
      expect(typeof parse).toBe("function");
      expect(parse("ref-1")).toBe("ref-1");
      expect(() => parse("")).toThrowError(ValidationError);
    }
  });
});
