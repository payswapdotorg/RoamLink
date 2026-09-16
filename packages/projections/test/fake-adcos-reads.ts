/**
 * The reads-only ADCOS fake (RL-034 test double, spec §10).
 *
 * Implements the public AdcosClient interface focused on the READ surface
 * the projection engine consumes (canonical documents with version
 * progression, silent canonical-state changes and injected read failures).
 * Mutations answer `capability-denied`: the projection boundary NEVER
 * mutates ADCOS state (RL-LOCK-001/002) - a test asserting that is itself a
 * conformance check. No ADCOS internals are used.
 */
import { AdcosApiError } from "@roamlink/adcos";
import type {
  AdcosClient,
  AdcosListQuery,
  AdcosMutationContext,
} from "@roamlink/adcos";

export interface FakeCanonicalResource {
  readonly id: string;
  readonly kind: "connectivity_intent" | "connectivity_contract" | "connectivity_lease";
  version: number;
  state: string;
}

export type FakeReadFault =
  | { readonly kind: "adcos-error"; readonly code: "rate-limited" | "store-failed" | "resource-unknown" }
  | { readonly kind: "unreachable" };

/**
 * A canonical ADCOS read surface: documents expose ONLY the fake's own
 * server-side model (opaque to RoamLink); versions progress via
 * `mutateVersion` (canonical-state change WITHOUT events) and reads fail via
 * `failNextRead`.
 */
export class FakeCanonicalAdcos implements AdcosClient {
  readonly environment = "sandbox" as const;
  readonly apiVersion = "2.0" as const;

  readonly resources = new Map<string, FakeCanonicalResource>();
  private readFaults: FakeReadFault[] = [];

  seed(resource: FakeCanonicalResource): this {
    this.resources.set(resource.id, resource);
    return this;
  }

  /** Canonical-state change with NO webhook event (missed-signal scenarios). */
  mutateVersion(id: string, nextState: string): this {
    const resource = this.resources.get(id);
    if (resource === undefined) {
      throw new AdcosApiError("resource-unknown", "fake canonical ADCOS: unknown resource");
    }
    resource.version += 1;
    resource.state = nextState;
    return this;
  }

  failNextRead(fault: FakeReadFault, count = 1): this {
    for (let i = 0; i < count; i += 1) {
      this.readFaults.push(fault);
    }
    return this;
  }

  private consumeFault(): void {
    const fault = this.readFaults.shift();
    if (fault === undefined) return;
    if (fault.kind === "unreachable") {
      // An unreachable canonical source produces no ADCOS answer; the fake
      // surfaces it as the retryable store-failed code (the caller's
      // projection logic decides STALE/UNKNOWN degradation).
      throw new AdcosApiError("store-failed", "injected fake: canonical source unreachable");
    }
    throw new AdcosApiError(fault.code, `injected fake read failure (${fault.code})`);
  }

  private documentOf(id: string): Record<string, unknown> {
    const resource = this.resources.get(id);
    if (resource === undefined) {
      throw new AdcosApiError("resource-unknown", "fake canonical ADCOS: unknown resource");
    }
    return {
      id: resource.id,
      kind: resource.kind,
      state: resource.state,
      resource_version: resource.version,
    };
  }

  // --- reads -------------------------------------------------------------------------

  async getApplication(): Promise<Record<string, unknown>> {
    this.consumeFault();
    return { application: "roamlink-fake-canonical", api_version: this.apiVersion };
  }

  async getIntent(intentId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    return this.documentOf(intentId);
  }

  async getIntentLifecycle(intentId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    const document = this.documentOf(intentId);
    return { intent_id: document["id"], state: document["state"], resource_version: document["resource_version"] };
  }

  async listIntents(query?: AdcosListQuery): Promise<{ next_cursor: string | null; items: readonly Record<string, unknown>[] }> {
    this.consumeFault();
    void query;
    return { next_cursor: null, items: [...this.resources.values()].map((r) => this.documentOf(r.id)) };
  }

  async getContract(contractId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    return this.documentOf(contractId);
  }

  async getContractUsage(contractId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    const document = this.documentOf(contractId);
    return { contract_id: document["id"], resource_version: document["resource_version"], usage: { bytes: 0 } };
  }

  async getContractAssurance(contractId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    const document = this.documentOf(contractId);
    return { contract_id: document["id"], resource_version: document["resource_version"], assurance: { satisfied: true } };
  }

  async listContracts(query?: AdcosListQuery): Promise<{ next_cursor: string | null; items: readonly Record<string, unknown>[] }> {
    this.consumeFault();
    void query;
    return { next_cursor: null, items: [...this.resources.values()].map((r) => this.documentOf(r.id)) };
  }

  async getLease(leaseId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    return this.documentOf(leaseId);
  }

  async listLeases(query?: AdcosListQuery): Promise<{ next_cursor: string | null; items: readonly Record<string, unknown>[] }> {
    this.consumeFault();
    void query;
    return { next_cursor: null, items: [...this.resources.values()].map((r) => this.documentOf(r.id)) };
  }

  async listWebhookEndpoints(query?: AdcosListQuery): Promise<{ next_cursor: string | null; items: readonly Record<string, unknown>[] }> {
    this.consumeFault();
    void query;
    return { next_cursor: null, items: [] };
  }

  async getWebhookEndpoint(endpointId: string): Promise<Record<string, unknown>> {
    this.consumeFault();
    return { id: endpointId, resource_version: 1 };
  }

  async listWebhookEndpointDeliveries(
    endpointId: string,
    query?: AdcosListQuery,
  ): Promise<{ next_cursor: string | null; items: readonly Record<string, unknown>[] }> {
    this.consumeFault();
    void endpointId;
    void query;
    return { next_cursor: null, items: [] };
  }

  // --- mutations: the projection boundary never mutates ADCOS -------------------------

  private refuseMutation(operation: string): never {
    throw new AdcosApiError(
      "capability-denied",
      `fake canonical ADCOS: '${operation}' refused - the projection boundary never mutates ADCOS state (RL-LOCK-001/002)`,
    );
  }

  async createIntent(request: never, mutation: AdcosMutationContext): Promise<never> {
    void request;
    void mutation;
    this.refuseMutation("intent_create");
  }

  async acceptOffers(intentId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void intentId;
    void request;
    void mutation;
    this.refuseMutation("offers_accept");
  }

  async activateContract(intentId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void intentId;
    void request;
    void mutation;
    this.refuseMutation("contract_activate");
  }

  async terminateContract(contractId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void contractId;
    void request;
    void mutation;
    this.refuseMutation("contract_terminate");
  }

  async grantLease(contractId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void contractId;
    void request;
    void mutation;
    this.refuseMutation("lease_grant");
  }

  async renewLease(leaseId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void leaseId;
    void request;
    void mutation;
    this.refuseMutation("lease_renew");
  }

  async revokeLease(leaseId: string, request: never, mutation: AdcosMutationContext): Promise<never> {
    void leaseId;
    void request;
    void mutation;
    this.refuseMutation("lease_revoke");
  }

  async createWebhookEndpoint(request: never, mutation: AdcosMutationContext): Promise<never> {
    void request;
    void mutation;
    this.refuseMutation("webhook_endpoint_create");
  }
}
