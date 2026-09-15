/**
 * Health/readiness contract (RL-040 platform scaffolding).
 *
 * Checks are REGISTERED against a {@link HealthRegistry} with validated
 * dependency names (lowercase dotted/dashed labels, e.g. `database`,
 * `adcos-api`, `outbox.worker`). States are the closed vocabulary
 * healthy | degraded | down. Aggregation rules:
 *
 *  - any `down` -> `down`;
 *  - else any `degraded` -> `degraded`;
 *  - else `healthy` (an empty registry is healthy: no declared dependency
 *    failed).
 *
 * A check that throws or returns garbage is `down` with a SUPPRESSED detail
 * (third-party error text may carry secrets - RL-LOCK-016); a check whose
 * result name does not match its registration is invalid and treated as
 * `down`.
 */
import { ConflictError, ValidationError, nowUtc, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";

export const HEALTH_STATES = ["healthy", "degraded", "down"] as const;

export type HealthState = (typeof HEALTH_STATES)[number];

export function isHealthState(value: unknown): value is HealthState {
  return typeof value === "string" && (HEALTH_STATES as readonly string[]).includes(value);
}

export function parseHealthState(value: unknown): HealthState {
  if (!isHealthState(value)) {
    throw new ValidationError(
      "value is not a member of the closed health-state vocabulary (healthy, degraded, down)",
      {
        reason: "HEALTH_STATE_INVALID",
        details: [{ path: "HealthState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Dependency naming convention: lowercase label, dots/dashes allowed. */
export const HEALTH_CHECK_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

const MAX_DETAIL_LENGTH = 256;

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A single check's validated result. */
export interface HealthCheckResult {
  /** The dependency name this result belongs to (must equal the check's registration name). */
  readonly name: string;
  readonly state: HealthState;
  /** Bounded, non-secret explanation. */
  readonly detail?: string;
  readonly checkedAt: UtcInstant;
}

/** Unvalidated output a check function may return. */
export type HealthCheckOutput = {
  readonly name: string;
  readonly state: string;
  readonly detail?: string;
  readonly checkedAt: string;
};

/** A registered health check: dependency name + run function. */
export interface HealthCheck {
  readonly name: string;
  readonly run: () => HealthCheckOutput | Promise<HealthCheckOutput>;
}

/** Registry of health checks (validated dependency names, unique). */
export class HealthRegistry {
  #checks = new Map<string, HealthCheck>();

  /** Registers a check; invalid or duplicate names are rejected. */
  register(check: HealthCheck): void {
    if (check === null || typeof check !== "object") {
      throw new ValidationError("HealthCheck must be an object with name and run", {
        reason: "HEALTH_CHECK_INVALID",
        details: [{ path: "HealthCheck", issue: "not an object" }],
      });
    }
    if (typeof check.name !== "string" || !HEALTH_CHECK_NAME_PATTERN.test(check.name)) {
      throw new ValidationError(
        "health check names must be lowercase dependency labels (e.g. 'database', 'adcos-api', 'outbox.worker')",
        {
          reason: "HEALTH_CHECK_INVALID",
          details: [{ path: "name", issue: "violates the dependency naming convention" }],
        },
      );
    }
    if (typeof check.run !== "function") {
      throw new ValidationError("health checks must provide a run function", {
        reason: "HEALTH_CHECK_INVALID",
        details: [{ path: "run", issue: "not a function" }],
      });
    }
    if (this.#checks.has(check.name)) {
      throw new ConflictError("a health check is already registered under this name", {
        reason: "HEALTH_CHECK_ALREADY_REGISTERED",
        details: [{ path: "name", issue: "duplicate registration" }],
      });
    }
    this.#checks.set(check.name, check);
  }

  has(name: string): boolean {
    return this.#checks.has(name);
  }

  checks(): readonly HealthCheck[] {
    return Object.freeze([...this.#checks.values()]);
  }

  get size(): number {
    return this.#checks.size;
  }
}

/** Pure aggregation: any down -> down; else any degraded -> degraded; else healthy. */
export function aggregateHealthStates(states: readonly HealthState[]): HealthState {
  if ((states as readonly string[]).includes("down")) return "down";
  if ((states as readonly string[]).includes("degraded")) return "degraded";
  return "healthy";
}

/** The overall health report. */
export interface HealthReport {
  readonly state: HealthState;
  readonly checks: readonly HealthCheckResult[];
  readonly evaluatedAt: UtcInstant;
}

/** Options for {@link runHealthChecks}. */
export interface RunHealthChecksOptions {
  /** Injectable clock for deterministic evaluation instants; defaults to now. */
  readonly now?: () => UtcInstant;
}

function makeResult(input: HealthCheckOutput): HealthCheckResult {
  const state = parseHealthState(input.state);
  const checkedAt = parseUtcInstant(input.checkedAt);
  if (typeof input.name !== "string" || !HEALTH_CHECK_NAME_PATTERN.test(input.name)) {
    throw new ValidationError("health check result names must be valid dependency labels", {
      reason: "HEALTH_RESULT_INVALID",
      details: [{ path: "name", issue: "violates the dependency naming convention" }],
    });
  }
  if (input.detail !== undefined) {
    if (
      typeof input.detail !== "string" ||
      input.detail.length === 0 ||
      input.detail.length > MAX_DETAIL_LENGTH ||
      hasControlCharacter(input.detail)
    ) {
      throw new ValidationError(
        `health check details must be printable, non-secret strings of 1-${MAX_DETAIL_LENGTH} chars`,
        {
          reason: "HEALTH_RESULT_INVALID",
          details: [{ path: "detail", issue: "out of bounds" }],
        },
      );
    }
  }
  return Object.freeze({
    name: input.name,
    state,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    checkedAt,
  });
}

function downResult(name: string, at: UtcInstant, detail: string): HealthCheckResult {
  return Object.freeze({ name, state: "down", detail, checkedAt: at });
}

/**
 * Runs all registered checks concurrently and aggregates their results.
 * Throwing checks and invalid results become `down` with suppressed detail;
 * result names must match the registration name.
 */
export async function runHealthChecks(
  registry: HealthRegistry,
  options?: RunHealthChecksOptions,
): Promise<HealthReport> {
  const now = options?.now ?? nowUtc;
  const results = await Promise.all(
    registry.checks().map(async (check): Promise<HealthCheckResult> => {
      try {
        const output = await check.run();
        try {
          const result = makeResult(output);
          if (result.name !== check.name) {
            return downResult(
              check.name,
              now(),
              "health check returned a result under a different name (treated as down)",
            );
          }
          return result;
        } catch {
          return downResult(check.name, now(), "health check returned an invalid result (treated as down)");
        }
      } catch {
        return downResult(check.name, now(), "health check threw an error (details suppressed)");
      }
    }),
  );
  return Object.freeze({
    state: aggregateHealthStates(results.map((result) => result.state)),
    checks: Object.freeze([...results]),
    evaluatedAt: now(),
  });
}
