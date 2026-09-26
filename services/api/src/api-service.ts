/**
 * The authenticated public API/BFF composition (RL-090).
 *
 * One framework-free handler over the app-kit HttpRequest/HttpResponse
 * contract - the host adapter (apps/portal-host route handlers, RL-089)
 * translates transport, nothing more. The dispatch:
 *
 *   POST /v1/webhooks/adcos              webhook ingress: HMAC verify ->
 *                                        durable inbox admit + persist; the
 *                                        route NEVER projects or processes
 *                                        (RL-LOCK-009: admission is not
 *                                        truth - processing stays in workers)
 *   POST /v1/auth/session                password login through the
 *                                        @roamlink/auth boundary (envelope-
 *                                        gated, idempotent); the token is
 *                                        handed out exactly once
 *   GET  /v1/users/me                    the authenticated principal view
 *   GET  /v1/readiness                   the composed readiness surface
 *                                        (RL-100): the REAL per-dependency
 *                                        probes aggregated into the honest
 *                                        vocabulary ready | degraded:<dep> |
 *                                        not-ready:<reason> - unauthenticated
 *                                        (load balancers probe it), never a
 *                                        business-event inference
 *   POST <mutation routes>               durable command ingestion (accepted;
 *                                        execution is the workers' concern)
 *   GET  /v1/commands/{commandId}        the stored-command view
 *   GET  <spec read routes>              the composed business read models
 *                                        (PA-019, closes F-016-2): the
 *                                        identity-backed reads (users,
 *                                        organizations) and the durable
 *                                        command-ledger / reconciliation-job
 *                                        projections (devices, experience-
 *                                        intents (+versions), payments,
 *                                        connectivity, support-cases,
 *                                        reconciliation-jobs) serve REAL
 *                                        bound state; the routes with no
 *                                        composed source keep the honest
 *                                        typed 501 with a named reason —
 *                                        the service invents NO data (the
 *                                        deterministic fake API remains
 *                                        the contract reference). PA-024
 *                                        adds the enterprise workspace read
 *                                        (organization from the bound
 *                                        identity stores, connector from
 *                                        the executed-command ledger, the
 *                                        unbound sections honestly null)
 *
 * Authorization is enforced server-side at this boundary through
 * @roamlink/auth (session verification + actor->tenant resolution); the
 * actor/tenant headers are transport context only and are cross-checked
 * against the authenticated principal.
 */
import {
  CommandEnvelope,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  canonicalizeJson,
  parseIdempotencyKey,
  parseTenantId,
  sha256Hex,
  tenantIdFromUser,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";
import { type HttpRequest, type HttpResponse } from "@roamlink/app-kit";
import {
  AuthenticationService,
  AuthorizationService,
  actorIdForUser,
  parseEmailAddress,
  parsePasswordSecret,
  personalTenantPermissions,
  type AuthSessionRepository,
  type CredentialRepository,
  type IdempotencyLedger,
  type MembershipRepository,
  type OrganizationRepository,
  type PasswordHasher,
  type UserDirectory,
  type UserRepository,
} from "@roamlink/auth";
import { ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES, type WebhookVerifier } from "@roamlink/adcos";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import { AdcosWebhookInboxService } from "@roamlink/webhook-inbox";

import { authenticate, readContextHeaders, readMutationEnvelope, type AuthenticatedPrincipal } from "./envelope.js";
import {
  acknowledgementOf,
  commandKindForPath,
  ingestCommand,
  readStoredCommand,
  type StoredCommand,
} from "./commands.js";
import { errorToResponse, jsonResponse } from "./http.js";
import { createReadModelDispatcher, type ReadModelDispatcher } from "./read-models.js";
import {
  composeReadiness,
  readinessToResponse,
  type ComposedReadiness,
  type ReadinessCheckBinding,
} from "./readiness.js";
import {
  createApiEdgeRuntime,
  createApiEdgeWrapper,
  type ApiEdgeOptions,
} from "./edge.js";
import {
  createInMemoryApiRateLimiter,
  parseRateLimitOptions,
  resolveRateLimitBinding,
  type ApiRateLimiter,
  type RateLimitBindingState,
} from "./rate-limit.js";
import { makeStructuredLogRecord, type StructuredLogSink } from "@roamlink/observability";

export {
  READINESS_STATUS_PATTERN,
  composeReadiness,
  readinessToResponse,
  type ComposedReadiness,
  type ComposedReadinessReport,
  type ReadinessCheckBinding,
  type ReadinessCriticality,
} from "./readiness.js";

// --------------------------------------------------------------------------------
// The spec's read-route surface (spec/api.md, mirrored by app-kit's route
// table): PA-019 composes the read models over the service's bound state
// (see ./read-models.ts); the routes with no real source keep the typed
// 501 with their named reasons - honest unavailability, never invented
// data. PA-024 adds the enterprise workspace read to the composed surface.
// The frozen pattern set below is the READ ROUTE SURFACE CONTRACT:
// every pattern must be answered by the composed dispatcher or the
// kept-501 table (the composition battery asserts the two tables together
// cover it exactly - a read route that answers the plain 404 is a gap).
// --------------------------------------------------------------------------------

export const READ_MODEL_ROUTES: readonly RegExp[] = Object.freeze([
  /^\/v1\/users\/[^/]+$/,
  /^\/v1\/organizations$/,
  /^\/v1\/devices$/,
  /^\/v1\/devices\/[^/]+$/,
  /^\/v1\/experience-intents$/,
  /^\/v1\/experience-intents\/[^/]+$/,
  /^\/v1\/experience-intents\/[^/]+\/versions$/,
  /^\/v1\/products$/,
  /^\/v1\/orders$/,
  /^\/v1\/orders\/[^/]+$/,
  /^\/v1\/subscriptions$/,
  /^\/v1\/payments$/,
  /^\/v1\/connectivity$/,
  /^\/v1\/notifications$/,
  /^\/v1\/audit-events$/,
  /^\/v1\/reconciliation-jobs$/,
  /^\/v1\/projection-health$/,
  // PA-010 (RL-115-F6): the integration-health read model has no real
  // source in this service's bound persistence (the ADCOS compatibility
  // probe is env-gated in the worker host) — the route keeps the typed
  // honest 501 (READ_MODEL_NOT_COMPOSED) with its named reason in
  // ./read-models.ts; the deterministic fake API remains the contract
  // reference.
  /^\/v1\/integration-health$/,
  /^\/v1\/support-cases$/,
  /^\/v1\/support-cases\/[^/]+$/,
  // PA-024: the enterprise workspace read — previously the audit §3's
  // plain 404 (not dispatched at all) — composes from the service's bound
  // identity stores + the executed-command ledger (see ./read-models.ts
  // handleEnterpriseWorkspaceRead). The pattern joins the frozen read
  // surface so the composition battery's coverage contract stays
  // exhaustive: every pattern is answered by the composed dispatcher or
  // the kept-501 table, never the plain 404.
  /^\/v1\/enterprise\/workspace$/,
]);

// --------------------------------------------------------------------------------
// Options + the service
// --------------------------------------------------------------------------------

/** The identity stores the auth boundary needs (injected by the composition). */
export interface ApiIdentityStores {
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly credentials: CredentialRepository;
  readonly sessions: AuthSessionRepository;
  readonly memberships: MembershipRepository;
  readonly organizations: OrganizationRepository;
  readonly ledger: IdempotencyLedger;
  readonly hasher: PasswordHasher;
}

export interface ApiServiceOptions {
  /** The REAL persistence (UnitOfWorkFactory + committed-state reader). */
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
  readonly identity: ApiIdentityStores;
  /** The webhook verifier seam (HMAC verifier over the injected key registry). */
  readonly webhookVerifier: WebhookVerifier;
  /** Injected clock: every decision instant is explicit and testable. */
  readonly now: () => UtcInstant;
  /** Supplies canonical lowercase UUIDs (command ids). */
  readonly newId: () => string;
  /**
   * The composed readiness bindings (RL-100): one binding per dependency
   * THIS process actually composed, each check probing through its provider
   * port with its criticality (required = correctness owner; optional =
   * accelerator). Absent/empty -> the readiness endpoint answers the honest
   * `not-ready:composition` (readiness without probed evidence is never
   * ready - the fail-closed law, never a hard-coded ready).
   */
  readonly readinessChecks?: readonly ReadinessCheckBinding[];
  /**
   * The runtime mode (RL-105): "production" refuses the in-memory rate-limit
   * fallback (rate limiting is then honestly DISABLED + readiness-degraded
   * until the composition binds a distributed limiter); "development" (the
   * default) composes the honest in-memory fallback with a loud log line.
   */
  readonly mode?: "production" | "development";
  /** The edge-hardening options (RL-105); absent -> the honest defaults. */
  readonly edge?: ApiEdgeOptions;
}

export interface ApiService {
  /** Handles one /v1 request (transport-independent). */
  handle(request: HttpRequest): Promise<HttpResponse>;
}

const WEBHOOK_INGRESS_PATH = "/v1/webhooks/adcos";
const LOGIN_PATH = "/v1/auth/session";
const ME_PATH = "/v1/users/me";
const READINESS_PATH = "/v1/readiness";
const COMMAND_PATH = /^\/v1\/commands\/([^/]+)$/;

/**
 * Restores the ADCOS delivery headers' canonical mixed-case names from a
 * case-insensitively-delivered header record (exact names win untouched).
 * Driven by the frozen contract's own constants - never hard-coded strings.
 */
function canonicalDeliveryHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const canonical: Record<string, string> = { ...headers };
  const byLowercaseName = new Map(Object.keys(headers).map((name) => [name.toLowerCase(), name] as const));
  for (const name of Object.values(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES)) {
    const deliveredAs = byLowercaseName.get(name.toLowerCase());
    if (deliveredAs !== undefined && deliveredAs !== name) {
      canonical[name] = headers[deliveredAs] as string;
    }
  }
  return canonical;
}

/** Creates the authenticated API/BFF service over the injected ports. */
export function createApiService(options: ApiServiceOptions): ApiService {
  const mode = options.mode ?? "development";
  const inner = createInnerApiService(options);
  const edgeOptions = options.edge ?? {};

  // --- Edge hardening (RL-105) --------------------------------------------
  // The rate-limit binding resolution is THE single source of truth: the
  // distributed limiter when bound; the honest in-memory fallback only in
  // non-production modes (with the loud composition line below); in
  // production without a bound limiter the fallback is REFUSED and the
  // binding is honestly disabled (the readiness surface carries it).
  const binding = resolveRateLimitBinding(mode, edgeOptions.rateLimiter);
  let limiter: ApiRateLimiter | undefined = binding.limiter;
  if (binding.state.kind === "in-memory") {
    const limited = parseRateLimitOptions({
      ...(edgeOptions.rateLimitWindowMs !== undefined ? { windowMs: edgeOptions.rateLimitWindowMs } : {}),
      ...(edgeOptions.rateLimitMaxCost !== undefined ? { maxCost: edgeOptions.rateLimitMaxCost } : {}),
    });
    limiter = createInMemoryApiRateLimiter(limited);
  } else if (binding.state.kind === "disabled") {
    limiter = undefined;
  }

  const runtime = createApiEdgeRuntime(edgeOptions);
  emitRateLimitCompositionNotice(runtime.sink, binding.state, options.now);

  const edge = createApiEdgeWrapper((request) => inner.handle(request), {
    runtime,
    limiter,
    now: options.now,
    newCorrelationId: edgeOptions.newCorrelationId ?? options.newId,
  });

  return { handle: edge };
}

/**
 * The one honest composition-time line about admission control (never a
 * silent fallback/downgrade): emitted through the edge's structured sink
 * with no correlation context (composition is not a request).
 */
function emitRateLimitCompositionNotice(
  sink: StructuredLogSink,
  state: RateLimitBindingState,
  now: () => UtcInstant,
): void {
  const record =
    state.kind === "distributed"
      ? { level: "info" as const, message: "rate_limit_binding", fields: { binding: "distributed" } }
      : state.kind === "in-memory"
        ? {
            level: "warn" as const,
            message: "rate_limit_binding",
            fields: { binding: "in-memory", note: "non-production fallback; not distributed" },
          }
        : {
            level: "warn" as const,
            message: "rate_limit_binding",
            fields: { binding: "disabled", note: state.reason },
          };
  try {
    sink(makeStructuredLogRecord({ ...record, at: now() }));
  } catch {
    // A broken composition log must never refuse to boot; the binding state
    // is still surfaced through the readiness check.
  }
}

/**
 * Resolves the rate-limit binding EXACTLY as the service composition does
 * (the single source of truth) so hosts can compose the matching readiness
 * check: pass `binding.limiter` into `edge.rateLimiter` and
 * `rateLimitReadinessCheck(binding.state)` into the readiness bindings.
 */
export function resolveApiRateLimitBinding(
  mode: "production" | "development",
  edge: ApiEdgeOptions | undefined,
): { readonly state: RateLimitBindingState; readonly limiter: ApiRateLimiter | undefined } {
  const edgeOptions = edge ?? {};
  const binding = resolveRateLimitBinding(mode, edgeOptions.rateLimiter);
  if (binding.state.kind === "in-memory") {
    const limited = parseRateLimitOptions({
      ...(edgeOptions.rateLimitWindowMs !== undefined ? { windowMs: edgeOptions.rateLimitWindowMs } : {}),
      ...(edgeOptions.rateLimitMaxCost !== undefined ? { maxCost: edgeOptions.rateLimitMaxCost } : {}),
    });
    return { state: binding.state, limiter: createInMemoryApiRateLimiter(limited) };
  }
  return binding;
}

function createInnerApiService(options: ApiServiceOptions): ApiService {
  return createInnerService(options);
}

function createInnerService(options: ApiServiceOptions): ApiService {
  const authentication = new AuthenticationService({
    users: options.identity.users,
    directory: options.identity.directory,
    credentials: options.identity.credentials,
    sessions: options.identity.sessions,
    hasher: options.identity.hasher,
    ledger: options.identity.ledger,
    now: options.now,
    generateSessionId: options.newId,
  });
  const authorization = new AuthorizationService(
    options.identity.memberships,
    options.identity.organizations,
  );
  // The composed business read models (PA-019): the dispatcher serves the
  // composed routes from the service's bound state and the kept-501 routes
  // with their named reasons; non-read paths return null (the caller's 404).
  const readModels: ReadModelDispatcher = createReadModelDispatcher({
    persistence: options.persistence,
    users: options.identity.users,
    organizations: options.identity.organizations,
    memberships: options.identity.memberships,
    authorization,
    now: options.now,
  });
  // The durable webhook inbox: admission (verify -> admit -> persist) is the
  // synchronous route path; projection/processing is NOT composed here - the
  // route only admits and persists (RL-LOCK-009).
  const webhookInbox = new AdcosWebhookInboxService({
    verifier: options.webhookVerifier,
    persistence: options.persistence,
    reader: options.persistence,
    clock: { now: options.now },
  });

  const notFound = (): HttpResponse =>
    errorToResponse(
      new NotFoundError("no API resource exists at this path (method and path)", {
        reason: "NOT_FOUND",
      }),
    );

  // The composed readiness surface (RL-100): live aggregation of the real
  // dependency probes - recomputed on EVERY request, never a boot snapshot.
  const readiness: ComposedReadiness = composeReadiness(
    options.readinessChecks !== undefined ? { checks: options.readinessChecks } : {},
  );

  return {
    async handle(request: HttpRequest): Promise<HttpResponse> {
      try {
        const path = stripQuery(request.path);

        // --- Readiness: REAL infrastructure truth, NO session requirement ---
        // Load balancers and the smoke suite probe it unauthenticated; the
        // answer is the per-dependency probe aggregate only (never business
        // events - an order/payment/webhook success is not readiness).
        if (request.method === "GET" && path === READINESS_PATH) {
          return readinessToResponse(await readiness.report());
        }

        // --- Webhook ingress: HMAC-authenticated, NOT session-based --------
        if (path === WEBHOOK_INGRESS_PATH && request.method === "POST") {
          return await handleWebhookIngress(request);
        }

        // --- Login: envelope-gated, NO bearer requirement --------------------
        // The password IS the credential here; the mutation header envelope
        // is validated (400) before any auth work, and a missing/garbage
        // bearer header is irrelevant to this route.
        if (request.method === "POST" && path === LOGIN_PATH) {
          return await handleLogin(request);
        }

        // --- Everything else requires an authenticated session -------------
        const principal = await authenticate(
          request,
          (token, at) => authentication.verifySession(token, at),
          options.now,
        );

        if (request.method === "GET" && path === ME_PATH) {
          // The principal view IS the app-kit ActorSessionResource - exactly
          // the contracted fields (actorId, userId, tenantId, scope, role,
          // permissions), because the apps' fail-closed parsers reject unknown
          // fields (app-kit resources.ts): a response that invents extra
          // fields is a contract violation on every consumer. The session is
          // personal-tenant scoped, so scope/role/permissions are the auth
          // boundary's OWN personal-tenant answers - nothing is invented here
          // and no organization authority is claimed.
          return jsonResponse(200, {
            actorId: principal.actorId,
            userId: principal.session.userId,
            tenantId: principal.session.tenantId,
            scope: "user",
            role: null,
            permissions: personalTenantPermissions(),
          });
        }

        if (request.method === "POST") {
          const commandKind = commandKindForPath(path);
          if (commandKind !== null) {
            const ack = await ingestCommand({
              request,
              path,
              commandKind,
              actorId: principal.actorId,
              authorization,
              persistence: options.persistence,
              now: options.now,
              newCommandId: options.newId,
            });
            return jsonResponse(202, ack); // accepted (stages later follow)
          }
          return notFound();
        }

        if (request.method === "GET") {
          const commandMatch = COMMAND_PATH.exec(path);
          if (commandMatch !== null) {
            return await handleCommandRead(principal, commandMatch[1] as string, request);
          }
          const read = await readModels(request, path, principal);
          if (read !== null) {
            return read;
          }
        }

        return notFound();
      } catch (error) {
        return errorToResponse(error);
      }
    },
  };

  // --------------------------------------------------------------------------

  /**
   * Login: the envelope's idempotency/correlation/request headers come from
   * the client; the envelope's actor/tenant are RESOLVED from the email via
   * the directory (the sanctioned pre-authentication read) so the auth
   * package's frozen envelope validation stays intact.
   */
  async function handleLogin(request: HttpRequest): Promise<HttpResponse> {
    const envelope = readMutationEnvelope(request);
    if (request.body === undefined) {
      throw new ValidationError("login requires a JSON body", {
        reason: "LOGIN_COMMAND_INVALID",
        details: [{ path: "$", issue: "body required" }],
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      throw new ValidationError("login requires a JSON body", {
        reason: "LOGIN_COMMAND_INVALID",
        details: [{ path: "$", issue: "not valid JSON" }],
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError("login requires an object body", {
        reason: "LOGIN_COMMAND_INVALID",
        details: [{ path: "$", issue: "not an object" }],
      });
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body["email"] !== "string" || typeof body["password"] !== "string") {
      throw new ValidationError("login requires email and password", {
        reason: "LOGIN_COMMAND_INVALID",
        details: [{ path: "email", issue: "email and password are required" }],
      });
    }
    const email = parseEmailAddress(body["email"]);
    const userId = await options.identity.directory.resolveUserIdByEmail(email);
    if (userId === undefined) {
      throw new UnauthorizedError("authentication failed (credentials rejected)", {
        reason: "AUTHENTICATION_FAILED",
      });
    }
    const actorId = actorIdForUser(userId);
    const tenantId = tenantIdFromUser(userId);

    // Host-layer idempotent admission (RL-LOCK-014 at the HTTP edge). The
    // auth boundary's ledger dedupes on the ENVELOPE digest, which cannot
    // see the login payload; THIS admission covers the logical login request
    // (identity + payload), namespaced away from the envelope-keyed records:
    //   same key + same payload  -> replay the recorded session outcome;
    //   same key + DIFFERENT payload -> the typed conflict, never a silent
    //   overwrite and never a second session under someone else's retry.
    // The ledger key is a digest-derived namespace (never the raw key) so it
    // always satisfies the safe-reference shape regardless of key length.
    const loginDigest = sha256Hex(
      canonicalizeJson({
        kind: "auth.session.login",
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
        actorId,
        tenantId,
        email,
        password: body["password"],
      }),
    );
    const loginLedgerKey = parseIdempotencyKey(`login-${sha256Hex(envelope.idempotencyKey)}`);
    const admission = await options.identity.ledger.admit(loginLedgerKey, loginDigest);
    if (admission.status === "replay") {
      // The recorded outcome IS the response: same session, same token.
      return jsonResponse(200, admission.outcome);
    }

    // The personal tenant + canonical user principal for the resolved identity.
    const commandEnvelope = new CommandEnvelope({
      commandId: options.newId(),
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      actorId,
      tenantId,
      createdAt: options.now(),
      retry: { attempt: 1 },
    });
    const result = await authentication.loginWithPassword(commandEnvelope, {
      email: body["email"],
      password: parsePasswordSecret(body["password"]),
    });
    const outcome = Object.freeze({
      authSessionId: result.authSessionId,
      userId: result.userId,
      tenantId: result.tenantId,
      // The opaque token appears exactly once per admission, in this
      // response; the host turns it into an httpOnly session cookie. It is
      // never logged. An idempotent replay re-serves THIS recorded outcome.
      token: result.token,
      issuedAt: result.issuedAt,
      expiresAt: result.expiresAt,
    });
    await options.identity.ledger.commit(
      loginLedgerKey,
      loginDigest,
      outcome as CanonicalJsonValue,
      options.now(),
    );
    return jsonResponse(200, outcome);
  }

  async function handleCommandRead(
    principal: AuthenticatedPrincipal,
    commandId: string,
    request: HttpRequest,
  ): Promise<HttpResponse> {
    // Tenant scope for the read: the context header, resolved through the
    // auth boundary's actor->tenant rules (fail-closed).
    const context = readContextHeaders(request);
    if (context.tenantId === undefined) {
      throw new ValidationError("the tenant context header is required for command reads", {
        reason: "COMMAND_ENVELOPE_INCOMPLETE",
        details: [{ path: "x-roamlink-tenant-id", issue: "required header missing or empty" }],
      });
    }
    await authorization.resolveActorTenant(principal.actorId, parseTenantId(context.tenantId), options.now());
    const command: StoredCommand | null = await readStoredCommand(
      options.persistence,
      commandId,
      parseTenantId(context.tenantId),
    );
    if (command === null) {
      throw new NotFoundError("no command exists for this id in the acting tenant", {
        reason: "NOT_FOUND",
      });
    }
    return jsonResponse(200, acknowledgementOf(command));
  }

  /**
   * Webhook ingress: read the byte-exact payload + all delivery headers.
   *
   * Real HTTP transports deliver header names case-insensitively (the Web
   * Headers API lowercases everything), while the ADCOS delivery contract's
   * header names are canonical mixed case. The canonical names are restored
   * HERE - at the API boundary that owns ADCOS ingress - so the host stays a
   * pure transport and application modules never import the ADCOS contract
   * package (RL-LOCK-002). Exact-name deliveries (the in-memory test world)
   * pass through untouched.
   */
  async function handleWebhookIngress(request: HttpRequest): Promise<HttpResponse> {
    if (request.body === undefined || typeof request.body !== "string") {
      return errorToResponse(
        new ValidationError(
          "the webhook delivery must carry the byte-exact payload string as the request body",
          { reason: "WEBHOOK_PAYLOAD_INVALID", details: [{ path: "$", issue: "body required" }] },
        ),
      );
    }
    const admission = await webhookInbox.admitDelivery({
      payload: request.body,
      headers: canonicalDeliveryHeaders(request.headers),
      receivedAt: options.now(),
    });
    if (admission.outcome === "ADMITTED") {
      return jsonResponse(202, {
        outcome: "ADMITTED",
        eventId: admission.eventId,
        sequence: admission.sequence,
      });
    }
    if (admission.outcome === "DUPLICATE") {
      return jsonResponse(202, {
        outcome: "DUPLICATE",
        eventId: admission.eventId,
        originalSequence: admission.originalSequence,
      });
    }
    // REJECTED: signature/authentication failures are 401; policy violations
    // (version, environment, size) are 400. The codes/messages come from the
    // closed ADCOS error vocabulary (safe by contract, no secrets - RL-LOCK-016).
    const authFailures = new Set(["webhook-signature-invalid", "webhook-timestamp-stale", "authentication-invalid"]);
    return jsonResponse(authFailures.has(admission.code) ? 401 : 400, {
      outcome: "REJECTED",
      code: admission.code,
      message: admission.message,
    });
  }
}

function stripQuery(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}
