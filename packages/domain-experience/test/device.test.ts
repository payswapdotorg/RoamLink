/**
 * RL-010 Device aggregate tests: lifecycle transitions, ownership rules and
 * platform metadata validation.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import { Device, isDeviceStatus } from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const at = (iso: string) => parseUtcInstant(iso);

function deviceInput(overrides?: Record<string, unknown>) {
  return {
    deviceId: deterministicUuidFromSeed(1),
    owningUserId: deterministicUuidFromSeed(2),
    platform: { family: "ios", platformVersion: "18.1" },
    status: "enrolled",
    enrolledAt: T0,
    updatedAt: T0,
    revision: 1,
    ...overrides,
  };
}

describe("Device ownership", () => {
  it("requires at least one owner and derives the personal tenant", () => {
    const device = new Device(deviceInput());
    expect(device.tenantId).toBe(`usr:${deterministicUuidFromSeed(2)}`);
    expect(() => new Device(deviceInput({ owningUserId: undefined }))).toThrowError(
      /at least one owner/,
    );
  });

  it("organization ownership governs the tenant when both owners are present", () => {
    const device = new Device(
      deviceInput({ owningOrganizationId: deterministicUuidFromSeed(3) }),
    );
    expect(device.tenantId).toBe(`org:${deterministicUuidFromSeed(3)}`);
  });

  it("org-only ownership works; unknown fields and bad shapes fail closed", () => {
    const device = new Device(
      deviceInput({
        owningUserId: undefined,
        owningOrganizationId: deterministicUuidFromSeed(3),
      }),
    );
    expect(device.tenantId).toBe(`org:${deterministicUuidFromSeed(3)}`);
    expect(() => new Device(deviceInput({ extra: 1 }))).toThrowError(/unknown field/);
    expect(() => new Device(deviceInput({ owningUserId: "not-a-uuid" }))).toThrowError(ValidationError);
    expect(() => new Device(deviceInput({ platform: { family: "plan9", platformVersion: "1" } }))).toThrowError(
      /platform-family vocabulary/,
    );
    expect(
      () => new Device(deviceInput({ platform: { family: "ios", platformVersion: "x".repeat(65) } })),
    ).toThrowError(/printable label/);
  });
});

describe("Device lifecycle", () => {
  it("happy path: enrolled -> active <-> suspended -> retired with revision bumps", () => {
    let device = new Device(deviceInput());
    expect(device.status).toBe("enrolled");
    device = device.activate(at("2026-01-15T09:00:00.000Z"));
    expect(device.status).toBe("active");
    expect(device.revision).toBe(2);
    device = device.suspend(at("2026-01-15T10:00:00.000Z"));
    expect(device.status).toBe("suspended");
    device = device.reactivate(at("2026-01-15T11:00:00.000Z"));
    expect(device.status).toBe("active");
    device = device.retire(at("2026-01-15T12:00:00.000Z"));
    expect(device.status).toBe("retired");
    expect(device.revision).toBe(5);
  });

  it("enrolled cannot jump to suspended (validated transitions only)", () => {
    const device = new Device(deviceInput());
    expect(() => device.suspend(at("2026-01-15T09:00:00.000Z"))).toThrowError(
      /only an active device can be suspended/,
    );
  });

  it("retired is terminal; enrolled may retire directly", () => {
    const retired = new Device(deviceInput({ status: "retired", revision: 3 }));
    for (const transition of ["activate", "suspend", "reactivate", "retire"] as const) {
      expect(() => retired[transition](at("2026-01-15T13:00:00.000Z"))).toThrowError(ValidationError);
    }
    const direct = new Device(deviceInput()).retire(at("2026-01-15T13:00:00.000Z"));
    expect(direct.status).toBe("retired");
  });

  it("records are deeply frozen and round-trip through toRecord/fromRecord", () => {
    const device = new Device(deviceInput({ platform: { family: "android", platformVersion: "15", model: "Pixel 9" } }));
    expect(Object.isFrozen(device)).toBe(true);
    expect(Object.isFrozen(device.platform)).toBe(true);
    expect(() => {
      (device as unknown as { hack?: number }).hack = 1;
    }).toThrowError(TypeError);
    const roundTripped = Device.fromRecord(device.toRecord());
    expect(roundTripped.toRecord()).toEqual(device.toRecord());
    expect(isDeviceStatus(device.status)).toBe(true);
  });
});
