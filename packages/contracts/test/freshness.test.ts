import { describe, expect, it } from "vitest";
import {
  FRESHNESS_STATES,
  evaluateFreshnessState,
  isFreshnessState,
  makeFreshness,
  parseFreshness,
  refreshFreshnessState,
} from "../src/freshness/freshness.js";
import { parseUtcInstant } from "../src/time/utc-instant.js";
import { ValidationError } from "../src/errors/errors.js";

const OBSERVED = parseUtcInstant("2026-09-15T10:00:00.000Z");
const RECEIVED = parseUtcInstant("2026-09-15T10:00:05.000Z");
const FRESH_UNTIL = parseUtcInstant("2026-09-15T10:05:00.000Z");
const BEFORE = parseUtcInstant("2026-09-15T10:04:59.999Z");
const AT_BOUNDARY = parseUtcInstant("2026-09-15T10:05:00.000Z");
const AFTER = parseUtcInstant("2026-09-15T10:05:00.001Z");

describe("freshness evaluation (RL-LOCK-010)", () => {
  it("exposes exactly FRESH | STALE | UNKNOWN", () => {
    expect([...FRESHNESS_STATES]).toEqual(["FRESH", "STALE", "UNKNOWN"]);
    expect(isFreshnessState("FRESH")).toBe(true);
    expect(isFreshnessState("EXPIRED")).toBe(false);
  });

  it("returns FRESH within the guarantee (boundary inclusive)", () => {
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, BEFORE)).toBe("FRESH");
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, AT_BOUNDARY)).toBe("FRESH");
  });

  it("returns STALE once past the guarantee", () => {
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, AFTER)).toBe("STALE");
  });

  it("returns UNKNOWN when evidence is missing - absence of evidence is not failure", () => {
    expect(evaluateFreshnessState({ observedAt: null, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, BEFORE)).toBe("UNKNOWN");
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: null, freshUntil: FRESH_UNTIL }, BEFORE)).toBe("UNKNOWN");
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: null }, BEFORE)).toBe("UNKNOWN");
    expect(evaluateFreshnessState({}, BEFORE)).toBe("UNKNOWN");
  });

  it("never claims FRESH without a freshness guarantee", () => {
    expect(evaluateFreshnessState({ observedAt: OBSERVED, receivedAt: RECEIVED }, BEFORE)).toBe("UNKNOWN");
  });
});

describe("freshness records", () => {
  it("makeFreshness builds a frozen record evaluated at the given instant", () => {
    const fresh = makeFreshness({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, BEFORE);
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(fresh).toEqual({
      observedAt: OBSERVED,
      receivedAt: RECEIVED,
      freshUntil: FRESH_UNTIL,
      freshnessState: "FRESH",
    });
    const stale = makeFreshness({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, AFTER);
    expect(stale.freshnessState).toBe("STALE");
  });

  it("state transitions over time: FRESH -> STALE at the boundary (forward time is monotone)", () => {
    const record = makeFreshness({ observedAt: OBSERVED, receivedAt: RECEIVED, freshUntil: FRESH_UNTIL }, BEFORE);
    expect(record.freshnessState).toBe("FRESH");
    // still fresh at the boundary
    expect(refreshFreshnessState(record, AT_BOUNDARY).freshnessState).toBe("FRESH");
    // one ms past the boundary: stale
    const stale = refreshFreshnessState(record, AFTER);
    expect(stale.freshnessState).toBe("STALE");
    // as time keeps moving forward it never becomes fresh again
    const later = parseUtcInstant("2026-09-16T00:00:00.000Z");
    expect(refreshFreshnessState(stale, later).freshnessState).toBe("STALE");
    // timestamps are preserved by refresh
    expect(stale.observedAt).toBe(OBSERVED);
    expect(stale.receivedAt).toBe(RECEIVED);
    expect(stale.freshUntil).toBe(FRESH_UNTIL);
  });

  it("UNKNOWN persists until a new observation establishes a guarantee", () => {
    const unknown = makeFreshness({ observedAt: null, receivedAt: RECEIVED, freshUntil: null }, BEFORE);
    expect(unknown.freshnessState).toBe("UNKNOWN");
    expect(refreshFreshnessState(unknown, AFTER).freshnessState).toBe("UNKNOWN");
    // recovery requires a new observation via makeFreshness
    const recovered = makeFreshness({ observedAt: AFTER, receivedAt: AFTER, freshUntil: parseUtcInstant("2026-09-15T11:00:00.000Z") }, AFTER);
    expect(recovered.freshnessState).toBe("FRESH");
  });

  it("parseFreshness validates shape strictly", () => {
    const valid = parseFreshness({
      observedAt: "2026-09-15T10:00:00.000Z",
      receivedAt: "2026-09-15T10:00:05.000Z",
      freshUntil: null,
      freshnessState: "UNKNOWN",
    });
    expect(valid.freshUntil).toBeNull();
    expect(Object.isFrozen(valid)).toBe(true);

    expect(() => parseFreshness(null)).toThrowError(ValidationError);
    expect(() => parseFreshness({})).toThrowError(/freshnessState/);
    expect(() =>
      parseFreshness({ observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "EXPIRED" }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseFreshness({ observedAt: "2026-09-15T10:00:00", receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" }),
    ).toThrowError(ValidationError); // naive timestamp
    expect(() =>
      parseFreshness({ observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "FRESH", extra: 1 }),
    ).toThrowError(/extra/);
  });
});
