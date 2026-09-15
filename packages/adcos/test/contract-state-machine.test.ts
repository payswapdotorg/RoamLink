import { describe, expect, it } from "vitest";
import {
  ADCOS_CONTRACT_CANONICAL_PROGRESSION,
  ADCOS_CONTRACT_STATE_TRANSITIONS,
  ADCOS_CONTRACT_TERMINAL_STATES,
  canTransitionAdcosContractState,
} from "../src/index.js";

describe("contract state machine legal-transition table (RL-030)", () => {
  it("terminals have no outgoing edges", () => {
    expect(ADCOS_CONTRACT_TERMINAL_STATES).toEqual(["SETTLED", "TERMINATED", "EXPIRED", "FAILED"]);
    for (const terminal of ADCOS_CONTRACT_TERMINAL_STATES) {
      expect(ADCOS_CONTRACT_STATE_TRANSITIONS[terminal]).toEqual([]);
      for (const state of Object.keys(ADCOS_CONTRACT_STATE_TRANSITIONS) as (keyof typeof ADCOS_CONTRACT_STATE_TRANSITIONS)[]) {
        expect(canTransitionAdcosContractState(terminal, state)).toBe(false);
      }
    }
  });

  it("the canonical progression is fully legal step by step", () => {
    expect(ADCOS_CONTRACT_CANONICAL_PROGRESSION).toEqual([
      "INTENT",
      "OFFER_SELECTED",
      "CONTRACT_ACTIVE",
      "EXECUTION_ACTIVE",
      "DELIVERY",
      "ASSURED",
      "USAGE_FINAL",
      "SETTLEMENT_PENDING",
      "SETTLED",
    ]);
    for (let i = 0; i < ADCOS_CONTRACT_CANONICAL_PROGRESSION.length - 1; i += 1) {
      const from = ADCOS_CONTRACT_CANONICAL_PROGRESSION[i];
      const to = ADCOS_CONTRACT_CANONICAL_PROGRESSION[i + 1];
      if (from === undefined || to === undefined) {
        throw new Error("progression iteration invariant violated");
      }
      expect(canTransitionAdcosContractState(from, to)).toBe(true);
    }
  });

  it("table invariants: no self-loops, every target is a real state, symmetric lookup", () => {
    const states = Object.keys(ADCOS_CONTRACT_STATE_TRANSITIONS) as (keyof typeof ADCOS_CONTRACT_STATE_TRANSITIONS)[];
    expect(states).toHaveLength(13);
    for (const from of states) {
      const targets = ADCOS_CONTRACT_STATE_TRANSITIONS[from];
      expect(targets).not.toContain(from);
      for (const to of targets) {
        expect(states).toContain(to);
        expect(canTransitionAdcosContractState(from, to)).toBe(true);
      }
    }
  });

  it("side exits: EXPIRED from validity-governed states; FAILED from all live states; TERMINATED once a contract exists", () => {
    // EXPIRED: INTENT..ASSURED, never from USAGE_FINAL onward
    for (const from of ["INTENT", "OFFER_SELECTED", "CONTRACT_ACTIVE", "EXECUTION_ACTIVE", "DELIVERY", "ASSURED"] as const) {
      expect(canTransitionAdcosContractState(from, "EXPIRED")).toBe(true);
    }
    for (const from of ["USAGE_FINAL", "SETTLEMENT_PENDING", "DEGRADED"] as const) {
      const expected = from === "DEGRADED";
      expect(canTransitionAdcosContractState(from, "EXPIRED")).toBe(expected);
    }
    // FAILED: reachable from every non-terminal state
    for (const from of statesNonTerminal()) {
      expect(canTransitionAdcosContractState(from, "FAILED")).toBe(true);
    }
    // TERMINATED: once a contract exists (OFFER_SELECTED..USAGE_FINAL) plus DEGRADED; not from INTENT, not during settlement
    expect(canTransitionAdcosContractState("INTENT", "TERMINATED")).toBe(false);
    for (const from of ["OFFER_SELECTED", "CONTRACT_ACTIVE", "EXECUTION_ACTIVE", "DELIVERY", "ASSURED", "USAGE_FINAL", "DEGRADED"] as const) {
      expect(canTransitionAdcosContractState(from, "TERMINATED")).toBe(true);
    }
    expect(canTransitionAdcosContractState("SETTLEMENT_PENDING", "TERMINATED")).toBe(false);
  });

  it("DEGRADED is reachable from delivery-capable states and recovers into them", () => {
    for (const from of ["CONTRACT_ACTIVE", "EXECUTION_ACTIVE", "DELIVERY", "ASSURED"] as const) {
      expect(canTransitionAdcosContractState(from, "DEGRADED")).toBe(true);
    }
    expect(canTransitionAdcosContractState("INTENT", "DEGRADED")).toBe(false);
    expect(canTransitionAdcosContractState("OFFER_SELECTED", "DEGRADED")).toBe(false);
    for (const to of ["EXECUTION_ACTIVE", "DELIVERY", "ASSURED", "USAGE_FINAL"] as const) {
      expect(canTransitionAdcosContractState("DEGRADED", to)).toBe(true);
    }
  });

  it("illegal jumps are rejected", () => {
    expect(canTransitionAdcosContractState("INTENT", "SETTLED")).toBe(false);
    expect(canTransitionAdcosContractState("INTENT", "CONTRACT_ACTIVE")).toBe(false);
    expect(canTransitionAdcosContractState("OFFER_SELECTED", "DELIVERY")).toBe(false);
    expect(canTransitionAdcosContractState("SETTLEMENT_PENDING", "CONTRACT_ACTIVE")).toBe(false);
    expect(canTransitionAdcosContractState("SETTLED", "FAILED")).toBe(false);
    expect(canTransitionAdcosContractState("USAGE_FINAL", "EXECUTION_ACTIVE")).toBe(false);
  });
});

function statesNonTerminal(): ("INTENT" | "OFFER_SELECTED" | "CONTRACT_ACTIVE" | "EXECUTION_ACTIVE" | "DELIVERY" | "ASSURED" | "USAGE_FINAL" | "SETTLEMENT_PENDING" | "DEGRADED")[] {
  return [
    "INTENT",
    "OFFER_SELECTED",
    "CONTRACT_ACTIVE",
    "EXECUTION_ACTIVE",
    "DELIVERY",
    "ASSURED",
    "USAGE_FINAL",
    "SETTLEMENT_PENDING",
    "DEGRADED",
  ];
}
