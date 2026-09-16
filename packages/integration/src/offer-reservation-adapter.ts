/**
 * The ADCOS offer/reservation adapter (RL-032, spec/adcos-integration.md §3).
 *
 * Implements the RoamLink-facing offer/reservation surface STRICTLY over the
 * @roamlink/adcos v2 route table:
 *
 *  - Offers DISCOVERY is NOT exposed by the v2 public surface (there is no
 *    GET offers route; offer discovery is ADCOS-internal until it publishes
 *    one). `discoverOffers` therefore degrades to a TYPED unsupported error
 *    (`route-unknown`, adapted onto the RoamLink domain kind by callers via
 *    mapAdcosFailure) instead of calling an undocumented endpoint (§3:
 *    "RoamLink must not call undocumented or internal ADCOS endpoints").
 *  - Reservations are the v2 LEASE surface (spec §2 models the canonical
 *    lifecycle as "Reservation/Lease"): create = `lease_grant`, read =
 *    `lease_get`/`lease_list`, renew = `lease_renew`, revoke =
 *    `lease_revoke`. No parallel reservation resource or state vocabulary is
 *    invented (RL-LOCK-001).
 *  - Lifecycle-state reads: `intent_lifecycle_get` plus the opaque contract
 *    documents; RoamLink never redefines lifecycle semantics.
 *  - Usage reads: `contract_usage_get` and `contract_assurance_get`.
 *  - Billing/commercial reference reads are NOT exposed by the v2 public
 *    surface (no billing route; contract documents are opaque) and degrade
 *    to the same typed unsupported error. ADCOS commercial settlement stays
 *    authoritative and external (RL-LOCK-008).
 *
 * Every mutation builds the full §5 command envelope with a DETERMINISTIC
 * idempotency key derived from (operation, subject, canonical payload
 * digest) - see command-context.ts. Retries after timeout, connection loss
 * or duplicate delivery are therefore safe: re-issuing the same logical
 * command (same payload) derives the SAME key and ADCOS absorbs the replay.
 * Callers wanting stable command ids across retries pass `context.commandId`
 * (the durable outbox owns command identity in production).
 */
import { parseUtcInstant } from "@roamlink/contracts";
import type { CanonicalJsonValue, CommandEnvelope, UtcInstant } from "@roamlink/contracts";
import type {
  AdcosClient,
  AdcosContractAssuranceDocument,
  AdcosContractDocument,
  AdcosContractUsageDocument,
  AdcosIntentLifecycleDocument,
  AdcosLeaseDocument,
  AdcosListQuery,
  AdcosPage,
  AdcosMutationContext,
} from "@roamlink/adcos";
import type {
  AdcosActivationRequest,
  AdcosLeaseRenewal,
  AdcosLeaseRequest,
  AdcosLeaseRevocation,
  AdcosOfferSelection,
  AdcosTerminationRequest,
} from "@roamlink/adcos";
import {
  parseAdcosActivationRequest,
  parseAdcosLeaseRenewal,
  parseAdcosLeaseRequest,
  parseAdcosLeaseRevocation,
  parseAdcosOfferSelection,
  parseAdcosTerminationRequest,
} from "@roamlink/adcos";
import { AdcosApiError } from "@roamlink/adcos";
import type { Clock, IdGenerator } from "@roamlink/testkit";
import type { AdcosCompatibilityState } from "./compatibility.js";
import {
  buildAdcosCommand,
  type AdcosCommandContext,
  type BuiltAdcosCommand,
} from "./command-context.js";
import { mapAdcosFailure } from "./error-mapping.js";

// --------------------------------------------------------------------------------
// The v2 surface support descriptor (declarative capability surface)
// --------------------------------------------------------------------------------

/**
 * What the pinned v2 public surface exposes for the offer/reservation
 * surface. Exported so downstream services can probe capabilities without
 * catching errors. Unavailable surfaces degrade to typed unsupported errors
 * (RL-032) and are `false` here.
 */
export const ADCOS_V2_SURFACE_SUPPORT = Object.freeze({
  /** GET offers discovery: NOT in the v2 route table. */
  offersDiscovery: false,
  /** Offers selection (offers_accept): exposed. */
  offersSelection: true,
  /** Contract activation (contract_activate): exposed. */
  contractActivation: true,
  /** Contract termination (contract_terminate): exposed. */
  contractTermination: true,
  /** Reservation create/read/renew/revoke via the v2 lease surface: exposed. */
  reservationViaLease: true,
  /** Intent lifecycle-state reads: exposed. */
  intentLifecycleReads: true,
  /** Contract usage reads: exposed. */
  contractUsageReads: true,
  /** Contract assurance reads: exposed. */
  contractAssuranceReads: true,
  /** Billing/commercial reference reads: NOT in the v2 route table. */
  billingCommercialReferenceReads: false,
});

function unsupportedRoute(surface: string, explanation: string): never {
  // Degrade to the closed ADCOS taxonomy's `route-unknown` code - the same
  // code a v2 server answers for undocumented routes. No parallel kinds.
  throw new AdcosApiError(
    "route-unknown",
    `ADCOS v2 public surface does not expose '${surface}': ${explanation} RoamLink never calls undocumented ADCOS endpoints (spec/adcos-integration.md §3)`,
  );
}

// --------------------------------------------------------------------------------
// The adapter
// --------------------------------------------------------------------------------

export interface AdcosOfferReservationAdapterDeps {
  readonly client: AdcosClient;
  readonly clock: Clock;
  readonly commandIds: IdGenerator;
  readonly compatibility: AdcosCompatibilityState;
}

/** A successful command result: the returned document + the §5 envelope. */
export interface AdcosCommandOk<TDocument> {
  readonly document: TDocument;
  readonly envelope: CommandEnvelope;
  readonly attempt: number;
}

/**
 * The offer/reservation adapter. Mutations: select offers, activate and
 * terminate contracts, grant/renew/revoke leases. Reads: contracts, usage,
 * assurance, leases, intent lifecycle. Typed-unsupported surfaces: offers
 * discovery, billing/commercial reference reads.
 */
export class AdcosOfferReservationAdapter {
  readonly client: AdcosClient;
  readonly compatibility: AdcosCompatibilityState;
  readonly clock: Clock;
  readonly commandIds: IdGenerator;

  constructor(deps: AdcosOfferReservationAdapterDeps) {
    this.client = deps.client;
    this.compatibility = deps.compatibility;
    this.clock = deps.clock;
    this.commandIds = deps.commandIds;
  }

  // --- offers -------------------------------------------------------------------

  /**
   * Offers discovery. NOT exposed by the pinned v2 route table (there is no
   * GET offers route); rejects with a typed `route-unknown` error. Offer
   * selection is the exposed surface (`selectOffers`).
   */
  async discoverOffers(): Promise<never> {
    unsupportedRoute(
      "offers discovery",
      "ADCOS v2 publishes no offers list/read route; eligibility and offer assembly happen inside ADCOS after intent creation, and RoamLink observes the accepted-offer result (contract) plus webhook signals.",
    );
  }

  /**
   * Selects offers on an intent (`POST intents/{id}/offers`, operation
   * `offers_accept`): creates the ADCOS contract.
   */
  async selectOffers(
    intentId: string,
    selection: AdcosOfferSelection,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosContractDocument>> {
    const request = parseAdcosOfferSelection(selection);
    return this.mutate("offers_accept", intentId, request, context, (mutation) =>
      this.client.acceptOffers(intentId as never, request, mutation),
    );
  }

  // --- contracts ------------------------------------------------------------------

  /** Activates a contract (`POST intents/{id}/activation`). */
  async activateContract(
    intentId: string,
    activation: AdcosActivationRequest,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosContractDocument>> {
    const request = parseAdcosActivationRequest(activation);
    return this.mutate("contract_activate", intentId, request, context, (mutation) =>
      this.client.activateContract(intentId as never, request, mutation),
    );
  }

  /** Terminates a contract (`POST contracts/{id}/termination`). */
  async terminateContract(
    contractId: string,
    termination: AdcosTerminationRequest,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosContractDocument>> {
    const request = parseAdcosTerminationRequest(termination);
    return this.mutate("contract_terminate", contractId, request, context, (mutation) =>
      this.client.terminateContract(contractId as never, request, mutation),
    );
  }

  async getContract(contractId: string): Promise<AdcosContractDocument> {
    try {
      return await this.client.getContract(contractId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  async listContracts(query?: AdcosListQuery): Promise<AdcosPage<AdcosContractDocument>> {
    try {
      return await this.client.listContracts(query);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  // --- reservations (the v2 lease surface) ------------------------------------------

  /**
   * Creates a reservation (`POST contracts/{id}/leases`, operation
   * `lease_grant`). v2 models reservations as leases (spec §2
   * "Reservation/Lease"); no parallel reservation resource is invented.
   */
  async createReservation(
    contractId: string,
    request: AdcosLeaseRequest,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosLeaseDocument>> {
    const parsed = parseAdcosLeaseRequest(request);
    return this.mutate("lease_grant", contractId, parsed, context, (mutation) =>
      this.client.grantLease(contractId as never, parsed, mutation),
    );
  }

  /** Reads one reservation (`GET leases/{id}`). */
  async readReservation(leaseId: string): Promise<AdcosLeaseDocument> {
    try {
      return await this.client.getLease(leaseId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  async listReservations(query?: AdcosListQuery): Promise<AdcosPage<AdcosLeaseDocument>> {
    try {
      return await this.client.listLeases(query);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  /** Renews a reservation (`POST leases/{id}/renewal`). */
  async renewReservation(
    leaseId: string,
    renewal: AdcosLeaseRenewal,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosLeaseDocument>> {
    const request = parseAdcosLeaseRenewal(renewal);
    return this.mutate("lease_renew", leaseId, request, context, (mutation) =>
      this.client.renewLease(leaseId as never, request, mutation),
    );
  }

  /** Revokes a reservation (`POST leases/{id}/revocation`). */
  async revokeReservation(
    leaseId: string,
    revocation: AdcosLeaseRevocation,
    context: AdcosCommandContext,
  ): Promise<AdcosCommandOk<AdcosLeaseDocument>> {
    const request = parseAdcosLeaseRevocation(revocation);
    return this.mutate("lease_revoke", leaseId, request, context, (mutation) =>
      this.client.revokeLease(leaseId as never, request, mutation),
    );
  }

  // --- lifecycle-state reads ----------------------------------------------------------

  /** Reads the intent lifecycle (`GET intents/{id}/lifecycle`). */
  async readIntentLifecycle(intentId: string): Promise<AdcosIntentLifecycleDocument> {
    try {
      return await this.client.getIntentLifecycle(intentId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  // --- usage / assurance reads ---------------------------------------------------------

  /** Reads contract usage (`GET contracts/{id}/usage`). */
  async readContractUsage(contractId: string): Promise<AdcosContractUsageDocument> {
    try {
      return await this.client.getContractUsage(contractId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  /** Reads contract assurance (`GET contracts/{id}/assurance`). */
  async readContractAssurance(contractId: string): Promise<AdcosContractAssuranceDocument> {
    try {
      return await this.client.getContractAssurance(contractId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  // --- billing/commercial reference reads ----------------------------------------------

  /**
   * Billing/commercial reference reads. NOT exposed by the pinned v2 route
   * table; rejects with a typed `route-unknown` error. ADCOS commercial
   * settlement remains authoritative and external (RL-LOCK-008); RoamLink
   * customer billing is a separate concern (RL-022/RL-023).
   */
  async readBillingCommercialReference(): Promise<never> {
    unsupportedRoute(
      "billing/commercial reference reads",
      "ADCOS v2 publishes no billing/commercial route; contract documents are opaque and RoamLink must not invent commercial fields on them.",
    );
  }

  // --- shared mutation pipeline -----------------------------------------------------------

  /**
   * Builds the §5 command for an operation WITHOUT I/O (deterministic
   * idempotency key; envelope is auditable before dispatch).
   */
  buildCommand(
    operation: string,
    subjectId: string,
    payload: unknown,
    context: AdcosCommandContext,
    at?: UtcInstant | string,
  ): BuiltAdcosCommand {
    return buildAdcosCommand({
      operation,
      subjectId,
      payload: payload as CanonicalJsonValue,
      context,
      at: at !== undefined ? parseUtcInstant(at) : this.clock.now(),
      commandId: this.commandIds.next(),
    });
  }

  private async mutate<TDocument>(
    operation: string,
    subjectId: string,
    payload: object,
    context: AdcosCommandContext,
    call: (mutation: AdcosMutationContext) => Promise<TDocument>,
  ): Promise<AdcosCommandOk<TDocument>> {
    this.compatibility.assertMutationsAllowed();
    const command = this.buildCommand(operation, subjectId, payload, context);
    try {
      const document = await call({
        idempotencyKey: command.envelope.idempotencyKey,
        correlationId: command.envelope.correlationId,
      });
      return Object.freeze({
        document,
        envelope: command.envelope,
        attempt: command.envelope.retry.attempt,
      });
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }
}

export type { AdcosCommandContext, BuiltAdcosCommand };
