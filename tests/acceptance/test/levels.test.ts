import { describe, expect, it } from "vitest";
import { LEVELS, furthestLevel, levelAtLeast, levelRank, parseLevel, type Level } from "../src/levels.js";

describe("the six-level vocabulary (the honest-level law)", () => {
  it("is exactly the six mandated levels in their ladder order", () => {
    expect([...LEVELS]).toEqual([
      "route-reachable",
      "surface-rendered",
      "read-available",
      "mutation-accepted",
      "mutation-executed",
      "user-visible-evidence",
    ]);
  });

  it("ranks the ladder monotonically", () => {
    for (let index = 1; index < LEVELS.length; index += 1) {
      const lower = LEVELS[index - 1] as Level;
      const higher = LEVELS[index] as Level;
      expect(levelRank(higher)).toBeGreaterThan(levelRank(lower));
    }
  });

  it("furthestLevel keeps the further evidence", () => {
    expect(furthestLevel("route-reachable", "mutation-accepted")).toBe("mutation-accepted");
    expect(furthestLevel("user-visible-evidence", "surface-rendered")).toBe("user-visible-evidence");
    expect(furthestLevel("read-available", "read-available")).toBe("read-available");
  });

  it("levelAtLeast answers floor questions", () => {
    expect(levelAtLeast("mutation-accepted", "mutation-accepted")).toBe(true);
    expect(levelAtLeast("surface-rendered", "mutation-accepted")).toBe(false);
    expect(levelAtLeast("user-visible-evidence", "route-reachable")).toBe(true);
  });

  it("rejects unknown levels (a report may never invent a level)", () => {
    expect(() => parseLevel("mutation-delivered")).toThrow(/unknown level/);
    expect(() => parseLevel("")).toThrow(/unknown level/);
    expect(parseLevel("mutation-executed")).toBe("mutation-executed");
  });
});
