/**
 * The edge observation engine (RL-041, spec/mobile.md "Edge desired-state
 * loop", RL-LOCK-011/015).
 *
 * Turns raw device/platform {@link EdgeObservation}s into evidence-tagged
 * capability- and context-snapshot chain updates. The engine is PURE with
 * respect to its inputs (explicit `at` instants, injectable snapshot-id
 * generator) and enforces the evidence discipline EXACTLY:
 *
 *  1. evidence classes are ASSIGNED from the closed kind->class map - a
 *     caller never claims a class; AUTHENTICATED is unreachable locally
 *     (and defended in depth at merge time);
 *  2. an observation may RAISE an entry's recorded evidence class only with
 *     genuine platform evidence (kind !== "none"), and only while it
 *     corroborates the SAME claim (status/value) - the strongest evidence
 *     unit for the current claim is retained (class, observedAt and
 *     evidence travel as one unit, so a raised class always points at the
 *     observation that produced it);
 *  3. absence of evidence never contradicts presence: a `none`-evidence
 *     observation can only record `unknown` where NO entry exists yet;
 *  4. the newest GENUINE observation wins for claim changes;
 *  5. genesis snapshots fill every in-scope subject the observation did not
 *     touch with honest `unknown` entries (kind `none`, class UNKNOWN) -
 *     the engine never guesses (RL-LOCK-011);
 *  6. untouched entries are carried over unchanged (their per-entry
 *     freshness is preserved); every application advances the chain
 *     (sequence + 1) and refreshes snapshot-level freshness.
 *
 * The engine never talks to platforms (RL-043 adapters produce the raw
 * observations) and never gates actions (the RL-040 `assertCapability` gate
 * stays the only gate).
 */
import {
  ConflictError,
  ValidationError,
  addMilliseconds,
  parseUtcInstant,
  type EvidenceClass,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND,
  type EdgeContextFieldName,
  type EdgeObservation,
} from "./observation.js";
import {
  EdgeContextSnapshot,
  type EdgeContextEntry,
  type EdgeContextSnapshotInput,
} from "./context-snapshot.js";
import { CAPABILITY_EVIDENCE_CLASS_RANKS } from "../capability/capability-gating.js";
import {
  EdgeCapabilitySnapshot,
  type EdgeCapabilityEntry,
  type EdgeCapabilitySnapshotInput,
} from "../capability/capability-snapshot.js";
import { edgeCapabilitiesInScope, isEdgeCapabilityInScope } from "../capability/capability-model.js";
import type { EdgeCapabilityName } from "../capability/capability-name.js";
import { EDGE_CONTRACT_VERSION } from "../version.js";

/** Why a specific observation did or did not change an entry. */
export const EDGE_OBSERVATION_APPLY_REASONS = [
  "recorded",
  "raised-evidence-class",
  "changed-claim",
  "corroborated-existing-evidence",
  "no-evidence-cannot-contradict",
] as const;

export type EdgeObservationApplyReason = (typeof EDGE_OBSERVATION_APPLY_REASONS)[number];

/** The per-observation outcome inside an {@link EdgeObservationResult}. */
export interface AppliedObservation {
  readonly observationId: EdgeObservation["observationId"];
  /** The capability name or context field the observation targeted. */
  readonly key: string;
  readonly applied: boolean;
  readonly reason: EdgeObservationApplyReason;
  readonly previousEntry: EdgeCapabilityEntry | EdgeContextEntry | null;
  readonly newEntry: EdgeCapabilityEntry | EdgeContextEntry | null;
}

/** The result of one engine application: the next snapshot + the outcomes. */
export interface EdgeObservationResult<TSnapshot> {
  readonly snapshot: TSnapshot;
  readonly applied: readonly AppliedObservation[];
}

/** Options for {@link EdgeObservationEngine}. */
export interface EdgeObservationEngineOptions {
  /** Snapshot-id source; inject a deterministic generator in tests. */
  readonly snapshotIdGenerator: () => string;
  /**
   * Snapshot-level freshness lifetime in ms applied to every produced
   * snapshot (`freshUntil = at + lifetime`); null = no freshness guarantee.
   */
  readonly snapshotFreshnessMs: number | null;
}

interface MergeableEntry {
  readonly evidenceClass: EvidenceClass;
  readonly observedAt: UtcInstant;
  readonly evidence: EdgeCapabilityEntry["evidence"];
  readonly claim: string;
}

function toMergeableCapabilityEntry(entry: EdgeCapabilityEntry): MergeableEntry {
  return { evidenceClass: entry.evidenceClass, observedAt: entry.observedAt, evidence: entry.evidence, claim: entry.status };
}

function toMergeableContextEntry(entry: EdgeContextEntry): MergeableEntry {
  return { evidenceClass: entry.evidenceClass, observedAt: entry.observedAt, evidence: entry.evidence, claim: entry.value };
}

function assertFreshnessOption(value: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ValidationError(
      "snapshotFreshnessMs must be null or an integer between 1 and 2147483647",
      {
        reason: "EDGE_OBSERVATION_ENGINE_INVALID",
        details: [{ path: "snapshotFreshnessMs", issue: "out of bounds" }],
      },
    );
  }
  return value;
}

function compareInstants(a: UtcInstant, b: UtcInstant): number {
  return new Date(a).getTime() - new Date(b).getTime();
}

/** The pure merge at the heart of the engine (see the module doc, rules 2-4). */
function mergeClaim(
  previous: MergeableEntry | null,
  observation: EdgeObservation,
  nextClaim: string,
): {
  readonly evidenceClass: EvidenceClass;
  readonly observedAt: UtcInstant;
  readonly applied: boolean;
  readonly reason: EdgeObservationApplyReason;
} {
  const evidenceClass = EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND[observation.evidence.kind];
  if (evidenceClass === "AUTHENTICATED") {
    // Defense in depth: the closed map cannot produce this, and no local
    // observation pipeline may ever fabricate it (RL-LOCK-011).
    throw new ConflictError(
      "the observation evidence-class map produced AUTHENTICATED - this is a contract violation (local observations never authenticate cryptographically)",
      { reason: "EDGE_OBSERVATION_EVIDENCE_CLASS_INVALID" },
    );
  }

  // Rule 3: absence of evidence can only record unknown where nothing exists.
  if (observation.evidence.kind === "none") {
    if (previous === null) {
      return { evidenceClass: "UNKNOWN", observedAt: observation.observedAt, applied: true, reason: "recorded" };
    }
    return {
      evidenceClass: previous.evidenceClass,
      observedAt: previous.observedAt,
      applied: false,
      reason: "no-evidence-cannot-contradict",
    };
  }

  // Genuine platform evidence.
  if (previous === null || previous.claim !== nextClaim) {
    return {
      evidenceClass,
      observedAt: observation.observedAt,
      applied: true,
      reason: previous === null ? "recorded" : "changed-claim",
    };
  }
  if (
    CAPABILITY_EVIDENCE_CLASS_RANKS[evidenceClass] >
    CAPABILITY_EVIDENCE_CLASS_RANKS[previous.evidenceClass]
  ) {
    return {
      evidenceClass,
      observedAt: observation.observedAt,
      applied: true,
      reason: "raised-evidence-class",
    };
  }
  return {
    evidenceClass: previous.evidenceClass,
    observedAt: previous.observedAt,
    applied: false,
    reason: "corroborated-existing-evidence",
  };
}

/**
 * The observation engine: applies raw observations to snapshot chains.
 * Stateless beyond its configuration - all state lives in the snapshots the
 * caller passes in, so the engine is trivially replayable and testable.
 */
export class EdgeObservationEngine {
  readonly #snapshotIdGenerator: () => string;
  readonly #snapshotFreshnessMs: number | null;

  constructor(options: EdgeObservationEngineOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("EdgeObservationEngineOptions must be an object", {
        reason: "EDGE_OBSERVATION_ENGINE_INVALID",
        details: [{ path: "EdgeObservationEngineOptions", issue: "not an object" }],
      });
    }
    if (typeof options.snapshotIdGenerator !== "function") {
      throw new ValidationError("snapshotIdGenerator must be a function producing canonical UUIDs", {
        reason: "EDGE_OBSERVATION_ENGINE_INVALID",
        details: [{ path: "snapshotIdGenerator", issue: "not a function" }],
      });
    }
    this.#snapshotIdGenerator = options.snapshotIdGenerator;
    this.#snapshotFreshnessMs = assertFreshnessOption(options.snapshotFreshnessMs);
  }

  /**
   * Applies one capability-probe observation to a capability snapshot chain
   * (previous === null starts the chain at sequence 1; every in-scope
   * capability the observation did not touch is recorded as an honest
   * `unknown` entry - never a guess).
   */
  applyCapabilityObservation(
    previous: EdgeCapabilitySnapshot | null,
    observation: EdgeObservation,
    at: UtcInstant | string,
  ): EdgeObservationResult<EdgeCapabilitySnapshot> {
    const instant = parseUtcInstant(at);
    this.#assertSubject(observation, "capability-probe");
    this.#assertBasics(observation, instant);
    const subject = observation.subject as {
      readonly kind: "capability-probe";
      readonly capability: EdgeCapabilityName;
      readonly status: EdgeCapabilityEntry["status"];
    };
    if (!isEdgeCapabilityInScope(subject.capability, observation.platform.family)) {
      throw new ConflictError(
        "the probed capability is not in scope for the observation's platform family (the closed vocabulary's platform scope is a contract)",
        { reason: "EDGE_OBSERVATION_OUT_OF_SCOPE" },
      );
    }
    if (previous !== null) {
      this.#assertChainContinuity(
        observation,
        previous.deviceRef,
        previous.platform.family,
        previous.sequence,
      );
    }

    const family = observation.platform.family;
    const capabilities: Record<string, EdgeCapabilityEntry> = {};
    if (previous === null) {
      // Genesis: every in-scope capability EXCEPT the observed one starts as
      // honest unknown (the observed one is recorded by the merge below).
      for (const name of edgeCapabilitiesInScope(family)) {
        if (name === subject.capability) continue;
        capabilities[name] = Object.freeze({
          status: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt: observation.observedAt,
          evidence: Object.freeze({ kind: "none" }),
        });
      }
    } else {
      for (const [name, entry] of Object.entries(previous.capabilities)) {
        capabilities[name] = entry;
      }
    }

    const merge = mergeClaim(
      capabilities[subject.capability] === undefined
        ? null
        : toMergeableCapabilityEntry(capabilities[subject.capability] as EdgeCapabilityEntry),
      observation,
      subject.status,
    );
    const previousEntry = (capabilities[subject.capability] as EdgeCapabilityEntry | undefined) ?? null;
    if (!merge.applied && previousEntry === null) {
      throw new ConflictError("observation engine invariant violated (an unapplied merge requires a previous entry)", {
        reason: "EDGE_OBSERVATION_ENGINE_INVALID",
      });
    }
    const newEntry: EdgeCapabilityEntry = merge.applied
      ? Object.freeze({
          status: subject.status,
          evidenceClass: merge.evidenceClass,
          observedAt: merge.observedAt,
          evidence: observation.evidence,
        })
      : (previousEntry as EdgeCapabilityEntry);
    capabilities[subject.capability] = newEntry;

    const snapshot = new EdgeCapabilitySnapshot({
      snapshotId: this.#snapshotIdGenerator(),
      contractVersion: EDGE_CONTRACT_VERSION,
      sequence: previous === null ? 1 : previous.sequence + 1,
      deviceRef: observation.deviceRef,
      platform: { family, platformVersion: observation.platform.platformVersion },
      observedAt: instant,
      freshUntil:
        this.#snapshotFreshnessMs === null
          ? null
          : addMilliseconds(instant, this.#snapshotFreshnessMs),
      capabilities,
    } satisfies EdgeCapabilitySnapshotInput);
    return {
      snapshot,
      applied: [
        {
          observationId: observation.observationId,
          key: subject.capability,
          applied: merge.applied,
          reason: merge.reason,
          previousEntry,
          newEntry,
        },
      ],
    };
  }

  /**
   * Applies one context observation to a context snapshot chain (previous ===
   * null starts the chain at sequence 1; untouched fields default to honest
   * `unknown` entries).
   */
  applyContextObservation(
    previous: EdgeContextSnapshot | null,
    observation: EdgeObservation,
    at: UtcInstant | string,
  ): EdgeObservationResult<EdgeContextSnapshot> {
    const instant = parseUtcInstant(at);
    this.#assertSubject(observation, "context-observation");
    this.#assertBasics(observation, instant);
    const subject = observation.subject as {
      readonly kind: "context-observation";
      readonly contextField: EdgeContextFieldName;
      readonly value: string;
    };
    if (previous !== null) {
      this.#assertChainContinuity(
        observation,
        previous.deviceRef,
        previous.platform.family,
        previous.sequence,
      );
    }

    const entries: Record<string, EdgeContextEntry> = {};
    if (previous === null) {
      for (const name of ["connectivity-state", "active-interface-kind", "interface-metered"] as const) {
        if (name === subject.contextField) continue;
        entries[name] = Object.freeze({
          value: "unknown",
          evidenceClass: "UNKNOWN",
          observedAt: observation.observedAt,
          evidence: Object.freeze({ kind: "none" }),
        });
      }
    } else {
      for (const [name, entry] of Object.entries(previous.entries)) {
        entries[name] = entry;
      }
    }

    const merge = mergeClaim(
      entries[subject.contextField] === undefined
        ? null
        : toMergeableContextEntry(entries[subject.contextField] as EdgeContextEntry),
      observation,
      subject.value,
    );
    const previousEntry = (entries[subject.contextField] as EdgeContextEntry | undefined) ?? null;
    if (!merge.applied && previousEntry === null) {
      throw new ConflictError("observation engine invariant violated (an unapplied merge requires a previous entry)", {
        reason: "EDGE_OBSERVATION_ENGINE_INVALID",
      });
    }
    const newEntry: EdgeContextEntry = merge.applied
      ? Object.freeze({
          value: subject.value,
          evidenceClass: merge.evidenceClass,
          observedAt: merge.observedAt,
          evidence: observation.evidence,
        })
      : (previousEntry as EdgeContextEntry);
    entries[subject.contextField] = newEntry;

    const snapshot = new EdgeContextSnapshot({
      snapshotId: this.#snapshotIdGenerator(),
      contractVersion: EDGE_CONTRACT_VERSION,
      sequence: previous === null ? 1 : previous.sequence + 1,
      deviceRef: observation.deviceRef,
      platform: {
        family: observation.platform.family,
        platformVersion: observation.platform.platformVersion,
      },
      observedAt: instant,
      freshUntil:
        this.#snapshotFreshnessMs === null
          ? null
          : addMilliseconds(instant, this.#snapshotFreshnessMs),
      entries,
    } satisfies EdgeContextSnapshotInput);
    return {
      snapshot,
      applied: [
        {
          observationId: observation.observationId,
          key: subject.contextField,
          applied: merge.applied,
          reason: merge.reason,
          previousEntry,
          newEntry,
        },
      ],
    };
  }

  /**
   * Applies a batch of observations (capability and context) as of one
   * instant, folding the chains in order. A chain that receives no
   * observations and has no previous snapshot stays `null` - the engine
   * never fabricates a chain (fail-closed, never a guess).
   */
  applyObservations(
    previousCapability: EdgeCapabilitySnapshot | null,
    previousContext: EdgeContextSnapshot | null,
    observations: readonly EdgeObservation[],
    at: UtcInstant | string,
  ): {
    readonly capability: { readonly snapshot: EdgeCapabilitySnapshot | null; readonly applied: readonly AppliedObservation[] };
    readonly context: { readonly snapshot: EdgeContextSnapshot | null; readonly applied: readonly AppliedObservation[] };
  } {
    let capabilitySnapshot = previousCapability;
    let contextSnapshot = previousContext;
    const appliedCapability: AppliedObservation[] = [];
    const appliedContext: AppliedObservation[] = [];
    for (const observation of observations) {
      if (observation.subject.kind === "capability-probe") {
        const result = this.applyCapabilityObservation(capabilitySnapshot, observation, at);
        capabilitySnapshot = result.snapshot;
        appliedCapability.push(...result.applied);
      } else {
        const result = this.applyContextObservation(contextSnapshot, observation, at);
        contextSnapshot = result.snapshot;
        appliedContext.push(...result.applied);
      }
    }
    return {
      capability: { snapshot: capabilitySnapshot, applied: Object.freeze(appliedCapability) },
      context: { snapshot: contextSnapshot, applied: Object.freeze(appliedContext) },
    };
  }

  #assertSubject(
    observation: EdgeObservation,
    kind: "capability-probe" | "context-observation",
  ): void {
    if (observation.subject.kind !== kind) {
      throw new ValidationError(
        `the observation subject is not a ${kind} (use the matching apply method)`,
        {
          reason: "EDGE_OBSERVATION_SUBJECT_MISMATCH",
          details: [{ path: "subject.kind", issue: "wrong apply method for this subject" }],
        },
      );
    }
  }

  #assertBasics(observation: EdgeObservation, at: UtcInstant): void {
    if (compareInstants(observation.observedAt, at) > 0) {
      throw new ConflictError(
        "an observation cannot be observed after the merge instant (check clock skew)",
        { reason: "EDGE_OBSERVATION_TIME_TRAVEL" },
      );
    }
  }

  #assertChainContinuity(
    observation: EdgeObservation,
    previousDeviceRef: EdgeObservation["deviceRef"],
    previousFamily: EdgeObservation["platform"]["family"],
    previousSequence: number,
  ): void {
    if (observation.deviceRef !== previousDeviceRef) {
      throw new ConflictError(
        "the observation's device reference does not match the snapshot chain (a chain belongs to exactly one device)",
        { reason: "EDGE_OBSERVATION_DEVICE_MISMATCH" },
      );
    }
    if (observation.platform.family !== previousFamily) {
      throw new ConflictError(
        "the observation's platform family does not match the snapshot chain (a device does not change families)",
        { reason: "EDGE_OBSERVATION_PLATFORM_MISMATCH" },
      );
    }
    if (!Number.isInteger(previousSequence) || previousSequence < 1) {
      throw new ConflictError("the previous snapshot's sequence is invalid", {
        reason: "EDGE_OBSERVATION_CHAIN_INVALID",
      });
    }
  }
}
