/**
 * The connectivity-reference service (RL-023): envelope-gated, idempotent,
 * CAS-aware use cases over the reference aggregate, plus the committed
 * read models.
 *
 * Discipline:
 *  - every mutating command takes a full §5 CommandEnvelope; the envelope's
 *    tenant IS the tenant of every read and write (RL-LOCK-018);
 *  - idempotency (RL-LOCK-014) via the domain-commerce ledger (local
 *    mirror of the Wave-0 discipline; this package may depend on
 *    domain-commerce, and reusing its ledger keeps one idempotency
 *    semantics across the commerce surface);
 *  - the subject MUST exist in the command tenant (verified through the
 *    CommercialSubjectReader port - cross-subject or cross-tenant links
 *    fail closed);
 *  - evidence enters ONLY through the read-only DeliveryEvidenceSource
 *    port: linking reads the current projection observation, validates the
 *    §8 shape and snapshots it; a MISSING projection is a typed
 *    NotFoundError (absence is presented, never guessed into evidence,
 *    RL-LOCK-010);
 *  - RL-LOCK-008 ("payment is not delivery"): nothing here reads payment
 *    state, and payment state never influences evidence. A fully paid
 *    order with no linked evidence is presented as exactly that.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  admitCommerceCommand,
  commitCommerceCommand,
  type CommerceIdempotencyLedger,
} from "@roamlink/domain-commerce";

import { ConnectivityReferenceEvent } from "./events.js";
import type { ConnectivityReferenceEventRecord } from "./events.js";
import { parseDeliveryEvidence } from "./delivery-evidence.js";
import { isLinkableCanonicalResourceType } from "./delivery-evidence.js";
import type { DeliveryEvidenceSource } from "./evidence-source.js";
import { ConnectivityReference } from "./reference.js";
import type { ConnectivityReferenceRecord } from "./reference.js";
import type {
  CommercialSubjectReader,
  ConnectivityReferenceAccessPolicy,
  ConnectivityReferenceSession,
  ConnectivityReferenceStore,
} from "./ports.js";
import { describeSubjectConnectivity } from "./read-model.js";
import type { SubjectConnectivityView } from "./read-model.js";

/** Dependencies of the reference service. */
export interface ConnectivityReferenceServiceDeps {
  readonly store: ConnectivityReferenceStore;
  readonly policy: ConnectivityReferenceAccessPolicy;
  readonly ledger: CommerceIdempotencyLedger;
  /** The commercial-subject seam (bound to domain-commerce read views). */
  readonly subjects: CommercialSubjectReader;
  /** The read-only ADCOS-derived evidence seam (bound to the RL-034 reader). */
  readonly evidenceSource: DeliveryEvidenceSource;
  /** Explicit time source (never ambient; deterministic in tests). */
  readonly now: () => UtcInstant;
  /** Supplies fresh entity ids (deterministic in tests). */
  readonly generateId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`connectivity reference command rejected: ${issue}`, {
    reason: "CONNECTIVITY_REFERENCE_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

async function recordReferenceEvent(
  session: ConnectivityReferenceSession,
  envelope: CommandEnvelope,
  aggregateId: string,
  aggregateRevision: number,
  transition: ConnectivityReferenceEventRecord["transition"],
  payload: object,
  at: UtcInstant,
  generateId: () => string,
): Promise<void> {
  const chain = await session.events.listForAggregate(envelope.tenantId, aggregateId);
  const event = new ConnectivityReferenceEvent({
    eventId: generateId(),
    tenantId: envelope.tenantId,
    aggregateId,
    aggregateRevision,
    sequence: chain.length + 1,
    transition,
    payload,
    actorId: envelope.actorId,
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    occurredAt: at,
  });
  await session.events.append(event.toRecord());
}

/** Reference-model use cases. */
export class ConnectivityReferenceService {
  readonly #deps: ConnectivityReferenceServiceDeps;

  constructor(deps: ConnectivityReferenceServiceDeps) {
    this.#deps = deps;
  }

  private expectRevision(expected: number, current: number, label: string): void {
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      commandInvalid(`${label} must be a positive integer (the observed revision)`);
    }
    if (expected !== current) {
      throw new ConflictError(
        `${label} optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the reference changed concurrently); re-read and retry - never overwrite silently`,
        { reason: "REVISION_CONFLICT" },
      );
    }
  }

  /**
   * Creates an ACTIVE, UNEVIDENCED reference for a commercial subject
   * (connectivity_reference:write). The subject must exist in the command
   * tenant; one live reference per subject (typed conflict otherwise).
   */
  async createReference(
    envelope: CommandEnvelope,
    input: {
      readonly referenceId: string;
      readonly subjectType: "order" | "subscription";
      readonly subjectId: string;
    },
  ): Promise<{
    readonly referenceId: string;
    readonly deliveryEvidenceState: string;
    readonly revision: number;
  }> {
    type Outcome = {
      readonly referenceId: string;
      readonly deliveryEvidenceState: string;
      readonly revision: number;
    };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      "connectivity_reference:write",
      this.#deps.now(),
    );

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const subject = await this.#findSubject(
        session,
        envelope.tenantId,
        input.subjectType,
        input.subjectId,
      );
      const existing = await session.references.findBySubject(
        envelope.tenantId,
        input.subjectType,
        input.subjectId,
      );
      if (existing !== undefined && existing.status === "active") {
        throw new ConflictError(
          "the subject already has an active connectivity reference (one live reference per subject; retire it before creating a new one)",
          { reason: "REFERENCE_ALREADY_EXISTS" },
        );
      }
      const reference = new ConnectivityReference({
        referenceId: input.referenceId,
        tenantId: envelope.tenantId,
        subjectType: input.subjectType,
        subjectId: subject.subjectId,
        status: "active",
        deliveryEvidenceState: "UNEVIDENCED",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordReferenceEvent(
        session,
        envelope,
        reference.referenceId,
        reference.revision,
        "connectivity_reference.created",
        {
          record: reference.toRecord(),
          subjectCommercialState: subject.commercialState,
        },
        at,
        this.#deps.generateId,
      );
      await session.references.save(reference.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        referenceId: reference.referenceId,
        deliveryEvidenceState: reference.deliveryEvidenceState,
        revision: reference.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * Links (or replaces) the delivery evidence of an ACTIVE reference from
   * the current projection observation (connectivity_reference:write; CAS
   * via expectedRevision). The observation is snapshotted immutably; the
   * previous snapshot's digest is retained on the event chain.
   *
   * A MISSING projection is a typed NotFoundError: absence of evidence is
   * presented (the reference stays/becomes UNEVIDENCED only through
   * explicit state, never through a guess).
   */
  async linkDeliveryEvidence(
    envelope: CommandEnvelope,
    input: {
      readonly referenceId: string;
      readonly expectedRevision: number;
      readonly canonicalResourceType: string;
      readonly canonicalResourceId: string;
    },
  ): Promise<{
    readonly referenceId: string;
    readonly deliveryEvidenceState: string;
    readonly freshnessState: string;
    readonly revision: number;
  }> {
    type Outcome = {
      readonly referenceId: string;
      readonly deliveryEvidenceState: string;
      readonly freshnessState: string;
      readonly revision: number;
    };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      "connectivity_reference:write",
      this.#deps.now(),
    );

    if (!isLinkableCanonicalResourceType(input.canonicalResourceType)) {
      commandInvalid("canonicalResourceType must be one of the linkable canonical resource types");
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const reference = await this.#findReference(session, envelope.tenantId, input.referenceId);
      this.expectRevision(input.expectedRevision, reference.revision, "reference");
      if (reference.status !== "active") {
        throw new ConflictError("only an active reference can link evidence (retired is terminal)", {
          reason: "REFERENCE_RETIRED",
        });
      }

      const observation = await this.#deps.evidenceSource.get(
        input.canonicalResourceType,
        input.canonicalResourceId,
      );
      if (observation === null) {
        throw new NotFoundError(
          "no ADCOS-derived projection exists for the canonical resource (absence of evidence is a valid state - it is presented, never linked as a guess)",
          { reason: "EVIDENCE_PROJECTION_NOT_FOUND" },
        );
      }
      const evidence = parseDeliveryEvidence({
        evidenceClass: observation.evidence_class,
        observedAt: observation.observed_at,
        receivedAt: observation.received_at,
        freshUntil: observation.fresh_until,
        freshnessState: observation.freshness_state,
        canonicalResourceType: observation.canonical_resource_type,
        canonicalResourceId: observation.canonical_resource_id,
        sourceVersion: observation.source_version,
        eventId: observation.event_id,
        payloadDigest: observation.payload_digest,
        payload: observation.payload,
      });

      const next = reference.link(evidence, at);
      await recordReferenceEvent(
        session,
        envelope,
        reference.referenceId,
        next.revision,
        "connectivity_reference.evidence_linked",
        {
          record: next.toRecord(),
          previousEvidence:
            reference.evidence === undefined
              ? null
              : {
                  canonicalResourceType: reference.evidence.canonicalResourceType,
                  canonicalResourceId: reference.evidence.canonicalResourceId,
                  payloadDigest: reference.evidence.payloadDigest,
                  freshnessState: reference.evidence.freshnessState,
                },
        },
        at,
        this.#deps.generateId,
      );
      await session.references.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        referenceId: next.referenceId,
        deliveryEvidenceState: next.deliveryEvidenceState,
        freshnessState: evidence.freshnessState,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** active -> retired (connectivity_reference:write; CAS via expectedRevision). */
  async retireReference(
    envelope: CommandEnvelope,
    input: { readonly referenceId: string; readonly expectedRevision: number },
  ): Promise<{
    readonly referenceId: string;
    readonly status: string;
    readonly revision: number;
  }> {
    type Outcome = { readonly referenceId: string; readonly status: string; readonly revision: number };
    const admission = await admitCommerceCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      "connectivity_reference:write",
      this.#deps.now(),
    );

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const reference = await this.#findReference(session, envelope.tenantId, input.referenceId);
      this.expectRevision(input.expectedRevision, reference.revision, "reference");
      const next = reference.retire(at);
      await recordReferenceEvent(
        session,
        envelope,
        reference.referenceId,
        next.revision,
        "connectivity_reference.retired",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.references.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        referenceId: next.referenceId,
        status: next.status,
        revision: next.revision,
      });
      await commitCommerceCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- read models --------------------------------------------------------------

  /**
   * The honest connectivity view of a subject (connectivity_reference:read):
   * commercial state + reference + evidence freshness, presented side by
   * side - never a combined opaque status. Freshness is re-evaluated at
   * `at` (default: the service clock).
   */
  async describeSubject(
    tenantId: TenantId,
    subjectType: "order" | "subscription",
    subjectId: string,
    at?: UtcInstant,
  ): Promise<SubjectConnectivityView> {
    const subject =
      subjectType === "order"
        ? await this.#deps.subjects.findOrder(tenantId, subjectId)
        : await this.#deps.subjects.findSubscription(tenantId, subjectId);
    if (subject === undefined || subject.subjectType !== subjectType) {
      throw new NotFoundError("commercial subject not found in the read tenant", {
        reason: "SUBJECT_NOT_FOUND",
      });
    }
    const reference = await this.#deps.store.read.references.findBySubject(
      tenantId,
      subjectType,
      subjectId,
    );
    return describeSubjectConnectivity(subject, reference, at ?? this.#deps.now());
  }

  /** The full observation history of a reference (audit, RL-LOCK-010). */
  async referenceHistory(
    tenantId: TenantId,
    referenceId: string,
  ): Promise<readonly ConnectivityReferenceEventRecord[]> {
    return this.#deps.store.read.events.listForAggregate(tenantId, referenceId);
  }

  // --- internal helpers ---------------------------------------------------------

  async #findSubject(
    session: ConnectivityReferenceSession,
    tenantId: TenantId,
    subjectType: "order" | "subscription",
    subjectId: string,
  ) {
    const subject =
      subjectType === "order"
        ? await this.#deps.subjects.findOrder(tenantId, subjectId)
        : await this.#deps.subjects.findSubscription(tenantId, subjectId);
    if (subject === undefined) {
      throw new NotFoundError("commercial subject not found in the command tenant", {
        reason: "SUBJECT_NOT_FOUND",
      });
    }
    return subject;
  }

  async #findReference(
    session: ConnectivityReferenceSession,
    tenantId: TenantId,
    referenceId: string,
  ): Promise<ConnectivityReference> {
    const record: ConnectivityReferenceRecord | undefined =
      await session.references.findById(tenantId, referenceId);
    if (record === undefined) {
      throw new NotFoundError("connectivity reference not found in the command tenant", {
        reason: "REFERENCE_NOT_FOUND",
      });
    }
    return ConnectivityReference.fromRecord(record);
  }
}
