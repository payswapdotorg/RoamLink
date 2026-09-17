/**
 * §11 intent-satisfaction mapping tests (additive RL-052 wiring): the pure
 * derived-status → satisfaction-outcome mapping behind the "intent
 * satisfaction rate" SLO measurement point.
 */
import { describe, expect, it } from "vitest";

import { DERIVED_EXPERIENCE_STATUSES } from "../src/decision/derived-status.js";
import { intentSatisfactionOf } from "../src/decision/intent-satisfaction.js";

describe("intentSatisfactionOf — the closed derived-status mapping", () => {
  it("supported decisions are satisfied; degraded and unresolved are not", () => {
    expect(intentSatisfactionOf({ derivedStatus: "experience_supported" })).toEqual({
      satisfied: true,
    });
    expect(intentSatisfactionOf({ derivedStatus: "experience_degraded" })).toEqual({
      satisfied: false,
    });
    expect(intentSatisfactionOf({ derivedStatus: "experience_unresolved" })).toEqual({
      satisfied: false,
    });
  });

  it("pending and closed decisions are NOT measurable (null — no fabricated denominator)", () => {
    expect(intentSatisfactionOf({ derivedStatus: "experience_pending" })).toBeNull();
    expect(intentSatisfactionOf({ derivedStatus: "experience_closed" })).toBeNull();
  });

  it("covers exactly the closed derived-status vocabulary", () => {
    const measurable = DERIVED_EXPERIENCE_STATUSES.filter(
      (status) => intentSatisfactionOf({ derivedStatus: status }) !== null,
    );
    expect(measurable).toEqual([
      "experience_supported",
      "experience_degraded",
      "experience_unresolved",
    ]);
  });

  it("fails closed on non-decision inputs", () => {
    expect(() => intentSatisfactionOf(null as never)).toThrow(/derivedStatus/);
    expect(() => intentSatisfactionOf({ derivedStatus: "great" as never })).toThrow(
      /closed vocabulary/,
    );
  });
});
