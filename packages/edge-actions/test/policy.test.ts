/**
 * RL-043 policy tests: local experience-policy evaluation from the
 * privacy-classified context (spec/mobile.md "Device privacy" - restricted
 * context is consent-gated; deferred, never silently dropped) plus the
 * vocabulary-alignment proof that the edge and DeviceCapabilitySnapshot
 * vocabularies carry the same closed name set (RL-LOCK-017/018).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { DeviceContextSnapshot } from "@roamlink/domain-experience";

import {
  createDesiredActionPolicy,
  DEVICE_ACTION_CAPABILITY_COUNT,
  assertDeviceCapabilityVocabularyAlignment,
  deviceCapabilityVocabularyIntersection,
  isDeviceCapabilityVocabularyAligned,
} from "../src/index.js";
import { T0 } from "./helpers.js";

function contextSnapshot(consent: boolean): DeviceContextSnapshot {
  return new DeviceContextSnapshot({
    snapshotId: "00000000-0000-4000-8000-0000000000c9",
    contractVersion: "0.1",
    sequence: 1,
    deviceId: "00000000-0000-4000-8000-0000000000d9",
    ownerUserId: "00000000-0000-4000-8000-0000000000da",
    observedAt: T0,
    freshUntil: "2026-01-15T08:31:00.000Z",
    consent: { fineLocationGranted: consent },
    payload: consent
      ? { fineLocation: { latitude: 50.1, longitude: 8.7 } }
      : { battery: { levelPercent: 80 } },
  });
}

describe("vocabulary alignment (the DeviceCapabilitySnapshot gate vocabulary)", () => {
  it("the edge and experience-domain vocabularies carry the same closed set", () => {
    expect(isDeviceCapabilityVocabularyAligned()).toBe(true);
    const names = assertDeviceCapabilityVocabularyAlignment();
    expect(names).toHaveLength(11);
    expect(DEVICE_ACTION_CAPABILITY_COUNT).toBe(11);
    expect(deviceCapabilityVocabularyIntersection()).toEqual([...names].sort());
  });

  it("includes exactly the spec/architecture.md §7 names", () => {
    expect(deviceCapabilityVocabularyIntersection()).toEqual([
      "active_interface_selection",
      "background_execution_limits",
      "cellular_data_sim_selection",
      "concurrent_interface_constraints",
      "esim_profile_enable",
      "esim_profile_install",
      "esim_profile_remove",
      "radio_os_telemetry",
      "vpn_network_extension",
      "wifi_control",
      "wifi_observation",
    ]);
  });
});

describe("createDesiredActionPolicy (deterministic, privacy-aware)", () => {
  it("validates templates fail-closed at construction", () => {
    expect(() =>
      createDesiredActionPolicy([{ capability: "nope", parameters: {}, dedupeKey: "d-1" }]),
    ).toThrowError(/closed edge capability vocabulary/);
    expect(() =>
      createDesiredActionPolicy([
        { capability: "wifi_control", parameters: { nested: { deep: 1 } }, dedupeKey: "d-1" },
      ]),
    ).toThrowError(ValidationError);
    expect(() =>
      createDesiredActionPolicy([
        { capability: "wifi_control", parameters: {}, dedupeKey: "bad key!" },
      ]),
    ).toThrowError(ValidationError);
  });

  it("produces privacy-independent desired actions regardless of context", () => {
    const policy = createDesiredActionPolicy([
      {
        capability: "wifi_control",
        parameters: { networkSsid: "Guest" },
        dedupeKey: "join-guest-1",
      },
    ]);
    const result = policy.evaluate({}, T0);
    expect(result.produced).toHaveLength(1);
    expect(result.produced[0]?.capability).toBe("wifi_control");
    expect(result.produced[0]?.dedupeKey).toBe("join-guest-1");
    expect(result.deferred).toHaveLength(0);
    // Deterministic: same input, same output (RL-LOCK-012).
    expect(policy.evaluate({}, T0)).toEqual(result);
  });

  it("defers fine-location-dependent actions when no context snapshot exists", () => {
    const policy = createDesiredActionPolicy([
      {
        capability: "wifi_control",
        parameters: { networkSsid: "Home" },
        dedupeKey: "join-home-1",
        requiresFineLocation: true,
      },
    ]);
    const result = policy.evaluate({}, T0);
    expect(result.produced).toHaveLength(0);
    expect(result.deferred).toEqual([
      {
        capability: "wifi_control",
        dedupeKey: "join-home-1",
        reason: "context-snapshot-unavailable",
      },
    ]);
  });

  it("defers fine-location-dependent actions when consent is absent (privacy gate)", () => {
    const policy = createDesiredActionPolicy([
      {
        capability: "wifi_control",
        parameters: { networkSsid: "Home" },
        dedupeKey: "join-home-1",
        requiresFineLocation: true,
      },
    ]);
    const result = policy.evaluate({ contextSnapshot: contextSnapshot(false).toPlain() }, T0);
    expect(result.produced).toHaveLength(0);
    expect(result.deferred).toEqual([
      {
        capability: "wifi_control",
        dedupeKey: "join-home-1",
        reason: "fine-location-consent-absent",
      },
    ]);
  });

  it("produces fine-location-dependent actions when consent is recorded", () => {
    const policy = createDesiredActionPolicy([
      {
        capability: "wifi_control",
        parameters: { networkSsid: "Home" },
        dedupeKey: "join-home-1",
        requiresFineLocation: true,
      },
    ]);
    const result = policy.evaluate({ contextSnapshot: contextSnapshot(true).toPlain() }, T0);
    expect(result.deferred).toHaveLength(0);
    expect(result.produced).toHaveLength(1);
    expect(result.produced[0]?.parameters).toEqual({ networkSsid: "Home" });
  });

  it("mixes produced and deferred actions honestly", () => {
    const policy = createDesiredActionPolicy([
      {
        capability: "wifi_control",
        parameters: { networkSsid: "Guest" },
        dedupeKey: "join-guest-1",
      },
      {
        capability: "active_interface_selection",
        parameters: { preferred: "wifi" },
        dedupeKey: "prefer-wifi-1",
        requiresFineLocation: true,
      },
    ]);
    const result = policy.evaluate({ contextSnapshot: contextSnapshot(false).toPlain() }, T0);
    expect(result.produced.map((action) => action.dedupeKey)).toEqual(["join-guest-1"]);
    expect(result.deferred.map((deferred) => deferred.reason)).toEqual([
      "fine-location-consent-absent",
    ]);
  });
});
