/**
 * The ADCOS v2 contract state machine and execution-status vocabulary
 * (RL-030, RL-LOCK-001: ADCOS is the connectivity authority - this package
 * MODELS the authoritative vocabulary, it never implements it).
 *
 * The contract state machine is the closed 13-state v2 enum. The legal-
 * transition table below is derived from the canonical lifecycle
 * (spec/adcos-integration.md §2) plus the v2 request surface:
 *
 *   INTENT -> OFFER_SELECTED -> CONTRACT_ACTIVE -> EXECUTION_ACTIVE
 *          -> DELIVERY -> ASSURED -> USAGE_FINAL -> SETTLEMENT_PENDING -> SETTLED
 *
 * Side exits:
 *  - EXPIRED: validity-window expiry, reachable while a validity window
 *    governs the resource (INTENT..ASSURED), never after usage finality;
 *  - FAILED: reachable from every non-terminal state (any live step can
 *    fail, including settlement);
 *  - TERMINATED: the customer-driven exit (POST contracts/{id}/termination),
 *    reachable once a contract exists (OFFER_SELECTED..USAGE_FINAL) and from
 *    DEGRADED - not during settlement finalization, whose failure mode is
 *    FAILED;
 *  - DEGRADED: reachable from the delivery-capable live states
 *    (CONTRACT_ACTIVE, EXECUTION_ACTIVE, DELIVERY, ASSURED), with recovery
 *    back into execution/delivery/assurance, or forward to usage finality,
 *    or exit via TERMINATED/EXPIRED/FAILED.
 *
 * This derivation is flagged for TL review in the RL-030 report; adjusting a
 * row is an additive contract change.
 *
 * Execution statuses are a CLOSED VOCABULARY (no transition table is claimed
 * beyond the states themselves - they describe execution progress of a
 * contract).
 */
import { ValidationError } from "@roamlink/contracts";

export const ADCOS_CONTRACT_STATES = [
  "INTENT",
  "OFFER_SELECTED",
  "CONTRACT_ACTIVE",
  "EXECUTION_ACTIVE",
  "DELIVERY",
  "ASSURED",
  "USAGE_FINAL",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "DEGRADED",
  "TERMINATED",
  "EXPIRED",
  "FAILED",
] as const;

export type AdcosContractState = (typeof ADCOS_CONTRACT_STATES)[number];

export function isAdcosContractState(value: unknown): value is AdcosContractState {
  return (
    typeof value === "string" && (ADCOS_CONTRACT_STATES as readonly string[]).includes(value)
  );
}

/** Parses a contract state; anything outside the closed set is rejected. */
export function parseAdcosContractState(value: unknown): AdcosContractState {
  if (!isAdcosContractState(value)) {
    throw new ValidationError(
      "AdcosContractState must be one of the 13 documented ADCOS v2 contract states",
      {
        reason: "ADCOS_CONTRACT_STATE_INVALID",
        details: [{ path: "AdcosContractState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Terminal contract states: no outgoing transitions. */
export const ADCOS_CONTRACT_TERMINAL_STATES: readonly AdcosContractState[] = Object.freeze([
  "SETTLED",
  "TERMINATED",
  "EXPIRED",
  "FAILED",
]);

/**
 * The legal-transition table of the v2 contract state machine (see the
 * module doc for the derivation and the TL-review flag).
 */
export const ADCOS_CONTRACT_STATE_TRANSITIONS: Readonly<
  Record<AdcosContractState, readonly AdcosContractState[]>
> = Object.freeze<Record<AdcosContractState, readonly AdcosContractState[]>>({
  INTENT: ["OFFER_SELECTED", "EXPIRED", "FAILED"],
  OFFER_SELECTED: ["CONTRACT_ACTIVE", "TERMINATED", "EXPIRED", "FAILED"],
  CONTRACT_ACTIVE: ["EXECUTION_ACTIVE", "DEGRADED", "TERMINATED", "EXPIRED", "FAILED"],
  EXECUTION_ACTIVE: ["DELIVERY", "DEGRADED", "TERMINATED", "EXPIRED", "FAILED"],
  DELIVERY: ["ASSURED", "DEGRADED", "TERMINATED", "EXPIRED", "FAILED"],
  ASSURED: ["USAGE_FINAL", "DEGRADED", "TERMINATED", "EXPIRED", "FAILED"],
  USAGE_FINAL: ["SETTLEMENT_PENDING", "TERMINATED", "FAILED"],
  SETTLEMENT_PENDING: ["SETTLED", "FAILED"],
  SETTLED: [],
  DEGRADED: ["EXECUTION_ACTIVE", "DELIVERY", "ASSURED", "USAGE_FINAL", "TERMINATED", "EXPIRED", "FAILED"],
  TERMINATED: [],
  EXPIRED: [],
  FAILED: [],
});

/** True when `from -> to` is a legal edge of the contract state machine. */
export function canTransitionAdcosContractState(
  from: AdcosContractState,
  to: AdcosContractState,
): boolean {
  const legal = ADCOS_CONTRACT_STATE_TRANSITIONS[from];
  return legal !== undefined && legal.includes(to);
}

/**
 * The canonical happy-path progression (spec/adcos-integration.md §2).
 */
export const ADCOS_CONTRACT_CANONICAL_PROGRESSION: readonly AdcosContractState[] = Object.freeze([
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

// --------------------------------------------------------------------------------
// Execution-status vocabulary
// --------------------------------------------------------------------------------

export const ADCOS_EXECUTION_STATUSES = [
  "not-started",
  "permitted",
  "executing",
  "delivering",
  "delivered-assured",
  "degraded",
  "usage-accounted",
  "closed",
] as const;

export type AdcosExecutionStatus = (typeof ADCOS_EXECUTION_STATUSES)[number];

export function isAdcosExecutionStatus(value: unknown): value is AdcosExecutionStatus {
  return (
    typeof value === "string" && (ADCOS_EXECUTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Parses an execution status; anything outside the closed set is rejected. */
export function parseAdcosExecutionStatus(value: unknown): AdcosExecutionStatus {
  if (!isAdcosExecutionStatus(value)) {
    throw new ValidationError(
      "AdcosExecutionStatus must be one of the 8 documented ADCOS v2 execution statuses",
      {
        reason: "ADCOS_EXECUTION_STATUS_INVALID",
        details: [{ path: "AdcosExecutionStatus", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}
