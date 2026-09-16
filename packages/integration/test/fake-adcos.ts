/**
 * The ADCOS fake (spec/adcos-integration.md §10, RL-031/032 test double).
 *
 * Implements the SAME PUBLIC AdcosClient interface as the real client with
 * NO dependency on ADCOS internals - only on the @roamlink/adcos public
 * contract types (state machine, schemas, error taxonomy). It simulates:
 *
 *  - duplicates: idempotency-key replay returns the ORIGINAL response (and
 *    the same event is deliverable multiple times via duplicateFactor);
 *  - reordering: webhook deliveries can be reversed;
 *  - delayed events: deliveries can be withheld until flushed;
 *  - dropped events: deliveries can be suppressed entirely;
 *  - transient failures: injectable AdcosApiError / transport failures, both
 *    BEFORE applying (request failed) and AFTER applying (applied but the
 *    response was lost - the timeout scenario);
 *  - canonical-state changes: silentStateChange() mutates canonical state
 *    WITHOUT emitting any event (reconciliation fodder, RL-035).
 */
import { canonicalizeJson } from "@roamlink/contracts";
import type {
  AdcosApiVersion,
  CorrelationId,
  AdcosEventId,
  AdcosResourceId,
  IdempotencyKey,
  Revision,
  UtcInstant,
} from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  AdcosApiError,
  canTransitionAdcosContractState,
  parseAdcosIntentRequest,
  parseAdcosLeaseRenewal,
  parseAdcosLeaseRequest,
  parseAdcosLeaseRevocation,
  parseAdcosOfferSelection,
  parseAdcosActivationRequest,
  parseAdcosTerminationRequest,
  type AdcosClient,
  type AdcosContractState,
  type AdcosListQuery,
  type AdcosMutationContext,
  type AdcosWebhookEvent,
  type AdcosWebhookEventType,
  type AdcosWebhookResourceKind,
} from "@roamlink/adcos";
import { AdcosTransportError } from "../src/index.js";

// --------------------------------------------------------------------------------
// Fault injection
// --------------------------------------------------------------------------------

import type { AdcosErrorCode } from "@roamlink/adcos";

export type FakeAdcosFaultKind =
  | { readonly kind: "adcos-error"; readonly code: AdcosErrorCode }
  | { readonly kind: "transport"; readonly outcome: "not-sent" | "unknown" };

/**
 * When the injected failure fires:
 *  - "pre"  - before the fake applies the mutation (request failed);
 *  - "post" - after the fake applied and recorded it (applied but the
 *    RESPONSE was lost - the timeout-with-unknown-outcome scenario).
 */
export type FakeAdcosFaultPhase = "pre" | "post";

// --------------------------------------------------------------------------------
// Internal canonical state (the fake's own server-side model)
// --------------------------------------------------------------------------------

interface StoredIntent {
  readonly id: string;
  readonly request: Record<string, unknown>;
  version: number;
  state: AdcosContractState;
}

interface StoredContract {
  readonly id: string;
  readonly intentId: string;
  version: number;
  state: AdcosContractState;
}

interface StoredLease {
  readonly id: string;
  readonly contractId: string;
  version: number;
  status: "granted" | "renewed" | "revoked";
}

/** One emitted webhook event plus its canonical payload. */
export interface FakeAdcosEvent {
  readonly event: AdcosWebhookEvent;
  readonly payload: string;
  /** Monotonic emission order (the "true" order at the source). */
  readonly emissionSequence: number;
}

/** One delivery attempt (the receiver's view). */
export interface FakeAdcosDelivery {
  readonly deliveryId: string;
  /** Per-endpoint monotonic sequence (ordering signal). */
  readonly sequence: number;
  readonly event: AdcosWebhookEvent;
  readonly payload: string;
}

/** Configurable webhook delivery behavior (duplicates/reorder/drop/delay). */
export interface FakeWebhookDeliveryBehavior {
  /** Deliver each event N times (1 = no duplicates). */
  readonly duplicateFactor: number;
  /** Reverse the delivery order ("none" keeps emission order). */
  readonly reorder: "none" | "reverse";
  /** Suppress the first N events entirely (dropped events). */
  readonly dropCount: number;
  /** Withhold the first N events until flushDelayedDeliveries() is called. */
  readonly delayCount: number;
}

export const DEFAULT_FAKE_WEBHOOK_DELIVERY: FakeWebhookDeliveryBehavior = Object.freeze({
  duplicateFactor: 1,
  reorder: "none",
  dropCount: 0,
  delayCount: 0,
});

// --------------------------------------------------------------------------------
// The fake (synchronous internals; the AdcosClient surface stays async)
// --------------------------------------------------------------------------------

export interface FakeAdcosOptions {
  readonly environment?: "sandbox" | "production";
  /** Defaults to the pinned 2.0; pass a mismatched value for gate tests. */
  readonly apiVersion?: AdcosApiVersion;
  /** Deterministic time source for canonical timestamps. */
  readonly now?: () => UtcInstant;
  /** Seed probe resources for the compatibility gate (default true). */
  readonly seedProbe?: boolean;
}

const FIXED_NOW = "2026-01-15T08:30:00.000Z" as UtcInstant;

type IntentDocument = Record<string, unknown>;

export class FakeAdcos implements AdcosClient {
  readonly environment: "sandbox" | "production";
  readonly apiVersion: AdcosApiVersion;

  private readonly now: () => UtcInstant;
  private readonly intents = new Map<string, StoredIntent>();
  private readonly contracts = new Map<string, StoredContract>();
  private readonly leases = new Map<string, StoredLease>();
  private readonly idempotentResponses = new Map<string, { digest: string; response: unknown }>();
  private readonly disabledRoutes = new Set<string>();

  private counter = 0;
  private eventCounter = 0;
  private deliveryCounter = 0;

  private readonly eventLog: FakeAdcosEvent[] = [];
  private readonly delayedEvents: FakeAdcosEvent[] = [];
  private readonly allEvents: FakeAdcosEvent[] = [];
  private readonly lifecycleStateOverrides = new Map<string, string>();
  private omitResourceVersions = false;

  /** Configurable webhook delivery behavior knobs. */
  webhookDelivery: FakeWebhookDeliveryBehavior = { ...DEFAULT_FAKE_WEBHOOK_DELIVERY };

  /** Probe refs for the compatibility gate (when seeded). */
  readonly probeRefs: { readonly intentId: string; readonly contractId: string; readonly leaseId: string } | null =
    null;

  private preFaults: FakeAdcosFaultKind[] = [];
  private postFaults: FakeAdcosFaultKind[] = [];

  constructor(options?: FakeAdcosOptions) {
    this.environment = options?.environment ?? "sandbox";
    this.apiVersion = options?.apiVersion ?? ADCOS_API_VERSION;
    this.now = options?.now ?? (() => FIXED_NOW);
    if (options?.seedProbe !== false) {
      const probe = FakeAdcos.seedProbe(this);
      (this as { probeRefs: typeof probe }).probeRefs = probe;
    }
  }

  // --- fault knobs ---------------------------------------------------------------

  /**
   * Injects upcoming failures. Phase "pre" fails before applying (default);
   * phase "post" applies the mutation and THEN fails - modeling a timeout
   * where the outcome is unknown but the command may have been applied.
   */
  failNext(fault: FakeAdcosFaultKind, options?: { readonly phase?: FakeAdcosFaultPhase; readonly count?: number }): this {
    const phase = options?.phase ?? "pre";
    const count = options?.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      (phase === "pre" ? this.preFaults : this.postFaults).push(fault);
    }
    return this;
  }

  /** Makes an operation permanently answer `route-unknown` (endpoint gone). */
  disableRoute(operation: string): this {
    this.disabledRoutes.add(operation);
    return this;
  }

  /**
   * Removes a canonical resource from the fake's server-side model WITHOUT
   * emitting any event (RL-035/RL-036 knob): subsequent reads answer
   * `resource-unknown` - the authority says the resource is gone.
   */
  forgetResource(
    kind: "connectivity_intent" | "connectivity_contract" | "connectivity_lease",
    resourceId: string,
  ): this {
    const store =
      kind === "connectivity_intent"
        ? this.intents
        : kind === "connectivity_contract"
          ? this.contracts
          : this.leases;
    if (!store.delete(resourceId)) {
      throw new AdcosApiError("resource-unknown", `fake ADCOS: ${kind} resource does not exist`);
    }
    return this;
  }

  /**
   * Makes intent lifecycle reads report an ARBITRARY state string
   * (RL-036 knob): simulates an ADCOS instance speaking a lifecycle
   * vocabulary outside the pinned 13-state contract.
   */
  overrideIntentLifecycleState(intentId: string, state: string): this {
    this.lifecycleStateOverrides.set(intentId, state);
    return this;
  }

  /**
   * Omits `resource_version` from every returned document (RL-036 knob):
   * simulates an ADCOS instance violating the required response fields.
   */
  stripResourceVersions(): this {
    this.omitResourceVersions = true;
    return this;
  }

  private consumeFault(phase: FakeAdcosFaultPhase): void {
    const queue = phase === "pre" ? this.preFaults : this.postFaults;
    const fault = queue.shift();
    if (fault === undefined) return;
    if (fault.kind === "adcos-error") {
      throw new AdcosApiError(fault.code, `injected fake failure (${fault.code})`);
    }
    throw new AdcosTransportError(
      fault.outcome,
      fault.outcome === "unknown"
        ? "injected fake timeout: the request was dispatched but no response arrived (outcome unknown)"
        : "injected fake connection loss: the request was not sent",
    );
  }

  // --- webhook delivery simulation -------------------------------------------------

  /**
   * Mutates canonical state WITHOUT emitting any event (canonical-state
   * change; the projection/reconciliation layers must cope, RL-035).
   */
  silentStateChange(contractId: string, nextState: AdcosContractState): this {
    const contract = this.mustFind(this.contracts, contractId, "contract");
    if (!canTransitionAdcosContractState(contract.state, nextState)) {
      throw new AdcosApiError(
        "invalid-input",
        `silentStateChange: ${contract.state} -> ${nextState} is not a legal v2 contract transition`,
      );
    }
    contract.state = nextState;
    contract.version += 1;
    return this;
  }

  /** Releases delayed events into the delivery view (delayed deliveries). */
  flushDelayedDeliveries(): this {
    for (const delayed of this.delayedEvents) {
      this.eventLog.push(delayed);
    }
    this.delayedEvents.length = 0;
    return this;
  }

  /** Every emitted event in emission order (the source's truth). */
  emittedEvents(): readonly FakeAdcosEvent[] {
    return Object.freeze([...this.allEvents]);
  }

  /**
   * The delivery attempts the receiver would see, honoring the duplicate /
   * reorder / drop knobs. Delayed events appear once flushed.
   */
  deliveries(): readonly FakeAdcosDelivery[] {
    const behavior = this.webhookDelivery;
    const base = [...this.eventLog];
    if (behavior.reorder === "reverse") {
      base.reverse();
    }
    const visible = base.slice(behavior.dropCount);
    const delivered: FakeAdcosDelivery[] = [];
    for (const event of visible) {
      for (let copy = 0; copy < behavior.duplicateFactor; copy += 1) {
        this.deliveryCounter += 1;
        delivered.push({
          deliveryId: `dlv-${this.deliveryCounter}`,
          sequence: delivered.length + 1,
          event: event.event,
          payload: event.payload,
        });
      }
    }
    return Object.freeze(delivered);
  }

  // --- inspection helpers ------------------------------------------------------------

  intentCount(): number {
    return this.intents.size;
  }

  contractCount(): number {
    return this.contracts.size;
  }

  leaseCount(): number {
    return this.leases.size;
  }

  // --- internals ----------------------------------------------------------------------

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private mustFind<T>(store: Map<string, T>, id: string, label: string): T {
    const found = store.get(id);
    if (found === undefined) {
      throw new AdcosApiError("resource-unknown", `fake ADCOS: ${label} resource does not exist`);
    }
    return found;
  }

  private assertRouteEnabled(operation: string): void {
    if (this.disabledRoutes.has(operation)) {
      throw new AdcosApiError(
        "route-unknown",
        `fake ADCOS: operation '${operation}' is disabled (endpoint unavailable)`,
      );
    }
  }

  private requireMutationContext(
    mutation: AdcosMutationContext | undefined,
    operation: string,
  ): AdcosMutationContext {
    if (mutation === null || mutation === undefined || typeof mutation !== "object") {
      throw new AdcosApiError(
        "idempotency-key-required",
        `fake ADCOS: '${operation}' requires an idempotency key (RL-LOCK-014)`,
      );
    }
    if (typeof mutation.idempotencyKey !== "string" || mutation.idempotencyKey.length === 0) {
      throw new AdcosApiError(
        "idempotency-key-required",
        `fake ADCOS: '${operation}' requires a non-empty idempotency key (RL-LOCK-014)`,
      );
    }
    return mutation;
  }

  /**
   * Idempotency replay bookkeeping: the FIRST response for a key is replayed
   * byte-identically for the same payload; a different payload under the
   * same key is an idempotency conflict. Pre-faults fail before applying;
   * post-faults apply + record and then fail (response lost).
   */
  private replay<TResponse>(
    idempotencyKey: IdempotencyKey,
    digestInput: unknown,
    operation: () => TResponse,
  ): TResponse {
    const digest = canonicalizeJson(digestInput);
    const existing = this.idempotentResponses.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        throw new AdcosApiError(
          "idempotency-conflict",
          "fake ADCOS: this idempotency key was already used with a DIFFERENT payload",
        );
      }
      return structuredClone(existing.response) as TResponse;
    }
    this.consumeFault("pre");
    const response = operation();
    this.idempotentResponses.set(idempotencyKey, { digest, response: structuredClone(response) });
    this.consumeFault("post");
    return response;
  }

  private emit(
    eventType: AdcosWebhookEventType,
    resourceKind: AdcosWebhookResourceKind,
    resourceId: string,
    resourceVersion: number,
    correlationId: string,
  ): void {
    this.eventCounter += 1;
    const event: AdcosWebhookEvent = Object.freeze({
      event_id: `evt-${this.eventCounter}` as AdcosEventId,
      event_type: eventType,
      resource_id: resourceId as AdcosResourceId,
      resource_kind: resourceKind,
      resource_version: resourceVersion as Revision,
      occurred_at: this.now(),
      api_version: ADCOS_API_VERSION,
      environment: this.environment,
      correlation_id: correlationId as CorrelationId,
    });
    const record: FakeAdcosEvent = Object.freeze({
      event,
      payload: canonicalizeJson(event),
      emissionSequence: this.eventCounter,
    });
    if (this.webhookDelivery.delayCount >= this.eventCounter) {
      this.delayedEvents.push(record);
    } else {
      this.eventLog.push(record);
    }
    this.allEvents.push(record);
  }

  private static seedProbe(fake: FakeAdcos): {
    readonly intentId: string;
    readonly contractId: string;
    readonly leaseId: string;
  } {
    const intentDocument = fake.createIntentSync(
      parseAdcosIntentRequest({
        requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "compat-probe" } }],
        validity: { start: "2026-01-15T08:30:00.000Z", end: "2026-01-16T08:30:00.000Z" },
        termination: { actor: "roamlink", on_expiry: "release" },
        recorded_at: "2026-01-15T08:30:00.000Z",
      }),
      { idempotencyKey: "idem.fake.probe.intent" as IdempotencyKey },
    );
    const intentId = intentDocument["id"] as string;
    const contractDocument = fake.acceptOffersSync(
      intentId,
      parseAdcosOfferSelection({
        offers: [{ offer: "probe-offer" }],
        recorded_at: "2026-01-15T08:30:00.000Z",
      }),
      { idempotencyKey: "idem.fake.probe.offers" as IdempotencyKey },
    );
    const contractId = contractDocument["id"] as string;
    fake.activateContractSync(
      intentId,
      parseAdcosActivationRequest({
        activated_at: "2026-01-15T09:00:00.000Z",
        signature_refs: ["sig-probe-1"],
      }),
      { idempotencyKey: "idem.fake.probe.activation" as IdempotencyKey },
    );
    const leaseDocument = fake.grantLeaseSync(
      contractId,
      parseAdcosLeaseRequest({ granted_at: "2026-01-15T09:01:00.000Z" }),
      { idempotencyKey: "idem.fake.probe.lease" as IdempotencyKey },
    );
    const leaseId = leaseDocument["id"] as string;
    return { intentId, contractId, leaseId };
  }

  private page(items: readonly Record<string, unknown>[]): {
    next_cursor: string | null;
    items: readonly Record<string, unknown>[];
  } {
    return Object.freeze({ next_cursor: null, items: Object.freeze([...items]) });
  }

  private intentDocument(intent: StoredIntent): IntentDocument {
    return Object.freeze({
      id: intent.id,
      state: intent.state,
      ...(this.omitResourceVersions ? {} : { resource_version: intent.version }),
      recorded_at: (intent.request as Record<string, unknown>)["recorded_at"],
    });
  }

  private contractDocument(contract: StoredContract): IntentDocument {
    return Object.freeze({
      id: contract.id,
      intent_id: contract.intentId,
      state: contract.state,
      ...(this.omitResourceVersions ? {} : { resource_version: contract.version }),
    });
  }

  private leaseDocument(lease: StoredLease): IntentDocument {
    return Object.freeze({
      id: lease.id,
      contract_id: lease.contractId,
      status: lease.status,
      ...(this.omitResourceVersions ? {} : { resource_version: lease.version }),
    });
  }

  // --- sync mutation internals ---------------------------------------------------------

  private createIntentSync(
    request: Parameters<AdcosClient["createIntent"]>[0],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("intent_create");
    const context = this.requireMutationContext(mutation, "intent_create");
    const validated = parseAdcosIntentRequest(request);
    return structuredClone(
      this.replay(context.idempotencyKey, { op: "intent_create", request: validated }, () => {
        const id = this.nextId("intent");
        const stored: StoredIntent = {
          id,
          request: validated as unknown as Record<string, unknown>,
          version: 1,
          state: "INTENT",
        };
        this.intents.set(id, stored);
        const document = this.intentDocument(stored);
        this.emit(
          "connectivity_intent.created",
          "connectivity_intent",
          id,
          stored.version,
          context.correlationId ?? `corr-${id}`,
        );
        return document;
      }),
    );
  }

  private acceptOffersSync(
    intentId: string,
    request: Parameters<AdcosClient["acceptOffers"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("offers_accept");
    const context = this.requireMutationContext(mutation, "offers_accept");
    const validated = parseAdcosOfferSelection(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "offers_accept", intentId, request: validated },
        () => {
          const intent = this.mustFind(this.intents, intentId, "intent");
          if (intent.state !== "INTENT") {
            throw new AdcosApiError(
              "invalid-input",
              "fake ADCOS: offers can only be accepted while the intent is in INTENT state",
            );
          }
          intent.state = "OFFER_SELECTED";
          const contract: StoredContract = {
            id: this.nextId("contract"),
            intentId: intent.id,
            version: 1,
            state: "OFFER_SELECTED",
          };
          this.contracts.set(contract.id, contract);
          const document = this.contractDocument(contract);
          this.emit(
            "connectivity_contract.offers_selected",
            "connectivity_contract",
            contract.id,
            contract.version,
            context.correlationId ?? `corr-${contract.id}`,
          );
          return document;
        },
      ),
    );
  }

  private activateContractSync(
    intentId: string,
    request: Parameters<AdcosClient["activateContract"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("contract_activate");
    const context = this.requireMutationContext(mutation, "contract_activate");
    const validated = parseAdcosActivationRequest(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "contract_activate", intentId, request: validated },
        () => {
          const intent = this.mustFind(this.intents, intentId, "intent");
          const contract = [...this.contracts.values()].find((c) => c.intentId === intent.id);
          if (contract === undefined) {
            throw new AdcosApiError(
              "invalid-input",
              "fake ADCOS: activation requires an accepted-offer contract for the intent",
            );
          }
          if (!canTransitionAdcosContractState(contract.state, "CONTRACT_ACTIVE")) {
            throw new AdcosApiError(
              "invalid-input",
              "fake ADCOS: contract activation from the current state is not a legal v2 transition",
            );
          }
          contract.state = "CONTRACT_ACTIVE";
          contract.version += 1;
          const document = this.contractDocument(contract);
          this.emit(
            "connectivity_contract.activated",
            "connectivity_contract",
            contract.id,
            contract.version,
            context.correlationId ?? `corr-${contract.id}`,
          );
          return document;
        },
      ),
    );
  }

  private terminateContractSync(
    contractId: string,
    request: Parameters<AdcosClient["terminateContract"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("contract_terminate");
    const context = this.requireMutationContext(mutation, "contract_terminate");
    const validated = parseAdcosTerminationRequest(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "contract_terminate", contractId, request: validated },
        () => {
          const contract = this.mustFind(this.contracts, contractId, "contract");
          if (!canTransitionAdcosContractState(contract.state, "TERMINATED")) {
            throw new AdcosApiError(
              "invalid-input",
              "fake ADCOS: termination from the current state is not a legal v2 transition",
            );
          }
          contract.state = "TERMINATED";
          contract.version += 1;
          const document = this.contractDocument(contract);
          this.emit(
            "connectivity_contract.terminated",
            "connectivity_contract",
            contract.id,
            contract.version,
            context.correlationId ?? `corr-${contract.id}`,
          );
          return document;
        },
      ),
    );
  }

  private grantLeaseSync(
    contractId: string,
    request: Parameters<AdcosClient["grantLease"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("lease_grant");
    const context = this.requireMutationContext(mutation, "lease_grant");
    const validated = parseAdcosLeaseRequest(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "lease_grant", contractId, request: validated },
        () => {
          const contract = this.mustFind(this.contracts, contractId, "contract");
          if (contract.state === "TERMINATED" || contract.state === "FAILED" || contract.state === "EXPIRED") {
            throw new AdcosApiError(
              "invalid-input",
              "fake ADCOS: leases cannot be granted on a terminal contract",
            );
          }
          const lease: StoredLease = {
            id: this.nextId("lease"),
            contractId: contract.id,
            version: 1,
            status: "granted",
          };
          this.leases.set(lease.id, lease);
          const document = this.leaseDocument(lease);
          this.emit(
            "connectivity_lease.granted",
            "connectivity_lease",
            lease.id,
            lease.version,
            context.correlationId ?? `corr-${lease.id}`,
          );
          return document;
        },
      ),
    );
  }

  private renewLeaseSync(
    leaseId: string,
    request: Parameters<AdcosClient["renewLease"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("lease_renew");
    const context = this.requireMutationContext(mutation, "lease_renew");
    const validated = parseAdcosLeaseRenewal(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "lease_renew", leaseId, request: validated },
        () => {
          const lease = this.mustFind(this.leases, leaseId, "lease");
          if (lease.status === "revoked") {
            throw new AdcosApiError("invalid-input", "fake ADCOS: a revoked lease cannot be renewed");
          }
          lease.status = "renewed";
          lease.version += 1;
          const document = this.leaseDocument(lease);
          this.emit(
            "connectivity_lease.renewed",
            "connectivity_lease",
            lease.id,
            lease.version,
            context.correlationId ?? `corr-${lease.id}`,
          );
          return document;
        },
      ),
    );
  }

  private revokeLeaseSync(
    leaseId: string,
    request: Parameters<AdcosClient["revokeLease"]>[1],
    mutation: AdcosMutationContext,
  ): IntentDocument {
    this.assertRouteEnabled("lease_revoke");
    const context = this.requireMutationContext(mutation, "lease_revoke");
    const validated = parseAdcosLeaseRevocation(request);
    return structuredClone(
      this.replay(
        context.idempotencyKey,
        { op: "lease_revoke", leaseId, request: validated },
        () => {
          const lease = this.mustFind(this.leases, leaseId, "lease");
          if (lease.status === "revoked") {
            throw new AdcosApiError("invalid-input", "fake ADCOS: the lease is already revoked");
          }
          lease.status = "revoked";
          lease.version += 1;
          const document = this.leaseDocument(lease);
          this.emit(
            "connectivity_lease.revoked",
            "connectivity_lease",
            lease.id,
            lease.version,
            context.correlationId ?? `corr-${lease.id}`,
          );
          return document;
        },
      ),
    );
  }

  // --- AdcosClient surface (async wrappers) ----------------------------------------------

  async getApplication(): Promise<IntentDocument> {
    this.assertRouteEnabled("application_self");
    this.consumeFault("pre");
    return Object.freeze({
      application: "roamlink-fake",
      api_version: this.apiVersion,
      environment: this.environment,
    });
  }

  async createIntent(
    request: Parameters<AdcosClient["createIntent"]>[0],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.createIntentSync(request, mutation);
  }

  async listIntents(query?: AdcosListQuery): Promise<{
    next_cursor: string | null;
    items: readonly IntentDocument[];
  }> {
    this.assertRouteEnabled("intent_list");
    this.consumeFault("pre");
    void query;
    return this.page([...this.intents.values()].map((intent) => this.intentDocument(intent)));
  }

  async getIntent(intentId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("intent_get");
    this.consumeFault("pre");
    return structuredClone(this.intentDocument(this.mustFind(this.intents, intentId, "intent")));
  }

  async getIntentLifecycle(intentId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("intent_lifecycle_get");
    this.consumeFault("pre");
    const intent = this.mustFind(this.intents, intentId, "intent");
    const contract = [...this.contracts.values()].find((c) => c.intentId === intent.id);
    const override = this.lifecycleStateOverrides.get(intentId);
    return structuredClone({
      intent_id: intent.id,
      state: override ?? (contract === undefined ? intent.state : contract.state),
      resource_version: contract === undefined ? intent.version : contract.version,
    });
  }

  async acceptOffers(
    intentId: string,
    request: Parameters<AdcosClient["acceptOffers"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.acceptOffersSync(intentId, request, mutation);
  }

  async activateContract(
    intentId: string,
    request: Parameters<AdcosClient["activateContract"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.activateContractSync(intentId, request, mutation);
  }

  async listContracts(query?: AdcosListQuery): Promise<{
    next_cursor: string | null;
    items: readonly IntentDocument[];
  }> {
    this.assertRouteEnabled("contract_list");
    this.consumeFault("pre");
    void query;
    return this.page([...this.contracts.values()].map((contract) => this.contractDocument(contract)));
  }

  async getContract(contractId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("contract_get");
    this.consumeFault("pre");
    return structuredClone(this.contractDocument(this.mustFind(this.contracts, contractId, "contract")));
  }

  async getContractUsage(contractId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("contract_usage_get");
    this.consumeFault("pre");
    const contract = this.mustFind(this.contracts, contractId, "contract");
    return structuredClone({
      contract_id: contract.id,
      ...(this.omitResourceVersions ? {} : { resource_version: contract.version }),
      usage: { bytes: 0, sessions: 0 },
    });
  }

  async getContractAssurance(contractId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("contract_assurance_get");
    this.consumeFault("pre");
    const contract = this.mustFind(this.contracts, contractId, "contract");
    return structuredClone({
      contract_id: contract.id,
      ...(this.omitResourceVersions ? {} : { resource_version: contract.version }),
      assurance: { satisfied: true },
    });
  }

  async terminateContract(
    contractId: string,
    request: Parameters<AdcosClient["terminateContract"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.terminateContractSync(contractId, request, mutation);
  }

  async grantLease(
    contractId: string,
    request: Parameters<AdcosClient["grantLease"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.grantLeaseSync(contractId, request, mutation);
  }

  async listLeases(query?: AdcosListQuery): Promise<{
    next_cursor: string | null;
    items: readonly IntentDocument[];
  }> {
    this.assertRouteEnabled("lease_list");
    this.consumeFault("pre");
    void query;
    return this.page([...this.leases.values()].map((lease) => this.leaseDocument(lease)));
  }

  async getLease(leaseId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("lease_get");
    this.consumeFault("pre");
    return structuredClone(this.leaseDocument(this.mustFind(this.leases, leaseId, "lease")));
  }

  async renewLease(
    leaseId: string,
    request: Parameters<AdcosClient["renewLease"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.renewLeaseSync(leaseId, request, mutation);
  }

  async revokeLease(
    leaseId: string,
    request: Parameters<AdcosClient["revokeLease"]>[1],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    return this.revokeLeaseSync(leaseId, request, mutation);
  }

  async listWebhookEndpoints(query?: AdcosListQuery): Promise<{
    next_cursor: string | null;
    items: readonly IntentDocument[];
  }> {
    this.assertRouteEnabled("webhook_endpoint_list");
    this.consumeFault("pre");
    void query;
    return this.page([]);
  }

  async createWebhookEndpoint(
    request: Parameters<AdcosClient["createWebhookEndpoint"]>[0],
    mutation: AdcosMutationContext,
  ): Promise<IntentDocument> {
    this.assertRouteEnabled("webhook_endpoint_create");
    const context = this.requireMutationContext(mutation, "webhook_endpoint_create");
    return structuredClone(
      this.replay(context.idempotencyKey, { op: "webhook_endpoint_create", request }, () => {
        const id = this.nextId("webhook-endpoint");
        const document = Object.freeze({ id, resource_version: 1 });
        this.emit(
          "webhook_endpoint.registered",
          "webhook_endpoint",
          id,
          1,
          context.correlationId ?? "corr-webhook-endpoint",
        );
        return document;
      }),
    );
  }

  async getWebhookEndpoint(endpointId: string): Promise<IntentDocument> {
    this.assertRouteEnabled("webhook_endpoint_get");
    this.consumeFault("pre");
    return Object.freeze({ id: endpointId, resource_version: 1 });
  }

  async listWebhookEndpointDeliveries(
    endpointId: string,
    query?: AdcosListQuery,
  ): Promise<{
    next_cursor: string | null;
    items: readonly IntentDocument[];
  }> {
    this.assertRouteEnabled("webhook_endpoint_deliveries_list");
    this.consumeFault("pre");
    void endpointId;
    void query;
    return this.page([]);
  }
}
