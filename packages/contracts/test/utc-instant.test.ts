import { describe, expect, expectTypeOf, it } from "vitest";
import {
  addMilliseconds,
  compareUtcInstants,
  epochMsOf,
  isUtcInstant,
  nowUtc,
  parseUtcInstant,
  utcInstantFromEpochMs,
  type UtcInstant,
} from "../src/time/utc-instant.js";
import { ValidationError } from "../src/errors/errors.js";

describe("UtcInstant parsing", () => {
  it("accepts canonical Z form and keeps it canonical", () => {
    const instant = parseUtcInstant("2026-09-15T12:34:56.789Z");
    expectTypeOf(instant).toEqualTypeOf<UtcInstant>();
    expect(instant).toBe("2026-09-15T12:34:56.789Z");
  });

  it("normalizes milliseconds: absent -> .000, shorter fractions padded", () => {
    expect(parseUtcInstant("2026-09-15T12:34:56Z")).toBe("2026-09-15T12:34:56.000Z");
    expect(parseUtcInstant("2026-09-15T12:34:56.5Z")).toBe("2026-09-15T12:34:56.500Z");
    expect(parseUtcInstant("2026-09-15T12:34:56.25Z")).toBe("2026-09-15T12:34:56.250Z");
  });

  it("accepts explicit offsets and converts them to the same UTC instant", () => {
    expect(parseUtcInstant("2026-09-15T14:00:00+02:00")).toBe("2026-09-15T12:00:00.000Z");
    expect(parseUtcInstant("2026-09-15T07:00:00-05:00")).toBe("2026-09-15T12:00:00.000Z");
    expect(parseUtcInstant("2026-09-15T12:00:00+00:00")).toBe("2026-09-15T12:00:00.000Z");
    // same instant expressed three ways -> identical canonical value
    const viaZ = parseUtcInstant("2026-09-15T12:00:00Z");
    const viaOffset = parseUtcInstant("2026-09-15T14:00:00+02:00");
    expect(viaOffset).toBe(viaZ);
  });

  it("REJECTS naive/local time (no zone designator)", () => {
    expect(() => parseUtcInstant("2026-09-15T12:00:00")).toThrowError(ValidationError);
    expect(() => parseUtcInstant("2026-09-15 12:00:00")).toThrowError(ValidationError); // space separator
    expect(() => parseUtcInstant("2026-09-15")).toThrowError(ValidationError); // date only
    expect(() => parseUtcInstant("12:00:00")).toThrowError(ValidationError);
  });

  it("rejects non-canonical and impossible timestamp forms", () => {
    const rejected = [
      "2026-09-15t12:00:00Z", // lowercase t
      "2026-09-15T12:00:00z", // lowercase z
      "20260915T120000Z", // basic format
      "2026-09-15T12:00:00.1234Z", // sub-ms precision unsupported
      "2026-13-01T00:00:00Z", // month 13
      "2026-02-30T00:00:00Z", // Feb 30 rolls over
      "2026-02-29T00:00:00Z", // 2026 is not a leap year
      "2026-09-15T24:00:00Z", // hour 24 (end-of-day is not RFC 3339)
      "2026-09-15T12:60:00Z", // minute 60
      "2026-09-15T12:00:60Z", // leap second
      "2026-09-15T12:00:00+24:00", // offset out of range
      "2026-09-15T12:00:00+02:70", // offset minutes out of range
      "26-09-15T12:00:00Z", // 2-digit year
      "",
      12345,
      null,
      {},
    ];
    for (const value of rejected) {
      expect(() => parseUtcInstant(value), `form: '${String(value)}'`).toThrowError(ValidationError);
      expect(isUtcInstant(value)).toBe(false);
    }
  });

  it("accepts leap-day dates that genuinely exist", () => {
    expect(parseUtcInstant("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
  });

  it("never includes the offending value in the error message", () => {
    const sentinel = "2026-09-15T12:00:00";
    let message = "";
    try {
      parseUtcInstant(sentinel);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(sentinel);
    expect(message).toContain("UtcInstant");
  });
});

describe("UtcInstant helpers", () => {
  it("round-trips epoch milliseconds", () => {
    expect(utcInstantFromEpochMs(0)).toBe("1970-01-01T00:00:00.000Z");
    const instant = parseUtcInstant("2026-09-15T12:00:00.250Z");
    expect(utcInstantFromEpochMs(epochMsOf(instant))).toBe(instant);
  });

  it("rejects invalid epoch millisecond input", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", Number.MAX_SAFE_INTEGER * 1000] as unknown[]) {
      expect(() => utcInstantFromEpochMs(bad as number)).toThrowError(ValidationError);
    }
  });

  it("compares and offsets instants deterministically", () => {
    const a = parseUtcInstant("2026-09-15T12:00:00Z");
    const b = parseUtcInstant("2026-09-15T13:00:00Z");
    expect(compareUtcInstants(a, b)).toBeLessThan(0);
    expect(compareUtcInstants(b, a)).toBeGreaterThan(0);
    expect(compareUtcInstants(a, parseUtcInstant("2026-09-15T14:00:00+02:00"))).toBe(0);
    expect(addMilliseconds(a, 3_600_000)).toBe("2026-09-15T13:00:00.000Z");
    expect(addMilliseconds(b, -3_600_000)).toBe("2026-09-15T12:00:00.000Z");
    expect(() => addMilliseconds(a, 0.5)).toThrowError(ValidationError);
  });

  it("nowUtc returns a canonical instant", () => {
    const now = nowUtc();
    expect(isUtcInstant(now)).toBe(true);
  });
});
