/**
 * The ADCOS client seam (RL-030) - TYPES ONLY.
 *
 * One method per v2 route, requests/responses typed, idempotency key
 * REQUIRED on every mutation, environment-scoped. RL-031+ implements this
 * interface (HTTP transport, mapping, retries); nothing here performs I/O.
 *
 * Failures: methods reject with {@link ../errors.js.AdcosApiError} carrying
 * the closed v2 error code and its pinned retryable flag (plus transport-
 * level errors wrapped by the implementation).
 *
 * RL-LOCK-004/005 reminder: there is NO session or NetworkPath resource in
 * the v2 public surface - do not add such methods here. Session/path-ish
 * read models are derived projections (RL-034) from contract lifecycle,
 * usage and assurance reads.
 */
import type {
  AdcosApiVersion,
  AdcosContractRef,
  AdcosIntentRef,
  AdcosLeaseRef,
  AdcosResourceId,
  CorrelationId,
  IdempotencyKey,
} from "@roamlink/contracts";
import type { AdcosEnvironment } from "./environments.js";
import type { AdcosListQuery, AdcosPage } from "./pagination.js";
import type {
  AdcosActivationRequest,
  AdcosIntentRequest,
  AdcosLeaseRenewal,
  AdcosLeaseRequest,
  AdcosLeaseRevocation,
  AdcosOfferSelection,
  AdcosTerminationRequest,
  AdcosWebhookEndpointRequest,
} from "./requests.js";
import type {
  AdcosApplicationDocument,
  AdcosContractAssuranceDocument,
  AdcosContractDocument,
  AdcosContractUsageDocument,
  AdcosIntentDocument,
  AdcosIntentLifecycleDocument,
  AdcosLeaseDocument,
  AdcosWebhookDeliveryDocument,
  AdcosWebhookEndpointDocument,
} from "./documents.js";

/** Context every mutation call must supply (RL-LOCK-014). */
export interface AdcosMutationContext {
  /** REQUIRED on every mutation; retries must reuse the same key. */
  readonly idempotencyKey: IdempotencyKey;
  /** Optional cross-boundary request correlation. */
  readonly correlationId?: CorrelationId;
}

/**
 * The environment-scoped ADCOS v2 client. Implementations bind to exactly
 * one {@link AdcosEnvironment} and fail closed with `environment-mismatch`
 * when an observed environment disagrees.
 */
export interface AdcosClient {
  /** The environment this client is scoped to. */
  readonly environment: AdcosEnvironment;
  /** The pinned API version this client speaks. */
  readonly apiVersion: AdcosApiVersion;

  // --- application -----------------------------------------------------------

  /** GET application (application_self). */
  getApplication(): Promise<AdcosApplicationDocument>;

  // --- intents ----------------------------------------------------------------

  /** POST intents (intent_create, MUTATION). */
  createIntent(
    request: AdcosIntentRequest,
    mutation: AdcosMutationContext,
  ): Promise<AdcosIntentDocument>;
  /** GET intents. */
  listIntents(query?: AdcosListQuery): Promise<AdcosPage<AdcosIntentDocument>>;
  /** GET intents/{id}. */
  getIntent(intentId: AdcosIntentRef): Promise<AdcosIntentDocument>;
  /** GET intents/{id}/lifecycle. */
  getIntentLifecycle(intentId: AdcosIntentRef): Promise<AdcosIntentLifecycleDocument>;
  /** POST intents/{id}/offers (offers_accept, MUTATION) - creates the contract. */
  acceptOffers(
    intentId: AdcosIntentRef,
    request: AdcosOfferSelection,
    mutation: AdcosMutationContext,
  ): Promise<AdcosContractDocument>;
  /** POST intents/{id}/activation (contract_activate, MUTATION). */
  activateContract(
    intentId: AdcosIntentRef,
    request: AdcosActivationRequest,
    mutation: AdcosMutationContext,
  ): Promise<AdcosContractDocument>;

  // --- contracts (accepted-offer results) --------------------------------------

  /** GET contracts. */
  listContracts(query?: AdcosListQuery): Promise<AdcosPage<AdcosContractDocument>>;
  /** GET contracts/{id}. */
  getContract(contractId: AdcosContractRef): Promise<AdcosContractDocument>;
  /** GET contracts/{id}/usage. */
  getContractUsage(contractId: AdcosContractRef): Promise<AdcosContractUsageDocument>;
  /** GET contracts/{id}/assurance. */
  getContractAssurance(contractId: AdcosContractRef): Promise<AdcosContractAssuranceDocument>;
  /** POST contracts/{id}/termination (MUTATION). */
  terminateContract(
    contractId: AdcosContractRef,
    request: AdcosTerminationRequest,
    mutation: AdcosMutationContext,
  ): Promise<AdcosContractDocument>;
  /** POST contracts/{id}/leases (lease_grant, MUTATION). */
  grantLease(
    contractId: AdcosContractRef,
    request: AdcosLeaseRequest,
    mutation: AdcosMutationContext,
  ): Promise<AdcosLeaseDocument>;

  // --- leases -------------------------------------------------------------------

  /** GET leases. */
  listLeases(query?: AdcosListQuery): Promise<AdcosPage<AdcosLeaseDocument>>;
  /** GET leases/{id}. */
  getLease(leaseId: AdcosLeaseRef): Promise<AdcosLeaseDocument>;
  /** POST leases/{id}/renewal (MUTATION). */
  renewLease(
    leaseId: AdcosLeaseRef,
    request: AdcosLeaseRenewal,
    mutation: AdcosMutationContext,
  ): Promise<AdcosLeaseDocument>;
  /** POST leases/{id}/revocation (MUTATION). */
  revokeLease(
    leaseId: AdcosLeaseRef,
    request: AdcosLeaseRevocation,
    mutation: AdcosMutationContext,
  ): Promise<AdcosLeaseDocument>;

  // --- webhook endpoints ---------------------------------------------------------

  /** GET webhook-endpoints. */
  listWebhookEndpoints(query?: AdcosListQuery): Promise<AdcosPage<AdcosWebhookEndpointDocument>>;
  /** POST webhook-endpoints (MUTATION). */
  createWebhookEndpoint(
    request: AdcosWebhookEndpointRequest,
    mutation: AdcosMutationContext,
  ): Promise<AdcosWebhookEndpointDocument>;
  /** GET webhook-endpoints/{id}. */
  getWebhookEndpoint(endpointId: AdcosResourceId): Promise<AdcosWebhookEndpointDocument>;
  /** GET webhook-endpoints/{id}/deliveries. */
  listWebhookEndpointDeliveries(
    endpointId: AdcosResourceId,
    query?: AdcosListQuery,
  ): Promise<AdcosPage<AdcosWebhookDeliveryDocument>>;
}
