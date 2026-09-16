/**
 * Actor/tenant request context + the mutation header set (spec/api.md
 * "Command semantics": every mutation request carries request id, correlation
 * id, idempotency key, actor/tenant context and an optimistic version when
 * needed - RL-LOCK-014).
 *
 * Header names are part of the public application API contract. They are
 * lowercase and prefixed `x-roamlink-` (the exception is the conventional
 * `idempotency-key`). The client always sets actor/tenant headers on every
 * request; the server re-authenticates and re-authorizes from its own session
 * layer - headers are transport context, NEVER an authorization grant an app
 * could forge or rely on (spec/security.md "Authorization").
 */
import { parseActorId, parseTenantId, parseIdempotencyKey, ValidationError } from "@roamlink/contracts";

export interface ActorContext {
  /** RoamLink actor principal, e.g. `usr:<uuid>` (opaque; server-validated). */
  readonly actorId: string;
  /** Tenant scope for the request: `org:<uuid>` or `usr:<uuid>`. */
  readonly tenantId: string;
}

export function parseActorContext(value: unknown): ActorContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("ActorContext must be an object", {
      reason: "ACTOR_CONTEXT_INVALID",
      details: [{ path: "ActorContext", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  let actorId: string;
  try {
    actorId = parseActorId(record["actorId"]);
  } catch {
    throw new ValidationError("ActorContext.actorId must be a safe actor reference", {
      reason: "ACTOR_CONTEXT_INVALID",
      details: [{ path: "actorId", issue: "not a safe actor reference" }],
    });
  }
  let tenantId: string;
  try {
    tenantId = parseTenantId(record["tenantId"]);
  } catch {
    throw new ValidationError("ActorContext.tenantId must be 'org:<uuid>' or 'usr:<uuid>'", {
      reason: "ACTOR_CONTEXT_INVALID",
      details: [{ path: "tenantId", issue: "not a tenant reference" }],
    });
  }
  return Object.freeze({ actorId, tenantId });
}

/**
 * Per-mutation request options. Re-supplying the SAME `idempotencyKey` on a
 * retry is the contract-level retry story: the server deduplicates the effect
 * and replays the original acknowledgement (RL-LOCK-014 - retries must not
 * duplicate orders, intents, reservations, payments or webhook effects).
 */
export interface MutationRequestOptions {
  /** Reuse an existing key to retry a logical command (idempotent replay). */
  readonly idempotencyKey?: string;
  /** Correlate several requests of one logical operation. */
  readonly correlationId?: string;
  /** Optimistic concurrency: the resource version the command expects. */
  readonly expectedVersion?: number;
}

/** The closed mutation-header set (contract names, lowercase). */
export const MUTATION_HEADERS = Object.freeze({
  requestId: "x-roamlink-request-id",
  correlationId: "x-roamlink-correlation-id",
  idempotencyKey: "idempotency-key",
  actorId: "x-roamlink-actor-id",
  tenantId: "x-roamlink-tenant-id",
  expectedVersion: "x-roamlink-expected-version",
} as const);

/** Deterministic id/correlation generator port (testkit-compatible shape). */
export interface RequestIdGenerator {
  next(): string;
}

export interface MutationRequestPlan {
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
}

/**
 * Builds the request plan for one mutation: fresh ids unless the caller
 * supplied a retry key / correlation id. The idempotency key is validated
 * against the Wave-0 safe-reference grammar so an unsafe key fails before it
 * ever reaches the wire.
 */
export function planMutationRequest(
  actor: ActorContext,
  ids: RequestIdGenerator,
  options?: MutationRequestOptions,
): MutationRequestPlan {
  const idempotencyKey = options?.idempotencyKey ?? ids.next();
  try {
    parseIdempotencyKey(idempotencyKey);
  } catch {
    throw new ValidationError(
      "idempotency key must be a non-empty safe reference string (RL-LOCK-014)",
      {
        reason: "IDEMPOTENCY_KEY_INVALID",
        details: [{ path: "idempotencyKey", issue: "not a safe reference string" }],
      },
    );
  }
  if (options?.expectedVersion !== undefined) {
    if (
      typeof options.expectedVersion !== "number" ||
      !Number.isInteger(options.expectedVersion) ||
      options.expectedVersion < 1
    ) {
      throw new ValidationError("expectedVersion must be a positive integer when present", {
        reason: "OPTIMISTIC_VERSION_INVALID",
        details: [{ path: "expectedVersion", issue: "not a positive integer" }],
      });
    }
  }
  return Object.freeze({
    requestId: ids.next(),
    correlationId: options?.correlationId ?? ids.next(),
    idempotencyKey,
    ...(options?.expectedVersion !== undefined
      ? { expectedVersion: options.expectedVersion }
      : {}),
  });
}

/**
 * The header record for a mutation request. Actor/tenant context rides every
 * request; the mutation envelope adds request/correlation/idempotency (and
 * the optimistic version when the caller pinned one).
 */
export function mutationRequestHeaders(
  actor: ActorContext,
  plan: MutationRequestPlan,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [MUTATION_HEADERS.actorId]: actor.actorId,
    [MUTATION_HEADERS.tenantId]: actor.tenantId,
    [MUTATION_HEADERS.requestId]: plan.requestId,
    [MUTATION_HEADERS.correlationId]: plan.correlationId,
    [MUTATION_HEADERS.idempotencyKey]: plan.idempotencyKey,
    ...(plan.expectedVersion !== undefined
      ? { [MUTATION_HEADERS.expectedVersion]: String(plan.expectedVersion) }
      : {}),
  });
}

/** Headers for read requests (actor/tenant context only). */
export function readRequestHeaders(actor: ActorContext): Readonly<Record<string, string>> {
  return Object.freeze({
    [MUTATION_HEADERS.actorId]: actor.actorId,
    [MUTATION_HEADERS.tenantId]: actor.tenantId,
  });
}
