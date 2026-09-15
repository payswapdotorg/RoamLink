import { describe, expect, it } from "vitest";
import { isUtcInstant, parseUtcInstant } from "@roamlink/contracts";
import { DeterministicClock, SystemClock } from "../src/index.js";

describe("DeterministicClock", () => {
  it("returns the injected start instant and is stable between advances", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    expect(clock.now()).toBe("2026-01-15T08:30:00.000Z");
    expect(clock.now()).toBe("2026-01-15T08:30:00.000Z");
  });

  it("accepts a pre-parsed UtcInstant", () => {
    const clock = new DeterministicClock(parseUtcInstant("2026-02-01T00:00:00.000Z"));
    expect(clock.now()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("advanceTo jumps forward and is chainable", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    clock.advanceTo("2026-01-15T09:00:00.000Z").advanceTo("2026-01-16T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("advanceTo accepts the current instant as a no-op but refuses the past", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    expect(clock.advanceTo("2026-01-15T08:30:00.000Z").now()).toBe("2026-01-15T08:30:00.000Z");
    clock.advanceTo("2026-01-15T10:00:00.000Z");
    expect(() => clock.advanceTo("2026-01-15T09:59:59.999Z")).toThrowError(/monotonic/);
  });

  it("advanceBy adds whole milliseconds and allows a zero no-op", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    expect(clock.advanceBy(0).now()).toBe("2026-01-15T08:30:00.000Z");
    expect(clock.advanceBy(1_500).now()).toBe("2026-01-15T08:30:01.500Z");
  });

  it("rejects non-integer or negative advanceBy arguments", () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    expect(() => clock.advanceBy(-1)).toThrowError(/non-negative integer/);
    expect(() => clock.advanceBy(1.5)).toThrowError(/non-negative integer/);
    expect(() => clock.advanceBy(Number.NaN)).toThrowError(/non-negative integer/);
  });

  it("rejects an invalid start instant (fail-closed parsing)", () => {
    expect(() => new DeterministicClock("2026-01-15 08:30:00")).toThrowError();
  });
});

describe("SystemClock", () => {
  it("returns valid Wave-0 UTC instants", () => {
    const clock = new SystemClock();
    expect(isUtcInstant(clock.now())).toBe(true);
  });
});
