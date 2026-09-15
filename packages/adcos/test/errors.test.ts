import { describe, expect, it } from "vitest";
import { ADCOS_ERROR_CODES, ADCOS_ERROR_RETRYABLE, AdcosApiError } from "../src/index.js";

describe("ADCOS error taxonomy retryable mapping (RL-030)", () => {
  it("every one of the 18 codes has a retryable classification", () => {
    expect(Object.keys(ADCOS_ERROR_RETRYABLE).sort()).toEqual([...ADCOS_ERROR_CODES].sort());
  });

  it("exactly rate-limited and store-failed are retryable", () => {
    const retryable = ADCOS_ERROR_CODES.filter((code) => ADCOS_ERROR_RETRYABLE[code]);
    expect(retryable).toEqual(["rate-limited", "store-failed"]);
  });

  it("non-retryable codes cover the deterministic failures", () => {
    for (const code of [
      "invalid-input",
      "route-unknown",
      "authentication-invalid",
      "authentication-expired",
      "environment-mismatch",
      "capability-denied",
      "version-unsupported",
      "idempotency-key-required",
      "idempotency-conflict",
      "pagination-invalid",
      "filter-invalid",
      "resource-unknown",
      "webhook-signature-invalid",
      "webhook-timestamp-stale",
      "webhook-delivery-unknown",
      "journal-corrupt",
    ] as const) {
      expect(ADCOS_ERROR_RETRYABLE[code]).toBe(false);
    }
  });

  it("AdcosApiError carries the code and the pinned retryable flag", () => {
    const rateLimited = new AdcosApiError("rate-limited", "too many requests");
    expect(rateLimited.code).toBe("rate-limited");
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.name).toBe("AdcosApiError");

    const invalid = new AdcosApiError("invalid-input", "malformed field");
    expect(invalid.retryable).toBe(false);
    expect(() => new AdcosApiError("teapot" as "rate-limited", "x")).toThrow(TypeError);
  });
});
