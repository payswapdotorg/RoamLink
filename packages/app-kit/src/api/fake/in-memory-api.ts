/**
 * The deterministic in-memory fake API (app-kit test surface).
 *
 * Implements the SAME public application API contract the production service
 * (services/api, a later wave) will implement, at the CONTRACT level:
 *
 *  - command semantics: every mutation requires the full header envelope
 *    (request/correlation/idempotency/actor/tenant + optimistic version for
 *    existing versioned resources) BEFORE any state is touched
 *    (spec/security.md "Authorization": tenant boundary, actor permission,
 *    resource ownership, command idempotency - in that order);
 *  - idempotency (RL-LOCK-014): replaying an idempotency key replays the
 *    original acknowledgement and performs NO additional effect;
 *  - the mutation-outcome stages: accepted/executed at command time,
 *    delivered/billable-final ONLY when evidence/finality facts arrive
 *    (controls progress them - the fake never invents delivery);
 *  - freshness evaluated at the query instant (FRESH degrades to STALE
 *    monotonically; UNKNOWN is presented, never guessed - RL-LOCK-010);
 *  - tenant scoping fail-closed: cross-tenant access is a 404 with no
 *    existence oracle; in-tenant permission failures are 403; the admin
 *    surfaces require org:read / org:manage within the acting tenant;
 *  - the audit chain: SHA-256 digest chaining over canonical JSON, exactly
 *    like @roamlink/audit (append-only, verifiable);
 *  - the ONE sanctioned suspended-organization escape: reactivation by an
 *    org:manage holder while suspended (mirrors @roamlink/auth).
 *
 * It is a FAKE: contract-level behavior for deterministic component tests,
 * not a domain authority. It deliberately implements none of the domain
 * invariants beyond the state-machine transitions the app surfaces exercise.
 */
import {
  canonicalizeJson,
  evaluateFreshnessState,
  sha256Hex,
  type UtcInstant,
} from "@roamlink/contracts";

import { HTTP_STATUS, type HttpRequest, type HttpResponse, type HttpTransport } from "../transport.js";
import type { FakeApiOptions, FakeApiSeed } from "./seed.js";

// --------------------------------------------------------------------------------
// Internal state types (mutable copies of the seed)
// --------------------------------------------------------------------------------

interface StoredCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  acceptedAt: string;
  executedAt?: string;
  deliveredAt?: string;
  billableFinalAt?: string;
  resource?: { type: string; id: string; version?: number };
}

interface StoredAuditEvent {
  readonly eventId: string;
  sequence: number;
  readonly category: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly commandId?: string;
  readonly target?: string;
  readonly occurredAt: string;
  readonly detail?: string;
  prevDigest: string | null;
  digest: string;
}

/** Recursively strips `readonly` (the JSON round-trip already made it so). */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

interface TenantState extends DeepMutable<FakeApiSeed["tenants"][string]> {
  auditEvents: StoredAuditEvent[];
}

interface FakeState {
  users: DeepMutable<FakeApiSeed["users"]>;
  catalog: DeepMutable<FakeApiSeed["catalog"]>;
  tenants: Map<string, TenantState>;
  commands: Map<string, StoredCommand>;
  idempotency: Map<string, string>;
}

// --------------------------------------------------------------------------------
// Error responses
// --------------------------------------------------------------------------------

function errorResponse(
  status: number,
  kind: string,
  reason: string,
  message: string,
  retryable: boolean,
): HttpResponse {
  return {
    status,
    body: JSON.stringify({ kind, reason, message, retryable, details: [] }),
  };
}

const badRequest = (reason: string, message: string) =>
  errorResponse(HTTP_STATUS.badRequest, "validation", reason, message, false);
const unauthorized = (reason: string, message: string) =>
  errorResponse(HTTP_STATUS.unauthorized, "unauthorized", reason, message, false);
const forbidden = (reason: string, message: string) =>
  errorResponse(HTTP_STATUS.forbidden, "unauthorized", reason, message, false);
const notFound = (message: string) =>
  errorResponse(HTTP_STATUS.notFound, "not-found", "NOT_FOUND", message, false);
const conflict = (reason: string, message: string) =>
  errorResponse(HTTP_STATUS.conflict, "conflict", reason, message, false);

const ok = (value: unknown): HttpResponse => ({ status: 200, body: JSON.stringify(value) });
const accepted = (value: unknown): HttpResponse => ({ status: 202, body: JSON.stringify(value) });

// --------------------------------------------------------------------------------
// Actor / permission resolution (mirrors @roamlink/auth's frozen map)
// --------------------------------------------------------------------------------

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  owner: Object.freeze([
    "account:read",
    "account:manage",
    "org:read",
    "org:manage",
    "member:read",
    "member:invite",
    "member:manage",
    "owner:manage",
  ]),
  admin: Object.freeze(["org:read", "org:manage", "member:read", "member:invite", "member:manage"]),
  member: Object.freeze(["org:read", "member:read"]),
});
const PERSONAL_PERMISSIONS: readonly string[] = Object.freeze(["account:read", "account:manage"]);

interface ResolvedActor {
  readonly userId: string;
  readonly scope: "user" | "organization";
  readonly role: string | null;
  readonly permissions: readonly string[];
  readonly orgStatus: "active" | "suspended" | null;
}

class HttpError extends Error {
  readonly response: HttpResponse;
  constructor(response: HttpResponse) {
    super("HttpError");
    this.response = response;
  }
}

function fail(response: HttpResponse): never {
  throw new HttpError(response);
}

function actorUserId(actorId: string): string {
  if (!actorId.startsWith("usr:")) {
    fail(unauthorized("ACTOR_INVALID", "the actor principal is not a RoamLink user principal"));
  }
  const userId = actorId.slice(4);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) {
    fail(unauthorized("ACTOR_INVALID", "the actor principal is not a canonical user principal"));
  }
  return userId;
}

function resolveActor(state: FakeState, actorId: string, tenantId: string): ResolvedActor {
  const userId = actorUserId(actorId);
  if (tenantId.startsWith("usr:")) {
    if (tenantId !== `usr:${userId}`) {
      fail(notFound("the requested tenant does not exist for this actor"));
    }
    return {
      userId,
      scope: "user",
      role: null,
      permissions: PERSONAL_PERMISSIONS,
      orgStatus: null,
    };
  }
  if (!tenantId.startsWith("org:")) {
    fail(unauthorized("TENANT_INVALID", "the tenant reference is not a recognized tenant scope"));
  }
  const tenant = state.tenants.get(tenantId);
  if (tenant?.organization === undefined) {
    fail(notFound("the requested tenant does not exist for this actor"));
  }
  const membership = tenant.organization.members.find(
    (m) => m.userId === userId && m.status === "active",
  );
  if (membership === undefined) {
    fail(notFound("the requested tenant does not exist for this actor"));
  }
  return {
    userId,
    scope: "organization",
    role: membership.role,
    permissions: ROLE_PERMISSIONS[membership.role] ?? [],
    orgStatus: tenant.organization.status,
  };
}

function requirePermission(actor: ResolvedActor, permission: string): void {
  if (!actor.permissions.includes(permission)) {
    fail(
      forbidden(
        "ACTOR_PERMISSION_MISSING",
        `the actor lacks the '${permission}' permission required by this surface`,
      ),
    );
  }
}

function requireOrgScope(actor: ResolvedActor): void {
  if (actor.scope !== "organization") {
    fail(
      forbidden(
        "ORG_SCOPE_REQUIRED",
        "administrative surfaces require an organization tenant scope",
      ),
    );
  }
}

// --------------------------------------------------------------------------------
// Freshness evaluation at the query instant
// --------------------------------------------------------------------------------

function evaluateFresh(
  freshness: { observedAt: string | null; receivedAt: string | null; freshUntil: string | null } | null | undefined,
  now: string,
): { observedAt: string | null; receivedAt: string | null; freshUntil: string | null; freshnessState: string } {
  if (freshness === null || freshness === undefined) {
    return { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" };
  }
  const state = evaluateFreshnessState(
    {
      observedAt: (freshness.observedAt ?? null) as UtcInstant | null,
      receivedAt: (freshness.receivedAt ?? null) as UtcInstant | null,
      freshUntil: (freshness.freshUntil ?? null) as UtcInstant | null,
    },
    now as UtcInstant,
  );
  return {
    observedAt: freshness.observedAt ?? null,
    receivedAt: freshness.receivedAt ?? null,
    freshUntil: freshness.freshUntil ?? null,
    freshnessState: state,
  };
}

// --------------------------------------------------------------------------------
// The fake API itself
// --------------------------------------------------------------------------------

export interface InMemoryApiControls {
  /** Moves a command to the `delivered` stage (requires executed). */
  progressCommandToDelivered(commandId: string): boolean;
  /** Moves a command to the `billable-final` stage (requires delivered). */
  progressCommandToBillableFinal(commandId: string): boolean;
  /**
   * Links delivery evidence to a commercial subject: sets the reference
   * EVIDENCED and auto-progresses the subject's place-order commands to
   * `delivered`. Delivery is only ever EVIDENCE (RL-LOCK-008/009).
   */
  linkDeliveryEvidence(input: {
    readonly subjectType: "order" | "subscription";
    readonly subjectId: string;
    readonly evidenceClass: string;
    readonly canonicalResourceType: string;
    readonly canonicalResourceId: string;
    readonly sourceVersion: number | null;
    readonly eventId: string | null;
    readonly payloadDigest: string;
    readonly freshUntil: string;
  }): void;
  /** Marks an invoice reconciled and progresses payment commands to billable-final. */
  reconcileInvoice(invoiceId: string): boolean;
  /** Frozen introspection of stored commands (assertions in tests). */
  commands(): readonly StoredCommand[];
}

export interface InMemoryApi {
  readonly transport: HttpTransport;
  readonly controls: InMemoryApiControls;
}

export function createInMemoryApi(seed: FakeApiSeed, options: FakeApiOptions): InMemoryApi {
  // Deep mutable copy of the frozen seed (JSON round-trip: seed is JSON-safe).
  const clonedSeed = JSON.parse(JSON.stringify(seed)) as unknown as {
    users: FakeState["users"];
    catalog: FakeState["catalog"];
    tenants: Record<string, TenantState>;
  };
  const state: FakeState = {
    users: clonedSeed.users,
    catalog: clonedSeed.catalog,
    tenants: new Map(
      Object.entries(clonedSeed.tenants).map(([tenantId, tenant]) => [
        tenantId,
        { ...tenant, auditEvents: [] },
      ]),
    ),
    commands: new Map(),
    idempotency: new Map(),
  };

  const now = options.now;
  const nextId = options.ids;

  // --------------------------------------------------------------------------
  // Audit chain (SHA-256 over canonical JSON, append-only)
  // --------------------------------------------------------------------------

  function auditBodyCanonical(event: Omit<StoredAuditEvent, "digest">): string {
    const body = {
      eventId: event.eventId,
      sequence: event.sequence,
      category: event.category,
      action: event.action,
      outcome: event.outcome,
      actorId: event.actorId,
      ...(event.tenantId !== undefined ? { tenantId: event.tenantId } : {}),
      correlationId: event.correlationId,
      ...(event.commandId !== undefined ? { commandId: event.commandId } : {}),
      ...(event.target !== undefined ? { target: event.target } : {}),
      occurredAt: event.occurredAt,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      prevDigest: event.prevDigest,
    };
    return canonicalizeJson(body);
  }

  function appendAudit(
    tenantId: string,
    input: {
      readonly category: string;
      readonly action: string;
      readonly outcome: string;
      readonly actorId: string;
      readonly correlationId: string;
      readonly commandId?: string;
      readonly target?: string;
      readonly detail?: string;
    },
  ): void {
    const tenant = state.tenants.get(tenantId);
    if (tenant === undefined) return;
    const last = tenant.auditEvents[tenant.auditEvents.length - 1];
    const draft: Omit<StoredAuditEvent, "digest"> = {
      eventId: nextId(),
      sequence: last === undefined ? 1 : last.sequence + 1,
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      actorId: input.actorId,
      tenantId,
      correlationId: input.correlationId,
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      occurredAt: now(),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      prevDigest: last === undefined ? null : last.digest,
    };
    const event: StoredAuditEvent = { ...draft, digest: sha256Hex(auditBodyCanonical(draft)) };
    tenant.auditEvents.push(event);
  }

  function verifyChain(events: readonly StoredAuditEvent[]): {
    verified: boolean;
    verifiedCount?: number;
    brokenAtSequence?: number;
  } {
    let previous: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.sequence !== index + 1 || event.prevDigest !== previous) {
        return { verified: false, brokenAtSequence: event.sequence };
      }
      const recomputed = sha256Hex(auditBodyCanonical(event));
      if (recomputed !== event.digest) {
        return { verified: false, brokenAtSequence: event.sequence };
      }
      previous = event.digest;
    }
    return events.length === 0
      ? { verified: true }
      : { verified: true, verifiedCount: events.length };
  }

  // --------------------------------------------------------------------------
  // Command engine (idempotency + stages)
  // --------------------------------------------------------------------------

  function ackOf(command: StoredCommand): Record<string, unknown> {
    return {
      commandId: command.commandId,
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      acceptedAt: command.acceptedAt,
      ...(command.executedAt !== undefined ? { executedAt: command.executedAt } : {}),
      ...(command.deliveredAt !== undefined ? { deliveredAt: command.deliveredAt } : {}),
      ...(command.billableFinalAt !== undefined ? { billableFinalAt: command.billableFinalAt } : {}),
      ...(command.resource !== undefined ? { resource: command.resource } : {}),
    };
  }

  function runCommand(input: {
    readonly kind: string;
    readonly actorId: string;
    readonly tenantId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly subjectType?: string;
    readonly subjectId?: string;
    readonly apply: () => { readonly resource?: { readonly type: string; readonly id: string; readonly version?: number } };
  }): HttpResponse {
    const idempotencyIndexKey = `${input.tenantId}|${input.idempotencyKey}`;
    const replayedCommandId = state.idempotency.get(idempotencyIndexKey);
    if (replayedCommandId !== undefined) {
      const stored = state.commands.get(replayedCommandId);
      if (stored !== undefined) {
        return accepted(ackOf(stored));
      }
    }
    const commandId = nextId();
    const command: StoredCommand = {
      commandId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      tenantId: input.tenantId,
      kind: input.kind,
      acceptedAt: now(),
      ...(input.subjectType !== undefined ? { subjectType: input.subjectType } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
    };
    const applied = input.apply();
    command.executedAt = now();
    if (applied.resource !== undefined) {
      command.resource = applied.resource;
    }
    state.commands.set(commandId, command);
    state.idempotency.set(idempotencyIndexKey, commandId);
    return accepted(ackOf(command));
  }

  // --------------------------------------------------------------------------
  // Helpers over tenant state
  // --------------------------------------------------------------------------

  function tenantOf(tenantId: string): TenantState {
    const tenant = state.tenants.get(tenantId);
    if (tenant === undefined) {
      fail(notFound("the requested tenant does not exist for this actor"));
    }
    return tenant;
  }

  function requireVersion(expected: string | undefined, actual: number, what: string): void {
    if (expected === undefined) {
      fail(
        badRequest(
          "OPTIMISTIC_VERSION_REQUIRED",
          `${what} requires the optimistic-version header for the targeted revision`,
        ),
      );
    }
    const parsed = Number.parseInt(expected, 10);
    if (!Number.isInteger(parsed) || parsed !== actual) {
      fail(
        conflict(
          "OPTIMISTIC_VERSION_CONFLICT",
          `${what} was changed concurrently; refresh and retry against the current revision`,
        ),
      );
    }
  }

  function findOrder(tenant: TenantState, orderId: string): TenantState["orders"][number] {
    const order = tenant.orders.find((o) => o.orderId === orderId);
    if (order === undefined) {
      fail(notFound("the requested order does not exist"));
    }
    return order;
  }

  function findIntent(tenant: TenantState, intentId: string): TenantState["intents"][number] {
    const intent = tenant.intents.find((i) => i.intentId === intentId);
    if (intent === undefined) {
      fail(notFound("the requested experience intent does not exist"));
    }
    return intent;
  }

  function findSupportCase(tenant: TenantState, caseId: string): TenantState["supportCases"][number] {
    const supportCase = tenant.supportCases.find((c) => c.caseId === caseId);
    if (supportCase === undefined) {
      fail(notFound("the requested support case does not exist"));
    }
    return supportCase;
  }

  function findReference(
    tenant: TenantState,
    subjectType: string,
    subjectId: string,
  ): TenantState["references"][number] | undefined {
    return tenant.references.find(
      (r) => r.subjectType === subjectType && r.subjectId === subjectId,
    );
  }

  function orderTotal(order: TenantState["orders"][number]): { amountMinor: number; currency: string } {
    const currency = order.lines[0]?.currency ?? "USD";
    const amountMinor = order.lines.reduce(
      (sum, line) => sum + line.amountMinor * line.quantity,
      0,
    );
    return { amountMinor, currency };
  }

  // --------------------------------------------------------------------------
  // Resource serializers (from internal state, freshness re-evaluated)
  // --------------------------------------------------------------------------

  function deviceResource(device: TenantState["devices"][number]): Record<string, unknown> {
    return {
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      status: device.status,
      ownership: { userId: device.owningUserId },
      revision: device.revision,
      createdAt: device.revision > 1 ? now() : now(),
      updatedAt: now(),
      capabilityFreshness:
        device.capabilityFreshness === null
          ? null
          : evaluateFresh(device.capabilityFreshness, now()),
      contextFreshness:
        device.contextFreshness === null ? null : evaluateFresh(device.contextFreshness, now()),
    };
  }

  function intentResource(intent: TenantState["intents"][number]): Record<string, unknown> {
    const current = [...intent.versions]
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .find((v) => v.status === "active");
    const sorted = [...intent.versions].sort((a, b) => a.versionNumber - b.versionNumber);
    return {
      intentId: intent.intentId,
      deviceId: intent.deviceId,
      status: intent.status,
      revision: intent.revision,
      currentVersion:
        current === undefined
          ? null
          : {
              intentVersionId: current.intentVersionId,
              versionNumber: current.versionNumber,
              status: current.status,
              rationale: current.rationale,
              accessClasses: [...current.accessClasses],
              createdAt: current.createdAt,
            },
      versions: sorted.map((v) => ({
        intentVersionId: v.intentVersionId,
        versionNumber: v.versionNumber,
        status: v.status,
        rationale: v.rationale,
        accessClasses: [...v.accessClasses],
        createdAt: v.createdAt,
      })),
      decision:
        intent.decision === null
          ? null
          : {
              decisionId: intent.decision.decisionId,
              derivedStatus: intent.decision.derivedStatus,
              computedAt: intent.decision.computedAt,
              subjectStatus: intent.status,
              inputFreshness: [],
            },
    };
  }

  function subjectConnectivity(
    subjectType: "order" | "subscription",
    subjectId: string,
    commercialState: string,
    reference: TenantState["references"][number] | undefined,
  ): Record<string, unknown> {
    if (reference === undefined) {
      return {
        subjectType,
        subjectId,
        commercialState,
        referenceStatus: "none",
        deliveryEvidenceState: "UNEVIDENCED",
        evidence: null,
      };
    }
    const evidence = reference.evidence;
    return {
      subjectType,
      subjectId,
      commercialState,
      referenceStatus: reference.status,
      deliveryEvidenceState: reference.deliveryEvidenceState,
      evidence:
        evidence === undefined
          ? null
          : {
              evidenceClass: evidence.evidenceClass,
              canonicalResourceType: evidence.canonicalResourceType,
              canonicalResourceId: evidence.canonicalResourceId,
              sourceVersion: evidence.sourceVersion,
              eventId: evidence.eventId,
              payloadDigest: evidence.payloadDigest,
              freshness: {
                ...evaluateFresh(
                  {
                    observedAt: evidence.observedAt,
                    receivedAt: evidence.receivedAt,
                    freshUntil: evidence.freshUntil,
                  },
                  now(),
                ),
                recordedFreshnessState: evidence.recordedFreshnessState,
              },
            },
    };
  }

  // --------------------------------------------------------------------------
  // Request handling
  // --------------------------------------------------------------------------

  function header(request: HttpRequest, name: string): string | undefined {
    const entry = Object.entries(request.headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return entry === undefined ? undefined : entry[1];
  }

  function parseBody(request: HttpRequest): Record<string, unknown> {
    if (request.body === undefined || request.body.length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(request.body) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail(badRequest("REQUEST_BODY_INVALID", "the request body must be a JSON object"));
      }
      return parsed as Record<string, unknown>;
    } catch {
      fail(badRequest("REQUEST_BODY_INVALID", "the request body must be valid JSON"));
    }
  }

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

  function queryParams(path: string): URLSearchParams {
    const queryIndex = path.indexOf("?");
    return new URLSearchParams(queryIndex === -1 ? "" : path.slice(queryIndex + 1));
  }

  async function handle(request: HttpRequest): Promise<HttpResponse> {
    const segments = pathSegments(request.path);
    const method = request.method;

    const actorHeader = header(request, "x-roamlink-actor-id");
    const tenantHeader = header(request, "x-roamlink-tenant-id");
    if (actorHeader === undefined || tenantHeader === undefined) {
      fail(
        unauthorized(
          "ACTOR_CONTEXT_MISSING",
          "every request must carry actor and tenant context headers",
        ),
      );
    }

    // Command envelope validation (mutations only) - before any state is read.
    let mutationEnvelope: { requestId: string; correlationId: string; idempotencyKey: string } | undefined;
    if (method === "POST") {
      const requestId = header(request, "x-roamlink-request-id");
      const correlationId = header(request, "x-roamlink-correlation-id");
      const idempotencyKey = header(request, "idempotency-key");
      if (
        requestId === undefined ||
        requestId.length === 0 ||
        correlationId === undefined ||
        correlationId.length === 0 ||
        idempotencyKey === undefined ||
        idempotencyKey.length === 0
      ) {
        fail(
          badRequest(
            "COMMAND_ENVELOPE_INCOMPLETE",
            "every mutation must carry request-id, correlation-id and idempotency-key headers",
          ),
        );
      }
      mutationEnvelope = { requestId, correlationId, idempotencyKey };
    }

    const actor = resolveActor(state, actorHeader, tenantHeader);
    const tenantId = tenantHeader;

    // Suspended organizations block all member access EXCEPT the sanctioned
    // reactivation path (mirrors @roamlink/auth's allowSuspendedOrganization:
    // org:manage + the suspended org's own tenant, reactivation only).
    const isReactivation =
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "organizations" &&
      segments[3] === "reactivate";
    if (actor.orgStatus === "suspended" && !isReactivation) {
      fail(
        forbidden(
          "ORGANIZATION_SUSPENDED",
          "the organization tenant is suspended; reactivation is the only sanctioned path",
        ),
      );
    }

    // -- GET /v1/users/me ------------------------------------------------------
    if (method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "users" && segments[2] === "me") {
      return ok({
        actorId: actorHeader,
        userId: actor.userId,
        tenantId,
        scope: actor.scope,
        role: actor.role,
        permissions: [...actor.permissions],
      });
    }

    // -- GET /v1/users/{userId} ------------------------------------------------
    if (method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "users") {
      const user = state.users.find((u) => u.userId === segments[2]);
      if (user === undefined) {
        fail(notFound("the requested user does not exist"));
      }
      return ok({ userId: user.userId, displayName: user.displayName, principalKind: "user" });
    }

    // -- Devices ----------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "devices") {
      const tenant = tenantOf(tenantId);
      if (method === "GET" && segments.length === 2) {
        return ok(tenant.devices.map(deviceResource));
      }
      if (method === "POST" && segments.length === 2) {
        const body = parseBody(request);
        const name = typeof body["name"] === "string" ? body["name"] : undefined;
        const platform = typeof body["platform"] === "string" ? body["platform"] : undefined;
        if (name === undefined || name.length === 0) {
          fail(badRequest("DEVICE_NAME_REQUIRED", "the device name is required"));
        }
        if (platform === undefined) {
          fail(badRequest("DEVICE_PLATFORM_REQUIRED", "the device platform is required"));
        }
        return runCommand({
          kind: "device.enroll",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "device",
          apply: () => {
            const deviceId = nextId();
            const device: TenantState["devices"][number] = {
              deviceId,
              name,
              platform: platform as TenantState["devices"][number]["platform"],
              status: "enrolled",
              owningUserId: actor.userId,
              revision: 1,
              capabilityFreshness: null,
              contextFreshness: null,
            };
            tenant.devices.push(device);
            appendAudit(tenantId, {
              category: "authority-decision",
              action: "device.enroll",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              target: `device:${deviceId}`,
            });
            return { resource: { type: "device", id: deviceId, version: 1 } };
          },
        });
      }
      const deviceId = segments[2];
      if (deviceId === undefined) {
        fail(notFound("the requested device does not exist"));
      }
      const device = tenant.devices.find((d) => d.deviceId === deviceId);
      if (device === undefined) {
        fail(notFound("the requested device does not exist"));
      }
      if (method === "GET" && segments.length === 3) {
        return ok(deviceResource(device));
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "update") {
        const body = parseBody(request);
        const expected = header(request, "x-roamlink-expected-version");
        return runCommand({
          kind: "device.update",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "device",
          subjectId: deviceId,
          apply: () => {
            requireVersion(expected, device.revision, "the device update");
            if (typeof body["name"] === "string" && body["name"].length > 0) {
              device.name = body["name"];
            }
            if (typeof body["platform"] === "string") {
              device.platform = body["platform"] as TenantState["devices"][number]["platform"];
            }
            device.revision += 1;
            return { resource: { type: "device", id: deviceId, version: device.revision } };
          },
        });
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "retire") {
        const expected = header(request, "x-roamlink-expected-version");
        return runCommand({
          kind: "device.retire",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "device",
          subjectId: deviceId,
          apply: () => {
            requireVersion(expected, device.revision, "the device retirement");
            if (device.status === "retired") {
              fail(conflict("DEVICE_ALREADY_RETIRED", "the device is already retired"));
            }
            device.status = "retired";
            device.revision += 1;
            return { resource: { type: "device", id: deviceId, version: device.revision } };
          },
        });
      }
    }

    // -- Experience intents -----------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "experience-intents") {
      const tenant = tenantOf(tenantId);
      if (method === "GET" && segments.length === 2) {
        return ok(tenant.intents.map(intentResource));
      }
      if (method === "POST" && segments.length === 2) {
        const body = parseBody(request);
        const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : undefined;
        const rationale = typeof body["rationale"] === "string" ? body["rationale"] : undefined;
        const accessClasses = Array.isArray(body["accessClasses"])
          ? (body["accessClasses"] as unknown[]).filter((c): c is string => typeof c === "string")
          : undefined;
        if (deviceId === undefined || !tenant.devices.some((d) => d.deviceId === deviceId)) {
          fail(notFound("the target device does not exist"));
        }
        if (rationale === undefined || rationale.length === 0) {
          fail(badRequest("INTENT_RATIONALE_REQUIRED", "the intent rationale is required"));
        }
        if (accessClasses === undefined || accessClasses.length === 0) {
          fail(badRequest("INTENT_ACCESS_CLASSES_REQUIRED", "at least one access class is required"));
        }
        return runCommand({
          kind: "intent.create",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "experience_intent",
          apply: () => {
            const intentId = nextId();
            const intent: TenantState["intents"][number] = {
              intentId,
              deviceId,
              status: "draft",
              revision: 1,
              versions: [
                {
                  intentVersionId: nextId(),
                  versionNumber: 1,
                  status: "draft",
                  rationale,
                  accessClasses: [...accessClasses],
                  createdAt: now(),
                },
              ],
              decision: null,
            };
            tenant.intents.push(intent);
            return { resource: { type: "experience_intent", id: intentId, version: 1 } };
          },
        });
      }
      const intentId = segments[2];
      if (intentId === undefined) {
        fail(notFound("the requested experience intent does not exist"));
      }
      if (method === "GET" && segments.length === 3) {
        return ok(intentResource(findIntent(tenant, intentId)));
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "versions") {
        const intent = findIntent(tenant, intentId);
        const body = parseBody(request);
        const expected = header(request, "x-roamlink-expected-version");
        const rationale = typeof body["rationale"] === "string" ? body["rationale"] : undefined;
        const accessClasses = Array.isArray(body["accessClasses"])
          ? (body["accessClasses"] as unknown[]).filter((c): c is string => typeof c === "string")
          : undefined;
        if (rationale === undefined || rationale.length === 0) {
          fail(badRequest("INTENT_RATIONALE_REQUIRED", "the intent rationale is required"));
        }
        if (accessClasses === undefined || accessClasses.length === 0) {
          fail(badRequest("INTENT_ACCESS_CLASSES_REQUIRED", "at least one access class is required"));
        }
        return runCommand({
          kind: "intent.supersede",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "experience_intent",
          subjectId: intentId,
          apply: () => {
            requireVersion(expected, intent.revision, "the intent supersession");
            if (intent.status !== "active") {
              fail(conflict("INTENT_NOT_ACTIVE", "only an active intent may be superseded"));
            }
            for (const version of intent.versions) {
              if (version.status === "active") {
                version.status = "superseded";
              }
            }
            const versionNumber = Math.max(...intent.versions.map((v) => v.versionNumber)) + 1;
            intent.versions.push({
              intentVersionId: nextId(),
              versionNumber,
              status: "active",
              rationale,
              accessClasses: [...accessClasses],
              createdAt: now(),
            });
            intent.revision += 1;
            return { resource: { type: "experience_intent", id: intentId, version: intent.revision } };
          },
        });
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "activate") {
        const intent = findIntent(tenant, intentId);
        const expected = header(request, "x-roamlink-expected-version");
        return runCommand({
          kind: "intent.activate",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "experience_intent",
          subjectId: intentId,
          apply: () => {
            requireVersion(expected, intent.revision, "the intent activation");
            if (intent.status !== "draft") {
              fail(conflict("INTENT_NOT_DRAFT", "only a draft intent may be activated"));
            }
            intent.status = "active";
            for (const version of intent.versions) {
              if (version.status === "draft") {
                version.status = "active";
              }
            }
            intent.revision += 1;
            return { resource: { type: "experience_intent", id: intentId, version: intent.revision } };
          },
        });
      }
    }

    // -- Products (catalog reads) ----------------------------------------------
    if (method === "GET" && segments.length === 2 && segments[0] === "v1" && segments[1] === "products") {
      tenantOf(tenantId);
      return ok(
        state.catalog.map((product) => ({
          productId: product.productId,
          name: product.name,
          description: product.description,
          status: product.status,
          variants: product.variants.map((variant) => ({
            variantId: variant.variantId,
            name: variant.name,
            billingModel: variant.billingModel,
            price: { amountMinor: variant.amountMinor, currency: variant.currency },
            ...(variant.termDays !== undefined ? { termDays: variant.termDays } : {}),
          })),
        })),
      );
    }

    // -- Orders -----------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "orders") {
      const tenant = tenantOf(tenantId);
      if (method === "GET" && segments.length === 2) {
        return ok(
          tenant.orders.map((order) => ({
            orderId: order.orderId,
            status: order.status,
            lines: order.lines.map((line) => ({
              lineId: line.lineId,
              productId: line.productId,
              variantId: line.variantId,
              quantity: line.quantity,
              unitPrice: { amountMinor: line.amountMinor, currency: line.currency },
            })),
            total: orderTotal(order),
            revision: order.revision,
            createdAt: now(),
            updatedAt: now(),
          })),
        );
      }
      if (method === "POST" && segments.length === 2) {
        const body = parseBody(request);
        const lines = Array.isArray(body["lines"]) ? (body["lines"] as unknown[]) : undefined;
        if (lines === undefined || lines.length === 0) {
          fail(badRequest("ORDER_LINES_REQUIRED", "an order requires at least one line"));
        }
        const orderId = nextId();
        return runCommand({
          kind: "order.place",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "order",
          subjectId: orderId,
          apply: () => {
            const orderLines = lines.map((line, index) => {
              const lineRecord = line as Record<string, unknown>;
              const variantId =
                typeof lineRecord["variantId"] === "string" ? lineRecord["variantId"] : undefined;
              const quantity = lineRecord["quantity"];
              const variant = state.catalog
                .flatMap((product) => product.variants)
                .find((v) => v.variantId === variantId);
              if (variant === undefined || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
                fail(badRequest("ORDER_LINE_INVALID", `order line ${index} does not reference a purchasable variant`));
              }
              return {
                lineId: nextId(),
                productId: state.catalog.find((product) =>
                  product.variants.some((v) => v.variantId === variant.variantId),
                )?.productId ?? "",
                variantId: variant.variantId,
                quantity,
                amountMinor: variant.amountMinor,
                currency: variant.currency,
              };
            });
            const order: TenantState["orders"][number] = {
              orderId,
              status: "placed",
              lines: orderLines,
              revision: 1,
            };
            tenant.orders.push(order);
            const variantId = orderLines[0]?.variantId ?? "";
            tenant.subscriptions.push({
              subscriptionId: nextId(),
              orderId,
              variantId,
              status: "pending",
              revision: 1,
              periodStart: now(),
            });
            return { resource: { type: "order", id: orderId, version: 1 } };
          },
        });
      }
      const orderId = segments[2];
      if (orderId === undefined) {
        fail(notFound("the requested order does not exist"));
      }
      if (method === "GET" && segments.length === 3) {
        const order = findOrder(tenant, orderId);
        return ok({
          order: {
            orderId: order.orderId,
            status: order.status,
            lines: order.lines.map((line) => ({
              lineId: line.lineId,
              productId: line.productId,
              variantId: line.variantId,
              quantity: line.quantity,
              unitPrice: { amountMinor: line.amountMinor, currency: line.currency },
            })),
            total: orderTotal(order),
            revision: order.revision,
            createdAt: now(),
            updatedAt: now(),
          },
          payments: tenant.payments
            .filter((p) => p.orderId === orderId)
            .map((p) => ({
              paymentId: p.paymentId,
              orderId: p.orderId,
              amount: { amountMinor: p.amountMinor, currency: p.currency },
              state: p.state,
              recordedAt: p.recordedAt,
            })),
          invoices: tenant.invoices
            .filter((i) => i.orderId === orderId)
            .map((i) => ({
              invoiceId: i.invoiceId,
              orderId: i.orderId,
              amount: { amountMinor: i.amountMinor, currency: i.currency },
              state: i.state,
              provenanceSummary: { succeededPayments: 1, succeededRefunds: 0 },
              issuedAt: i.issuedAt,
              ...(i.reconciledAt !== undefined ? { reconciledAt: i.reconciledAt } : {}),
            })),
        });
      }
      const order = findOrder(tenant, orderId);
      if (method === "POST" && segments.length === 4 && (segments[3] === "cancel" || segments[3] === "complete")) {
        const expected = header(request, "x-roamlink-expected-version");
        const completing = segments[3] === "complete";
        return runCommand({
          kind: completing ? "order.complete" : "order.cancel",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "order",
          subjectId: orderId,
          apply: () => {
            requireVersion(expected, order.revision, "the order transition");
            if (order.status !== "placed") {
              fail(
                conflict(
                  "ORDER_TRANSITION_INVALID",
                  `a ${order.status} order cannot be ${completing ? "completed" : "cancelled"}`,
                ),
              );
            }
            order.status = completing ? "completed" : "cancelled";
            order.revision += 1;
            return { resource: { type: "order", id: orderId, version: order.revision } };
          },
        });
      }
    }

    // -- Subscriptions ------------------------------------------------------------
    if (method === "GET" && segments.length === 2 && segments[0] === "v1" && segments[1] === "subscriptions") {
      const tenant = tenantOf(tenantId);
      return ok(
        tenant.subscriptions.map((subscription) => ({
          subscriptionId: subscription.subscriptionId,
          orderId: subscription.orderId,
          variantId: subscription.variantId,
          status: subscription.status,
          revision: subscription.revision,
          periodStart: subscription.periodStart,
          ...(subscription.periodEnd !== undefined ? { periodEnd: subscription.periodEnd } : {}),
        })),
      );
    }

    // -- Payments -----------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "payments" && method === "POST" && segments.length === 2) {
      const tenant = tenantOf(tenantId);
      const body = parseBody(request);
      const orderId = typeof body["orderId"] === "string" ? body["orderId"] : undefined;
      const amountMinor = body["amountMinor"];
      const currency = typeof body["currency"] === "string" ? body["currency"] : undefined;
      if (orderId === undefined) {
        fail(badRequest("PAYMENT_ORDER_REQUIRED", "a payment must reference an order"));
      }
      if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor < 1) {
        fail(badRequest("PAYMENT_AMOUNT_INVALID", "the payment amount must be positive integer minor units"));
      }
      if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
        fail(badRequest("PAYMENT_CURRENCY_INVALID", "the payment currency must be an ISO-4217-style code"));
      }
      const order = findOrder(tenant, orderId);
      return runCommand({
        kind: "payment.record",
        actorId: actorHeader,
        tenantId,
        correlationId: mutationEnvelope?.correlationId ?? "",
        idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
        subjectType: "order",
        subjectId: orderId,
        apply: () => {
          const paymentId = nextId();
          const payment: TenantState["payments"][number] = {
            paymentId,
            orderId,
            amountMinor,
            currency,
            state: "succeeded",
            recordedAt: now(),
          };
          tenant.payments.push(payment);
          if (!tenant.invoices.some((i) => i.orderId === orderId)) {
            const total = orderTotal(order);
            const invoice: TenantState["invoices"][number] = {
              invoiceId: nextId(),
              orderId,
              amountMinor: total.amountMinor,
              currency: total.currency,
              state: "issued",
              issuedAt: now(),
            };
            tenant.invoices.push(invoice);
          }
          return { resource: { type: "payment", id: paymentId } };
        },
      });
    }

    // -- Connectivity read ---------------------------------------------------------
    if (method === "GET" && segments.length === 2 && segments[0] === "v1" && segments[1] === "connectivity") {
      const tenant = tenantOf(tenantId);
      const subjects: Record<string, unknown>[] = [];
      for (const order of tenant.orders) {
        subjects.push(
          subjectConnectivity("order", order.orderId, order.status, findReference(tenant, "order", order.orderId)),
        );
      }
      for (const subscription of tenant.subscriptions) {
        subjects.push(
          subjectConnectivity(
            "subscription",
            subscription.subscriptionId,
            subscription.status,
            findReference(tenant, "subscription", subscription.subscriptionId),
          ),
        );
      }
      return ok({
        presentedAt: now(),
        subjects,
        deviceObservations: tenant.devices.map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.name,
          capabilityFreshness:
            device.capabilityFreshness === null
              ? null
              : evaluateFresh(device.capabilityFreshness, now()),
          contextFreshness:
            device.contextFreshness === null ? null : evaluateFresh(device.contextFreshness, now()),
          lastObservedAt:
            device.capabilityFreshness?.observedAt ?? device.contextFreshness?.observedAt ?? null,
        })),
      });
    }

    // -- Notifications ---------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "notifications") {
      const tenant = tenantOf(tenantId);
      if (method === "GET" && segments.length === 2) {
        return ok(
          tenant.notifications.map((n) => ({
            notificationId: n.notificationId,
            recipientUserId: n.recipientUserId,
            topic: n.topic,
            severity: n.severity,
            title: n.title,
            body: n.body,
            state: n.state,
            source: n.source,
            related: n.related,
            channels: n.channels,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          })),
        );
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "read") {
        const notificationId = segments[2] ?? "";
        const notification = tenant.notifications.find((n) => n.notificationId === notificationId);
        if (notification === undefined) {
          fail(notFound("the requested notification does not exist"));
        }
        if (notification.recipientUserId !== actor.userId) {
          fail(forbidden("NOTIFICATION_RECIPIENT_MISMATCH", "notifications may only be read by their recipient"));
        }
        return runCommand({
          kind: "notification.read",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "notification",
          subjectId: notificationId,
          apply: () => {
            if (notification.state !== "read") {
              notification.state = "read";
              notification.updatedAt = now();
            }
            return { resource: { type: "notification", id: notificationId } };
          },
        });
      }
    }

    // -- Support cases -----------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "support-cases") {
      const tenant = tenantOf(tenantId);
      if (method === "GET" && segments.length === 2) {
        return ok(
          tenant.supportCases.map((c) => ({
            caseId: c.caseId,
            subject: c.subject,
            description: c.description,
            status: c.status,
            priority: c.priority,
            createdByUserId: c.createdByUserId,
            relatedRefs: c.relatedRefs,
            messages: c.messages,
            revision: c.revision,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          })),
        );
      }
      if (method === "POST" && segments.length === 2) {
        const body = parseBody(request);
        const subject = typeof body["subject"] === "string" ? body["subject"] : undefined;
        const description = typeof body["description"] === "string" ? body["description"] : undefined;
        if (subject === undefined || subject.length === 0) {
          fail(badRequest("CASE_SUBJECT_REQUIRED", "the support case subject is required"));
        }
        if (description === undefined || description.length === 0) {
          fail(badRequest("CASE_DESCRIPTION_REQUIRED", "the support case description is required"));
        }
        return runCommand({
          kind: "support_case.create",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "support_case",
          apply: () => {
            const caseId = nextId();
            const supportCase: TenantState["supportCases"][number] = {
              caseId,
              subject,
              description,
              status: "open",
              priority: "normal",
              createdByUserId: actor.userId,
              relatedRefs: [],
              messages: [],
              revision: 1,
              createdAt: now(),
              updatedAt: now(),
            };
            tenant.supportCases.push(supportCase);
            return { resource: { type: "support_case", id: caseId, version: 1 } };
          },
        });
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "transitions") {
        // Console action: org:manage required (fail-closed authorization).
        requireOrgScope(actor);
        try {
          requirePermission(actor, "org:manage");
        } catch (error) {
          if (error instanceof HttpError) {
            appendAudit(tenantId, {
              category: "admin-override",
              action: "support_case.transition",
              outcome: "denied",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              detail: "actor lacked org:manage",
            });
          }
          throw error;
        }
        const caseId = segments[2] ?? "";
        const supportCase = findSupportCase(tenant, caseId);
        const body = parseBody(request);
        const transition = typeof body["transition"] === "string" ? body["transition"] : undefined;
        const expected = header(request, "x-roamlink-expected-version");
        const LEGAL: Readonly<Record<string, readonly string[]>> = Object.freeze({
          open: ["startProgress", "cancel"],
          in_progress: ["resolve", "close", "cancel"],
          resolved: ["close", "cancel"],
          closed: [],
          cancelled: [],
        });
        return runCommand({
          kind: "support_case.transition",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "support_case",
          subjectId: caseId,
          apply: () => {
            requireVersion(expected, supportCase.revision, "the support-case transition");
            if (transition === undefined || !(LEGAL[supportCase.status] ?? []).includes(transition)) {
              fail(
                badRequest(
                  "SUPPORT_TRANSITION_INVALID",
                  `a ${supportCase.status} case cannot transition via ${String(transition)}`,
                ),
              );
            }
            supportCase.status =
              transition === "startProgress"
                ? "in_progress"
                : transition === "resolve"
                  ? "resolved"
                  : transition === "close"
                    ? "closed"
                    : "cancelled";
            supportCase.revision += 1;
            supportCase.updatedAt = now();
            appendAudit(tenantId, {
              category: "admin-override",
              action: "support_case.transition",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              target: `support_case:${caseId}`,
              detail: transition,
            });
            return { resource: { type: "support_case", id: caseId, version: supportCase.revision } };
          },
        });
      }
    }

    // -- Command status -----------------------------------------------------------------
    if (method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "commands") {
      const command = state.commands.get(segments[2] ?? "");
      if (command === undefined || command.tenantId !== tenantId) {
        fail(notFound("the requested command does not exist"));
      }
      return ok(ackOf(command));
    }

    // -- Admin: organizations -------------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "organizations") {
      if (method === "GET" && segments.length === 2) {
        requireOrgScope(actor);
        try {
          requirePermission(actor, "org:read");
        } catch (error) {
          if (error instanceof HttpError) {
            appendAudit(tenantId, {
              category: "admin-override",
              action: "org.list",
              outcome: "denied",
              actorId: actorHeader,
              correlationId: "console",
              detail: "actor lacked org:read",
            });
          }
          throw error;
        }
        const tenant = tenantOf(tenantId);
        if (tenant.organization === undefined) {
          fail(notFound("the requested organization does not exist"));
        }
        return ok([
          {
            tenantId,
            organizationId: tenant.organization.organizationId,
            name: tenant.organization.name,
            status: tenant.organization.status,
            members: tenant.organization.members.map((m) => ({
              userId: m.userId,
              role: m.role,
              status: m.status,
            })),
            revision: tenant.organization.revision,
            createdAt: "2024-06-01T00:00:00.000Z",
            updatedAt: now(),
          },
        ]);
      }
      if (method === "POST" && segments.length === 4 && (segments[3] === "suspend" || segments[3] === "reactivate")) {
        const targetTenant = segments[2] ?? "";
        const reactivating = segments[3] === "reactivate";
        // Tenant boundary FIRST (no cross-tenant org management - the confused
        // deputy threat, spec/security.md "Threat priorities").
        if (targetTenant !== tenantId) {
          fail(notFound("the requested organization does not exist"));
        }
        requireOrgScope(actor);
        // (The suspended-org block and its single sanctioned escape - the
        // reactivation route - are enforced above, before route dispatch.)
        try {
          requirePermission(actor, "org:manage");
        } catch (error) {
          if (error instanceof HttpError) {
            appendAudit(tenantId, {
              category: "admin-override",
              action: reactivating ? "org.reactivate" : "org.suspend",
              outcome: "denied",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              detail: "actor lacked org:manage",
            });
          }
          throw error;
        }
        const tenant = tenantOf(tenantId);
        const organization = tenant.organization;
        if (organization === undefined) {
          fail(notFound("the requested organization does not exist"));
        }
        const expected = header(request, "x-roamlink-expected-version");
        return runCommand({
          kind: reactivating ? "org.reactivate" : "org.suspend",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "organization",
          subjectId: targetTenant,
          apply: () => {
            requireVersion(expected, organization.revision, "the organization transition");
            if (reactivating && organization.status !== "suspended") {
              fail(conflict("ORGANIZATION_NOT_SUSPENDED", "only a suspended organization may be reactivated"));
            }
            if (!reactivating && organization.status !== "active") {
              fail(conflict("ORGANIZATION_NOT_ACTIVE", "only an active organization may be suspended"));
            }
            organization.status = reactivating ? "active" : "suspended";
            organization.revision += 1;
            appendAudit(tenantId, {
              category: "admin-override",
              action: reactivating ? "org.reactivate" : "org.suspend",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              target: `organization:${targetTenant}`,
            });
            return {
              resource: { type: "organization", id: targetTenant, version: organization.revision },
            };
          },
        });
      }
    }

    // -- Admin: audit events ----------------------------------------------------------------
    if (method === "GET" && segments.length === 2 && segments[0] === "v1" && segments[1] === "audit-events") {
      requireOrgScope(actor);
      try {
        requirePermission(actor, "org:read");
      } catch (error) {
        if (error instanceof HttpError) {
          appendAudit(tenantId, {
            category: "admin-override",
            action: "audit.review",
            outcome: "denied",
            actorId: actorHeader,
            correlationId: "console",
            detail: "actor lacked org:read",
          });
        }
        throw error;
      }
      const tenant = tenantOf(tenantId);
      const params = queryParams(request.path);
      const category = params.get("category") ?? undefined;
      const actorFilter = params.get("actorId") ?? undefined;
      const correlationFilter = params.get("correlationId") ?? undefined;
      const from = params.get("from") ?? undefined;
      const to = params.get("to") ?? undefined;
      const events = tenant.auditEvents.filter((event) => {
        if (category !== null && category !== undefined && event.category !== category) return false;
        if (actorFilter !== null && actorFilter !== undefined && event.actorId !== actorFilter) return false;
        if (correlationFilter !== null && correlationFilter !== undefined && event.correlationId !== correlationFilter) return false;
        if (from !== null && from !== undefined && event.occurredAt < from) return false;
        if (to !== null && to !== undefined && event.occurredAt > to) return false;
        return true;
      });
      return ok({
        events: events.map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          category: event.category,
          action: event.action,
          outcome: event.outcome,
          actorId: event.actorId,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
          ...(event.commandId !== undefined ? { commandId: event.commandId } : {}),
          ...(event.target !== undefined ? { target: event.target } : {}),
          occurredAt: event.occurredAt,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          prevDigest: event.prevDigest,
          digest: event.digest,
        })),
        chain: verifyChain(tenant.auditEvents),
      });
    }

    // -- Admin: reconciliation jobs -----------------------------------------------------------
    if (segments[0] === "v1" && segments[1] === "reconciliation-jobs") {
      const tenant = tenantOf(tenantId);
      requireOrgScope(actor);
      try {
        requirePermission(actor, "org:read");
      } catch (error) {
        if (error instanceof HttpError) {
          appendAudit(tenantId, {
            category: "admin-override",
            action: "reconciliation.list",
            outcome: "denied",
            actorId: actorHeader,
            correlationId: "console",
            detail: "actor lacked org:read",
          });
        }
        throw error;
      }
      if (method === "GET" && segments.length === 2) {
        return ok(
          tenant.reconciliationJobs.map((job) => ({
            jobId: job.jobId,
            status: job.status,
            trigger: job.trigger,
            commandId: job.commandId,
            correlationId: job.correlationId,
            idempotencyKey: job.idempotencyKey,
            createdAt: job.createdAt,
            ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
            ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
            actions: job.actions,
          })),
        );
      }
      if (method === "POST" && segments.length === 2) {
        try {
          requirePermission(actor, "org:manage");
        } catch (error) {
          if (error instanceof HttpError) {
            appendAudit(tenantId, {
              category: "admin-override",
              action: "reconciliation.trigger",
              outcome: "denied",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              detail: "actor lacked org:manage",
            });
          }
          throw error;
        }
        return runCommand({
          kind: "reconciliation.trigger",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "reconciliation_job",
          apply: () => {
            const jobId = nextId();
            // Honest job execution: the sweep reports projection freshness as
            // it stands - DEGRADED_* when truth is not fresh, never a guess.
            const actions = tenant.projections.map((projection) => {
              const freshness = evaluateFresh(projection.freshness, now());
              return {
                actionType: "FRESHNESS_SWEEP",
                outcome:
                  freshness.freshnessState === "FRESH"
                    ? "ALREADY_CONSISTENT"
                    : freshness.freshnessState === "STALE"
                      ? "DEGRADED_STALE"
                      : "DEGRADED_UNKNOWN",
                targetType: projection.canonicalResourceType,
                targetId: projection.canonicalResourceId,
                at: now(),
              };
            });
            tenant.reconciliationJobs.push({
              jobId,
              status: "COMPLETED",
              trigger: "manual",
              commandId: jobId,
              correlationId: mutationEnvelope?.correlationId ?? "",
              idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
              createdAt: now(),
              startedAt: now(),
              completedAt: now(),
              actions,
            });
            appendAudit(tenantId, {
              category: "admin-override",
              action: "reconciliation.trigger",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              target: `reconciliation_job:${jobId}`,
            });
            return { resource: { type: "reconciliation_job", id: jobId } };
          },
        });
      }
    }

    // -- Admin: projection health ---------------------------------------------------------------
    if (method === "GET" && segments.length === 2 && segments[0] === "v1" && segments[1] === "projection-health") {
      const tenant = tenantOf(tenantId);
      requireOrgScope(actor);
      try {
        requirePermission(actor, "org:read");
      } catch (error) {
        if (error instanceof HttpError) {
          appendAudit(tenantId, {
            category: "admin-override",
            action: "projection_health.read",
            outcome: "denied",
            actorId: actorHeader,
            correlationId: "console",
            detail: "actor lacked org:read",
          });
        }
        throw error;
      }
      const projections = tenant.projections.map((projection) => ({
        projectionId: projection.projectionId,
        canonicalResourceType: projection.canonicalResourceType,
        canonicalResourceId: projection.canonicalResourceId,
        freshness: evaluateFresh(projection.freshness, now()),
        evidenceClass: projection.evidenceClass,
        projectionVersion: projection.projectionVersion,
        payloadDigest: projection.payloadDigest,
      }));
      const slos = tenant.slos.map((slo) => ({ ...slo }));
      const allFresh = projections.every((p) => p.freshness.freshnessState === "FRESH");
      const allSlosOk = slos.every((s) => s.state === "within-budget");
      return ok({
        projections,
        slos,
        overallHealth: allFresh && allSlosOk ? "healthy" : "degraded",
        presentedAt: now(),
      });
    }

    fail(notFound("the requested API route does not exist"));
  }

  const transport: HttpTransport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      try {
        return await handle(request);
      } catch (error) {
        if (error instanceof HttpError) {
          return error.response;
        }
        if (process.env["ROAMLINK_FAKE_DEBUG"] === "1") {
          console.error("[fake-api] internal error:", error);
        }
        return errorResponse(
          HTTP_STATUS.internalError,
          "unknown-state",
          "FAKE_INTERNAL_ERROR",
          "the fake API failed unexpectedly (details suppressed)",
          false,
        );
      }
    },
  };

  // --------------------------------------------------------------------------
  // Controls (test hooks for stage progression + evidence/finality facts)
  // --------------------------------------------------------------------------

  function commandById(commandId: string): StoredCommand | undefined {
    return state.commands.get(commandId);
  }

  const controls: InMemoryApiControls = {
    progressCommandToDelivered(commandId: string): boolean {
      const command = commandById(commandId);
      if (command === undefined || command.executedAt === undefined) return false;
      if (command.deliveredAt === undefined) {
        command.deliveredAt = now();
      }
      return true;
    },
    progressCommandToBillableFinal(commandId: string): boolean {
      const command = commandById(commandId);
      if (command === undefined || command.deliveredAt === undefined) return false;
      if (command.billableFinalAt === undefined) {
        command.billableFinalAt = now();
      }
      return true;
    },
    linkDeliveryEvidence(input: {
      subjectType: "order" | "subscription";
      subjectId: string;
      evidenceClass: string;
      canonicalResourceType: string;
      canonicalResourceId: string;
      sourceVersion: number | null;
      eventId: string | null;
      payloadDigest: string;
      freshUntil: string;
    }): void {
      for (const tenant of state.tenants.values()) {
        let reference = tenant.references.find(
          (r) => r.subjectType === input.subjectType && r.subjectId === input.subjectId,
        );
        if (reference === undefined) {
          reference = {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            status: "active",
            deliveryEvidenceState: "UNEVIDENCED",
          };
          tenant.references.push(reference);
        }
        reference.deliveryEvidenceState = "EVIDENCED";
        reference.evidence = {
          evidenceClass: input.evidenceClass,
          canonicalResourceType: input.canonicalResourceType,
          canonicalResourceId: input.canonicalResourceId,
          sourceVersion: input.sourceVersion,
          eventId: input.eventId,
          payloadDigest: input.payloadDigest,
          observedAt: now(),
          receivedAt: now(),
          freshUntil: input.freshUntil,
          recordedFreshnessState: "FRESH",
        };
        // Delivery evidence progresses the subject's place-order commands.
        for (const command of state.commands.values()) {
          if (
            command.kind === "order.place" &&
            command.subjectType === input.subjectType &&
            command.subjectId === input.subjectId &&
            command.deliveredAt === undefined
          ) {
            command.deliveredAt = now();
          }
        }
      }
    },
    reconcileInvoice(invoiceId: string): boolean {
      for (const tenant of state.tenants.values()) {
        const invoice = tenant.invoices.find((i) => i.invoiceId === invoiceId);
        if (invoice === undefined) continue;
        invoice.state = "reconciled";
        invoice.reconciledAt = now();
        // Billable finality attaches to the COMMERCIAL SUBJECT's command (the
        // order that was placed) once its invoice reconciles. Payment commands
        // stay at executed: payment is a money fact, never a delivery fact
        // (RL-LOCK-008).
        for (const command of state.commands.values()) {
          if (
            (command.kind === "order.place" || command.kind === "order.complete") &&
            command.subjectId === invoice.orderId &&
            command.billableFinalAt === undefined &&
            command.deliveredAt !== undefined
          ) {
            command.billableFinalAt = now();
          }
        }
        return true;
      }
      return false;
    },
    commands(): readonly StoredCommand[] {
      return Object.freeze([...state.commands.values()].map((c) => Object.freeze({ ...c })));
    },
  };

  return { transport, controls };
}
