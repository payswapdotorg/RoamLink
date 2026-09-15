/**
 * ADCOS environments (RL-030).
 *
 * v2 exposes exactly two environments: `sandbox` and `production`. Mixing
 * them fails CLOSED with the ADCOS `environment-mismatch` error code: a
 * sandbox response never satisfies a production client and vice versa
 * (spec/security.md "Fail-safe defaults").
 */
import { ValidationError } from "@roamlink/contracts";
import type { AdcosErrorCode } from "./errors.js";

export const ADCOS_ENVIRONMENTS = ["sandbox", "production"] as const;

export type AdcosEnvironment = (typeof ADCOS_ENVIRONMENTS)[number];

export function isAdcosEnvironment(value: unknown): value is AdcosEnvironment {
  return typeof value === "string" && (ADCOS_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Parses an environment; anything outside the closed set is rejected. */
export function parseAdcosEnvironment(value: unknown): AdcosEnvironment {
  if (!isAdcosEnvironment(value)) {
    throw new ValidationError(
      "AdcosEnvironment must be one of: sandbox, production",
      {
        reason: "ADCOS_ENVIRONMENT_INVALID",
        details: [{ path: "AdcosEnvironment", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * Typed error for the fail-closed environment check: carries the ADCOS
 * `environment-mismatch` error code. Messages never echo the observed values
 * (RL-LOCK-016).
 */
export class AdcosEnvironmentMismatchError extends Error {
  readonly code: AdcosErrorCode = "environment-mismatch";

  constructor() {
    super(
      "ADCOS environment mismatch: the observed environment does not match the environment this client/verifier is scoped to; failing closed (values are never echoed)",
    );
    this.name = "AdcosEnvironmentMismatchError";
    Object.freeze(this);
  }
}

/**
 * Fail-closed environment check: throws {@link AdcosEnvironmentMismatchError}
 * when the observed environment does not equal the expected one.
 */
export function assertAdcosEnvironmentMatches(
  expected: AdcosEnvironment,
  observed: AdcosEnvironment,
): void {
  if (expected !== observed) {
    throw new AdcosEnvironmentMismatchError();
  }
}
