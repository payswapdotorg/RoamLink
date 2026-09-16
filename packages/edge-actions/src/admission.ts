/**
 * Capability-gated action admission (RL-043, RL-LOCK-011, spec/mobile.md
 * "Edge desired-state loop" + "Platform constraints").
 *
 * `admitDeviceAction` is the PURE single entry criterion for every device
 * action the edge may take or queue: the RL-040 `assertCapability` gate is
 * evaluated against the CURRENT capability snapshot as of an explicit instant.
 * Nothing is admitted, executed or queued without a passing gate:
 *
 * | gate outcome | admission                                        |
 * |--------------|--------------------------------------------------|
 * | allow        | ADMITTED (execution/queueing may proceed)       |
 * | deny         | BLOCKED-UNSUPPORTED (typed, diagnosable)         |
 * | degrade      | BLOCKED-DEGRADED (typed, diagnosable)            |
 *
 * The mapping from gate decisions to honest RL-040 results reuses
 * `deviceActionResultFromGate` verbatim - a denied gate can only produce
 * `unsupported`, a degraded gate only `degraded`; NEITHER is ever a fabricated
 * success (RL-LOCK-011 evidence discipline). Unsupported capability/platform
 * combinations degrade to these typed states - never best-effort guesses.
 *
 * The admission ALSO rejects actions whose capability is outside the
 * DeviceCapabilitySnapshot closed vocabulary: such a request is a contract
 * violation, not a capability question (fail-closed).
 */
import { DomainError, type UtcInstant } from "@roamlink/contracts";
import { DEVICE_CAPABILITY_NAMES } from "@roamlink/domain-experience";
import {
  type DeviceActionResult,
  assertCapability,
  deviceActionResultFromGate,
  type CapabilityGateDecision,
  type DeviceActionRequest,
  type DeviceActionResultReason,
  type EdgeCapabilitySnapshot,
  type EdgeCapabilitySnapshotPlain,
} from "@roamlink/edge";

/** The admission outcome: exactly one admitted shape, two blocked shapes. */
export type DeviceActionAdmission =
  | {
      readonly admission: "ADMITTED";
      readonly gate: CapabilityGateDecision & { readonly decision: "allow" };
    }
  | {
      readonly admission: "BLOCKED-UNSUPPORTED";
      readonly gate: CapabilityGateDecision & { readonly decision: "deny" };
      readonly result: DeviceActionResult;
    }
  | {
      readonly admission: "BLOCKED-DEGRADED";
      readonly gate: CapabilityGateDecision & { readonly decision: "degrade" };
      readonly result: DeviceActionResult;
    };

/**
 * Evaluates the capability gate for `request` against `snapshot` as of `at`
 * (explicit instant for determinism). Pure: same inputs, same decision; never
 * throws for capability reasons - only for contract violations outside the
 * closed vocabularies (which fail closed).
 */
export function admitDeviceAction(
  snapshot: EdgeCapabilitySnapshot | EdgeCapabilitySnapshotPlain,
  request: DeviceActionRequest,
  at: UtcInstant,
): DeviceActionAdmission {
  const capability = request.capabilityRequirement.capability;
  if (!(DEVICE_CAPABILITY_NAMES as readonly string[]).includes(capability)) {
    // Outside the DeviceCapabilitySnapshot closed vocabulary: a contract
    // violation. Fail closed - the registry vocabulary is the authority for
    // which capability questions exist at all (RL-LOCK-011/017).
    throw new DomainError(
      "the requested capability is outside the DeviceCapabilitySnapshot closed vocabulary; device actions fail closed on unknown capability names",
      {
        reason: "DEVICE_ACTION_CAPABILITY_OUTSIDE_VOCABULARY",
        details: [
          { path: "capabilityRequirement.capability", issue: "outside the closed vocabulary" },
        ],
      },
    );
  }

  const gate = assertCapability(snapshot, request.capabilityRequirement, at);
  switch (gate.decision) {
    case "allow":
      return { admission: "ADMITTED", gate };
    case "deny":
    case "degrade": {
      // deviceActionResultFromGate: deny -> unsupported, degrade -> degraded,
      // each carrying the gate's closed-vocabulary reason + the decision
      // itself for traceability. An allow throws there; unreachable here.
      const result = deviceActionResultFromGate(request.actionId, gate, at);
      return gate.decision === "deny"
        ? { admission: "BLOCKED-UNSUPPORTED", gate, result }
        : { admission: "BLOCKED-DEGRADED", gate, result };
    }
  }
}

/**
 * The honest result-reason for a blocked admission (used when projecting
 * blocked actions without executing them).
 */
export function blockedAdmissionReason(admission: DeviceActionAdmission): DeviceActionResultReason {
  if (admission.admission === "ADMITTED") {
    throw new DomainError("an admitted action has no block reason", {
      reason: "ADMISSION_NOT_BLOCKED",
    });
  }
  const reason = admission.result.reason;
  if (reason === undefined) {
    throw new DomainError(
      "a blocked admission result must carry its closed-vocabulary reason (RL-040 invariant)",
      { reason: "ADMISSION_RESULT_REASON_MISSING" },
    );
  }
  return reason;
}
