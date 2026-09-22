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
  /**
   * Confirms the pending eSIM profile change with platform evidence
   * (RL-115-F1): install-requested -> installed+enabled, remove-requested ->
   * removed from the inventory, pending enable/disable -> the flipped
   * confirmed state. The confirmation is PLATFORM evidence (OBSERVED,
   * fresh) - it never edits the command pipeline, whose stages stay the
   * honest RoamLink-side record.
   */
  confirmEsimProfile(input: { readonly deviceId: string; readonly profileId: string }): boolean;
  /**
   * PA-06: completes a connector provisioning (provisioning -> provisioned).
   * Mirrors the owning domain's transition machinery
   * (packages/enterprise/src/connectors.ts applyConnectorProvisioningTransition
   * legal map: provisioning may move to provisioned/failed/revoked): the
   * fake NEVER invents the completion inside the command - tests drive it.
   * Returns false when no in-flight provisioning with that id exists.
   */
  progressConnectorToProvisioned(provisioningId: string): boolean;
  /**
   * PA-06: fails a connector provisioning (provisioning -> failed with a
   * closed-vocabulary reason - the domain's failure vocabulary, mirrored).
   * Returns false when no in-flight provisioning with that id exists.
   */
  failConnectorProvisioning(
    provisioningId: string,
    reason: "connector-unavailable" | "capability-negotiation-empty" | "configuration-delivery-failed",
  ): boolean;
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
    /** Receives the command id so apply-time records can reference it. */
    readonly apply: (commandId: string) => { readonly resource?: { readonly type: string; readonly id: string; readonly version?: number } };
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
    const applied = input.apply(commandId);
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

  // --------------------------------------------------------------------------
  // Device SIM & eSIM state (RL-115-F1 remediation, PA-001)
  //
  // The fake's per-device eSIM state mirrors the READ contract (capability
  // evidence rows + profile inventory) and implements the same gate truth
  // table the edge capability gate owns (status/evidence/freshness -> allow/
  // deny/degrade with the closed reason vocabulary). It is contract-level
  // behavior: nothing is admitted without a passing gate, a commanded state
  // is never a confirmed state, and absent evidence is unknown - never
  // assumed (RL-LOCK-011).
  // --------------------------------------------------------------------------

  interface StoredEsimCapability {
    readonly capability: string;
    readonly status: string;
    readonly evidenceClass: string | null;
    readonly freshness: { observedAt: string | null; receivedAt: string | null; freshUntil: string | null } | null;
  }

  interface StoredEsimPending {
    readonly kind: "install" | "remove" | "enable" | "disable";
    readonly commandId: string;
    readonly requestedAt: string;
  }

  interface StoredEsimProfile {
    readonly profileId: string;
    readonly label: string;
    state: "install-requested" | "enabled" | "disabled" | "remove-requested";
    evidenceClass: string | null;
    freshness: { observedAt: string | null; receivedAt: string | null; freshUntil: string | null } | null;
    installedAt: string | null;
    pending: StoredEsimPending | null;
  }

  interface StoredDeviceEsim {
    readonly deviceId: string;
    readonly capabilities: StoredEsimCapability[];
    readonly installRequiresActivationCode: boolean;
    profiles: StoredEsimProfile[];
  }

  const esimStates = new Map<string, StoredDeviceEsim>();
  for (const [seedTenantId, seedTenant] of state.tenants) {
    for (const seedDevice of seedTenant.devices) {
      if (seedDevice.esim === undefined) continue;
      esimStates.set(`${seedTenantId}|${seedDevice.deviceId}`, {
        deviceId: seedDevice.deviceId,
        capabilities: seedDevice.esim.capabilities.map((capability) => ({
          ...capability,
          freshness:
            capability.freshness === null ? null : { ...capability.freshness },
        })),
        installRequiresActivationCode: seedDevice.esim.installRequiresActivationCode,
        profiles: seedDevice.esim.profiles.map((profile) => ({
          ...profile,
          freshness: profile.freshness === null ? null : { ...profile.freshness },
          pending: null,
        })),
      });
    }
  }

  /**
   * The device's stored eSIM state, synthesizing the honest UNKNOWN world
   * (no evidence rows, no profiles) for devices that never reported any -
   * capability questions without evidence stay unknown, never assumed
   * (RL-LOCK-011).
   */
  function esimOf(tenantId: string, deviceId: string): StoredDeviceEsim {
    const key = `${tenantId}|${deviceId}`;
    const existing = esimStates.get(key);
    if (existing !== undefined) return existing;
    const synthesized: StoredDeviceEsim = {
      deviceId,
      capabilities: ["esim_profile_install", "esim_profile_remove", "esim_profile_enable"].map(
        (capability) => ({ capability, status: "unknown", evidenceClass: null, freshness: null }),
      ),
      // Meaningful only once the install gate allows (an ungated install
      // never renders a form to ask for a code in the first place).
      installRequiresActivationCode: false,
      profiles: [],
    };
    esimStates.set(key, synthesized);
    return synthesized;
  }

  function esimCapabilityRow(
    esim: StoredDeviceEsim,
    capability: string,
  ): StoredEsimCapability | undefined {
    return esim.capabilities.find((row) => row.capability === capability);
  }

  /** Evidence-class gating rank (the eSIM capabilities' minimum is OBSERVED). */
  const ESIM_EVIDENCE_CLASS_RANKS: Readonly<Record<string, number>> = Object.freeze({
    AUTHENTICATED: 4,
    OBSERVED: 3,
    REPORTED: 2,
    DERIVED: 1,
    INFERRED: 0,
    STALE: 0,
    UNKNOWN: 0,
  });

  /**
   * The contract-level capability gate for eSIM commands (the same truth
   * table the edge gate owns): available + sufficient evidence + fresh ->
   * allow; unavailable/unknown -> deny; requires-permission -> degrade;
   * weak or stale evidence -> deny. Pure over its inputs.
   */
  function esimGateFor(
    row: StoredEsimCapability | undefined,
  ): { decision: "allow" | "deny" | "degrade"; reason: string | null } {
    if (row === undefined) {
      return { decision: "deny", reason: "capability-unknown" };
    }
    switch (row.status) {
      case "unavailable":
        return { decision: "deny", reason: "capability-unavailable" };
      case "unknown":
        return { decision: "deny", reason: "capability-unknown" };
      case "requires-permission":
        return { decision: "degrade", reason: "capability-requires-permission" };
      case "available": {
        if ((ESIM_EVIDENCE_CLASS_RANKS[row.evidenceClass ?? "UNKNOWN"] ?? 0) < 3) {
          return { decision: "deny", reason: "evidence-class-insufficient" };
        }
        const freshness = evaluateFresh(row.freshness, now());
        if (freshness.freshnessState !== "FRESH") {
          return { decision: "deny", reason: "evidence-stale" };
        }
        return { decision: "allow", reason: null };
      }
      default:
        return { decision: "deny", reason: "capability-unknown" };
    }
  }

  /** The typed rejection for a gate-blocked eSIM command (never an effect). */
  function esimGateBlocked(gate: { decision: string; reason: string | null }): never {
    fail(
      errorResponse(
        HTTP_STATUS.conflict,
        "domain",
        "CAPABILITY_GATE_BLOCKED",
        `the device action was blocked by the capability gate before any state was touched (decision: ${gate.decision}, reason: ${gate.reason ?? "capability-unknown"})`,
        false,
      ),
    );
  }

  function esimCapabilityResource(row: StoredEsimCapability): Record<string, unknown> {
    return {
      capability: row.capability,
      status: row.status,
      evidenceClass: row.evidenceClass,
      freshness: row.freshness === null ? null : evaluateFresh(row.freshness, now()),
      gate: esimGateFor(row),
    };
  }

  function esimProfileResource(profile: StoredEsimProfile): Record<string, unknown> {
    return {
      profileId: profile.profileId,
      label: profile.label,
      state: profile.state,
      evidenceClass: profile.evidenceClass,
      freshness: profile.freshness === null ? null : evaluateFresh(profile.freshness, now()),
      installedAt: profile.installedAt,
      pending:
        profile.pending === null
          ? null
          : {
              kind: profile.pending.kind,
              commandId: profile.pending.commandId,
              requestedAt: profile.pending.requestedAt,
            },
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

      // -- SIM & eSIM profiles (RL-115-F1 remediation) ------------------------
      // The read: capability truth rows (gate preview computed at this
      // instant) + the profile inventory. The three commands: capability-
      // gated admission first (a blocked gate is a typed rejection, never an
      // effect), then the honest commanded states - install/remove requests
      // and pending enable/disable - which only platform confirmation
      // (controls.confirmEsimProfile) flips to evidenced confirmed states.
      if (method === "GET" && segments.length === 4 && segments[3] === "sim") {
        const esim = esimOf(tenantId, deviceId);
        return ok({
          deviceId,
          capabilities: esim.capabilities.map(esimCapabilityResource),
          installRequiresActivationCode: esim.installRequiresActivationCode,
          profiles: esim.profiles.map(esimProfileResource),
        });
      }
      if (method === "POST" && segments.length === 5 && segments[3] === "sim" && segments[4] === "install") {
        const body = parseBody(request);
        const activationCode =
          typeof body["activationCode"] === "string" ? body["activationCode"] : undefined;
        const esim = esimOf(tenantId, deviceId);
        if (
          esim.installRequiresActivationCode &&
          (activationCode === undefined || activationCode.length === 0)
        ) {
          fail(
            badRequest(
              "ESIM_ACTIVATION_CODE_REQUIRED",
              "installing a profile on this device requires the activation code from your carrier or provider",
            ),
          );
        }
        return runCommand({
          kind: "esim.install",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "device",
          subjectId: deviceId,
          apply: (commandId) => {
            const gate = esimGateFor(esimCapabilityRow(esim, "esim_profile_install"));
            if (gate.decision !== "allow") {
              appendAudit(tenantId, {
                category: "authority-decision",
                action: "esim.install",
                outcome: "denied",
                actorId: actorHeader,
                correlationId: mutationEnvelope?.correlationId ?? "",
                target: `device:${deviceId}`,
                detail: `gate ${gate.decision}: ${gate.reason ?? "capability-unknown"}`,
              });
              esimGateBlocked(gate);
            }
            const profileId = nextId();
            esim.profiles.push({
              profileId,
              label: "New eSIM profile",
              state: "install-requested",
              evidenceClass: null,
              freshness: null,
              installedAt: null,
              pending: { kind: "install", commandId, requestedAt: now() },
            });
            appendAudit(tenantId, {
              category: "authority-decision",
              action: "esim.install",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              commandId,
              target: `device:${deviceId}`,
            });
            return { resource: { type: "esim_profile", id: profileId } };
          },
        });
      }
      if (
        method === "POST" &&
        segments.length === 7 &&
        segments[3] === "sim" &&
        segments[4] === "profiles" &&
        segments[6] === "remove"
      ) {
        const profileId = segments[5] ?? "";
        const esim = esimOf(tenantId, deviceId);
        const profile = esim.profiles.find((p) => p.profileId === profileId);
        if (profile === undefined) {
          fail(notFound("the requested eSIM profile does not exist on this device"));
        }
        return runCommand({
          kind: "esim.remove",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "esim_profile",
          subjectId: profileId,
          apply: (commandId) => {
            const gate = esimGateFor(esimCapabilityRow(esim, "esim_profile_remove"));
            if (gate.decision !== "allow") {
              appendAudit(tenantId, {
                category: "authority-decision",
                action: "esim.remove",
                outcome: "denied",
                actorId: actorHeader,
                correlationId: mutationEnvelope?.correlationId ?? "",
                target: `device:${deviceId}`,
                detail: `gate ${gate.decision}: ${gate.reason ?? "capability-unknown"}`,
              });
              esimGateBlocked(gate);
            }
            if (profile.state === "remove-requested") {
              fail(conflict("ESIM_PROFILE_REMOVAL_ALREADY_REQUESTED", "the profile removal is already requested and awaiting the device's confirmation"));
            }
            profile.state = "remove-requested";
            profile.pending = { kind: "remove", commandId, requestedAt: now() };
            appendAudit(tenantId, {
              category: "authority-decision",
              action: "esim.remove",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              commandId,
              target: `device:${deviceId}`,
            });
            return { resource: { type: "esim_profile", id: profileId } };
          },
        });
      }
      if (
        method === "POST" &&
        segments.length === 7 &&
        segments[3] === "sim" &&
        segments[4] === "profiles" &&
        segments[6] === "enable"
      ) {
        const profileId = segments[5] ?? "";
        const body = parseBody(request);
        const enabled = body["enabled"];
        const esim = esimOf(tenantId, deviceId);
        const profile = esim.profiles.find((p) => p.profileId === profileId);
        if (profile === undefined) {
          fail(notFound("the requested eSIM profile does not exist on this device"));
        }
        if (typeof enabled !== "boolean") {
          fail(badRequest("ESIM_ENABLED_FLAG_REQUIRED", "the enable command requires the desired state (enabled: true or false)"));
        }
        return runCommand({
          kind: "esim.enable",
          actorId: actorHeader,
          tenantId,
          correlationId: mutationEnvelope?.correlationId ?? "",
          idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
          subjectType: "esim_profile",
          subjectId: profileId,
          apply: (commandId) => {
            const gate = esimGateFor(esimCapabilityRow(esim, "esim_profile_enable"));
            if (gate.decision !== "allow") {
              appendAudit(tenantId, {
                category: "authority-decision",
                action: "esim.enable",
                outcome: "denied",
                actorId: actorHeader,
                correlationId: mutationEnvelope?.correlationId ?? "",
                target: `device:${deviceId}`,
                detail: `gate ${gate.decision}: ${gate.reason ?? "capability-unknown"}`,
              });
              esimGateBlocked(gate);
            }
            if (profile.state !== "enabled" && profile.state !== "disabled") {
              fail(
                conflict(
                  "ESIM_PROFILE_NOT_CONFIRMED",
                  "only a device-confirmed profile can be enabled or disabled (a requested install is not an installed profile)",
                ),
              );
            }
            const desired = enabled ? "enable" : "disable";
            if (profile.pending !== null) {
              fail(conflict("ESIM_CHANGE_ALREADY_REQUESTED", "a change for this profile is already requested and awaiting the device's confirmation"));
            }
            profile.pending = { kind: desired, commandId, requestedAt: now() };
            appendAudit(tenantId, {
              category: "authority-decision",
              action: "esim.enable",
              outcome: "allowed",
              actorId: actorHeader,
              correlationId: mutationEnvelope?.correlationId ?? "",
              commandId,
              target: `device:${deviceId}`,
            });
            return { resource: { type: "esim_profile", id: profileId } };
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

    // -- Enterprise workspace read (RL-104) -----------------------------------------
    if (method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "enterprise" && segments[2] === "workspace") {
      // The workspace surface is an organization-scoped customer surface:
      // personal tenants have nothing to compose (fail-closed 403, exactly
      // like the admin surfaces' org-scope guard - no existence oracle).
      requireOrgScope(actor);
      const tenant = tenantOf(tenantId);
      const organization = tenant.organization;
      // The journey fixtures ride with the tenant's enterprise STATE (the
      // seed's enterprise section, cloned mutable at creation): the read is
      // still a read-only composition mirroring the domain-owned journey
      // state - the ONLY writer is the provision-connector command below
      // (and the test controls that mirror the domain's transition map).
      // PA-007: the policy section composes the same way - READ-ONLY, with
      // the freshness STATE evaluated at the query instant (the fake never
      // invents a policy, never invents an observation).
      const enterprise = tenant.enterprise;
      const policySeed = enterprise?.policy;
      return ok({
        presentedAt: now(),
        organization:
          organization === undefined
            ? null
            : {
                tenantId,
                organizationId: organization.organizationId,
                name: organization.name,
                status: organization.status,
              },
        enrollment:
          enterprise?.enrollment === undefined || enterprise.enrollment === null
            ? null
            : { ...enterprise.enrollment },
        connector:
          enterprise?.connector === undefined || enterprise.connector === null
            ? null
            : { ...enterprise.connector },
        policy:
          policySeed === undefined || policySeed === null
            ? null
            : {
                policyId: policySeed.policyId,
                state: policySeed.state,
                source: policySeed.source,
                ...(policySeed.policyVersion !== undefined ? { policyVersion: policySeed.policyVersion } : {}),
                ...(policySeed.summary !== undefined ? { summary: policySeed.summary } : {}),
                ...(policySeed.effectiveAt !== undefined ? { effectiveAt: policySeed.effectiveAt } : {}),
                freshness: evaluateFresh(policySeed.freshness, now()),
              },
      });
    }

    // -- Enterprise connector provisioning (PA-06, RL-115-F3) ----------------------
    // The customer-facing command behind the guided connector enrollment.
    // Contract-level behavior only (the fake is not the domain authority):
    //  - org scope + org:manage permission (an organization-admin action);
    //  - the ENROLLMENT GATE: provisioning belongs to the enterprise
    //    enrollment journey, so the acting tenant's enrollment must be
    //    verified or active (mirrors packages/enterprise's precondition that
    //    a provisioning record references an owning enrollment);
    //  - one ACTIVE provisioning per workspace: a provisioning|provisioned
    //    record blocks a new attempt (typed conflict); a failed|revoked
    //    attempt is terminal in the domain's lifecycle, so a retry with a
    //    fresh idempotency key starts a NEW provisioning (new id);
    //  - the record is created in the honest in-flight `provisioning` state
    //    (the domain's lifecycle vocabulary); the fake NEVER invents the
    //    completion - the transition to provisioned/failed happens only
    //    through the test controls that mirror the domain's legal map.
    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[0] === "v1" &&
      segments[1] === "enterprise" &&
      segments[2] === "workspace" &&
      segments[3] === "connector" &&
      segments[4] === "provision"
    ) {
      requireOrgScope(actor);
      requirePermission(actor, "org:manage");
      const tenant = tenantOf(tenantId);
      const body = parseBody(request);
      const connectorId = typeof body["connectorId"] === "string" ? body["connectorId"] : undefined;
      if (connectorId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(connectorId)) {
        fail(
          badRequest(
            "CONNECTOR_LABEL_INVALID",
            "the connector label must be a bounded, printable label (never a secret)",
          ),
        );
      }
      const enterprise = tenant.enterprise;
      const enrollment = enterprise?.enrollment;
      if (
        enrollment === undefined ||
        enrollment === null ||
        (enrollment.state !== "verified" && enrollment.state !== "active")
      ) {
        fail(
          conflict(
            "CONNECTOR_ENROLLMENT_GATE",
            "connector provisioning requires a verified or active organization enrollment (the provisioning belongs to the enrollment journey)",
          ),
        );
      }
      const provisioningId = nextId();
      return runCommand({
        kind: "connector.provision",
        actorId: actorHeader,
        tenantId,
        correlationId: mutationEnvelope?.correlationId ?? "",
        idempotencyKey: mutationEnvelope?.idempotencyKey ?? "",
        subjectType: "connector_provisioning",
        subjectId: provisioningId,
        apply: () => {
          // The one-active-attempt guard lives INSIDE the command (like the
          // org-suspend status guard): an idempotent REPLAY of the same key
          // short-circuits above with the original acknowledgement and never
          // reaches this check - only a genuinely new attempt can trip it.
          const current = tenant.enterprise?.connector;
          if (
            current !== undefined &&
            current !== null &&
            (current.state === "provisioning" || current.state === "provisioned")
          ) {
            fail(
              conflict(
                "CONNECTOR_PROVISIONING_EXISTS",
                "a connector provisioning already exists for this workspace; a new attempt is possible only after a failed or revoked one",
              ),
            );
          }
          if (tenant.enterprise === undefined) {
            // The seed carried no enterprise section; the provisioning
            // journey starts here (the enrollment gate above already
            // failed-closed for a world without a verified enrollment, so
            // this branch is unreachable in practice - kept total anyway).
            tenant.enterprise = {};
          }
          // The honest in-flight start state; completion NEVER happens here.
          tenant.enterprise.connector = {
            provisioningId,
            state: "provisioning",
            createdAt: now(),
            updatedAt: now(),
          };
          appendAudit(tenantId, {
            category: "authority-decision",
            action: "connector.provision",
            outcome: "allowed",
            actorId: actorHeader,
            correlationId: mutationEnvelope?.correlationId ?? "",
            target: `connector_provisioning:${provisioningId}`,
            detail: `label ${connectorId}`,
          });
          return { resource: { type: "connector_provisioning", id: provisioningId, version: 1 } };
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
        const priority =
          body["priority"] === "low" ||
          body["priority"] === "normal" ||
          body["priority"] === "high" ||
          body["priority"] === "urgent"
            ? body["priority"]
            : undefined;
        if (priority === undefined) {
          fail(badRequest("CASE_PRIORITY_INVALID", "the support case priority must be low, normal, high or urgent"));
        }
        // RL-103: the caller's typed related references are honored (the
        // command layer already validated relatedRefs[] {kind,id}); the
        // fake stores them verbatim so the admin triage surface receives
        // the carried context through the same command path.
        const rawRelatedRefs = body["relatedRefs"];
        if (rawRelatedRefs !== undefined && !Array.isArray(rawRelatedRefs)) {
          fail(badRequest("CASE_RELATED_REFS_INVALID", "relatedRefs must be an array of {kind, id}"));
        }
        const relatedRefs: { kind: string; id: string }[] = [];
        for (const entry of (rawRelatedRefs ?? []) as unknown[]) {
          if (entry === null || typeof entry !== "object") {
            fail(badRequest("CASE_RELATED_REFS_INVALID", "relatedRefs entries must be objects with kind + id"));
          }
          const record = entry as Record<string, unknown>;
          if (typeof record["kind"] !== "string" || record["kind"].length === 0 || typeof record["id"] !== "string" || record["id"].length === 0) {
            fail(badRequest("CASE_RELATED_REFS_INVALID", "relatedRefs entries must carry non-empty kind and id strings"));
          }
          relatedRefs.push({ kind: record["kind"] as string, id: record["id"] as string });
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
              priority,
              createdByUserId: actor.userId,
              relatedRefs,
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
    confirmEsimProfile(input: { deviceId: string; profileId: string }): boolean {
      for (const esim of esimStates.values()) {
        if (esim.deviceId !== input.deviceId) continue;
        const index = esim.profiles.findIndex((p) => p.profileId === input.profileId);
        if (index === -1) continue;
        const profile = esim.profiles[index];
        if (profile === undefined || profile.pending === null) return false;
        const freshUntil = new Date(Date.parse(now()) + 3_600_000).toISOString();
        switch (profile.pending.kind) {
          case "remove":
            // The platform confirmed the removal: the record leaves the
            // inventory (its absence is the honest confirmed state).
            esim.profiles.splice(index, 1);
            return true;
          case "install":
            profile.state = "enabled";
            profile.installedAt = now();
            break;
          case "enable":
            profile.state = "enabled";
            break;
          case "disable":
            profile.state = "disabled";
            break;
        }
        profile.pending = null;
        profile.evidenceClass = "OBSERVED";
        profile.freshness = { observedAt: now(), receivedAt: now(), freshUntil };
        return true;
      }
      return false;
    },
    commands(): readonly StoredCommand[] {
      return Object.freeze([...state.commands.values()].map((c) => Object.freeze({ ...c })));
    },
    progressConnectorToProvisioned(provisioningId: string): boolean {
      // Mirrors the domain's legal map: ONLY an in-flight provisioning may
      // reach provisioned (failed/revoked are terminal there).
      for (const tenant of state.tenants.values()) {
        const connector = tenant.enterprise?.connector;
        if (connector === undefined || connector === null) continue;
        if (connector.provisioningId !== provisioningId || connector.state !== "provisioning") {
          continue;
        }
        connector.state = "provisioned";
        connector.updatedAt = now();
        connector.provisionedAt = now();
        delete connector.failureReason;
        return true;
      }
      return false;
    },
    failConnectorProvisioning(
      provisioningId: string,
      reason: "connector-unavailable" | "capability-negotiation-empty" | "configuration-delivery-failed",
    ): boolean {
      // Mirrors the domain's legal map: ONLY an in-flight provisioning may
      // fail, and a failed record carries its closed-vocabulary reason.
      for (const tenant of state.tenants.values()) {
        const connector = tenant.enterprise?.connector;
        if (connector === undefined || connector === null) continue;
        if (connector.provisioningId !== provisioningId || connector.state !== "provisioning") {
          continue;
        }
        connector.state = "failed";
        connector.updatedAt = now();
        connector.failureReason = reason;
        delete connector.provisionedAt;
        return true;
      }
      return false;
    },
  };

  return { transport, controls };
}
