import { describe, expect, it } from "vitest";
import {
  ERROR_KINDS,
  DomainError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  RETRYABLE_BY_KIND,
  StaleStateError,
  UnauthorizedError,
  UnavailableError,
  UnknownStateError,
  ValidationError,
  isRoamLinkError,
  normalizeUnknownError,
  type RoamLinkError,
} from "../src/errors/errors.js";

describe("error taxonomy", () => {
  it("exposes exactly the nine kinds", () => {
    expect([...ERROR_KINDS]).toEqual([
      "domain",
      "validation",
      "conflict",
      "not-found",
      "unauthorized",
      "rate-limited",
      "unavailable",
      "stale-state",
      "unknown-state",
    ]);
  });

  it("each kind constructs with a stable default reason and correct retryable flag", () => {
    const samples: readonly [string, RoamLinkError][] = [
      ["domain", new DomainError("d")],
      ["validation", new ValidationError("v")],
      ["conflict", new ConflictError("c")],
      ["not-found", new NotFoundError("n")],
      ["unauthorized", new UnauthorizedError("u")],
      ["rate-limited", new RateLimitedError("r")],
      ["unavailable", new UnavailableError("a")],
      ["stale-state", new StaleStateError("s")],
      ["unknown-state", new UnknownStateError("?")],
    ];
    for (const [kind, error] of samples) {
      expect(error.kind, kind).toBe(kind);
      expect(error.retryable, kind).toBe(RETRYABLE_BY_KIND[kind as keyof typeof RETRYABLE_BY_KIND]);
      expect(error.reason, kind).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
      expect(isRoamLinkError(error)).toBe(true);
    }
  });

  it("classifies retryability per the taxonomy table", () => {
    expect(RETRYABLE_BY_KIND).toEqual({
      domain: false,
      validation: false,
      conflict: false,
      "not-found": false,
      unauthorized: false,
      "rate-limited": true,
      unavailable: true,
      "stale-state": true,
      "unknown-state": true,
    });
    expect(new RateLimitedError("r").retryable).toBe(true);
    expect(new UnavailableError("u").retryable).toBe(true);
    expect(new StaleStateError("s").retryable).toBe(true);
    expect(new UnknownStateError("?").retryable).toBe(true);
    expect(new ValidationError("v").retryable).toBe(false);
    expect(new DomainError("d").retryable).toBe(false);
    expect(new ConflictError("c").retryable).toBe(false);
  });

  it("supports custom reason codes and retry overrides", () => {
    const error = new DomainError("tenant mismatch", {
      reason: "TENANT_BOUNDARY_VIOLATION",
      retryable: true,
      details: [{ path: "tenantId", issue: "does not own the resource" }],
    });
    expect(error.reason).toBe("TENANT_BOUNDARY_VIOLATION");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual([{ path: "tenantId", issue: "does not own the resource" }]);
  });

  it("rejects malformed reason codes", () => {
    expect(() => new DomainError("x", { reason: "lower_case" })).toThrowError(TypeError);
    expect(() => new DomainError("x", { reason: "HAS SPACE" })).toThrowError(TypeError);
    expect(() => new DomainError("x", { reason: "" })).toThrowError(TypeError);
  });

  it("validates retryAfterMs", () => {
    expect(new RateLimitedError("r", { retryAfterMs: 250 }).retryAfterMs).toBe(250);
    expect("retryAfterMs" in new DomainError("d")).toBe(false);
    expect(() => new RateLimitedError("r", { retryAfterMs: 0 })).toThrowError(TypeError);
    expect(() => new RateLimitedError("r", { retryAfterMs: 1.5 })).toThrowError(TypeError);
  });

  it("serializes to a log-safe JSON without the cause", () => {
    const cause = new Error("password=hunter2 connection string leaked");
    const error = new UnavailableError("adcos boundary unreachable", { cause });
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(json["kind"]).toBe("unavailable");
    expect(json["reason"]).toBe("UNAVAILABLE");
    expect(json["retryable"]).toBe(true);
    expect(json["message"]).toBe("adcos boundary unreachable");
    expect(JSON.stringify(error)).not.toContain("hunter2");
    expect(error.cause).toBe(cause); // retained for local debugging only
  });

  it("name includes the kind for greppable logs", () => {
    expect(new ValidationError("v").name).toBe("RoamLinkValidationError");
    expect(new RateLimitedError("r").name).toBe("RoamLinkRateLimitedError");
    expect(new UnknownStateError("?").name).toBe("RoamLinkUnknownStateError");
  });

  it("errors are frozen", () => {
    const error = new DomainError("d");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("normalizeUnknownError wraps foreign errors without propagating their messages", () => {
    const foreign = new Error("secret=hunter2 in third-party message");
    const normalized = normalizeUnknownError(foreign);
    expect(isRoamLinkError(normalized)).toBe(true);
    expect(normalized.kind).toBe("domain");
    expect(normalized.reason).toBe("UNKNOWN_ERROR");
    expect(normalized.message).not.toContain("hunter2");
    expect(normalized.message).toContain("Error");
    expect(normalized.cause).toBe(foreign);

    const fromString = normalizeUnknownError("boom");
    expect(fromString.message).toContain("string");
    const passthrough = normalizeUnknownError(new DomainError("already ours"));
    expect(passthrough).toBeInstanceOf(DomainError);
    expect(passthrough.message).toBe("already ours");
  });

  it("isRoamLinkError rejects non-taxonomy errors", () => {
    expect(isRoamLinkError(new Error("plain"))).toBe(false);
    expect(isRoamLinkError("string")).toBe(false);
    expect(isRoamLinkError(null)).toBe(false);
  });
});
