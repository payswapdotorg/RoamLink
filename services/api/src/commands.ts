/**
 * Durable command ingestion (RL-090).
 *
 * The call-chain discipline of spec/deployment.md §4 is enforced HERE, not in
 * any HTTP adapter:  HTTP -> application command -> persistence. The route
 * handler's only job is translating transport <-> the app-kit
 * HttpRequest/HttpResponse contract.
 *
 * What a mutation does (ONE real unit of work):
 *  1. validates the full header envelope (request/correlation/idempotency/
 *     actor/tenant + optimistic version when pinned) - RL-LOCK-014;
 *  2. authorizes the actor in the target tenant through @roamlink/auth's
 *     AuthorizationService (fail-closed on unknown tenants, inactive
 *     memberships, suspended organizations);
 *  3. dedupes on the idempotency key: same key + same command digest replays
 *     the recorded acknowledgement with NO additional effect; same key with a
 *     different digest is the typed conflict - never a silent overwrite;
 *  4. stores the command record (repository `api-commands`, keyed by
 *     commandId) plus the key->commandId pointer (repository
 *     `api-command-keys`), and enqueues the delivery obligation to the
 *     durable outbox - so "command accepted" and "work queued" commit
 *     atomically (transactional outbox by construction);
 *  5. answers the four-stage acknowledgement with `acceptedAt` present and
 *     every later stage absent - the command is durably ACCEPTED and queued;
 *     `executed` appears when a composed command handler applies it, never
 *     before (the stages never collapse or lie, spec/api.md).
 *
 * Domain command EXECUTION is a worker concern (services/workers, RL-107+):
 * this boundary records and delivers commands, it does not invent outcomes.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  canonicalizeJson,
  parseActorId,
  parseTenantId,
  sha256Hex,
  type ActorId,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  type HttpRequest,
  type MutationAcknowledgement,
  parseMutationAcknowledgement,
} from "@roamlink/app-kit";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import type { AuthorizationService } from "@roamlink/auth";

import { readMutationEnvelope } from "./envelope.js";

// --------------------------------------------------------------------------------
// Route -> command kind mapping (the additive mutation surface of app-kit's
// route table; reads are NOT ingestion and never mutate state)
// --------------------------------------------------------------------------------

interface MutationRoute {
  readonly pattern: RegExp;
  readonly kind: string;
}

export const MUTATION_ROUTES: readonly MutationRoute[] = Object.freeze([
  { pattern: /^\/v1\/devices$/, kind: "device.enroll" },
  { pattern: /^\/v1\/devices\/[^/]+\/update$/, kind: "device.update" },
  { pattern: /^\/v1\/devices\/[^/]+\/retire$/, kind: "device.retire" },
  { pattern: /^\/v1\/experience-intents$/, kind: "experience-intent.create" },
  { pattern: /^\/v1\/experience-intents\/[^/]+\/versions$/, kind: "experience-intent.supersede" },
  { pattern: /^\/v1\/experience-intents\/[^/]+\/activate$/, kind: "experience-intent.activate" },
  { pattern: /^\/v1\/orders$/, kind: "order.place" },
  { pattern: /^\/v1\/orders\/[^/]+\/cancel$/, kind: "order.cancel" },
  { pattern: /^\/v1\/orders\/[^/]+\/complete$/, kind: "order.complete" },
  { pattern: /^\/v1\/payments$/, kind: "payment.record" },
  { pattern: /^\/v1\/notifications\/[^/]+\/read$/, kind: "notification.read" },
  { pattern: /^\/v1\/support-cases$/, kind: "support-case.create" },
  { pattern: /^\/v1\/support-cases\/[^/]+\/transitions$/, kind: "support-case.transition" },
  { pattern: /^\/v1\/organizations\/[^/]+\/suspend$/, kind: "organization.suspend" },
  { pattern: /^\/v1\/organizations\/[^/]+\/reactivate$/, kind: "organization.reactivate" },
]);

/** Resolves the command kind of a mutation path; null when it is not a mutation route. */
export function commandKindForPath(path: string): string | null {
  for (const route of MUTATION_ROUTES) {
    if (route.pattern.test(path)) return route.kind;
  }
  return null;
}

/** The record repositories the command ledger uses (records-port partitions). */
export const COMMAND_REPOSITORY = "api-commands";
export const COMMAND_KEY_REPOSITORY = "api-command-keys";

/** The durable stored-command record (canonical JSON in the record store). */
export interface StoredCommand {
  readonly commandId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly route: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly expectedVersion: number | null;
  readonly payloadDigest: string;
  readonly payload: CanonicalJsonValue;
  readonly acceptedAt: string;
  readonly executedAt: string | null;
  readonly deliveredAt: string | null;
  readonly billableFinalAt: string | null;
  readonly resource: { readonly type: string; readonly id: string; readonly version?: number } | null;
}

/** The digest that defines "the same logical command" for a given key. */
export function commandDigest(input: {
  readonly kind: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly expectedVersion: number | null;
  readonly payload: CanonicalJsonValue;
}): string {
  const canonical = canonicalizeJson({
    kind: input.kind,
    tenantId: input.tenantId,
    actorId: input.actorId,
    ...(input.expectedVersion !== null ? { expectedVersion: input.expectedVersion } : {}),
    payload: input.payload,
  });
  return sha256Hex(canonical);
}

/** Builds the wire acknowledgement from a stored command (contract-parsed). */
export function acknowledgementOf(command: StoredCommand): MutationAcknowledgement {
  return parseMutationAcknowledgement({
    commandId: command.commandId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt: command.acceptedAt,
    ...(command.executedAt !== null ? { executedAt: command.executedAt } : {}),
    ...(command.deliveredAt !== null ? { deliveredAt: command.deliveredAt } : {}),
    ...(command.billableFinalAt !== null ? { billableFinalAt: command.billableFinalAt } : {}),
    ...(command.resource !== null
      ? { resource: command.resource as { type: string; id: string; version?: number } }
      : {}),
  });
}

// --------------------------------------------------------------------------------
// Ingestion
// --------------------------------------------------------------------------------

export interface IngestCommandOptions {
  readonly request: HttpRequest;
  /** The resolved path (no query string). */
  readonly path: string;
  readonly commandKind: string;
  /** The SESSION-derived actor (branded principal id), never the raw header. */
  readonly actorId: ActorId;
  readonly authorization: AuthorizationService;
  readonly persistence: UnitOfWorkFactory;
  readonly now: () => UtcInstant;
  readonly newCommandId: () => string;
}

function commandInvalid(issue: string, path: string): never {
  throw new ValidationError(`the command was rejected before admission: ${issue}`, {
    reason: "COMMAND_PAYLOAD_INVALID",
    details: [{ path, issue }],
  });
}

/**
 * Validates + durably ingests one command. Returns the parsed wire
 * acknowledgement (stage: accepted) for the 202 response.
 */
export async function ingestCommand(options: IngestCommandOptions): Promise<MutationAcknowledgement> {
  const envelope = readMutationEnvelope(options.request);
  if (envelope.actorId !== options.actorId) {
    // The actor header is transport context; the SESSION decides the actor.
    throw new ValidationError(
      "the actor header does not match the authenticated principal (the server authenticates from its own session layer)",
      { reason: "COMMAND_ENVELOPE_INVALID", details: [{ path: "actor", issue: "mismatch with the authenticated session" }] },
    );
  }
  if (options.request.body === undefined) {
    commandInvalid("a mutation requires a JSON body", "$");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(options.request.body as string);
  } catch {
    commandInvalid("the request body is not valid JSON", "$");
  }
  let canonicalPayload: CanonicalJsonValue;
  try {
    canonicalPayload = canonicalizeJson(payload);
  } catch (error) {
    if (error instanceof ValidationError) {
      commandInvalid("the request body is not canonicalizable JSON", "$");
    }
    throw error;
  }

  const digest = commandDigest({
    kind: options.commandKind,
    tenantId: envelope.tenantId,
    actorId: envelope.actorId,
    expectedVersion: envelope.expectedVersion,
    payload: canonicalPayload,
  });

  // The actor must be authorized in the command's tenant (fail-closed).
  await options.authorization.resolveActorTenant(
    parseActorId(envelope.actorId),
    parseTenantId(envelope.tenantId),
    options.now(),
  );

  const unitOfWork = await options.persistence.begin();
  try {
    const keys = unitOfWork.records(COMMAND_KEY_REPOSITORY);
    const commands = unitOfWork.records(COMMAND_REPOSITORY);

    const existingPointer = await keys.get(parsePointerId(envelope.idempotencyKey));
    if (existingPointer !== null) {
      const pointer = existingPointer.value as { commandId?: unknown };
      if (typeof pointer.commandId !== "string") {
        throw new NotFoundError("the command ledger pointer is corrupt (failing closed)", {
          reason: "COMMAND_LEDGER_CORRUPT",
        });
      }
      const stored = await commands.get(pointer.commandId);
      if (stored === null) {
        throw new NotFoundError("the command ledger is corrupt (failing closed)", {
          reason: "COMMAND_LEDGER_CORRUPT",
        });
      }
      const command = stored.value as unknown as StoredCommand;
      if (command.payloadDigest === digest) {
        // Idempotent replay: the ORIGINAL acknowledgement, no new effect.
        await unitOfWork.rollback();
        return acknowledgementOf(command);
      }
      throw new ConflictError(
        "this idempotency key was already used for a DIFFERENT command payload (retries must reuse the same payload; never silently overwrite - RL-LOCK-014)",
        { reason: "COMMAND_IDEMPOTENCY_CONFLICT" },
      );
    }

    const commandId = options.newCommandId();
    const acceptedAt = options.now();
    const command: StoredCommand = {
      commandId,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      kind: options.commandKind,
      route: options.path,
      tenantId: envelope.tenantId,
      actorId: envelope.actorId,
      expectedVersion: envelope.expectedVersion,
      payloadDigest: digest,
      payload: canonicalPayload,
      acceptedAt,
      executedAt: null,
      deliveredAt: null,
      billableFinalAt: null,
      resource: null,
    };
    await commands.insert(commandId, command as unknown as CanonicalJsonValue);
    await keys.insert(parsePointerId(envelope.idempotencyKey), { commandId });
    // The delivery obligation rides the SAME transaction: the command being
    // durable and the work being queued commit atomically.
    await unitOfWork.outbox.enqueue({
      idempotencyKey: envelope.idempotencyKey,
      payload: {
        commandId,
        kind: options.commandKind,
        tenantId: envelope.tenantId,
        actorId: envelope.actorId,
        payload: canonicalPayload,
        ...(envelope.expectedVersion !== null ? { expectedVersion: envelope.expectedVersion } : {}),
      },
      createdAt: acceptedAt,
    });
    await unitOfWork.commit();
    return acknowledgementOf(command);
  } catch (error) {
    await unitOfWork.rollback();
    throw error;
  }
}

function parsePointerId(idempotencyKey: string): string {
  // The idempotency key is already validated as a safe reference by the
  // envelope; the record store re-validates it as a record id.
  return idempotencyKey;
}

/**
 * Reads one stored command (the GET /v1/commands/{commandId} view).
 * Cross-tenant and unknown commands are BOTH null (no existence oracle -
 * the caller turns null into the 404).
 */
export async function readStoredCommand(
  reader: PersistenceReader,
  commandId: string,
  tenantId: string,
): Promise<StoredCommand | null> {
  const record = await reader.records(COMMAND_REPOSITORY).get(commandId);
  if (record === null) return null;
  const command = record.value as unknown as StoredCommand;
  if (command.tenantId !== tenantId) return null; // fail closed, no oracle
  return command;
}
