import { describe, expect, it } from "vitest";
import { DomainError } from "@roamlink/contracts";
import { AdcosApiError } from "@roamlink/adcos";
import { AdcosCompatibilityState, runAdcosCompatibilityCheck } from "../src/index.js";
import { FakeAdcos } from "./fake-adcos.js";

const T0 = "2026-01-15T08:30:00.000Z";

describe("the compatibility gate (RL-031, spec/adcos-integration.md §9)", () => {
  it("a healthy fake yields a compatible, diagnosable report", async () => {
    const fake = new FakeAdcos();
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}), at: T0 });
    expect(report.status).toBe("compatible");
    expect(report.at).toBe(T0);
    const names = report.checks.map((check) => check.name);
    expect(names).toContain("application_self.available");
    expect(names).toContain("intent_get.available");
    expect(names).toContain("intent_lifecycle_get.available");
    expect(names).toContain("contract_get.available");
    expect(names).toContain("contract_usage_get.available");
    expect(names).toContain("lease_get.available");
    expect(names).toContain("contract_lifecycle_states.required");
    expect(names).toContain("request_schemas.closed");
    expect(names).toContain("webhook_envelope.closed");
    expect(names).toContain("webhook_signature_semantics.pinned");
    expect(names).toContain("idempotency_behavior.replay");
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(state.status()).toBe("compatible");
  });

  it("a version-mismatched ADCOS fails the gate and mutations fail CLOSED", async () => {
    const fake = new FakeAdcos({ apiVersion: "3.0" as never });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("incompatible");
    const versionCheck = report.checks.find((c) => c.name === "application_self.available");
    expect(versionCheck?.passed).toBe(false);
    expect(versionCheck?.code).toBe("ADCOS_VERSION_UNSUPPORTED");
    expect(state.status()).toBe("incompatible");

    expect(() => state.assertMutationsAllowed()).toThrow(DomainError);
    try {
      state.assertMutationsAllowed();
    } catch (error) {
      expect((error as DomainError).reason).toBe("ADCOS_COMPATIBILITY_GATE_CLOSED");
      // diagnosable: names the failed checks, never secret values
      expect((error as DomainError).message).toContain("application_self.available");
    }
  });

  it("a missing endpoint (route disabled) fails the gate", async () => {
    const fake = new FakeAdcos();
    fake.disableRoute("application_self");
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("incompatible");
    const endpointCheck = report.checks.find((c) => c.name === "application_self.available");
    expect(endpointCheck?.passed).toBe(false);
    expect(endpointCheck?.code).toBe("route-unknown");
  });

  it("probe resource reads that fail make the corresponding checks fail", async () => {
    const fake = new FakeAdcos();
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, {
      probe: { intentId: "intent-does-not-exist" },
      at: T0,
    });
    expect(report.status).toBe("incompatible");
    const intentCheck = report.checks.find((c) => c.name === "intent_get.available");
    expect(intentCheck?.passed).toBe(false);
    expect(intentCheck?.code).toBe("resource-unknown");
  });

  it("absent probe ids skip route-availability checks rather than passing them", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("compatible");
    expect(report.checks.find((c) => c.name === "intent_get.available")).toBeUndefined();
  });

  it("the DEFAULT state is unknown and fails closed for mutations", () => {
    const state = new AdcosCompatibilityState();
    expect(state.status()).toBe("unknown");
    expect(() => state.assertMutationsAllowed()).toThrow(DomainError);
    try {
      state.assertMutationsAllowed();
    } catch (error) {
      expect((error as DomainError).reason).toBe("ADCOS_COMPATIBILITY_GATE_UNVERIFIED");
    }
  });

  it("the idempotency probe proves same-key replay returns identical responses", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("compatible");
    // the probe created exactly ONE intent through two identical calls
    expect(fake.intentCount()).toBe(1);
  });

  it("transient failures during the gate surface as failed checks, not crashes", async () => {
    const fake = new FakeAdcos();
    fake.failNext({ kind: "adcos-error", code: "rate-limited" });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("incompatible");
    const failed = report.checks.find((c) => !c.passed);
    expect(failed?.code).toBe("rate-limited");
  });

  it("the report is diagnosable and value-free (RL-LOCK-016)", async () => {
    const fake = new FakeAdcos({ apiVersion: "3.0" as never });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    const serialized = JSON.stringify(report);
    // the mismatched version value itself must not be echoed as a secret-free
    // report field (the message may name the pinned line only)
    expect(serialized).not.toContain("server-side-secret");
    expect(report.checks.every((c) => typeof c.name === "string" && c.name.length > 0)).toBe(true);
  });

  it("reads still flow through an incompatible client (diagnosability)", async () => {
    const fake = new FakeAdcos();
    fake.disableRoute("intent_get");
    const state = new AdcosCompatibilityState();
    await runAdcosCompatibilityCheck(fake, state, {
      ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
      at: T0,
    });
    // reads do not consult the gate:
    const document = await fake.getApplication();
    expect((document as Record<string, unknown>)["environment"]).toBe("sandbox");
    expect(() => state.assertMutationsAllowed()).toThrow(DomainError);
  });
});

describe("AdcosApiError contract sanity at the boundary (RL-LOCK-017)", () => {
  it("AdcosApiError construction rejects codes outside the closed taxonomy", () => {
    expect(() => new AdcosApiError("made-up" as never, "nope")).toThrow(TypeError);
  });
});
