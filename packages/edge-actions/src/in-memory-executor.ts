/**
 * Deterministic in-memory {@link PlatformActionExecutor} fake (RL-043).
 *
 * Test/dev-only reference implementation of the seam: no platform code, no
 * network, no real radios. Behavior is configured per capability name as a
 * list of scripted outcomes; when the script is exhausted the last entry
 * repeats. A `succeeded` script entry MUST carry real evidence or construction
 * rejects it (fail-closed, RL-LOCK-011). The fake is dedupe-aware: replaying a
 * request with an already-executed `dedupeKey` returns the FIRST outcome again
 * instead of re-applying the physical action (RL-LOCK-014 - a physical device
 * action must not double-apply under redelivery).
 */
import { ValidationError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import type {
  DeviceActionRequest,
  EdgeCapabilityName,
  EdgePlatformEvidence,
} from "@roamlink/edge";

import {
  PLATFORM_EXECUTOR_REASONS,
  parsePlatformExecutionOutcome,
  type PlatformExecutionOutcome,
  type PlatformExecutorReason,
} from "./platform-executor.js";

/** A scripted outcome for the fake: either evidenced success or typed failure. */
export interface FakeExecutorScriptEntry {
  readonly outcome: string;
  readonly evidence?: { readonly kind: string; readonly source?: string; readonly detail?: string };
  readonly reason?: string;
  readonly detail?: string;
}

/** Configuration for one capability inside the fake. */
export interface FakeExecutorCapabilityConfig {
  readonly capability: EdgeCapabilityName;
  readonly script: readonly FakeExecutorScriptEntry[];
}

/** Options for {@link InMemoryPlatformActionExecutor}. */
export interface InMemoryPlatformActionExecutorOptions {
  readonly executorId?: string;
  readonly capabilities?: readonly FakeExecutorCapabilityConfig[];
  /**
   * When true, a replayed dedupe key that already SUCCEEDED returns the first
   * success again without re-applying the physical action (default true,
   * RL-LOCK-014). When false, the script keeps advancing (simulating a
   * non-idempotent buggy platform, for negative tests).
   */
  readonly dedupeReplays?: boolean;
}

function validEvidence(evidence: EdgePlatformEvidence | undefined): evidence is EdgePlatformEvidence {
  return evidence !== undefined && evidence.kind !== "none";
}

/**
 * The deterministic fake. Every scripted entry is validated through
 * {@link parsePlatformExecutionOutcome} at construction so a broken script
 * fails fast, not at execution time.
 */
export class InMemoryPlatformActionExecutor {
  readonly executorId: string;
  readonly #scripts = new Map<EdgeCapabilityName, readonly PlatformExecutionOutcome[]>();
  readonly #cursor = new Map<EdgeCapabilityName, number>();
  readonly #appliedDedupeKeys = new Map<string, PlatformExecutionOutcome>();
  readonly #dedupeReplays: boolean;
  readonly #requests: DeviceActionRequest[] = [];

  constructor(options: InMemoryPlatformActionExecutorOptions = {}) {
    this.executorId = options.executorId ?? "in-memory-platform-executor";
    this.#dedupeReplays = options.dedupeReplays ?? true;
    for (const config of options.capabilities ?? []) {
      if (config.script.length === 0) {
        throw new ValidationError(
          "a fake executor capability script must carry at least one entry (use an explicit unsupported entry for 'not implemented')",
          {
            reason: "FAKE_EXECUTOR_SCRIPT_INVALID",
            details: [{ path: "script", issue: "empty script" }],
          },
        );
      }
      const validated = config.script.map((entry) => parsePlatformExecutionOutcome(entry));
      this.#scripts.set(config.capability, Object.freeze(validated));
      this.#cursor.set(config.capability, 0);
    }
  }

  /** A succeeding scripted entry for common tests. */
  static evidencedSuccess(
    evidence: EdgePlatformEvidence = {
      kind: "platform-api-probe",
      source: "FakeExecutor.framework",
    },
  ): FakeExecutorScriptEntry {
    if (!validEvidence(evidence)) {
      throw new ValidationError("fake success evidence must be real (kind !== 'none')", {
        reason: "FAKE_EXECUTOR_SCRIPT_INVALID",
        details: [{ path: "evidence", issue: "kind 'none' cannot prove success" }],
      });
    }
    return { outcome: "succeeded", evidence };
  }

  /** A failing scripted entry for common tests. */
  static failure(reason: PlatformExecutorReason, detail?: string): FakeExecutorScriptEntry {
    if (!(PLATFORM_EXECUTOR_REASONS as readonly string[]).includes(reason)) {
      throw new ValidationError("fake failure reason must be in the closed vocabulary", {
        reason: "FAKE_EXECUTOR_SCRIPT_INVALID",
        details: [{ path: "reason", issue: "outside the closed vocabulary" }],
      });
    }
    return { outcome: "failed", reason, ...(detail === undefined ? {} : { detail }) };
  }

  /** All requests the fake has seen, in arrival order (diagnostics/tests). */
  requests(): readonly DeviceActionRequest[] {
    return Object.freeze([...this.#requests]);
  }

  /** The dedupe keys that were physically applied (tests RL-LOCK-014). */
  appliedDedupeKeys(): ReadonlyMap<string, PlatformExecutionOutcome> {
    return new Map(this.#appliedDedupeKeys);
  }

  async execute(
    request: DeviceActionRequest,
    at: string | UtcInstant,
  ): Promise<PlatformExecutionOutcome> {
    parseUtcInstant(at); // explicit instant discipline; never an ambient clock
    this.#requests.push(request);

    const capability = request.capabilityRequirement.capability;
    if (this.#dedupeReplays && this.#appliedDedupeKeys.has(request.dedupeKey)) {
      // Physical dedupe: the SAME physical action replays its first outcome.
      return this.#appliedDedupeKeys.get(request.dedupeKey) as PlatformExecutionOutcome;
    }

    const script = this.#scripts.get(capability);
    if (script === undefined) {
      // A capability with no adapter implementation is typed-unsupported,
      // never a best-effort guess (RL-LOCK-011).
      const outcome: PlatformExecutionOutcome = Object.freeze({
        outcome: "unsupported",
        reason: "action-unsupported",
        detail: `no platform executor implementation is registered for capability ${capability}`,
      });
      if (this.#dedupeReplays) this.#appliedDedupeKeys.set(request.dedupeKey, outcome);
      return outcome;
    }

    const index = this.#cursor.get(capability) ?? 0;
    const boundedIndex = Math.min(index, script.length - 1);
    this.#cursor.set(capability, boundedIndex + 1);
    const outcome = script[boundedIndex] as PlatformExecutionOutcome;
    if (this.#dedupeReplays && outcome.outcome === "succeeded") {
      this.#appliedDedupeKeys.set(request.dedupeKey, outcome);
    }
    return outcome;
  }
}
