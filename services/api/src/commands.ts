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

/**
 * The additive eSIM/connector mutation surface (PA-023 — the audit's §3
 * mutation-parity gap): the app contract already pinned these wire paths
 * (app-kit API_ROUTE_TEMPLATES deviceSimInstall / deviceSimProfileRemove /
 * deviceSimProfileEnable / enterpriseConnectorProvision) and PA-018 wired
 * the rendered forms; the kinds follow the in-repo command vocabulary
 * (`esim.install` / `esim.remove` / `esim.enable` / `connector.provision` —
 * exactly the deterministic fake API's kinds and the workers' executor-table
 * key style). NO-INVENTION LAW: these routes DURABLY ACCEPT a typed command
 * envelope into the command plane; they never execute it (execution is the
 * worker path's concern — the acknowledgement stays honestly `accepted`).
 */

interface MutationRoute {
  readonly pattern: RegExp;
  readonly kind: string;
}

export const MUTATION_ROUTES: readonly MutationRoute[] = Object.freeze([
  { pattern: /^\/v1\/devices$/, kind: "device.enroll" },
  { pattern: /^\/v1\/devices\/[^/]+\/update$/, kind: "device.update" },
  { pattern: /^\/v1\/devices\/[^/]+\/retire$/, kind: "device.retire" },
  { pattern: /^\/v1\/devices\/[^/]+\/sim\/install$/, kind: "esim.install" },
  { pattern: /^\/v1\/devices\/[^/]+\/sim\/profiles\/[^/]+\/remove$/, kind: "esim.remove" },
  { pattern: /^\/v1\/devices\/[^/]+\/sim\/profiles\/[^/]+\/enable$/, kind: "esim.enable" },
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
  { pattern: /^\/v1\/enterprise\/workspace\/connector\/provision$/, kind: "connector.provision" },
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
// Per-kind payload validation (PA-023 — mutation-route parity)
// --------------------------------------------------------------------------------

/** The canonical lowercase UUID shape (mirrors app-kit's requireId law). */
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The connector label rule, mirrored EXACTLY from the app-kit serializer
 * (`provisionConnectorBody`; the owning domain's CONNECTOR_LABEL_PATTERN): a
 * bounded printable diagnostics label — never a secret.
 */
const CONNECTOR_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** The eSIM install path: /v1/devices/{deviceId}/sim/install (deviceId at segment 3). */
const ESIM_DEVICE_ID_SEGMENT = 3;

/** The eSIM profile command path: /v1/devices/{deviceId}/sim/profiles/{profileId}/{action}. */
const ESIM_PROFILE_ID_SEGMENT = 6;

function pathSegmentOf(path: string, index: number): string {
  const segment = path.split("/")[index];
  if (segment === undefined) {
    // Unreachable for a path that already matched the route pattern; kept
    // total anyway (the validator never trusts its caller).
    commandInvalid("the command path is malformed", "$");
  }
  return segment;
}

function requirePayloadObject(kind: string, payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    commandInvalid(`the ${kind} command requires a JSON object body`, "$");
  }
  return payload as Record<string, unknown>;
}

/**
 * Fail-closed unknown-field rejection: the accepted body carries EXACTLY the
 * fields the app-kit serializer emits (byte-for-byte agreement, PA-023).
 */
function requireOnlyFields(kind: string, body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      commandInvalid(
        `the ${kind} command body carries a field outside the contract (allowed: ${[...allowed].sort().join(", ") || "none"})`,
        key,
      );
    }
  }
}

/** The path-bound id law mirrored from app-kit's requireId/requireDeviceId. */
function requirePathId(kind: string, name: string, value: string): void {
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    commandInvalid(`the ${kind} command's ${name} path segment must be a canonical lowercase UUID`, name);
  }
}

/**
 * Server-side payload validation for the PA-023 mutation routes, mirroring the
 * app-kit client serializers EXACTLY (same field names, same bounds, same
 * fail-closed typed rejections — the client and the server agree
 * byte-for-byte on bodies):
 *  - `esim.install`  <- installEsimProfileBody: {activationCode: non-empty string},
 *    deviceId on the path as a canonical lowercase UUID;
 *  - `esim.remove`   <- validateRemoveEsimProfile + the "{}" wire body: the ids
 *    ride the path (both canonical UUIDs), the body carries no fields;
 *  - `esim.enable`   <- enableEsimProfileBody: {enabled: boolean}, the ids ride
 *    the path (both canonical UUIDs);
 *  - `connector.provision` <- provisionConnectorBody: {connectorId: bounded
 *    printable label}.
 *
 * The pre-existing kinds keep their ingestion contract (any canonical JSON
 * body): their full payload semantics remain the domain executors' law and
 * the deterministic fake API stays the contract reference. Validation runs
 * BEFORE admission (fail-closed): a malformed payload is never accepted into
 * the durable command plane.
 */
export function validateMutationPayload(path: string, kind: string, payload: unknown): void {
  switch (kind) {
    case "esim.install": {
      const body = requirePayloadObject(kind, payload);
      requireOnlyFields(kind, body, new Set(["activationCode"]));
      const activationCode = body["activationCode"];
      if (typeof activationCode !== "string" || activationCode.length === 0) {
        commandInvalid(
          "the esim.install command requires activationCode to be a non-empty string (the carrier-issued install credential)",
          "activationCode",
        );
      }
      requirePathId(kind, "deviceId", pathSegmentOf(path, ESIM_DEVICE_ID_SEGMENT));
      return;
    }
    case "esim.remove": {
      const body = requirePayloadObject(kind, payload);
      requireOnlyFields(kind, body, new Set());
      requirePathId(kind, "deviceId", pathSegmentOf(path, ESIM_DEVICE_ID_SEGMENT));
      requirePathId(kind, "profileId", pathSegmentOf(path, ESIM_PROFILE_ID_SEGMENT));
      return;
    }
    case "esim.enable": {
      const body = requirePayloadObject(kind, payload);
      requireOnlyFields(kind, body, new Set(["enabled"]));
      if (typeof body["enabled"] !== "boolean") {
        commandInvalid(
          "the esim.enable command requires enabled to be a boolean (the desired state)",
          "enabled",
        );
      }
      requirePathId(kind, "deviceId", pathSegmentOf(path, ESIM_DEVICE_ID_SEGMENT));
      requirePathId(kind, "profileId", pathSegmentOf(path, ESIM_PROFILE_ID_SEGMENT));
      return;
    }
    case "connector.provision": {
      const body = requirePayloadObject(kind, payload);
      requireOnlyFields(kind, body, new Set(["connectorId"]));
      const connectorId = body["connectorId"];
      if (typeof connectorId !== "string" || !CONNECTOR_LABEL_PATTERN.test(connectorId)) {
        commandInvalid(
          "the connector.provision command requires connectorId to be a bounded, printable connector label (letters, numbers, dots, underscores, colons, at-signs or dashes; never a secret)",
          "connectorId",
        );
      }
      return;
    }
    default:
      // The pre-existing kinds keep their ingestion contract (the fake API
      // remains the full contract reference for their payload semantics).
      return;
  }
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

  // The per-kind payload law (PA-023): the four eSIM/connector routes mirror
  // the app-kit serializers fail-closed BEFORE admission. A malformed payload
  // is never accepted into the durable command plane. (Validated on the
  // PARSED body; the canonical string below is the digest/storage form.)
  validateMutationPayload(options.path, options.commandKind, payload);

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
