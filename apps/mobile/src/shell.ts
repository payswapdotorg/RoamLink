/**
 * The mobile/edge UX shell (RL-062, spec/mobile.md - THE contract).
 *
 * An OBSERVATION / EXPERIENCE / SYNCHRONIZATION agent surface - not a radio
 * or network authority (spec/mobile.md "Principle"; RL-LOCK-003/004/005: no
 * ADCOS identity/session/path authority exists anywhere in this shell).
 *
 * The edge desired-state loop (spec/mobile.md):
 * `local context -> evaluate RoamLink experience policy -> produce desired
 * experience action -> queue command -> server/ADCOS integration -> receive
 * authoritative result -> update local projection`
 *
 * This shell composes the Wave-3 edge packages and owns NOTHING they own:
 *
 *  - observation: raw {@link MobilePlatformProbe} samples parse through the
 *    RL-041 contract and fold into capability/context snapshot chains via
 *    the RL-041 engine (evidence classes are ASSIGNED, never claimed);
 *  - capability gating: every executed OR queued action passes the RL-043
 *    admission gate against the current snapshot (RL-LOCK-011 - INFERRED,
 *    STALE and UNKNOWN evidence can never allow an action);
 *  - offline: desired-state changes enqueue into the RL-042 encrypted
 *    offline outbox (ciphertext-only at rest); retries dedupe; convergence
 *    happens through explicit `sync` when connectivity returns
 *    (RL-LOCK-015);
 *  - projection: the local device-action projection keeps honest
 *    `queued != executed` boundary states; authoritative results from the
 *    server/ADCOS integration arrive ONLY through
 *    `receiveAuthoritativeResult` as validated RL-040 records;
 *  - honesty: every view renders LAST-KNOWN freshness re-evaluated at the
 *    query instant (FRESH degrades to STALE monotonically; UNKNOWN is
 *    presented, never hidden) and the shell NEVER fabricates connectivity
 *    state (RL-LOCK-010/015).
 *
 * The shell is host-agnostic and side-effect-free by construction: ids,
 * ciphers, signers, executors, probes and transports are all injected; the
 * app sources never touch a node builtin (hosts bind them).
 */
import {
  DomainError,
  makeFreshness,
  parseUtcInstant,
  type Freshness,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  DeviceActionRequest,
  EdgeObservationEngine,
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  parseEdgeDesiredStateRecord,
  parseEdgeObservation,
  type DeviceActionResultPlain,
  type EdgeCapabilitySnapshot,
  type EdgeCapabilitySnapshotPlain,
  type EdgeContextSnapshot,
  type EdgeObservation,
  type EdgeOutboxRecord,
  type EdgeSyncRunReport,
  type EdgeSyncTransport,
  type EdgePlatformFamily,
} from "@roamlink/edge";
import {
  DeviceActionAdapter,
  InMemoryDeviceActionProjectionStore,
  admitDeviceAction,
  type AuthoritativeResultDescriptor,
  type DeviceActionAdmission,
  type DeviceActionProjectionEntry,
  type LocalExperiencePolicy,
  type PlatformActionExecutor,
  type PolicyEvaluationResult,
} from "@roamlink/edge-actions";
import type { DeviceActionResult, EdgeOutboxRecord as OutboxRecord } from "@roamlink/edge";

import type { MobilePlatformProbe } from "./platform-probe.js";
import {
  MOBILE_SHELL_CONTRACT_VERSION,
  buildMobileEnrollmentPublication,
  type MobileEnrollmentPublication,
  type MobileEnrollmentSigner,
} from "./enrollment.js";

/** Options for {@link MobileEdgeShell}. All seams are host-injected. */
export interface MobileEdgeShellOptions {
  readonly deviceRef: string;
  readonly platform: { readonly family: EdgePlatformFamily; readonly platformVersion: string };
  /** The acting context commands carry (actor + tenant, RL-LOCK-014). */
  readonly actorId: string;
  readonly tenantId: string;
  readonly probe: MobilePlatformProbe;
  readonly executor: PlatformActionExecutor;
  /** The RL-042 payload cipher (hosts bind the secrets-boundary key provider). */
  readonly cipher: EdgeOfflineOutboxOptionsCipher;
  /** Key REFERENCE for new outbox encryptions (never material). */
  readonly outboxKeyId: string;
  /** Deterministic id sources (hosts bind crypto in production). */
  readonly observationIdGenerator: () => string;
  readonly snapshotIdGenerator: () => string;
  readonly outboxRecordIdGenerator: () => string;
  readonly actionIdGenerator: () => string;
  readonly commandIdGenerator: () => string;
  readonly correlationIdGenerator: () => string;
  readonly idempotencyKeyGenerator: () => string;
  readonly desiredStateIdGenerator: () => string;
  readonly publicationIdGenerator: () => string;
  /** Required for {@link MobileEdgeShell.enroll} (signed publications). */
  readonly signer?: MobileEnrollmentSigner;
  /** The RoamLink experience policy (RL-043 port; optional). */
  readonly policy?: LocalExperiencePolicy;
  /**
   * Host-bound context for policy evaluation (the consented domain-side
   * context snapshot). The shell itself never imports a domain package.
   */
  readonly policyContextProvider?: () => unknown;
  /** Snapshot freshness lifetime in ms (default 60s; null = no guarantee). */
  readonly snapshotFreshnessMs?: number | null;
  /** Bounded telemetry ring size (default 100). */
  readonly telemetryLimit?: number;
  /** Default outbox retry policy. */
  readonly defaultRetryPolicy?: {
    readonly maxAttempts: number;
    readonly initialBackoffMs: number;
    readonly backoffMultiplier: number;
    readonly maxBackoffMs: number;
  };
}

/** The duck-typed cipher port of the RL-042 offline outbox. */
export interface EdgeOfflineOutboxOptionsCipher {
  readonly algorithm: string;
  encrypt(keyId: string, plaintext: string): Promise<string>;
  decrypt(keyId: string, ciphertext: string): Promise<string>;
}

/** One action request input (the user-guided desired action). */
export interface MobileActionRequestInput {
  readonly capability: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Physical action dedupe key (defaults to a generated idempotency key). */
  readonly dedupeKey?: string;
  /** Minimum evidence class override (defaults to the capability's own). */
  readonly minimumEvidenceClass?: string;
  /** Optional max age of the gating observation. */
  readonly maxAgeMs?: number | null;
}

/** Where the desired action goes: local execution or the server loop. */
export type MobileActionMode = "local" | "server";

/** The outcome of one requested desired action. */
export type MobileActionResult =
  | { readonly mode: "local"; readonly outcome: "EXECUTED" | "BLOCKED"; readonly result: DeviceActionResultPlain }
  | {
      readonly mode: "server";
      readonly outcome: "QUEUED" | "ALREADY_QUEUED" | "BLOCKED";
      readonly enqueue?: OutboxRecord;
      readonly result: DeviceActionResultPlain;
    };

/** One bounded telemetry entry (observation cycle receipts). */
export interface MobileTelemetryEntry {
  readonly at: UtcInstant;
  readonly observations: number;
  readonly applied: number;
  readonly subjects: readonly string[];
}

/** The shell's per-capability truth-table row (RL-LOCK-011 rendered). */
export interface MobileCapabilityRow {
  readonly capability: string;
  readonly status: string;
  readonly evidenceClass: string;
  readonly observedAt: UtcInstant;
  /** Freshness of the entry, re-evaluated at the query instant. */
  readonly freshness: Freshness;
  /** What the admission gate would say for this capability right now. */
  readonly gatePreview: DeviceActionAdmission;
}

/** The connectivity view model (freshness FIRST, never fabricated). */
export interface MobileConnectivityView {
  readonly at: UtcInstant;
  /** True while the HOST declares sync reachability (never a connectivity claim). */
  readonly syncReachable: boolean;
  /** The last OBSERVED connectivity state with its freshness (may be UNKNOWN). */
  readonly observedConnectivityState: { readonly value: string; readonly freshness: Freshness } | null;
  /** Context entries with freshness re-evaluated at the query instant. */
  readonly context: ReadonlyArray<{ readonly field: string; readonly value: string; readonly freshness: Freshness }>;
  readonly capabilitySummary: { readonly available: number; readonly unknown: number; readonly total: number };
  readonly outbox: {
    readonly pending: number;
    readonly inFlight: number;
    readonly synced: number;
    readonly deadLettered: number;
  };
  readonly lastObservationAt: UtcInstant | null;
  /** The enrollment publication's freshness, re-evaluated (or null). */
  readonly enrollmentFreshness: Freshness | null;
}

const DEFAULT_SNAPSHOT_FRESHNESS_MS = 60_000;
const DEFAULT_TELEMETRY_LIMIT = 100;
const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  initialBackoffMs: 1_000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
});

/**
 * The mobile/edge UX shell. All operations take EXPLICIT UTC instants
 * (deterministic under the testkit clock). Every read re-evaluates freshness
 * at the query instant; nothing here claims physical success without
 * platform/ADCOS evidence (RL-LOCK-011/015).
 */
export class MobileEdgeShell {
  readonly #options: MobileEdgeShellOptions;
  readonly #engine: EdgeObservationEngine;
  readonly #outboxStore = new InMemoryEdgeOutboxStore();
  readonly #outbox: EdgeOfflineOutbox;
  readonly #projection = new InMemoryDeviceActionProjectionStore();
  readonly #adapter: DeviceActionAdapter;
  readonly #telemetry: MobileTelemetryEntry[] = [];

  #capabilitySnapshot: EdgeCapabilitySnapshot | null = null;
  #contextSnapshot: EdgeContextSnapshot | null = null;
  #enrollment: MobileEnrollmentPublication | null = null;
  #syncReachable = true;
  #lastObservationAt: UtcInstant | null = null;

  constructor(options: MobileEdgeShellOptions) {
    if (options === null || typeof options !== "object") {
      throw new DomainError("MobileEdgeShellOptions must be an object", {
        reason: "MOBILE_SHELL_INVALID",
      });
    }
    this.#options = options;
    this.#engine = new EdgeObservationEngine({
      snapshotIdGenerator: options.snapshotIdGenerator,
      snapshotFreshnessMs:
        options.snapshotFreshnessMs === undefined
          ? DEFAULT_SNAPSHOT_FRESHNESS_MS
          : options.snapshotFreshnessMs,
    });
    this.#outbox = new EdgeOfflineOutbox({
      store: this.#outboxStore,
      cipher: options.cipher,
      keyId: options.outboxKeyId,
      idGenerator: options.outboxRecordIdGenerator,
      defaultRetryPolicy: options.defaultRetryPolicy ?? DEFAULT_RETRY_POLICY,
    });
    this.#adapter = new DeviceActionAdapter({
      capabilitySnapshotProvider: () => this.#capabilitySnapshot,
      executor: options.executor,
      projection: this.#projection,
      outbox: this.#outbox,
      outboxStore: this.#outboxStore,
    });
  }

  // ---------------------------------------------------------------------------
  // Enrollment (signed, versioned, expiring capability snapshot publication)
  // ---------------------------------------------------------------------------

  /**
   * Publishes the capability snapshot: runs one observation cycle, then signs
   * the resulting snapshot through the enrollment signer. Re-enrollment
   * publishes the NEXT snapshot-chain sequence (versioned chain, never a
   * mutation).
   */
  async enroll(at: UtcInstant | string): Promise<MobileEnrollmentPublication> {
    const instant = parseUtcInstant(at);
    if (this.#options.signer === undefined) {
      throw new DomainError(
        "enrollment requires a signer (the publication is signed, versioned and expiring - spec/mobile.md Capability discovery)",
        { reason: "MOBILE_SHELL_SIGNER_NOT_WIRED" },
      );
    }
    await this.runObservationCycle(instant);
    if (this.#capabilitySnapshot === null) {
      throw new DomainError(
        "the probe produced no capability snapshot; enrollment is refused rather than guessed",
        { reason: "MOBILE_SHELL_ENROLLMENT_NO_SNAPSHOT" },
      );
    }
    const publication = await buildMobileEnrollmentPublication(
      {
        publicationId: this.#options.publicationIdGenerator(),
        snapshot: this.#capabilitySnapshot,
      },
      this.#options.signer,
      instant,
    );
    this.#enrollment = publication;
    return publication;
  }

  /** The current enrollment publication (or null - never fabricated). */
  enrollment(): MobileEnrollmentPublication | null {
    return this.#enrollment;
  }

  // ---------------------------------------------------------------------------
  // Observation (continues offline - spec/mobile.md "Offline")
  // ---------------------------------------------------------------------------

  /**
   * One observation cycle: collects the probe's raw samples, parses each
   * through the RL-041 contract (evidence classes assigned, never claimed)
   * and folds them into the capability/context snapshot chains. A bounded
   * telemetry receipt is recorded (oldest entries dropped at the limit).
   */
  async runObservationCycle(at: UtcInstant | string): Promise<readonly EdgeObservation[]> {
    const instant = parseUtcInstant(at);
    const samples = await this.#options.probe.collect(instant);
    const observations: EdgeObservation[] = [];
    for (const sample of samples) {
      observations.push(
        parseEdgeObservation({
          observationId: this.#options.observationIdGenerator(),
          deviceRef: this.#options.deviceRef,
          observedAt: sample.observedAt,
          platform: {
            family: this.#options.platform.family,
            platformVersion: this.#options.platform.platformVersion,
          },
          evidence: sample.evidence,
          subject: sample.subject,
        }),
      );
    }
    const result = this.#engine.applyObservations(
      this.#capabilitySnapshot,
      this.#contextSnapshot,
      observations,
      instant,
    );
    this.#capabilitySnapshot = result.capability.snapshot;
    this.#contextSnapshot = result.context.snapshot;
    this.#lastObservationAt = instant;

    // Bounded telemetry (spec/mobile.md "Offline": stores bounded telemetry
    // locally - the ring truncates honestly, it never silently unbounds).
    const applied = result.capability.applied.length + result.context.applied.length;
    this.#telemetry.push(
      Object.freeze({
        at: instant,
        observations: observations.length,
        applied,
        subjects: Object.freeze([
          ...result.capability.applied.map((entry) => entry.key),
          ...result.context.applied.map((entry) => entry.key),
        ]),
      }),
    );
    const limit = this.#options.telemetryLimit ?? DEFAULT_TELEMETRY_LIMIT;
    while (this.#telemetry.length > limit) this.#telemetry.shift();
    return Object.freeze(observations);
  }

  /** The bounded telemetry ring (oldest first). */
  telemetry(): readonly MobileTelemetryEntry[] {
    return Object.freeze([...this.#telemetry]);
  }

  /** The current capability snapshot (plain) - or null (honest absence). */
  capabilitySnapshot(): EdgeCapabilitySnapshotPlain | null {
    return this.#capabilitySnapshot?.toPlain() ?? null;
  }

  // ---------------------------------------------------------------------------
  // The desired-state loop
  // ---------------------------------------------------------------------------

  /**
   * Evaluates the RoamLink experience policy against the local context and
   * produces desired experience actions (spec/mobile.md "Edge desired-state
   * loop" step 1-2). The policy is the RL-043 port; the shell adds nothing.
   */
  evaluatePolicy(at: UtcInstant | string): PolicyEvaluationResult {
    const instant = parseUtcInstant(at);
    if (this.#options.policy === undefined) {
      throw new DomainError("no experience policy is wired", {
        reason: "MOBILE_SHELL_POLICY_NOT_WIRED",
      });
    }
    // The host binds the consented domain-side context snapshot; the shell
    // never imports a domain package (structural hand-off, RL-LOCK-019).
    const context = this.#options.policyContextProvider?.();
    const policyContext =
      context === undefined
        ? {}
        : ({ contextSnapshot: context } as Parameters<LocalExperiencePolicy["evaluate"]>[0]);
    return this.#options.policy.evaluate(policyContext, instant);
  }

  /**
   * Requests one desired action through the loop. `local` executes through
   * the platform executor (physical success ONLY with platform evidence);
   * `server` queues the command into the encrypted offline outbox toward
   * the server/ADCOS integration. Both paths pass the capability gate first;
   * blocked actions return the typed, diagnosable result and never touch the
   * outbox (RL-LOCK-011/014/015).
   */
  async requestAction(
    input: MobileActionRequestInput,
    mode: MobileActionMode,
    at: UtcInstant | string,
  ): Promise<MobileActionResult> {
    const instant = parseUtcInstant(at);
    const request = this.#buildActionRequest(input, instant);

    if (mode === "local") {
      const result = await this.#adapter.execute(request, instant);
      return {
        mode: "local",
        outcome: result.status === "executed-observed" ? "EXECUTED" : "BLOCKED",
        result: result.toPlain(),
      };
    }

    const desiredStateId = this.#options.desiredStateIdGenerator();
    const desiredState = parseEdgeDesiredStateRecord({
      desiredStateId,
      contractVersion: MOBILE_SHELL_CONTRACT_VERSION,
      deviceRef: this.#options.deviceRef,
      capabilityRequirement: request.capabilityRequirement,
      parameters: request.parameters,
      createdAt: instant,
      revision: 1,
      lastKnownFreshness: this.#lastKnownFreshness(instant),
    });
    void desiredState;
    const queueOutcome = await this.#adapter.queue(
      request,
      {
        deviceRef: this.#options.deviceRef,
        desiredStateId,
        lastKnownFreshness: this.#lastKnownFreshness(instant),
      },
      instant,
    );
    if (queueOutcome.outcome === "BLOCKED") {
      return { mode: "server", outcome: "BLOCKED", result: queueOutcome.result.toPlain() };
    }
    return {
      mode: "server",
      outcome: queueOutcome.outcome === "ENQUEUED" ? "QUEUED" : "ALREADY_QUEUED",
      enqueue: queueOutcome.enqueue.record,
      result: {
        actionId: request.actionId,
        status: "accepted" as const,
        completedAt: instant,
      },
    };
  }

  /**
   * Runs one bounded sync pass of the encrypted offline outbox (converge when
   * connectivity returns, RL-LOCK-015) and updates the local projection from
   * the run report.
   */
  async sync(
    transport: EdgeSyncTransport,
    at: UtcInstant | string,
  ): Promise<EdgeSyncRunReport> {
    const instant = parseUtcInstant(at);
    return this.#adapter.sync(instant, transport);
  }

  /** Re-queues records left in-flight by a crash/restart (replay-safe). */
  async recoverInFlight(at: UtcInstant | string): Promise<readonly EdgeOutboxRecord[]> {
    const instant = parseUtcInstant(at);
    return this.#adapter.recoverInFlight(instant);
  }

  /**
   * Receives an AUTHORITATIVE result from the server/ADCOS integration and
   * updates the local projection (the loop's last step). The result is
   * validated through the RL-040 honesty rules first.
   */
  async receiveAuthoritativeResult(
    result: DeviceActionResult,
    descriptor: AuthoritativeResultDescriptor | undefined,
    at: UtcInstant | string,
  ): Promise<DeviceActionProjectionEntry> {
    return this.#adapter.receiveAuthoritativeResult(result, descriptor, at);
  }

  // ---------------------------------------------------------------------------
  // Reachability (host-declared sync state; NEVER a connectivity claim)
  // ---------------------------------------------------------------------------

  /** The host declares sync unreachability (observation continues offline). */
  enterOffline(at: UtcInstant | string): UtcInstant {
    const instant = parseUtcInstant(at);
    this.#syncReachable = false;
    return instant;
  }

  /** The host declares sync reachability (converge with {@link sync}). */
  resumeOnline(at: UtcInstant | string): UtcInstant {
    const instant = parseUtcInstant(at);
    this.#syncReachable = true;
    return instant;
  }

  isSyncReachable(): boolean {
    return this.#syncReachable;
  }

  // ---------------------------------------------------------------------------
  // Read models (freshness re-evaluated at the query instant)
  // ---------------------------------------------------------------------------

  /**
   * The capability truth table: every in-scope capability with its status,
   * evidence class, freshness re-evaluated at `at`, and the admission gate
   * preview (what the gate says RIGHT NOW for that capability).
   */
  capabilityMatrix(at: UtcInstant | string): readonly MobileCapabilityRow[] {
    const instant = parseUtcInstant(at);
    const snapshot = this.#capabilitySnapshot;
    if (snapshot === null) return [];
    const rows: MobileCapabilityRow[] = [];
    for (const [capability, entry] of Object.entries(snapshot.capabilities)) {
      if (entry === undefined) continue;
      rows.push({
        capability,
        status: entry.status,
        evidenceClass: entry.evidenceClass,
        observedAt: entry.observedAt,
        freshness: makeFreshness(
          {
            observedAt: entry.observedAt,
            receivedAt: snapshot.observedAt,
            freshUntil: snapshot.freshUntil,
          },
          instant,
        ),
        gatePreview: previewCapabilityGate(snapshot, capability, instant),
      });
    }
    return Object.freeze(
      rows.sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0)),
    );
  }

  /**
   * The connectivity view model: OBSERVED context entries with freshness,
   * the outbox boundary summary and the honest absence markers. The shell
   * NEVER derives "connected/disconnected" from anything but the observed
   * context (spec/api.md "Connectivity read API" spirit, RL-LOCK-010/015).
   */
  async connectivityView(at: UtcInstant | string): Promise<MobileConnectivityView> {
    const instant = parseUtcInstant(at);
    const context = this.#contextSnapshot;
    const contextEntries: {
      readonly field: string;
      readonly value: string;
      readonly freshness: Freshness;
    }[] = [];
    let observedConnectivity: MobileConnectivityView["observedConnectivityState"] = null;
    if (context !== null) {
      for (const [field, entry] of Object.entries(context.entries)) {
        if (entry === undefined) continue;
        const freshness = makeFreshness(
          {
            observedAt: entry.observedAt,
            receivedAt: context.observedAt,
            freshUntil: context.freshUntil,
          },
          instant,
        );
        contextEntries.push({ field, value: entry.value, freshness });
        if (field === "connectivity-state") {
          observedConnectivity = { value: entry.value, freshness };
        }
      }
    }

    const records = await this.#outboxStore.list();
    const outbox = {
      pending: records.filter((record) => record.state === "pending").length,
      inFlight: records.filter((record) => record.state === "in-flight").length,
      synced: records.filter((record) => record.state === "synced").length,
      deadLettered: records.filter((record) => record.state === "dead-lettered").length,
    };

    const capability = this.#capabilitySnapshot;
    const entries = capability === null ? [] : Object.values(capability.capabilities);
    return Object.freeze({
      at: instant,
      syncReachable: this.#syncReachable,
      observedConnectivityState: observedConnectivity,
      context: Object.freeze(contextEntries),
      capabilitySummary: {
        available: entries.filter((entry) => entry?.status === "available").length,
        unknown: entries.filter(
          (entry) => entry?.status === "unknown" || entry?.evidenceClass === "UNKNOWN",
        ).length,
        total: entries.length,
      },
      outbox,
      lastObservationAt: this.#lastObservationAt,
      enrollmentFreshness:
        this.#enrollment === null
          ? null
          : makeFreshness(
              {
                observedAt: this.#enrollment.snapshot.observedAt,
                receivedAt: this.#enrollment.publishedAt,
                freshUntil: this.#enrollment.freshUntil,
              },
              instant,
            ),
    });
  }

  /** The outbox records (ciphertext-only payloads, for the outbox screen). */
  async outboxRecords(): Promise<readonly EdgeOutboxRecord[]> {
    return this.#outboxStore.list();
  }

  /** The local device-action projection entries (action history screen). */
  async projectionEntries(): Promise<readonly DeviceActionProjectionEntry[]> {
    return this.#projection.list();
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  #lastKnownFreshness(at: UtcInstant): Freshness {
    return makeFreshness(
      {
        observedAt: this.#lastObservationAt,
        receivedAt: this.#lastObservationAt,
        freshUntil: this.#capabilitySnapshot?.freshUntil ?? null,
      },
      at,
    );
  }

  #buildActionRequest(input: MobileActionRequestInput, at: UtcInstant): DeviceActionRequest {
    return new DeviceActionRequest({
      actionId: this.#options.actionIdGenerator(),
      capabilityRequirement: {
        capability: input.capability,
        ...(input.minimumEvidenceClass === undefined
          ? {}
          : { minimumEvidenceClass: input.minimumEvidenceClass }),
        ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
      },
      parameters: input.parameters ?? {},
      command: {
        commandId: this.#options.commandIdGenerator(),
        correlationId: this.#options.correlationIdGenerator(),
        idempotencyKey: this.#options.idempotencyKeyGenerator(),
        actorId: this.#options.actorId,
        tenantId: this.#options.tenantId,
        createdAt: at,
        retry: { attempt: 1 },
      },
      dedupeKey: input.dedupeKey ?? this.#options.idempotencyKeyGenerator(),
    });
  }
}

/**
 * PURE capability-gate preview against a snapshot as of `at` - the truth
 * table used by the capability matrix. Exported so shell-level truth tables
 * can be proven directly against hand-built snapshots (RL-LOCK-018).
 */
export function previewCapabilityGate(
  snapshot: EdgeCapabilitySnapshot | EdgeCapabilitySnapshotPlain,
  capability: string,
  at: UtcInstant | string,
): DeviceActionAdmission {
  const instant = parseUtcInstant(at);
  const request = new DeviceActionRequest({
    actionId: "00000000-0000-4000-8000-000000000000",
    capabilityRequirement: { capability },
    parameters: {},
    command: {
      commandId: "00000000-0000-4000-8000-000000000000",
      correlationId: "preview",
      idempotencyKey: "preview",
      actorId: "actor-preview",
      tenantId: "org:00000000-0000-4000-8000-000000000000",
      createdAt: instant,
      retry: { attempt: 1 },
    },
    dedupeKey: "preview",
  });
  return admitDeviceAction(snapshot, request, instant);
}
