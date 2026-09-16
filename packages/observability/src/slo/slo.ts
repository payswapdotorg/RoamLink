/**
 * Service-level objectives and error budgets (RL-052, spec/architecture.md
 * §11, building on the RL-040 health/metrics contracts).
 *
 *  - a {@link ServiceLevelObjective} is a TYPED, FROZEN object: safe-label
 *    name, target good-event ratio in (0, 1], evaluation window, and an
 *    at-risk burn-rate threshold in (0, 1];
 *  - {@link SloEventRecorder} records good/bad outcomes at explicit UTC
 *    instants and evaluates objectives PURELY from the events inside the
 *    window (deterministic under the testkit clock);
 *  - the error budget is expressed through the BURN RATE
 *    `(bad/total) / (1 - target)` - the fraction of the budget consumed by
 *    the observed traffic. 1.0 means exactly exhausted;
 *  - the closed {@link SloState} vocabulary is honest: `no-data` when the
 *    window contains no events (never silently healthy - fail-safe
 *    defaults), `exhausted` at >= 100% consumption, `at-risk` above the
 *    configured burn threshold, else `within-budget`;
 *  - multi-window burn rates support the classic fast/slow alert pairing.
 */
import {
  ValidationError,
  addMilliseconds,
  epochMsOf,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

/** SLO names follow the health-check naming convention (lowercase labels). */
export const SLO_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

/** Closed event-outcome vocabulary feeding the good/total ratio. */
export const SLO_EVENT_OUTCOMES = ["good", "bad"] as const;

export type SloEventOutcome = (typeof SLO_EVENT_OUTCOMES)[number];

/** Closed SLO evaluation states. */
export const SLO_STATES = ["within-budget", "at-risk", "exhausted", "no-data"] as const;

export type SloState = (typeof SLO_STATES)[number];

/** Float tolerance for burn-rate boundary comparisons (exact consumption). */
const BURN_RATE_EPSILON = 1e-9;

/** Options for {@link makeServiceLevelObjective}. */
export interface ServiceLevelObjectiveOptions {
  readonly name: string;
  /** Required fraction of GOOD events, in (0, 1] (e.g. 0.999 = 99.9%). */
  readonly targetRatio: number;
  /** Evaluation window in milliseconds (>= 1). */
  readonly windowMs: number;
  /** Burn rate at/beyond which the SLO is `at-risk`; (0, 1], default 0.5. */
  readonly atRiskBurnRate?: number;
  /** Optional bounded human-readable description. */
  readonly help?: string;
}

/** A validated, frozen service-level objective. */
export interface ServiceLevelObjective {
  readonly name: string;
  readonly targetRatio: number;
  readonly windowMs: number;
  readonly atRiskBurnRate: number;
  readonly help?: string;
}

export function makeServiceLevelObjective(
  options: ServiceLevelObjectiveOptions,
): ServiceLevelObjective {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("ServiceLevelObjective must be an object", {
      reason: "SLO_INVALID",
      details: [{ path: "ServiceLevelObjective", issue: "not an object" }],
    });
  }
  if (typeof options.name !== "string" || !SLO_NAME_PATTERN.test(options.name)) {
    throw new ValidationError(
      "SLO names must be lowercase labels (e.g. 'connectivity.usable-time', 'edge.sync')",
      {
        reason: "SLO_INVALID",
        details: [{ path: "name", issue: "violates the naming convention" }],
      },
    );
  }
  if (
    typeof options.targetRatio !== "number" ||
    !Number.isFinite(options.targetRatio) ||
    options.targetRatio <= 0 ||
    options.targetRatio > 1
  ) {
    throw new ValidationError("targetRatio must be a finite number in (0, 1] (e.g. 0.999)", {
      reason: "SLO_INVALID",
      details: [{ path: "targetRatio", issue: "out of bounds" }],
    });
  }
  if (
    typeof options.windowMs !== "number" ||
    !Number.isInteger(options.windowMs) ||
    options.windowMs < 1 ||
    options.windowMs > 2_147_483_647
  ) {
    throw new ValidationError("windowMs must be an integer between 1 and 2147483647", {
      reason: "SLO_INVALID",
      details: [{ path: "windowMs", issue: "out of bounds" }],
    });
  }
  const atRiskBurnRate = options.atRiskBurnRate ?? 0.5;
  if (
    typeof atRiskBurnRate !== "number" ||
    !Number.isFinite(atRiskBurnRate) ||
    atRiskBurnRate <= 0 ||
    atRiskBurnRate > 1
  ) {
    throw new ValidationError("atRiskBurnRate must be a finite number in (0, 1]", {
      reason: "SLO_INVALID",
      details: [{ path: "atRiskBurnRate", issue: "out of bounds" }],
    });
  }
  if (options.help !== undefined) {
    if (typeof options.help !== "string" || options.help.length === 0 || options.help.length > 256) {
      throw new ValidationError("help must be a non-empty string of at most 256 chars", {
        reason: "SLO_INVALID",
        details: [{ path: "help", issue: "out of bounds" }],
      });
    }
    return Object.freeze({
      name: options.name,
      targetRatio: options.targetRatio,
      windowMs: options.windowMs,
      atRiskBurnRate,
      help: options.help,
    });
  }
  return Object.freeze({
    name: options.name,
    targetRatio: options.targetRatio,
    windowMs: options.windowMs,
    atRiskBurnRate,
  });
}

/** One recorded outcome. */
export interface SloRecordedEvent {
  readonly sloName: string;
  readonly outcome: SloEventOutcome;
  readonly at: UtcInstant;
}

/** The result of evaluating an objective over its window. */
export interface SloEvaluation {
  readonly sloName: string;
  readonly asOf: UtcInstant;
  /** Window start: events in (windowStart, asOf] count. */
  readonly windowStart: UtcInstant;
  readonly total: number;
  readonly good: number;
  readonly bad: number;
  /** good/total, or null when total === 0 (no-data). */
  readonly observedGoodRatio: number | null;
  /** 1 - targetRatio: the tolerated bad-event fraction. */
  readonly errorBudgetRatio: number;
  /** (bad/total)/errorBudgetRatio - the fraction of budget consumed; null on no-data. */
  readonly burnRate: number | null;
  /** 1 - burnRate; negative when the budget is overspent; null on no-data. */
  readonly budgetRemainingRatio: number | null;
  readonly state: SloState;
}

function isSloEventOutcome(value: unknown): value is SloEventOutcome {
  return typeof value === "string" && (SLO_EVENT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * In-memory good/bad event recorder and SLO evaluator. Events are timestamped
 * with EXPLICIT UTC instants; evaluation is a pure function of the recorded
 * events and the evaluation instant. Not a vendor metrics store - wire the
 * events into the RL-040 metrics contract through
 * {@link ./slo-health.js.registerSloMetrics} when exporting.
 */
export class SloEventRecorder {
  readonly #events: SloRecordedEvent[] = [];

  /** Records one outcome for an SLO at an explicit instant. */
  record(sloName: string, outcome: SloEventOutcome, at: UtcInstant | string): void {
    if (typeof sloName !== "string" || !SLO_NAME_PATTERN.test(sloName)) {
      throw new ValidationError(
        "SLO event names must be lowercase labels matching the SLO naming convention",
        {
          reason: "SLO_EVENT_INVALID",
          details: [{ path: "sloName", issue: "violates the naming convention" }],
        },
      );
    }
    if (!isSloEventOutcome(outcome)) {
      throw new ValidationError("SLO event outcome must be 'good' or 'bad'", {
        reason: "SLO_EVENT_INVALID",
        details: [{ path: "outcome", issue: "outside the closed vocabulary" }],
      });
    }
    this.#events.push({ sloName, outcome, at: parseUtcInstant(at) });
  }

  /** Evaluates the objective over (asOf - windowMs, asOf]. */
  evaluate(slo: ServiceLevelObjective, asOf: UtcInstant | string): SloEvaluation {
    const instant = parseUtcInstant(asOf);
    const windowStart = addMilliseconds(instant, -slo.windowMs);
    const windowStartMs = epochMsOf(windowStart);
    let good = 0;
    let bad = 0;
    for (const event of this.#events) {
      if (event.sloName !== slo.name) continue;
      if (epochMsOf(event.at) <= windowStartMs) continue;
      if (event.outcome === "good") good += 1;
      else bad += 1;
    }
    const total = good + bad;
    const errorBudgetRatio = 1 - slo.targetRatio;
    if (total === 0) {
      return Object.freeze({
        sloName: slo.name,
        asOf: instant,
        windowStart,
        total: 0,
        good: 0,
        bad: 0,
        observedGoodRatio: null,
        errorBudgetRatio,
        burnRate: null,
        budgetRemainingRatio: null,
        state: "no-data",
      });
    }
    const burnRate = bad / total / errorBudgetRatio;
    let state: SloState;
    if (burnRate >= 1 - BURN_RATE_EPSILON) {
      state = "exhausted";
    } else if (burnRate >= slo.atRiskBurnRate - BURN_RATE_EPSILON) {
      state = "at-risk";
    } else {
      state = "within-budget";
    }
    return Object.freeze({
      sloName: slo.name,
      asOf: instant,
      windowStart,
      total,
      good,
      bad,
      observedGoodRatio: good / total,
      errorBudgetRatio,
      burnRate,
      budgetRemainingRatio: 1 - burnRate,
      state,
    });
  }

  /** Frozen snapshot of all recorded events (tests/telemetry). */
  events(): readonly SloRecordedEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** Removes all recorded events. */
  clear(): void {
    this.#events.length = 0;
  }
}

/** One window of a multi-window burn-rate evaluation. */
export interface SloWindowBurnRate {
  readonly label: string;
  readonly windowMs: number;
  readonly total: number;
  readonly bad: number;
  readonly burnRate: number | null;
}

/**
 * Evaluates the same objective over several windows (e.g. the classic
 * fast/slow alert pairing: 5m + 1h fast, 30m + 6h slow). Windows are labeled
 * explicitly; `burnRate` is null for windows with no events (no-data, never
 * a zero - honesty rule).
 */
export function multiWindowBurnRates(
  recorder: SloEventRecorder,
  slo: ServiceLevelObjective,
  windows: readonly { readonly label: string; readonly windowMs: number }[],
  asOf: UtcInstant | string,
): readonly SloWindowBurnRate[] {
  const instant = parseUtcInstant(asOf);
  const results: SloWindowBurnRate[] = [];
  for (const window of windows) {
    if (typeof window.label !== "string" || window.label.length === 0 || window.label.length > 32) {
      throw new ValidationError("window labels must be non-empty strings of at most 32 chars", {
        reason: "SLO_WINDOW_INVALID",
        details: [{ path: "label", issue: "out of bounds" }],
      });
    }
    if (
      typeof window.windowMs !== "number" ||
      !Number.isInteger(window.windowMs) ||
      window.windowMs < 1
    ) {
      throw new ValidationError("windowMs must be a positive integer", {
        reason: "SLO_WINDOW_INVALID",
        details: [{ path: "windowMs", issue: "not a positive integer" }],
      });
    }
    const evaluation = recorder.evaluate(
      makeServiceLevelObjective({
        name: slo.name,
        targetRatio: slo.targetRatio,
        windowMs: window.windowMs,
        atRiskBurnRate: slo.atRiskBurnRate,
      }),
      instant,
    );
    results.push(
      Object.freeze({
        label: window.label,
        windowMs: window.windowMs,
        total: evaluation.total,
        bad: evaluation.bad,
        burnRate: evaluation.burnRate,
      }),
    );
  }
  return Object.freeze(results);
}
