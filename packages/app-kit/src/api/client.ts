/**
 * The typed RoamLink application API client (RL-060/061).
 *
 * The ONLY way app code talks to a RoamLink API:
 *  - reads return parsed, fail-closed wire resources;
 *  - every mutation carries the full command header set (request id,
 *    correlation id, idempotency key, actor/tenant context, optimistic
 *    version when pinned - spec/api.md "Command semantics", RL-LOCK-014);
 *  - server errors surface as {@link ApiClientError} with the taxonomy kind
 *    intact; transport failures fail closed as retryable `unavailable`.
 *
 * The client holds NO authority: it never decides outcomes, never invents
 * state, never caches authoritative truth. Retrying a mutation with the SAME
 * idempotency key is the sanctioned retry story - the server replays the
 * original acknowledgement without duplicating the effect.
 */
import { parseActorContext, type ActorContext } from "./context.js";
import type {
  MutationRequestOptions,
  RequestIdGenerator,
} from "./context.js";
import { mutationRequestHeaders, planMutationRequest, readRequestHeaders } from "./context.js";
import {
  ApiClientError,
  parseApiErrorResource,
} from "./errors.js";
import {
  advanceSupportCaseBody,
  createExperienceIntentBody,
  createSupportCaseBody,
  enableEsimProfileBody,
  enrollDeviceBody,
  installEsimProfileBody,
  placeOrderBody,
  provisionConnectorBody,
  recordPaymentBody,
  supersedeExperienceIntentBody,
  triggerReconciliationBody,
  updateDeviceBody,
  validateCancelOrder,
  validateCompleteOrder,
  validateEnableEsimProfileRequest,
  validateMarkNotificationRead,
  validateReactivateOrganization,
  validateRemoveEsimProfile,
  validateRetireDevice,
  validateSuspendOrganization,
  type AdvanceSupportCaseRequest,
  type CreateExperienceIntentRequest,
  type CreateSupportCaseRequest,
  type EnableEsimProfileRequest,
  type EnrollDeviceRequest,
  type InstallEsimProfileRequest,
  type PlaceOrderRequest,
  type ProvisionConnectorRequest,
  type RecordPaymentRequest,
  type RemoveEsimProfileRequest,
  type SupersedeExperienceIntentRequest,
  type TriggerReconciliationRequest,
  type UpdateDeviceRequest,
} from "./commands.js";
import {
  parseActorSessionResource,
  parseAuditEventListResource,
  parseConnectivityOverviewResource,
  parseDeviceList,
  parseDeviceResource,
  parseDeviceSimResource,
  parseExperienceIntentList,
  parseExperienceIntentResource,
  parseNotificationList,
  parseOrderDetailResource,
  parseOrderList,
  parseOrganizationList,
  parseProductList,
  parseProjectionHealthResource,
  parseIntegrationHealthResource,
  parseReconciliationJobList,
  parseSubscriptionList,
  parseSupportCaseList,
  parseUserResource,
  type AuditEventResource,
  type IntegrationHealthResource,
} from "./resources.js";
import { parseEnterpriseWorkspaceResource } from "./enterprise.js";
import { parseMutationAcknowledgement, type MutationAcknowledgement } from "./outcomes.js";
import { route } from "./routes.js";
import { HTTP_STATUS, type HttpRequest, type HttpTransport } from "./transport.js";

export interface RoamLinkApiClientDeps {
  readonly transport: HttpTransport;
  readonly actor: ActorContext;
  /** Deterministic id source for request/correlation/idempotency ids. */
  readonly ids: RequestIdGenerator;
}

/** Query filters for the audit event review surface (all ANDed). */
export interface AuditEventQuery {
  readonly category?: "auth" | "secret-access" | "authority-decision" | "admin-override";
  readonly actorId?: string;
  readonly correlationId?: string;
  readonly from?: string;
  readonly to?: string;
}

export class RoamLinkApiClient {
  readonly #transport: HttpTransport;
  readonly #actor: ActorContext;
  readonly #ids: RequestIdGenerator;

  constructor(deps: RoamLinkApiClientDeps) {
    this.#transport = deps.transport;
    this.#actor = parseActorContext(deps.actor);
    this.#ids = deps.ids;
  }

  /** The actor context every request carries (display/tenant switch UX). */
  actor(): ActorContext {
    return this.#actor;
  }

  // ---------------------------------------------------------------------------
  // Reads - identity/session
  // ---------------------------------------------------------------------------

  /** Resolves the authenticated actor's scope + effective permissions. */
  async getActorSession() {
    return this.#get(route("actorSession"), parseActorSessionResource);
  }

  async getUser(userId: string) {
    return this.#get(route("user", { userId }), parseUserResource);
  }

  // ---------------------------------------------------------------------------
  // Reads - experience
  // ---------------------------------------------------------------------------

  async listDevices() {
    return this.#get(route("devices"), parseDeviceList);
  }

  async getDevice(deviceId: string) {
    return this.#get(route("device", { deviceId }), parseDeviceResource);
  }

  /**
   * The device's SIM & Profiles read (RL-115-F1 remediation): the three
   * eSIM capability truth rows (status, evidence, freshness, gate preview),
   * the platform's install contract and the profile inventory — every
   * claimed state carries its evidence/freshness.
   */
  async getDeviceSim(deviceId: string) {
    return this.#get(route("deviceSim", { deviceId }), parseDeviceSimResource);
  }

  async listExperienceIntents() {
    return this.#get(route("experienceIntents"), parseExperienceIntentList);
  }

  async getExperienceIntent(intentId: string) {
    return this.#get(route("experienceIntent", { intentId }), parseExperienceIntentResource);
  }

  async getConnectivityOverview() {
    return this.#get(route("connectivity"), parseConnectivityOverviewResource);
  }

  // ---------------------------------------------------------------------------
  // Reads - commerce
  // ---------------------------------------------------------------------------

  async listProducts() {
    return this.#get(route("products"), parseProductList);
  }

  async listOrders() {
    return this.#get(route("orders"), parseOrderList);
  }

  async getOrder(orderId: string) {
    return this.#get(route("order", { orderId }), parseOrderDetailResource);
  }

  async listSubscriptions() {
    return this.#get(route("subscriptions"), parseSubscriptionList);
  }

  // ---------------------------------------------------------------------------
  // Reads - notifications + support
  // ---------------------------------------------------------------------------

  async listNotifications() {
    return this.#get(route("notifications"), parseNotificationList);
  }

  async listSupportCases() {
    return this.#get(route("supportCases"), parseSupportCaseList);
  }

  // ---------------------------------------------------------------------------
  // Reads - enterprise workspace (RL-104, additive)
  // ---------------------------------------------------------------------------

  /**
   * Reads the acting tenant's enterprise workspace composition (identity +
   * enrollment journey + connector status). Organization-scoped tenants
   * only; the parsed resource carries the mirrored closed vocabularies and
   * honest null sections where the journey has not started.
   */
  async getEnterpriseWorkspace() {
    return this.#get(route("enterpriseWorkspace"), parseEnterpriseWorkspaceResource);
  }

  /**
   * PA-06 / RL-115-F3: starts (or retries) the workspace connector
   * provisioning through the full command envelope. The customer payload
   * carries only the bounded connector label; the enrollment reference and
   * the capability negotiation inputs are resolved server-side against the
   * acting tenant's enterprise journey (the enterprise package's machinery
   * is the authority - this client never decides outcomes). The returned
   * acknowledgement is the command record; /v1/commands/{commandId} and the
   * workspace read are the polling states. Retrying with the SAME
   * idempotency key replays the original acknowledgement (RL-LOCK-014);
   * retrying a FAILED attempt with a NEW key starts a new provisioning
   * (the domain's failed state is terminal - a retry is a new attempt).
   */
  async provisionConnector(request: ProvisionConnectorRequest, options?: MutationRequestOptions) {
    return this.#mutate("enterpriseConnectorProvision", provisionConnectorBody(request), options);
  }

  // ---------------------------------------------------------------------------
  // Reads - command status (stage progression)
  // ---------------------------------------------------------------------------

  async getCommandStatus(commandId: string) {
    return this.#get(route("command", { commandId }), parseMutationAcknowledgement);
  }

  // ---------------------------------------------------------------------------
  // Reads - admin surfaces (RL-061)
  // ---------------------------------------------------------------------------

  async listOrganizations() {
    return this.#get(route("organizations"), parseOrganizationList);
  }

  async listAuditEvents(query?: AuditEventQuery): Promise<{
    readonly events: readonly AuditEventResource[];
    readonly chain: {
      readonly verified: boolean;
      readonly verifiedCount?: number;
      readonly brokenAtSequence?: number;
    };
  }> {
    const params = new URLSearchParams();
    if (query?.category !== undefined) params.set("category", query.category);
    if (query?.actorId !== undefined) params.set("actorId", query.actorId);
    if (query?.correlationId !== undefined) params.set("correlationId", query.correlationId);
    if (query?.from !== undefined) params.set("from", query.from);
    if (query?.to !== undefined) params.set("to", query.to);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#get(`${route("auditEvents")}${suffix}`, parseAuditEventListResource);
  }

  async listReconciliationJobs() {
    return this.#get(route("reconciliationJobs"), parseReconciliationJobList);
  }

  async getProjectionHealth() {
    return this.#get(route("projectionHealth"), parseProjectionHealthResource);
  }

  /**
   * The admin integration-health read (PA-010): the recorded outcome of the
   * env-gated ADCOS compatibility probe (RL-108). READ-ONLY by construction —
   * a GET whose parsed resource is what the probe recorded (never a live
   * probe run, never a compatibility mutation; the gate stays inside the
   * ADCOS integration boundary).
   */
  async getIntegrationHealth(): Promise<IntegrationHealthResource> {
    return this.#get(route("integrationHealth"), parseIntegrationHealthResource);
  }

  // ---------------------------------------------------------------------------
  // Mutations - experience
  // ---------------------------------------------------------------------------

  async enrollDevice(request: EnrollDeviceRequest, options?: MutationRequestOptions) {
    return this.#mutate(
      "devices",
      enrollDeviceBody(request),
      options,
    );
  }

  async updateDevice(request: UpdateDeviceRequest, options?: MutationRequestOptions) {
    return this.#mutate(
      "deviceUpdate",
      updateDeviceBody(request),
      options,
      { deviceId: request.deviceId },
    );
  }

  async retireDevice(
    request: { readonly deviceId: string },
    options?: MutationRequestOptions,
  ) {
    const deviceId = validateRetireDevice(request);
    return this.#mutate("deviceRetire", "{}", options, { deviceId });
  }

  /**
   * Installs an eSIM profile (RL-115-F1). Capability-gated server-side
   * against `esim_profile_install`; the activation code rides the body when
   * the platform's install contract requires one.
   */
  async installEsimProfile(request: InstallEsimProfileRequest, options?: MutationRequestOptions) {
    const deviceId = requireDeviceId(request?.deviceId);
    return this.#mutate(
      "deviceSimInstall",
      installEsimProfileBody(request),
      options,
      { deviceId },
    );
  }

  /** Removes an installed eSIM profile (capability-gated server-side). */
  async removeEsimProfile(request: RemoveEsimProfileRequest, options?: MutationRequestOptions) {
    const ids = validateRemoveEsimProfile(request);
    return this.#mutate("deviceSimProfileRemove", "{}", options, ids);
  }

  /** Enables or disables an installed eSIM profile (capability-gated server-side). */
  async enableEsimProfile(request: EnableEsimProfileRequest, options?: MutationRequestOptions) {
    const ids = validateEnableEsimProfileRequest(request);
    return this.#mutate("deviceSimProfileEnable", enableEsimProfileBody(request), options, ids);
  }

  async createExperienceIntent(request: CreateExperienceIntentRequest, options?: MutationRequestOptions) {
    return this.#mutate("experienceIntents", createExperienceIntentBody(request), options);
  }

  async supersedeExperienceIntent(
    request: SupersedeExperienceIntentRequest,
    options?: MutationRequestOptions,
  ) {
    validateExperienceIntentTarget(request.intentId);
    return this.#mutate(
      "experienceIntentVersions",
      supersedeExperienceIntentBody(request),
      options,
      { intentId: request.intentId },
    );
  }

  async activateExperienceIntent(
    request: { readonly intentId: string },
    options?: MutationRequestOptions,
  ) {
    const intentId = validateIntentId(request.intentId);
    return this.#mutate(
      "experienceIntentActivate",
      "{}",
      options,
      { intentId },
    );
  }

  // ---------------------------------------------------------------------------
  // Mutations - commerce
  // ---------------------------------------------------------------------------

  async placeOrder(request: PlaceOrderRequest, options?: MutationRequestOptions) {
    return this.#mutate("orders", placeOrderBody(request), options);
  }

  async cancelOrder(
    request: { readonly orderId: string },
    options?: MutationRequestOptions,
  ) {
    const orderId = validateCancelOrder(request);
    return this.#mutate("orderCancel", "{}", options, { orderId });
  }

  async completeOrder(
    request: { readonly orderId: string },
    options?: MutationRequestOptions,
  ) {
    const orderId = validateCompleteOrder(request);
    return this.#mutate("orderComplete", "{}", options, { orderId });
  }

  async recordPayment(request: RecordPaymentRequest, options?: MutationRequestOptions) {
    return this.#mutate("payments", recordPaymentBody(request), options);
  }

  // ---------------------------------------------------------------------------
  // Mutations - notifications + support
  // ---------------------------------------------------------------------------

  async markNotificationRead(
    request: { readonly notificationId: string },
    options?: MutationRequestOptions,
  ) {
    const notificationId = validateMarkNotificationRead(request);
    return this.#mutate("notificationRead", "{}", options, { notificationId });
  }

  async createSupportCase(request: CreateSupportCaseRequest, options?: MutationRequestOptions) {
    return this.#mutate("supportCases", createSupportCaseBody(request), options);
  }

  async advanceSupportCase(request: AdvanceSupportCaseRequest, options?: MutationRequestOptions) {
    const caseId = validateSupportCaseId(request.caseId);
    return this.#mutate(
      "supportCaseTransitions",
      advanceSupportCaseBody(request),
      options,
      { caseId },
    );
  }

  // ---------------------------------------------------------------------------
  // Mutations - admin (RL-061); authorization enforced server-side
  // ---------------------------------------------------------------------------

  async suspendOrganization(
    request: { readonly tenantId: string },
    options?: MutationRequestOptions,
  ) {
    const tenantId = validateSuspendOrganization(request);
    return this.#mutate("organizationSuspend", "{}", options, { tenantId });
  }

  async reactivateOrganization(
    request: { readonly tenantId: string },
    options?: MutationRequestOptions,
  ) {
    const tenantId = validateReactivateOrganization(request);
    return this.#mutate("organizationReactivate", "{}", options, { tenantId });
  }

  async triggerReconciliation(request: TriggerReconciliationRequest, options?: MutationRequestOptions) {
    return this.#mutate("reconciliationJobs", triggerReconciliationBody(request), options);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async #get<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    const request: HttpRequest = {
      method: "GET",
      path,
      headers: { ...readRequestHeaders(this.#actor) },
    };
    return this.#parseResource(await this.#execute(request, HTTP_STATUS.ok), parse);
  }

  async #mutate(
    name: Parameters<typeof route>[0],
    body: string,
    options: MutationRequestOptions | undefined,
    params: Readonly<Record<string, string>> = {},
  ): Promise<MutationAcknowledgement> {
    const plan = planMutationRequest(this.#actor, this.#ids, options);
    const request: HttpRequest = {
      method: "POST",
      path: route(name, params),
      headers: { ...mutationRequestHeaders(this.#actor, plan) },
      body,
    };
    const parsed = await this.#execute(request, [HTTP_STATUS.ok, HTTP_STATUS.accepted]);
    return this.#parseResource(parsed, parseMutationAcknowledgement);
  }

  /**
   * Parses a response body through its resource parser; a body that does not
   * match the contract fails closed as a typed unknown-state error (the app
   * never renders an unvalidated payload).
   */
  #parseResource<T>(value: unknown, parse: (value: unknown) => T): T {
    try {
      return parse(value);
    } catch {
      throw new ApiClientError({
        kind: "unknown-state",
        reason: "RESPONSE_CONTRACT_VIOLATION",
        message:
          "the response body does not match the API contract (details suppressed)",
        retryable: true,
        status: HTTP_STATUS.ok,
      });
    }
  }

  async #execute(
    request: HttpRequest,
    acceptedStatus: number | readonly number[],
  ): Promise<unknown> {
    let response;
    try {
      response = await this.#transport.request(request);
    } catch {
      throw ApiClientError.transportFailure(
        "the API transport failed before a response was produced (retryable)",
      );
    }
    const accepted =
      typeof acceptedStatus === "number"
        ? acceptedStatus === response.status
        : acceptedStatus.includes(response.status);
    if (accepted) {
      if (response.body === undefined || response.body === null) {
        throw ApiClientError.unparseableErrorBody(response.status);
      }
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw ApiClientError.unparseableErrorBody(response.status);
      }
    }
    if (response.body !== undefined && response.body !== null && response.body.length > 0) {
      let parsedErrorBody: unknown;
      try {
        parsedErrorBody = JSON.parse(response.body) as unknown;
      } catch {
        throw ApiClientError.unparseableErrorBody(response.status);
      }
      let parsedError: ReturnType<typeof parseApiErrorResource>;
      try {
        parsedError = parseApiErrorResource(parsedErrorBody);
      } catch {
        // The error body does not match the contract - fail closed without
        // propagating third-party text (RL-LOCK-016).
        throw ApiClientError.unparseableErrorBody(response.status);
      }
      throw ApiClientError.fromResource(parsedError, response.status);
    }
    throw ApiClientError.unparseableErrorBody(response.status);
  }
}

function validateExperienceIntentTarget(intentId: string | undefined): void {
  if (typeof intentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intentId)) {
    throw new ApiClientError({
      kind: "validation",
      reason: "REQUEST_PAYLOAD_INVALID",
      message: "SupersedeExperienceIntentRequest.intentId must be a canonical lowercase UUID",
      retryable: false,
      status: 0,
    });
  }
}

function validateIntentId(intentId: unknown): string {
  if (
    typeof intentId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intentId)
  ) {
    throw new ApiClientError({
      kind: "validation",
      reason: "REQUEST_PAYLOAD_INVALID",
      message: "the experience-intent id must be a canonical lowercase UUID",
      retryable: false,
      status: 0,
    });
  }
  return intentId;
}

function validateSupportCaseId(caseId: unknown): string {
  if (
    typeof caseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(caseId)
  ) {
    throw new ApiClientError({
      kind: "validation",
      reason: "REQUEST_PAYLOAD_INVALID",
      message: "the support-case id must be a canonical lowercase UUID",
      retryable: false,
      status: 0,
    });
  }
  return caseId;
}

function requireDeviceId(deviceId: unknown): string {
  if (
    typeof deviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deviceId)
  ) {
    throw new ApiClientError({
      kind: "validation",
      reason: "REQUEST_PAYLOAD_INVALID",
      message: "the device id must be a canonical lowercase UUID",
      retryable: false,
      status: 0,
    });
  }
  return deviceId;
}
