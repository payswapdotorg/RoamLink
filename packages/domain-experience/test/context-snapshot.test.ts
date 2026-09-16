/**
 * RL-010 DeviceContextSnapshot tests: privacy classifications, the
 * consent gate for fine location, and minimization (closed payload
 * vocabulary, no raw network identifiers).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import {
  CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS,
  DeviceContextSnapshot,
  PRIVACY_CLASSIFICATIONS,
} from "../src/index.js";

const OBSERVED_AT = "2026-01-15T08:30:00.000Z";
const FRESH_UNTIL = "2026-01-15T08:31:00.000Z";
const OWNER = deterministicUuidFromSeed(2);

function contextInput(overrides?: Record<string, unknown>) {
  return {
    snapshotId: deterministicUuidFromSeed(20),
    contractVersion: "0.1",
    sequence: 1,
    deviceId: deterministicUuidFromSeed(1),
    ownerUserId: OWNER,
    observedAt: OBSERVED_AT,
    freshUntil: FRESH_UNTIL,
    consent: { fineLocationGranted: false },
    payload: {},
    ...overrides,
  };
}

describe("privacy classifications", () => {
  it("the classification vocabulary is closed and the field map is frozen", () => {
    expect([...PRIVACY_CLASSIFICATIONS]).toEqual(["public", "sensitive", "restricted"]);
    expect(CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS.fineLocation).toBe("restricted");
    expect(CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS.coarseLocation).toBe("sensitive");
    expect(CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS.network).toBe("sensitive");
    expect(CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS.battery).toBe("public");
    expect(Object.isFrozen(CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS)).toBe(true);
  });

  it("classificationOf exposes the frozen map through the snapshot", () => {
    const snapshot = new DeviceContextSnapshot(contextInput());
    expect(snapshot.classificationOf("fineLocation")).toBe("restricted");
  });
});

describe("consent gate (fine location)", () => {
  it("fine location without an explicit consent grant is REJECTED", () => {
    expect(
      () =>
        new DeviceContextSnapshot(
          contextInput({
            payload: { fineLocation: { latitude: 5.6, longitude: -0.19 } },
          }),
        ),
    ).toThrowError(/consent-gated/);
  });

  it("fine location with an explicit grant is accepted and bounds-checked", () => {
    const snapshot = new DeviceContextSnapshot(
      contextInput({
        consent: { fineLocationGranted: true },
        payload: { fineLocation: { latitude: 5.6, longitude: -0.19, accuracyMeters: 12 } },
      }),
    );
    expect(snapshot.payload.fineLocation).toMatchObject({ latitude: 5.6, longitude: -0.19 });
    expect(() =>
      new DeviceContextSnapshot(
        contextInput({
          consent: { fineLocationGranted: true },
          payload: { fineLocation: { latitude: 91, longitude: 0 } },
        }),
      ),
    ).toThrowError(ValidationError);
  });
});

describe("minimization (closed payload vocabulary)", () => {
  it("an EMPTY payload is valid (nothing observed is honest data)", () => {
    const snapshot = new DeviceContextSnapshot(contextInput());
    expect(snapshot.payload).toEqual({});
  });

  it("unknown payload fields are rejected (fail-closed)", () => {
    expect(
      () => new DeviceContextSnapshot(contextInput({ payload: { contacts: {} } })),
    ).toThrowError(/minimization/);
    expect(
      () =>
        new DeviceContextSnapshot(
          contextInput({ payload: { battery: { levelPercent: 80, turbo: true } } }),
        ),
    ).toThrowError(/minimization/);
  });

  it("raw network identifiers are rejected: only counts, digests and radio labels", () => {
    const snapshot = new DeviceContextSnapshot(
      contextInput({
        payload: {
          network: {
            visibleWifiNetworkCount: 7,
            wifiNetworkNameDigest: "a1b2c3d4e5f60718",
            cellularRadio: "nr",
            vpnActive: true,
          },
        },
      }),
    );
    expect(snapshot.payload.network).toMatchObject({ visibleWifiNetworkCount: 7, cellularRadio: "nr" });
    expect(() =>
      new DeviceContextSnapshot(
        contextInput({ payload: { network: { wifiNetworkName: "HomeWifi" } } }),
      ),
    ).toThrowError(/minimization/);
    expect(() =>
      new DeviceContextSnapshot(
        contextInput({ payload: { network: { wifiNetworkNameDigest: "not-hex!" } } }),
      ),
    ).toThrowError(ValidationError);
    expect(() =>
      new DeviceContextSnapshot(
        contextInput({ payload: { network: { cellularRadio: "NOT_A_RADIO!!" } } }),
      ),
    ).toThrowError(ValidationError);
  });

  it("coarse location is country-level only; battery is bounded 0-100", () => {
    const snapshot = new DeviceContextSnapshot(
      contextInput({ payload: { coarseLocation: { countryCode: "GH" }, battery: { levelPercent: 42, charging: true } } }),
    );
    expect(snapshot.payload.coarseLocation).toEqual({ countryCode: "GH" });
    expect(snapshot.payload.battery).toEqual({ levelPercent: 42, charging: true });
    expect(() =>
      new DeviceContextSnapshot(contextInput({ payload: { coarseLocation: { countryCode: "ghana" } } })),
    ).toThrowError(ValidationError);
    expect(() =>
      new DeviceContextSnapshot(contextInput({ payload: { battery: { levelPercent: 101 } } })),
    ).toThrowError(ValidationError);
  });

  it("records are deeply frozen with a deterministic tenant and chain continuity", () => {
    const snapshot = new DeviceContextSnapshot(contextInput({ payload: { battery: { levelPercent: 42 } } }));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
    expect(snapshot.tenantId).toBe(`usr:${OWNER}`);
    const second = new DeviceContextSnapshot(
      contextInput({ snapshotId: deterministicUuidFromSeed(21), sequence: 2 }),
    );
    expect(second.succeeds(snapshot)).toBe(true);
    const skip = new DeviceContextSnapshot(
      contextInput({ snapshotId: deterministicUuidFromSeed(22), sequence: 3 }),
    );
    expect(skip.succeeds(snapshot)).toBe(false);
  });
});
