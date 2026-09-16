/**
 * The mobile platform-probe port (RL-062, spec/mobile.md "Capability
 * discovery" + "Platform constraints"; RL-LOCK-011/013).
 *
 * The edge agent's ONLY source of platform facts: a host-bound probe that
 * reports WHAT THE OS AND DEVICE EXPOSE, sample by sample. The shell parses
 * each sample through the RL-041 observation contract (which assigns the
 * evidence class from the closed kind->class map - a probe can never claim a
 * class), folds them into capability/context snapshot chains, and the
 * RL-043 admission gate decides what the device may do.
 *
 * No platform-specific type leaks (spec/mobile.md "Platform constraints"):
 * the sample shape is platform-neutral JSON primitives; real iOS/Android/
 * desktop adapters implement this port behind the stable seam (RL-043's
 * discipline). The deterministic in-memory fake is the reference
 * implementation for tests/local dev.
 */
import type { UtcInstant } from "@roamlink/contracts";

/** One raw platform fact, as reported by the host probe. */
export interface PlatformProbeSample {
  /** When the platform reported the fact (explicit UTC instant). */
  readonly observedAt: string;
  /** The platform evidence backing the fact (closed vocabulary upstream). */
  readonly evidence: { readonly kind: string; readonly source?: string; readonly detail?: string };
  /**
   * The probed subject: a `capability-probe` (capability name + status the
   * platform reports) or a `context-observation` (context field + value).
   * Validated through the RL-041 observation parser in the shell.
   */
  readonly subject: Record<string, unknown>;
}

/** The host-bound probe port (the ONLY platform seam of the mobile shell). */
export interface MobilePlatformProbe {
  /** Bounded, printable probe label (diagnostics; never secrets). */
  readonly probeId: string;
  /**
   * Collects the current platform facts as of `at`. Offline-safe by design:
   * observation never requires connectivity (spec/mobile.md "Offline").
   */
  collect(at: UtcInstant | string): Promise<readonly PlatformProbeSample[]>;
}

/** Options for {@link InMemoryMobilePlatformProbe}. */
export interface InMemoryMobilePlatformProbeOptions {
  readonly probeId?: string;
  /**
   * The staged sample batches, returned in order per collect() call; when the
   * script is exhausted the last batch repeats. A capability-probe sample
   * with evidence kind "none" is a valid honest probe (records `unknown`).
   */
  readonly batches: readonly (readonly PlatformProbeSample[])[];
}

/**
 * The deterministic probe fake: no platform, no radios, no real permissions.
 * Batches play in order (the last repeats), so observation cycles are fully
 * reproducible under the testkit clock.
 */
export class InMemoryMobilePlatformProbe implements MobilePlatformProbe {
  readonly probeId: string;
  readonly #batches: readonly (readonly PlatformProbeSample[])[];
  #cursor = 0;

  constructor(options: InMemoryMobilePlatformProbeOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("InMemoryMobilePlatformProbe requires a batches script");
    }
    if (options.batches.length === 0) {
      throw new TypeError("the probe script needs at least one batch (use an empty batch for 'no facts')");
    }
    this.probeId = options.probeId ?? "in-memory-platform-probe";
    this.#batches = options.batches.map((batch) => Object.freeze([...batch]));
  }

  async collect(at: UtcInstant | string): Promise<readonly PlatformProbeSample[]> {
    void at; // explicit-instant discipline is the shell's concern
    const batch = this.#batches[Math.min(this.#cursor, this.#batches.length - 1)] ?? [];
    this.#cursor += 1;
    return Object.freeze([...batch]);
  }
}
