/**
 * The commerce-side connectivity read model (RL-023).
 *
 * PURE projection over (commercial subject facts + connectivity reference
 * record). This is the ONLY sanctioned way the commerce surface answers
 * "what connectivity does this order/subscription have?" - and the answer
 * is STRUCTURAL: the subject's own commercial state, the reference's
 * delivery-evidence state, and the linked evidence's freshness facts,
 * presented side by side. There is deliberately NO combined/derived
 * "connectivity status" field here: combining states is a READ-MODEL
 * concern of the customer surfaces (RL-013 / Wave 4 apps), which must
 * expose the underlying states and evidence, never an opaque blend
 * (spec/data-model.md "State separation").
 *
 * Freshness is re-evaluated AT THE QUERY INSTANT from the recorded
 * timestamps (contracts' evaluateFreshnessState): FRESH degrades to STALE
 * monotonically as the guarantee expires; missing timestamps present as
 * UNKNOWN - a valid state, never a guess, never hidden (RL-LOCK-010).
 */
import {
  evaluateFreshnessState,
  type FreshnessState,
  type UtcInstant,
} from "@roamlink/contracts";

import type { DeliveryEvidence, DeliveryEvidenceState } from "./delivery-evidence.js";
import type { ConnectivityReferenceRecord } from "./reference.js";

/** The freshness facts of linked evidence, re-evaluated at the query instant. */
export interface EvidenceFreshnessView {
  readonly observedAt: UtcInstant | null;
  readonly receivedAt: UtcInstant | null;
  readonly freshUntil: UtcInstant | null;
  /** Re-evaluated at `presentedAt` (FRESH | STALE | UNKNOWN). */
  readonly freshnessState: FreshnessState;
  /** The state as recorded when the evidence was linked (audit). */
  readonly recordedFreshnessState: FreshnessState;
}

/**
 * The honest connectivity view of one commercial subject. Every field is
 * an underlying fact; nothing is invented.
 */
export interface SubjectConnectivityView {
  readonly subjectType: "order" | "subscription";
  readonly subjectId: string;
  /** The subject's own commercial state (order_state / customer_subscription_state). */
  readonly commercialState: string;
  /** Whether a reference exists and its lifecycle (active | retired | none). */
  readonly referenceStatus: "active" | "retired" | "none";
  /** The reference's delivery-evidence state (UNEVIDENCED | EVIDENCED). */
  readonly deliveryEvidenceState: DeliveryEvidenceState;
  /** Present iff evidence is linked; freshness re-evaluated at presentedAt. */
  readonly evidence: {
    readonly evidenceClass: DeliveryEvidence["evidenceClass"];
    readonly canonicalResourceType: DeliveryEvidence["canonicalResourceType"];
    readonly canonicalResourceId: DeliveryEvidence["canonicalResourceId"];
    readonly sourceVersion: DeliveryEvidence["sourceVersion"];
    readonly eventId: DeliveryEvidence["eventId"];
    readonly payloadDigest: DeliveryEvidence["payloadDigest"];
    readonly freshness: EvidenceFreshnessView;
  } | null;
  /** The instant this view was computed at (freshness evaluation point). */
  readonly presentedAt: UtcInstant;
}

/**
 * Computes the honest connectivity view. Pure: same inputs -> same view.
 *
 * @param subject the commercial subject facts (from the subject reader)
 * @param reference the subject's reference record, when one exists
 * @param at the query instant (freshness is evaluated against it)
 */
export function describeSubjectConnectivity(
  subject: {
    readonly subjectType: "order" | "subscription";
    readonly subjectId: string;
    readonly commercialState: string;
  },
  reference: ConnectivityReferenceRecord | undefined,
  at: UtcInstant,
): SubjectConnectivityView {
  if (reference === undefined) {
    return Object.freeze({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      commercialState: subject.commercialState,
      referenceStatus: "none",
      deliveryEvidenceState: "UNEVIDENCED",
      evidence: null,
      presentedAt: at,
    });
  }
  if (reference.subjectType !== subject.subjectType || reference.subjectId !== subject.subjectId) {
    throw new Error(
      "describeSubjectConnectivity: the reference does not belong to the given subject (caller bug)",
    );
  }
  const evidence = reference.evidence;
  return Object.freeze({
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    commercialState: subject.commercialState,
    referenceStatus: reference.status,
    deliveryEvidenceState: reference.deliveryEvidenceState,
    evidence:
      evidence === undefined
        ? null
        : Object.freeze({
            evidenceClass: evidence.evidenceClass,
            canonicalResourceType: evidence.canonicalResourceType,
            canonicalResourceId: evidence.canonicalResourceId,
            sourceVersion: evidence.sourceVersion,
            eventId: evidence.eventId,
            payloadDigest: evidence.payloadDigest,
            freshness: Object.freeze({
              observedAt: evidence.observedAt,
              receivedAt: evidence.receivedAt,
              freshUntil: evidence.freshUntil,
              freshnessState: evaluateFreshnessState(
                {
                  observedAt: evidence.observedAt,
                  receivedAt: evidence.receivedAt,
                  freshUntil: evidence.freshUntil,
                },
                at,
              ),
              recordedFreshnessState: evidence.freshnessState,
            }),
          }),
    presentedAt: at,
  });
}
