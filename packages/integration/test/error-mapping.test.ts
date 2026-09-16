import { describe, expect, it } from "vitest";
import { DomainError, RoamLinkError } from "@roamlink/contracts";
import { ADCOS_ERROR_CODES, ADCOS_ERROR_RETRYABLE, AdcosApiError, AdcosEnvironmentMismatchError } from "@roamlink/adcos";
import { ADCOS_FAILURE_ADAPTATION, AdcosTransportError, mapAdcosFailure, transportOutcomeKind } from "../src/index.js";

describe("the closed ADCOS failure adaptation (RL-031/032)", () => {
  it("covers EVERY code of the closed 18-code ADCOS taxonomy", () => {
    for (const code of ADCOS_ERROR_CODES) {
      expect(ADCOS_FAILURE_ADAPTATION[code], `missing adaptation for ${code}`).toBeDefined();
    }
    expect(Object.keys(ADCOS_FAILURE_ADAPTATION).length).toBe(ADCOS_ERROR_CODES.length);
  });

  it("preserves the pinned retryable flag of every ADCOS code", () => {
    for (const code of ADCOS_ERROR_CODES) {
      const mapped = mapAdcosFailure(new AdcosApiError(code, `probe ${code}`));
      expect(mapped.retryable, `retryable mismatch for ${code}`).toBe(ADCOS_ERROR_RETRYABLE[code]);
    }
  });

  it("maps every code onto a RoamLink error with a stable ADCOS_* reason", () => {
    for (const code of ADCOS_ERROR_CODES) {
      const mapped = mapAdcosFailure(new AdcosApiError(code, `probe ${code}`));
      expect(mapped).toBeInstanceOf(RoamLinkError);
      expect(mapped.reason).toBe(ADCOS_FAILURE_ADAPTATION[code].reason);
      expect(mapped.kind).toBe(ADCOS_FAILURE_ADAPTATION[code].kind);
    }
  });

  it("maps transport timeouts (outcome unknown) onto unknown-state, safe to re-issue", () => {
    const mapped = mapAdcosFailure(
      new AdcosTransportError("unknown", "request dispatched, no response arrived"),
    );
    expect(mapped.kind).toBe("unknown-state");
    expect(mapped.reason).toBe("ADCOS_TIMEOUT_OUTCOME_UNKNOWN");
    expect(mapped.retryable).toBe(true);
    expect(transportOutcomeKind("unknown")).toBe("unknown-state");
  });

  it("maps connection loss (not sent) onto unavailable", () => {
    const mapped = mapAdcosFailure(
      new AdcosTransportError("not-sent", "connection lost before the request was sent"),
    );
    expect(mapped.kind).toBe("unavailable");
    expect(mapped.reason).toBe("ADCOS_TRANSPORT_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
    expect(transportOutcomeKind("not-sent")).toBe("unavailable");
  });

  it("maps environment mismatches onto a deterministic domain failure", () => {
    const mapped = mapAdcosFailure(new AdcosEnvironmentMismatchError());
    expect(mapped.kind).toBe("domain");
    expect(mapped.reason).toBe("ADCOS_ENVIRONMENT_MISMATCH");
    expect(mapped.retryable).toBe(false);
  });

  it("passes RoamLink errors through unchanged", () => {
    const original = new DomainError("already adapted", { reason: "ADCOS_STORE_FAILED" });
    const passed = mapAdcosFailure(original);
    expect(passed).toBe(original);
  });

  it("normalizes unknown thrown values without propagating third-party messages", () => {
    const mapped = mapAdcosFailure(new Error("host=prod-db password=hunter2"));
    expect(mapped).toBeInstanceOf(RoamLinkError);
    expect(mapped.message).not.toContain("hunter2");
    expect(mapped.message).not.toContain("prod-db");
  });

  it("key mappings land on the expected RoamLink kinds", () => {
    expect(mapAdcosFailure(new AdcosApiError("rate-limited", "x")).kind).toBe("rate-limited");
    expect(mapAdcosFailure(new AdcosApiError("store-failed", "x")).kind).toBe("unavailable");
    expect(mapAdcosFailure(new AdcosApiError("resource-unknown", "x")).kind).toBe("not-found");
    expect(mapAdcosFailure(new AdcosApiError("idempotency-conflict", "x")).kind).toBe("conflict");
    expect(mapAdcosFailure(new AdcosApiError("invalid-input", "x")).kind).toBe("validation");
    expect(mapAdcosFailure(new AdcosApiError("authentication-invalid", "x")).kind).toBe("unauthorized");
    expect(mapAdcosFailure(new AdcosApiError("version-unsupported", "x")).kind).toBe("domain");
    expect(mapAdcosFailure(new AdcosApiError("journal-corrupt", "x")).kind).toBe("domain");
    expect(mapAdcosFailure(new AdcosApiError("route-unknown", "x")).kind).toBe("domain");
  });
});
