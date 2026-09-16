/**
 * The delivery-evidence source port (RL-023).
 *
 * The ONLY seam through which ADCOS-derived observations enter the
 * commerce-to-connectivity reference model. The production binding adapts
 * the ADCOS projection engine's READ surface (RL-034, spec §8: "Only the
 * reconciler/integration boundary may write ADCOS-derived projections;
 * everyone else consumes the read surface") - see ./adapters.ts. The port
 * deliberately speaks the §8 SNAKE_CASE field names so the projection
 * records bind STRUCTURALLY, with no re-interpretation layer that could
 * drop provenance, freshness or digests (RL-LOCK-010).
 *
 * This port is READ-ONLY: the reference model never writes projections and
 * never commands ADCOS (RL-LOCK-005 - no duplicate path/routing authority).
 */
import type {
  CanonicalJsonValue,
  Digest,
  EvidenceClass,
  FreshnessState,
  Revision,
  UtcInstant,
} from "@roamlink/contracts";

/**
 * One ADCOS-derived observation in the §8 projection shape (structural
 * mirror of the projection record; the adapter guarantees compatibility
 * and a conformance test pins the vocabularies together).
 */
export interface DeliveryEvidenceObservation {
  readonly source_authority: "adcos" | "roamlink";
  readonly canonical_resource_type: string;
  readonly canonical_resource_id: string;
  readonly source_version: Revision | null;
  readonly event_id: string | null;
  readonly payload_digest: Digest;
  readonly observed_at: UtcInstant | null;
  readonly received_at: UtcInstant | null;
  readonly fresh_until: UtcInstant | null;
  readonly freshness_state: FreshnessState;
  readonly evidence_class: EvidenceClass;
  readonly payload: CanonicalJsonValue;
}

/**
 * The read-only evidence source. Returns null when no projection exists
 * for the canonical resource - ABSENCE IS NOT EVIDENCE (RL-LOCK-010): the
 * caller must present the absence, never guess a state from it.
 */
export interface DeliveryEvidenceSource {
  get(
    canonicalResourceType: string,
    canonicalResourceId: string,
  ): Promise<DeliveryEvidenceObservation | null>;
}
