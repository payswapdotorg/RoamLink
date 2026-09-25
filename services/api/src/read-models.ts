/**
 * The composed business read models (PA-019, closes F-016-2).
 *
 * Every read route of the spec's read surface (spec/api.md, mirrored by
 * app-kit's route table) answers one of exactly two honest answers:
 *
 *  1. A COMPOSED read model over the service's BOUND state - the identity
 *     stores the service is composed with (users, organizations,
 *     memberships) and the durable command ledger (`api-commands`, the
 *     record repository the command plane writes through the SAME
 *     @roamlink/persistence ports) plus the durable reconciliation job
 *     records (`adcos-reconciliation-jobs`). Every served field is a real
 *     fact of that bound state - the service invents NO data.
 *
 *  2. The typed 501 READ_MODEL_NOT_COMPOSED with a NAMED reason - for the
 *     routes whose models have no real source in this service's bound
 *     persistence. Honest skips, recorded in the route table below (and in
 *     the PA-019 closure note), never papered over.
 *
 * THE PROJECTION LAW (the standing truthfulness law, applied to reads): a
 * business resource exists in a composed read model ONLY when its creating
 * command has EXECUTED and recorded its resource id (the executed stage +
 * `resource` field are the ledger's own durable record of what execution
 * applied - accepted is NOT executed, spec/api.md command semantics). On a
 * runtime where the worker plane composes no command executors (the live
 * demo), every command is accepted-only, so every ledger projection serves
 * its honest EMPTY state - the pages then render the real empty journey
 * content instead of the fail-closed panel. That is the composed truth: the
 * read models serve what the bound state actually asserts, nothing more.
 *
 * Field mapping (every field's source, by construction):
 *  - ids: the executed command's `resource.id` (the executor's durable
 *    record of the created aggregate); a targeted command's subject id is
 *    its stored route path (the path the command was ingested under);
 *  - payload fields: verbatim from the stored canonical payload;
 *  - lifecycle statuses: the closed domain vocabularies' initial state at
 *    creation (enrolled / draft / placed / open / pending - exactly the
 *    state the owning domain service records at creation), advanced by the
 *    executed commands that target the resource;
 *  - revision: 1 + the number of executed commands applied to the resource
 *    (the optimistic-concurrency bookkeeping the domain performs);
 *  - createdAt/updatedAt: the executedAt instants of the creating / latest
 *    applied command (a resource exists from execution);
 *  - ownership/authorship: the creating command's actor;
 *  - freshness/observations/decision/evidence sections: the honest null /
 *    empty values - the observation, decision, reference-evidence and
 *    notification planes are not composed in this service, and absence is
 *    stated, never bridged with an assumption (RL-LOCK-010/011).
 */
import {
  NotFoundError,
  ValidationError,
  parseOrganizationId,
  parseTenantId,
  parseUserId,
  tenantIdFromUser,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";
import type { HttpRequest, HttpResponse } from "@roamlink/app-kit";
import type {
  AuthorizationService,
  MembershipRepository,
  OrganizationRepository,
  UserRepository,
} from "@roamlink/auth";
import type { PersistenceReader } from "@roamlink/persistence";

import { COMMAND_REPOSITORY, type StoredCommand } from "./commands.js";
import { readContextHeaders, type AuthenticatedPrincipal } from "./envelope.js";
import {
  jsonResponse,
  readModelNotComposed,
  type ReadModelNotComposedReason,
} from "./http.js";

// --------------------------------------------------------------------------------
// The route tables (composed vs. honestly-kept 501)
// --------------------------------------------------------------------------------

/**
 * The routes that honestly keep the typed 501 (PA-019's recorded skips):
 * each names the real source that does not exist in this service's bound
 * persistence. The deterministic fake API remains the contract reference
 * for these reads.
 */
export const READ_MODELS_NOT_COMPOSED: Readonly<Record<string, ReadModelNotComposedReason>> =
  Object.freeze({
    "/v1/products": {
      code: "PRODUCT_CATALOG_NOT_BOUND",
      explanation:
        "the product catalog is domain-plane state; no catalog source is bound in this service's persistence",
    },
    "/v1/orders": {
      code: "ORDER_PRICE_FACTS_NOT_BOUND",
      explanation:
        "order line prices and totals come from the catalog and domain execution; the bound state carries no price facts and prices are never invented",
    },
    "/v1/orders/{orderId}": {
      code: "ORDER_PRICE_FACTS_NOT_BOUND",
      explanation:
        "order line prices and totals come from the catalog and domain execution; the bound state carries no price facts and prices are never invented",
    },
    "/v1/subscriptions": {
      code: "SUBSCRIPTION_STATE_NOT_BOUND",
      explanation:
        "subscription lifecycle state is domain-execution state; no subscription records exist in this service's bound persistence",
    },
    "/v1/notifications": {
      code: "NOTIFICATION_STORE_NOT_BOUND",
      explanation:
        "notifications are emitted from durable domain transitions; no notification store is bound on this runtime",
    },
    "/v1/audit-events": {
      code: "AUDIT_CHAIN_NOT_BOUND",
      explanation:
        "the tamper-evident audit chain is a domain-plane component; no audit chain is bound in this service",
    },
    "/v1/projection-health": {
      code: "PROJECTION_HEALTH_SOURCE_NOT_BOUND",
      explanation:
        "the projection store and SLO state live in the worker plane (in-memory by design); no projection-health source exists in this service's bound persistence",
    },
    "/v1/integration-health": {
      code: "INTEGRATION_HEALTH_SOURCE_NOT_BOUND",
      explanation:
        "the ADCOS compatibility probe is env-gated in the worker host; its recorded state is not part of this service's bound persistence (PA-010 / RL-115-F6)",
    },
  } as const);

// --------------------------------------------------------------------------------
// Options + the dispatcher
// --------------------------------------------------------------------------------

/** The bound state the read models compose over. */
export interface ReadModelOptions {
  /** The REAL committed-state reader (the command plane's own persistence). */
  readonly persistence: PersistenceReader;
  /** The identity stores the service is composed with. */
  readonly users: UserRepository;
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  /** The boundary authorization (actor -> tenant, fail-closed). */
  readonly authorization: AuthorizationService;
  /** Injected clock: every presented instant is explicit and testable. */
  readonly now: () => UtcInstant;
}

/** The per-request read context (the authorized tenant scope of the read). */
export interface ReadRequestContext {
  /** The raw read request (unused by most handlers; kept for the contract). */
  readonly request: HttpRequest;
  /** The resolved path (no query string). */
  readonly path: string;
  readonly principal: AuthenticatedPrincipal;
  readonly tenantId: TenantId;
}

/** A composed read handler: the request context + the bound composition. */
type ComposedReadHandler = (input: ReadRequestContext & ReadModelOptions) => Promise<HttpResponse>;

export type ReadModelDispatcher = (
  request: HttpRequest,
  path: string,
  principal: AuthenticatedPrincipal,
) => Promise<HttpResponse | null>;

/**
 * Creates the read-model dispatcher: matches a GET path against the
 * composed/kept read surface, authorizes the session principal in the
 * request's tenant context (fail-closed, exactly like the command plane),
 * and serves the composed projection. Returns null when the path is not a
 * read-model route (the caller answers its own 404).
 */
export function createReadModelDispatcher(options: ReadModelOptions): ReadModelDispatcher {
  return async (request, path, principal): Promise<HttpResponse | null> => {
    if (request.method !== "GET") return null;
    const segments = pathSegments(path);
    if (segments[0] !== "v1") return null;

    // --- the honestly-kept 501s (named reasons, never invented data) -----
    const notComposed =
      READ_MODELS_NOT_COMPOSED[`/${segments.join("/")}`] ??
      (segments.length === 3 && segments[1] === "orders"
        ? READ_MODELS_NOT_COMPOSED["/v1/orders/{orderId}"]
        : undefined);
    if (notComposed !== undefined) {
      return readModelNotComposed(path, notComposed);
    }

    // --- the composed routes ----------------------------------------------
    const handler: ComposedReadHandler | undefined = selectComposedHandler(segments);
    if (handler === undefined) return null;

    // Tenant scope for the read: the context header, cross-checked against
    // the authenticated principal exactly like the command plane (a forged
    // actor header that disagrees with the session is rejected before any
    // state is read).
    const context = readContextHeaders(request);
    if (context.tenantId === undefined) {
      throw new ValidationError(
        "the tenant context header is required for business reads",
        {
          reason: "READ_CONTEXT_INCOMPLETE",
          details: [{ path: "x-roamlink-tenant-id", issue: "required header missing or empty" }],
        },
      );
    }
    if (context.actorId !== undefined && context.actorId !== principal.actorId) {
      throw new ValidationError(
        "the actor header does not match the authenticated principal (the server authenticates from its own session layer)",
        {
          reason: "READ_CONTEXT_INVALID",
          details: [
            { path: "x-roamlink-actor-id", issue: "mismatch with the authenticated session" },
          ],
        },
      );
    }
    const tenantId = parseTenantId(context.tenantId);
    await options.authorization.resolveActorTenant(principal.actorId, tenantId, options.now());
    return handler({ request, path, principal, tenantId, ...options });
  };
}

/** Selects the composed read handler for a decoded `/v1/...` path. */
function selectComposedHandler(segments: readonly string[]): ComposedReadHandler | undefined {
  if (segments.length === 3 && segments[1] === "users") return handleUserRead;
  if (segments.length === 2 && segments[1] === "organizations") return handleOrganizationsRead;
  if (segments.length === 2 && segments[1] === "devices") return handleDeviceListRead;
  if (segments.length === 3 && segments[1] === "devices") return handleDeviceRead;
  if (segments.length === 2 && segments[1] === "experience-intents") return handleIntentListRead;
  if (segments.length === 3 && segments[1] === "experience-intents") return handleIntentRead;
  if (segments.length === 4 && segments[1] === "experience-intents" && segments[3] === "versions") {
    return handleIntentVersionsRead;
  }
  if (segments.length === 2 && segments[1] === "payments") return handlePaymentListRead;
  if (segments.length === 2 && segments[1] === "connectivity") return handleConnectivityRead;
  if (segments.length === 2 && segments[1] === "reconciliation-jobs") {
    return handleReconciliationJobsRead;
  }
  if (segments.length === 2 && segments[1] === "support-cases") return handleSupportCaseListRead;
  if (segments.length === 3 && segments[1] === "support-cases") return handleSupportCaseRead;
  return undefined;
}

// --------------------------------------------------------------------------------
// Identity-backed reads (users, organizations)
// --------------------------------------------------------------------------------

async function handleUserRead(input: ReadRequestContext & ReadModelOptions): Promise<HttpResponse> {
  const segments = pathSegments(input.path);
  const rawUserId = segments[2] ?? "";
  let userId: UserId;
  try {
    userId = parseUserId(rawUserId);
  } catch {
    throw new ValidationError("the user read requires a canonical user id path segment", {
      reason: "READ_PATH_INVALID",
      details: [{ path: "userId", issue: "not a canonical lowercase UUID" }],
    });
  }
  // The user record lives in its own personal tenant: this is the directory
  // resolution read (the sanctioned cross-namespace shape - the acting
  // tenant was authorized above, the requested user is resolved by id).
  const user = await input.users.findById(tenantIdFromUser(userId), userId);
  if (user === undefined) {
    throw new NotFoundError("the requested user does not exist", { reason: "NOT_FOUND" });
  }
  return jsonResponse(200, {
    userId: user.userId,
    displayName: user.displayName,
    principalKind: "user",
  });
}

async function handleOrganizationsRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  // The organization list is an organization-scoped administrative read:
  // org:read through the boundary's own permission map (a personal tenant
  // fails closed - the typed 403, exactly like the contract reference).
  await input.authorization.authorize(
    input.principal.actorId,
    input.tenantId,
    "org:read",
    input.now(),
  );
  const organizationId = organizationIdOfTenant(input.tenantId);
  const organization = await input.organizations.findById(input.tenantId, organizationId);
  if (organization === undefined) {
    throw new NotFoundError("the requested organization does not exist", { reason: "NOT_FOUND" });
  }
  const memberships = await input.memberships.listByOrganization(input.tenantId, organizationId);
  const activeMembers = memberships
    .filter((membership) => membership.status === "active")
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((membership) => ({
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
    }));
  return jsonResponse(200, [
    {
      tenantId: organization.tenantId,
      organizationId: organization.organizationId,
      name: organization.name,
      status: organization.status,
      members: activeMembers,
      revision: organization.revision,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    },
  ]);
}

/** The organization id of an `org:<uuid>` tenant (undefined for personal). */
function organizationIdOfTenant(tenantId: TenantId): ReturnType<typeof parseOrganizationId> {
  if (!tenantId.startsWith("org:")) {
    // Personal tenants carry no organization scope; the authorize() call
    // above already failed closed, so this is unreachable in practice.
    throw new NotFoundError("the requested organization does not exist", { reason: "NOT_FOUND" });
  }
  return parseOrganizationId(tenantId.slice("org:".length));
}

// --------------------------------------------------------------------------------
// The command-ledger projections
// --------------------------------------------------------------------------------

/** The durable job-record repository of the reconciliation boundary. */
const RECONCILIATION_JOBS_REPOSITORY = "adcos-reconciliation-jobs";

/** One executed command's projection facts (validated narrow shape). */
interface ExecutedCommand {
  readonly commandId: string;
  readonly kind: string;
  readonly route: string;
  readonly actorId: string;
  readonly payload: Record<string, unknown>;
  readonly acceptedAt: string;
  readonly executedAt: string;
  readonly resourceId: string | null;
}

function commandCorrupt(what: string): never {
  throw new NotFoundError(
    `the command ledger is corrupt (failing closed): ${what}`,
    { reason: "COMMAND_LEDGER_CORRUPT" },
  );
}

function stringPayload(command: ExecutedCommand, field: string): string {
  const value = command.payload[field];
  if (typeof value !== "string" || value.length === 0) {
    commandCorrupt(`${command.commandId} (${command.kind}) is missing its ${field} payload fact`);
  }
  return value;
}

function accessClassesPayload(command: ExecutedCommand): readonly string[] {
  const value = command.payload["accessClasses"];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    commandCorrupt(`${command.commandId} (${command.kind}) is missing its accessClasses payload fact`);
  }
  return value as readonly string[];
}

/** The executed commands of the acting tenant, in execution order. */
async function executedCommandsOf(
  reader: PersistenceReader,
  tenantId: TenantId,
): Promise<readonly ExecutedCommand[]> {
  const records = await reader.records(COMMAND_REPOSITORY).list();
  const executed: ExecutedCommand[] = [];
  for (const record of records) {
    const command = record.value as unknown as StoredCommand;
    if (command.tenantId !== tenantId || command.executedAt === null) continue;
    if (typeof command.commandId !== "string" || typeof command.kind !== "string" || typeof command.route !== "string") {
      commandCorrupt("a stored command record is not a command");
    }
    // The ledger stores the command payload as its canonical JSON string
    // (the ingest's canonicalizeJson); the projection parses it back.
    let payload: Record<string, unknown> = {};
    if (typeof command.payload === "string") {
      try {
        const parsed: unknown = JSON.parse(command.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        commandCorrupt(`${command.commandId} carries an unparseable payload`);
      }
    } else if (command.payload !== null && command.payload !== undefined) {
      payload = command.payload as Record<string, unknown>;
    }
    executed.push({
      commandId: command.commandId,
      kind: command.kind,
      route: command.route,
      actorId: command.actorId,
      payload,
      acceptedAt: command.acceptedAt,
      executedAt: command.executedAt,
      resourceId: command.resource !== null && typeof command.resource.id === "string"
        ? command.resource.id
        : null,
    });
  }
  return executed.sort((a, b) =>
    a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : a.commandId < b.commandId ? -1 : 1,
  );
}

/** The creating user id of an `usr:<uuid>` actor id. */
function userIdOfActor(actorId: string): string {
  if (!actorId.startsWith("usr:") || actorId.length !== "usr:".length + 36) {
    commandCorrupt(`the actor id of a stored command is not a canonical user principal`);
  }
  return actorId.slice("usr:".length);
}

/** Extracts the targeted resource id of a `/v1/<resource>/{id>/<action>` route. */
function targetIdOfRoute(command: ExecutedCommand, prefix: string, action: string): string | null {
  const pattern = new RegExp(`^${prefix}/([^/]+)/${action}$`);
  const match = pattern.exec(command.route);
  return match === null ? null : (match[1] as string);
}

// --- devices -------------------------------------------------------------------

interface DeviceProjection {
  readonly deviceId: string;
  name: string;
  platform: string;
  status: "enrolled" | "retired";
  readonly owningUserId: string;
  revision: number;
  readonly createdAt: string;
  updatedAt: string;
}

function projectDevices(commands: readonly ExecutedCommand[]): readonly DeviceProjection[] {
  const devices = new Map<string, DeviceProjection>();
  for (const command of commands) {
    if (command.kind !== "device.enroll") continue;
    if (command.resourceId === null) continue; // executed without its recorded resource: nothing to project
    if (devices.has(command.resourceId)) continue; // one enrollment command per device id (idempotent plane)
    devices.set(command.resourceId, {
      deviceId: command.resourceId,
      name: stringPayload(command, "name"),
      platform: stringPayload(command, "platform"),
      status: "enrolled", // the domain registry's creation state (device-registry-service)
      owningUserId: userIdOfActor(command.actorId),
      revision: 1,
      createdAt: command.executedAt, // a device exists from execution
      updatedAt: command.executedAt,
    });
  }
  for (const command of commands) {
    if (command.kind === "device.update") {
      const deviceId = targetIdOfRoute(command, "/v1/devices", "update");
      const device = deviceId === null ? undefined : devices.get(deviceId);
      if (device === undefined) continue;
      const name = command.payload["name"];
      if (name !== undefined) device.name = stringPayload(command, "name");
      const platform = command.payload["platform"];
      if (platform !== undefined) device.platform = stringPayload(command, "platform");
      device.revision += 1;
      device.updatedAt = command.executedAt;
    } else if (command.kind === "device.retire") {
      const deviceId = targetIdOfRoute(command, "/v1/devices", "retire");
      const device = deviceId === null ? undefined : devices.get(deviceId);
      if (device === undefined) continue;
      device.status = "retired";
      device.revision += 1;
      device.updatedAt = command.executedAt;
    }
  }
  return [...devices.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
}

function deviceResourceOf(device: DeviceProjection): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    status: device.status,
    ownership: { userId: device.owningUserId },
    revision: device.revision,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    // No observation plane is composed in this service: freshness is the
    // honest null (never an assumed observation, RL-LOCK-011).
    capabilityFreshness: null,
    contextFreshness: null,
  };
}

async function handleDeviceListRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  return jsonResponse(200, projectDevices(commands).map(deviceResourceOf));
}

async function handleDeviceRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const segments = pathSegments(input.path);
  const deviceId = segments[2] ?? "";
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  const device = projectDevices(commands).find((candidate) => candidate.deviceId === deviceId);
  if (device === undefined) {
    // Cross-tenant and unknown ids are BOTH 404 (no existence oracle).
    throw new NotFoundError("the requested device does not exist", { reason: "NOT_FOUND" });
  }
  return jsonResponse(200, deviceResourceOf(device));
}

// --- experience intents (+ versions) --------------------------------------------

interface IntentVersionProjection {
  readonly intentVersionId: string; // the durable command that produced the version
  readonly versionNumber: number;
  status: "draft" | "active" | "superseded";
  readonly rationale: string;
  readonly accessClasses: readonly string[];
  readonly createdAt: string;
}

interface IntentProjection {
  readonly intentId: string;
  readonly deviceId: string;
  status: "draft" | "active";
  revision: number;
  readonly versions: IntentVersionProjection[];
}

function projectIntents(commands: readonly ExecutedCommand[]): readonly IntentProjection[] {
  const intents = new Map<string, IntentProjection>();
  for (const command of commands) {
    if (command.kind !== "experience-intent.create") continue;
    if (command.resourceId === null) continue;
    if (intents.has(command.resourceId)) continue;
    intents.set(command.resourceId, {
      intentId: command.resourceId,
      deviceId: stringPayload(command, "deviceId"),
      status: "draft", // the domain intent service's creation state
      revision: 1,
      versions: [
        {
          intentVersionId: command.commandId,
          versionNumber: 1,
          status: "draft",
          rationale: stringPayload(command, "rationale"),
          accessClasses: accessClassesPayload(command),
          createdAt: command.executedAt,
        },
      ],
    });
  }
  for (const command of commands) {
    const intentId =
      command.kind === "experience-intent.activate"
        ? targetIdOfRoute(command, "/v1/experience-intents", "activate")
        : command.kind === "experience-intent.supersede"
          ? targetIdOfRoute(command, "/v1/experience-intents", "versions")
          : null;
    if (intentId === null) continue;
    const intent = intents.get(intentId);
    if (intent === undefined) continue;
    if (command.kind === "experience-intent.activate") {
      intent.status = "active";
      for (const version of intent.versions) {
        if (version.status === "draft") version.status = "active";
      }
      intent.revision += 1;
    } else {
      // supersede: the active versions become superseded, the new version
      // is the active one (the domain's immutable-version lifecycle).
      for (const version of intent.versions) {
        if (version.status === "active") version.status = "superseded";
      }
      intent.versions.push({
        intentVersionId: command.commandId,
        versionNumber: intent.versions.length + 1,
        status: "active",
        rationale: stringPayload(command, "rationale"),
        accessClasses: accessClassesPayload(command),
        createdAt: command.executedAt,
      });
      intent.revision += 1;
    }
  }
  return [...intents.values()].sort((a, b) => (a.intentId < b.intentId ? -1 : 1));
}

function currentVersionOf(intent: IntentProjection): IntentVersionProjection | null {
  const active = intent.versions.filter((version) => version.status === "active");
  return active.length === 0 ? null : active[active.length - 1] ?? null;
}

function versionSummaryOf(version: IntentVersionProjection): Record<string, unknown> {
  return {
    intentVersionId: version.intentVersionId,
    versionNumber: version.versionNumber,
    status: version.status,
    rationale: version.rationale,
    accessClasses: [...version.accessClasses],
    createdAt: version.createdAt,
  };
}

function intentResourceOf(intent: IntentProjection): Record<string, unknown> {
  const current = currentVersionOf(intent);
  return {
    intentId: intent.intentId,
    deviceId: intent.deviceId,
    status: intent.status,
    revision: intent.revision,
    currentVersion: current === null ? null : versionSummaryOf(current),
    versions: intent.versions.map(versionSummaryOf),
    // No decision plane is composed in this service: the explainable
    // decision section is the honest null (never a derived status).
    decision: null,
  };
}

async function handleIntentListRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  return jsonResponse(200, projectIntents(commands).map(intentResourceOf));
}

async function handleIntentRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const segments = pathSegments(input.path);
  const intentId = segments[2] ?? "";
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  const intent = projectIntents(commands).find((candidate) => candidate.intentId === intentId);
  if (intent === undefined) {
    throw new NotFoundError("the requested experience intent does not exist", { reason: "NOT_FOUND" });
  }
  return jsonResponse(200, intentResourceOf(intent));
}

async function handleIntentVersionsRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const segments = pathSegments(input.path);
  const intentId = segments[2] ?? "";
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  const intent = projectIntents(commands).find((candidate) => candidate.intentId === intentId);
  if (intent === undefined) {
    throw new NotFoundError("the requested experience intent does not exist", { reason: "NOT_FOUND" });
  }
  return jsonResponse(200, intent.versions.map(versionSummaryOf));
}

// --- payments --------------------------------------------------------------------

interface PaymentProjection {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly recordedAt: string;
}

function projectPayments(commands: readonly ExecutedCommand[]): readonly PaymentProjection[] {
  const payments: PaymentProjection[] = [];
  for (const command of commands) {
    if (command.kind !== "payment.record") continue;
    if (command.resourceId === null) continue;
    const amountMinor = command.payload["amountMinor"];
    if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor < 1) {
      commandCorrupt(`${command.commandId} (payment.record) is missing its amountMinor payload fact`);
    }
    payments.push({
      paymentId: command.resourceId,
      orderId: stringPayload(command, "orderId"),
      amountMinor,
      currency: stringPayload(command, "currency"),
      recordedAt: command.executedAt,
    });
  }
  return payments.sort((a, b) => (a.paymentId < b.paymentId ? -1 : 1));
}

async function handlePaymentListRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  // state "pending": the domain's creation state for a recorded payment
  // (payment-service records pending; succeed/fail/cancel are transitions
  // this service's bound state never asserts - money facts only, never a
  // delivery claim, spec/data-model.md "State separation").
  return jsonResponse(
    200,
    projectPayments(commands).map((payment) => ({
      paymentId: payment.paymentId,
      orderId: payment.orderId,
      amount: { amountMinor: payment.amountMinor, currency: payment.currency },
      state: "pending",
      recordedAt: payment.recordedAt,
    })),
  );
}

// --- connectivity (the honest aggregate) -------------------------------------------

interface SubjectProjection {
  readonly subjectType: "order";
  readonly subjectId: string;
  commercialState: "placed" | "completed" | "cancelled";
}

function projectSubjects(commands: readonly ExecutedCommand[]): readonly SubjectProjection[] {
  const subjects = new Map<string, SubjectProjection>();
  for (const command of commands) {
    if (command.kind !== "order.place") continue;
    if (command.resourceId === null) continue;
    if (subjects.has(command.resourceId)) continue;
    subjects.set(command.resourceId, {
      subjectType: "order",
      subjectId: command.resourceId,
      commercialState: "placed", // the domain order aggregate's creation state
    });
  }
  for (const command of commands) {
    if (command.kind !== "order.cancel" && command.kind !== "order.complete") continue;
    const orderId = targetIdOfRoute(command, "/v1/orders", command.kind === "order.cancel" ? "cancel" : "complete");
    const subject = orderId === null ? undefined : subjects.get(orderId);
    if (subject === undefined) continue;
    subject.commercialState = command.kind === "order.cancel" ? "cancelled" : "completed";
  }
  return [...subjects.values()].sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
}

async function handleConnectivityRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  const devices = projectDevices(commands);
  // The answer to "what connectivity do I currently have?" over the bound
  // state: the executed commercial subjects with their reference lifecycle
  // and delivery-evidence state (no reference plane is composed here, so
  // the honest referenceStatus is "none" with UNEVIDENCED delivery state -
  // payment is not delivery, RL-LOCK-008/009), plus the device observations
  // (no observation plane is composed, so the honest per-device freshness
  // facts are null - never a guessed status).
  return jsonResponse(200, {
    presentedAt: input.now(),
    subjects: projectSubjects(commands).map((subject) => ({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      commercialState: subject.commercialState,
      referenceStatus: "none",
      deliveryEvidenceState: "UNEVIDENCED",
      evidence: null,
    })),
    deviceObservations: devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.name,
      capabilityFreshness: null,
      contextFreshness: null,
      lastObservedAt: null,
    })),
  });
}

// --- reconciliation jobs (the durable job records) ----------------------------------

interface JobRecordFacts {
  readonly jobId: string;
  readonly status: string;
  readonly trigger: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly actions: readonly {
    readonly actionType: string;
    readonly outcome: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly detail?: string;
    readonly at: string;
  }[];
}

function jobCorrupt(what: string): never {
  throw new NotFoundError(
    `the reconciliation job records are corrupt (failing closed): ${what}`,
    { reason: "RECONCILIATION_JOBS_CORRUPT" },
  );
}

async function handleReconciliationJobsRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  // The reconciliation-jobs list is an organization-scoped administrative
  // read (org:read through the boundary's permission map).
  await input.authorization.authorize(
    input.principal.actorId,
    input.tenantId,
    "org:read",
    input.now(),
  );
  const records = await input.persistence.records(RECONCILIATION_JOBS_REPOSITORY).list();
  const jobs: JobRecordFacts[] = [];
  for (const record of records) {
    const value = record.value as Record<string, unknown>;
    if (value["tenant_id"] !== input.tenantId) continue; // tenant boundary first
    const jobId = value["job_id"];
    const status = value["status"];
    const trigger = value["trigger_reason"];
    const correlationId = value["correlation_id"];
    const idempotencyKey = value["idempotency_key"];
    const createdAt = value["created_at"];
    if (
      typeof jobId !== "string" || typeof status !== "string" || typeof trigger !== "string" ||
      typeof correlationId !== "string" || typeof idempotencyKey !== "string" ||
      typeof createdAt !== "string"
    ) {
      jobCorrupt("a stored job record is not a reconciliation job");
    }
    const rawActions = value["actions"];
    if (!Array.isArray(rawActions)) {
      jobCorrupt("a stored job record is missing its action list");
    }
    const actions: {
      actionType: string;
      outcome: string;
      targetType?: string;
      targetId?: string;
      detail?: string;
      at: string;
    }[] = [];
    for (const rawAction of rawActions) {
      const action = rawAction as Record<string, unknown>;
      if (
        typeof action["action_type"] !== "string" || typeof action["outcome"] !== "string" ||
        typeof action["attempted_at"] !== "string"
      ) {
        jobCorrupt("a stored job record carries a malformed action");
      }
      actions.push({
        actionType: action["action_type"] as string,
        outcome: action["outcome"] as string,
        ...(typeof action["resource_type"] === "string" ? { targetType: action["resource_type"] } : {}),
        ...(typeof action["resource_id"] === "string" ? { targetId: action["resource_id"] } : {}),
        ...(typeof action["detail"] === "string" ? { detail: action["detail"] } : {}),
        at: action["attempted_at"] as string,
      });
    }
    jobs.push({
      jobId,
      status,
      trigger,
      correlationId,
      idempotencyKey,
      createdAt,
      startedAt: typeof value["started_at"] === "string" ? value["started_at"] : null,
      completedAt: typeof value["completed_at"] === "string" ? value["completed_at"] : null,
      actions,
    });
  }
  jobs.sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
  return jsonResponse(
    200,
    jobs.map((job) => ({
      jobId: job.jobId,
      status: job.status,
      trigger: job.trigger,
      commandId: job.jobId, // a job record IS a §5 command (its job id)
      correlationId: job.correlationId,
      idempotencyKey: job.idempotencyKey,
      createdAt: job.createdAt,
      ...(job.startedAt !== null ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt !== null ? { completedAt: job.completedAt } : {}),
      actions: job.actions,
    })),
  );
}

// --- support cases ------------------------------------------------------------------

interface SupportCaseProjection {
  readonly caseId: string;
  readonly subject: string;
  readonly description: string;
  status: "open" | "in_progress" | "resolved" | "closed" | "cancelled";
  readonly priority: string;
  readonly createdByUserId: string;
  readonly relatedRefs: readonly { readonly kind: string; readonly id: string }[];
  revision: number;
  readonly createdAt: string;
  updatedAt: string;
}

function projectSupportCases(
  commands: readonly ExecutedCommand[],
): readonly SupportCaseProjection[] {
  const cases = new Map<string, SupportCaseProjection>();
  for (const command of commands) {
    if (command.kind !== "support-case.create") continue;
    if (command.resourceId === null) continue;
    if (cases.has(command.resourceId)) continue;
    const rawRelatedRefs = command.payload["relatedRefs"];
    if (!Array.isArray(rawRelatedRefs)) {
      commandCorrupt(`${command.commandId} (support-case.create) is missing its relatedRefs payload fact`);
    }
    const relatedRefs: { kind: string; id: string }[] = [];
    for (const rawRef of rawRelatedRefs) {
      const ref = rawRef as Record<string, unknown>;
      if (typeof ref["kind"] !== "string" || typeof ref["id"] !== "string") {
        commandCorrupt("a support-case.create command carries a malformed related reference");
      }
      relatedRefs.push({ kind: ref["kind"] as string, id: ref["id"] as string });
    }
    cases.set(command.resourceId, {
      caseId: command.resourceId,
      subject: stringPayload(command, "subject"),
      description: stringPayload(command, "description"),
      status: "open", // the domain case service's creation state
      priority: stringPayload(command, "priority"),
      createdByUserId: userIdOfActor(command.actorId),
      relatedRefs,
      revision: 1,
      createdAt: command.executedAt,
      updatedAt: command.executedAt,
    });
  }
  const STATUS_OF_TRANSITION: Readonly<Record<string, SupportCaseProjection["status"]>> =
    Object.freeze({
      startProgress: "in_progress",
      resolve: "resolved",
      close: "closed",
      cancel: "cancelled",
    });
  for (const command of commands) {
    if (command.kind !== "support-case.transition") continue;
    const caseId = targetIdOfRoute(command, "/v1/support-cases", "transitions");
    const supportCase = caseId === null ? undefined : cases.get(caseId);
    if (supportCase === undefined) continue;
    const transition = command.payload["transition"];
    if (typeof transition !== "string") {
      commandCorrupt(`${command.commandId} (support-case.transition) is missing its transition payload fact`);
    }
    const status = STATUS_OF_TRANSITION[transition];
    if (status === undefined) continue; // not a closed-vocabulary transition: nothing applied
    supportCase.status = status;
    supportCase.revision += 1;
    supportCase.updatedAt = command.executedAt;
  }
  return [...cases.values()].sort((a, b) => (a.caseId < b.caseId ? -1 : 1));
}

function supportCaseResourceOf(supportCase: SupportCaseProjection): Record<string, unknown> {
  return {
    caseId: supportCase.caseId,
    subject: supportCase.subject,
    description: supportCase.description,
    status: supportCase.status,
    priority: supportCase.priority,
    createdByUserId: supportCase.createdByUserId,
    relatedRefs: supportCase.relatedRefs,
    // No message plane is composed in this service: the message history is
    // the honest empty list (never a fabricated exchange).
    messages: [],
    revision: supportCase.revision,
    createdAt: supportCase.createdAt,
    updatedAt: supportCase.updatedAt,
  };
}

async function handleSupportCaseListRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  return jsonResponse(200, projectSupportCases(commands).map(supportCaseResourceOf));
}

async function handleSupportCaseRead(
  input: ReadRequestContext & ReadModelOptions,
): Promise<HttpResponse> {
  const segments = pathSegments(input.path);
  const caseId = segments[2] ?? "";
  const commands = await executedCommandsOf(input.persistence, input.tenantId);
  const supportCase = projectSupportCases(commands).find((candidate) => candidate.caseId === caseId);
  if (supportCase === undefined) {
    throw new NotFoundError("the requested support case does not exist", { reason: "NOT_FOUND" });
  }
  return jsonResponse(200, supportCaseResourceOf(supportCase));
}

// --------------------------------------------------------------------------------
// Path helpers
// --------------------------------------------------------------------------------

/** The decoded path segments (query string stripped, like the fake's). */
function pathSegments(path: string): readonly string[] {
  const queryIndex = path.indexOf("?");
  const clean = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return clean
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}
