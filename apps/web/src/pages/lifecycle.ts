/**
 * The honest connection journey derivation (RL-084, spec/ux-architecture.md
 * §6, tech-lead handoff §8, RL-LOCK-008/009/010).
 *
 * PRESENTATION-ONLY derivation with a hard rule: the journey is computed
 * from what the projection read model ASSERTS — the reference lifecycle
 * (active/retired/none), the delivery-evidence state, the evidence
 * freshness, and per-device observations — and from nothing else. In
 * particular:
 *
 *  - commercial state (orders, payments) NEVER feeds this derivation
 *    (RL-LOCK-008: payment is not delivery);
 *  - a connected/active claim exists ONLY where delivery evidence is linked
 *    (never from event arrival or webhook admission — RL-LOCK-009);
 *  - stages the read model does not assert render honestly as "waiting" or
 *    "not recorded yet" — never guessed, never hidden (RL-LOCK-010);
 *  - "recovered" is never claimed from this read: recovery actions live in
 *    the Activity narrative, so the stage renders "not recorded yet" with a
 *    pointer to Activity.
 *
 * Every value it returns stays within the closed vocabularies declared in
 * language.ts (a derived explanation, not a new authority — the same
 * discipline as app-kit's shell derivation).
 */
import type {
  ConnectivityOverviewResource,
  SubjectConnectivityResource,
} from "@roamlink/app-kit";

import type { ConnectionStage, ConnectionStageState } from "./language.js";

/** One rendered stage of the honest connection journey. */
export interface ConnectionJourneyStage {
  readonly stage: ConnectionStage;
  readonly state: ConnectionStageState;
  /** Evidence-backed detail lines shown under the stage (facts, not claims). */
  readonly facts: readonly string[];
}

/** The full page-level journey for one connectivity overview read. */
export interface ConnectionJourney {
  readonly stages: readonly ConnectionJourneyStage[];
  /**
   * The subjects the delivery stage currently waits on (active references
   * without delivery evidence). Empty when nothing is pending.
   */
  readonly pendingDelivery: readonly SubjectConnectivityResource[];
  /** The requested subjects (the references the journey is delivering against). */
  readonly requested: readonly SubjectConnectivityResource[];
  /** The latest device observation instant in the overview, if any. */
  readonly lastObservedAt: string | null;
}

function requestedSubjects(
  subjects: readonly SubjectConnectivityResource[],
): readonly SubjectConnectivityResource[] {
  return subjects.filter((subject) => subject.referenceStatus !== "none");
}

function evidencedSubjects(
  subjects: readonly SubjectConnectivityResource[],
): readonly SubjectConnectivityResource[] {
  return subjects.filter((subject) => subject.deliveryEvidenceState === "EVIDENCED");
}

function subjectLabel(subject: SubjectConnectivityResource): string {
  return `${subject.subjectType} ${subject.subjectId}`;
}

/**
 * Derives the page-level connection journey from ONE authoritative overview
 * read. Pure and total: any input yields exactly one journey whose stages
 * carry only the three honest states.
 */
export function deriveConnectionJourney(
  overview: ConnectivityOverviewResource,
): ConnectionJourney {
  const requested = requestedSubjects(overview.subjects);
  const evidenced = evidencedSubjects(overview.subjects);
  const pendingDelivery = requested.filter(
    (subject) => subject.deliveryEvidenceState !== "EVIDENCED",
  );
  const observationInstants = overview.deviceObservations
    .map((observation) => observation.lastObservedAt)
    .filter((instant): instant is string => instant !== null);
  const lastObservedAt =
    observationInstants.length === 0
      ? null
      : observationInstants.reduce((latest, instant) => (instant > latest ? instant : latest));

  const journeyNotStarted = requested.length === 0;
  const anyEvidenced = evidenced.length > 0;
  const allRequestedEvidenced = requested.length > 0 && pendingDelivery.length === 0;

  const stages: ConnectionJourneyStage[] = [
    {
      stage: "observed",
      state: lastObservedAt === null ? "waiting" : "reached",
      facts:
        lastObservedAt === null
          ? ["No device observations have been recorded yet."]
          : [`Latest device observation ${lastObservedAt}.`],
    },
    {
      stage: "requested",
      state: journeyNotStarted ? "waiting" : "reached",
      facts:
        requested.length === 0
          ? ["No connectivity request exists yet."]
          : requested.map((subject) => `Request exists for ${subjectLabel(subject)}.`),
    },
  ];

  // The confirmed chain (accepted -> reserved -> path active) is asserted to
  // the customer ONLY through linked delivery evidence: while no evidence is
  // linked, the intermediate network steps honestly render as "waiting";
  // once delivery is evidenced, they render as confirmed by that evidence.
  const chainState: ConnectionStageState = journeyNotStarted
    ? "not-recorded"
    : anyEvidenced
      ? "reached"
      : "waiting";
  const chainFacts = journeyNotStarted
    ? (["The journey has not started — nothing has been requested yet."] as const)
    : anyEvidenced
      ? (["Confirmed by the linked delivery evidence."] as const)
      : ([
          "RoamLink is working with the network; these steps are confirmed when delivery evidence is linked.",
        ] as const);

  stages.push(
    { stage: "accepted", state: chainState, facts: [...chainFacts] },
    { stage: "reserved", state: chainState, facts: [...chainFacts] },
    { stage: "path-active", state: chainState, facts: [...chainFacts] },
    {
      stage: "delivery",
      state: journeyNotStarted ? "not-recorded" : allRequestedEvidenced ? "reached" : "waiting",
      facts:
        requested.length === 0
          ? ["Nothing is requested yet, so there is nothing to deliver."]
          : overview.subjects.map((subject) => {
              const evidence =
                subject.deliveryEvidenceState === "EVIDENCED"
                  ? subject.evidence?.freshness.freshnessState ?? "evidence linked, freshness unknown"
                  : "no delivery evidence linked";
              return `${subjectLabel(subject)}: ${evidence}.`;
            }),
    },
    {
      stage: "recovered",
      state: "not-recorded",
      facts: [
        "This read does not assert recovery. What RoamLink did — including any recovery — is recorded in Activity.",
      ],
    },
  );

  return { stages, pendingDelivery, requested, lastObservedAt };
}

/**
 * The degraded conditions that warrant the support escape hatch
 * (spec/ux-architecture.md §11: support is reachable from every
 * degraded/error state). Fresh delivery is the only non-degraded state.
 */
export function isDegradedShellState(state: string): boolean {
  return state === "evidenced-stale" || state === "evidenced-unknown" || state === "unevidenced";
}
