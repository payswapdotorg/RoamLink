/**
 * The hosted end-to-end journey harness (RL-113).
 *
 * Boots the REAL portal-host composition exactly as
 * apps/portal-host/test/journey.test.ts does — embedded real PostgreSQL
 * (pglite, development mode only), the REAL infra/migrations through the
 * deployment migration runner, the REAL services/api /v1 boundary over
 * @roamlink/auth — and then drives the REAL `CustomerWebApp`
 * (renderDocument/renderPage + typed flow methods) through a REAL transport
 * into the host's /v1 mount handler (`handleV1`).
 *
 * What this harness deliberately does NOT do:
 *  - no fake API anywhere in the path (the app-kit deterministic fake is
 *    the contract reference, never a substitute here);
 *  - no mocked journey state (every fact asserted below is produced by the
 *    real composition);
 *  - no browser dependency (document-level assertions over string HTML +
 *    data-attribute scanners, consistent with apps/web/test conventions).
 *
 * The honest terrain this harness explores: the real hosted runtime
 * composes the COMMAND plane (durable command ingestion, session/login,
 * command-status reads, webhook admission) AND the composed business read
 * models (PA-019, closes F-016-2): the command-ledger projections serve the
 * runtime's REAL executed state — on this composition no command has
 * executed (the worker plane's executors are not composed here), so every
 * ledger projection serves its honest EMPTY state and the business pages
 * render the real empty journey content instead of the fail-closed panel.
 * PA-024 composes the enterprise workspace read the same way: the
 * organization section serves the bound identity stores' REAL organization
 * record (the honest null for a personal tenant), the connector section
 * projects the executed-command ledger (honestly null until execution), and
 * the enrollment/policy/integrations sections keep the contract's honest
 * nulls. The routes with no composed source (products, orders,
 * subscriptions, notifications, audit-events, projection-health,
 * integration-health) keep the typed 501 READ_MODEL_NOT_COMPOSED with
 * their named reasons — pages whose read set includes one of those still
 * degrade or fail closed into the typed error panel, and the journeys
 * assert exactly that. The composition never fabricates a state:
 * completion where the planes reach, fail-closed where they do not, and
 * never an eighth state.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseUserId,
  parseUtcInstant,
  tenantIdFromUser,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";
import { deterministicUuidFromSeed, fixtureCommandEnvelope } from "@roamlink/testkit";
import { DeterministicUuidGenerator } from "@roamlink/testkit";
import {
  QSTASH_SIGNATURE_HEADER,
  renderQStashSignatureHeader,
} from "@roamlink/provider-qstash";
import {
  AccountAdministrationService,
  AuthorizationService,
  parsePasswordSecret,
} from "@roamlink/auth";
import {
  createPostgresMigrationRunner,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import {
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  buildAdcosWebhookSignatureMessage,
} from "@roamlink/adcos";
import { signWebhookDelivery } from "@roamlink/webhook-inbox";
import {
  RoamLinkApiClient,
  type HttpTransport,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { CustomerWebApp } from "@roamlink/web";

import {
  createPortalHostComposition,
  handleLoginSubmit,
  handleV1,
  handleWorkerTick,
  type PortalHostComposition,
} from "../../../apps/portal-host/src/index.js";

/** The repo root (this file lives at <root>/tests/e2e/src/host.ts). */
const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

/** The deterministic epoch every hosted journey starts at. */
export const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");

export const WEBHOOK_KEY_ID = "whk-e2e-journey";
export const WEBHOOK_SECRET = "e2e-journey-signing-secret-never-prod";

/**
 * PA-025: the receiver-side signing key of the hosted journey's worker-tick
 * endpoint (test-only; NEVER a production credential).
 */
export const WORKER_TICK_SIGNING_KEY = "e2e-worker-tick-signing-key-never-prod";

/** The closed tick job body the signed deliveries carry (byte-exact). */
export const WORKER_TICK_JOB_BODY = JSON.stringify({ kind: "worker.tick" });

/**
 * PA-025: a MUTABLE journey clock for the composed-execution journeys. The
 * execution legs must advance time between ticks: the read projections
 * order executed commands by (executedAt, commandId), so a FROZEN clock
 * would tie every command at one instant and fall to the (random) commandId
 * tie-break — advancing the clock keeps the projection's order the TRUE
 * chronological order, exactly as production ticks (minutes apart) do.
 */
export function createJourneyClock(): {
  now(): UtcInstant;
  /** Advances the clock and returns the NEW instant. */
  advanceMinutes(minutes?: number): UtcInstant;
} {
  let currentMs = Date.parse(T0);
  return {
    now: (): UtcInstant => new Date(currentMs).toISOString() as UtcInstant,
    advanceMinutes(minutes = 1): UtcInstant {
      currentMs += minutes * 60_000;
      return new Date(currentMs).toISOString() as UtcInstant;
    },
  };
}

/** The REAL migration file access (infra/migrations) — the deployment runner's own binding. */
function pinRealMigrations(): void {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
}

/** The host runtime shape the portal-host handlers take (the booted arm). */
export interface BootedHostRuntime {
  readonly ok: true;
  readonly composition: PortalHostComposition;
}

export function runtimeOf(composition: PortalHostComposition): BootedHostRuntime {
  return { ok: true as const, composition };
}

/** The registered customer identity of one hosted journey. */
export interface HostedIdentity {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly email: string;
}

/** One booted hosted journey: the REAL composition + the REAL app over it. */
export interface HostedJourney {
  readonly composition: PortalHostComposition;
  readonly identity: HostedIdentity;
  /** The opaque session token exactly once (the login response carries it). */
  readonly token: string;
  /** The REAL transport: app-kit requests into the host's /v1 mount. */
  readonly transport: HttpTransport;
  /** The typed app-kit client over the real transport. */
  readonly client: RoamLinkApiClient;
  /** The REAL customer web app driven over the real composition. */
  readonly app: CustomerWebApp;
  /** Raw /v1 access with the session token injected (authenticated legs). */
  v1(request: HttpRequest): Promise<HttpResponse>;
  /** Raw /v1 access with NO token injection (unauthenticated-leg probes). */
  v1Raw(request: HttpRequest): Promise<HttpResponse>;
  /**
   * PA-025: the live command-execution path's leg — delivers ONE SIGNED
   * worker.tick job to the host's mounted endpoint (through the REAL
   * handleWorkerTick dispatch), exactly the way the QStash scheduled
   * transport would. Null when the journey booted WITHOUT the endpoint
   * composed (the honest uncomposed terrain keeps its own assertions).
   */
  readonly workerTick: ((input?: { readonly at?: string; readonly body?: string }) => Promise<Response>) | null;
  dispose(): Promise<void>;
}

export interface HostedJourneyOptions {
  /** Registration seed (also derives the deterministic user id). */
  readonly seed: number;
  readonly email: string;
  readonly password?: string;
  /** Optional now() override for the composition clock. */
  readonly now?: () => UtcInstant;
  /**
   * PA-025: compose the bounded worker-tick endpoint (the receiver-side
   * QStash signing keys ride the SAME composition the hosted demo uses).
   * Default: NOT composed — the honest uncomposed terrain of the
   * pre-execution journeys (asserted by the existing suites, unchanged).
   */
  readonly composeWorkerTickEndpoint?: boolean;
}

/**
 * Boots one migrated host composition over its own embedded real
 * PostgreSQL, registers the journey customer through the REAL auth
 * administration boundary, signs in through the REAL hosted login form
 * binding (httpOnly cookie), and binds the REAL CustomerWebApp over a REAL
 * /v1 transport.
 */
export async function bootHostedJourney(
  options: HostedJourneyOptions,
): Promise<HostedJourney> {
  pinRealMigrations();
  const now = options.now ?? (() => T0);
  const composition = await createPortalHostComposition({
    mode: "development",
    databaseUrl: "pglite://",
    webhookSigningKeys: `${WEBHOOK_KEY_ID}:${WEBHOOK_SECRET}`,
    webhookEnvironment: "sandbox",
    // PA-025: the composed execution path (env-gated exactly like the hosted
    // demo — the receiver-side signing keys compose the endpoint).
    ...(options.composeWorkerTickEndpoint === true
      ? { qstashSigningKeyCurrent: WORKER_TICK_SIGNING_KEY }
      : {}),
    now,
  });
  const applied = await createPostgresMigrationRunner({ driver: composition.driver }).migrateUp();
  if (applied.length < 4) {
    await composition.dispose();
    throw new Error(
      `the hosted journey harness expected the real migration set to apply (got ${applied.length})`,
    );
  }

  const identity = await registerHostedUser(composition, options.seed, options.email);

  // The hosted entry-point leg: the login FORM binding (the host's own
  // session layer) turns the API session into the httpOnly cookie. The
  // token is read from that binding exactly once.
  const form = new FormData();
  form.set("email", options.email);
  form.set("password", options.password ?? "correct-horse-battery");
  const loginResponse = await handleLoginSubmit(
    new Request("https://host.test/auth/session", { method: "POST", body: form }),
    runtimeOf(composition),
  );
  if (loginResponse.status !== 303) {
    await composition.dispose();
    throw new Error(`the hosted login leg failed with status ${loginResponse.status}`);
  }
  const cookie = loginResponse.headers.get("set-cookie");
  const token = sessionCookieTokenOf(cookie);
  if (token === undefined) {
    await composition.dispose();
    throw new Error("the hosted login leg produced no session cookie");
  }

  const transport = createHostedV1Transport(composition, token);
  const client = new RoamLinkApiClient({
    transport,
    actor: { actorId: identity.actorId, tenantId: identity.tenantId },
    ids: new DeterministicUuidGenerator(40_000 + options.seed),
  });
  const app = new CustomerWebApp({ client });

  return {
    composition,
    identity,
    token,
    transport,
    client,
    app,
    v1: (request: HttpRequest): Promise<HttpResponse> => transportRequest(composition, token, request),
    v1Raw: (request: HttpRequest): Promise<HttpResponse> => rawTransportRequest(composition, request),
    workerTick:
      composition.worker.tickEndpoint !== null
        ? (input: { readonly at?: string; readonly body?: string } = {}): Promise<Response> =>
            // The delivery is signed at the JOURNEY'S CURRENT clock instant —
            // the transport's clock tracks the receiver's (within the replay
            // window), so journeys that advance their deterministic clock
            // between legs stay verifiable.
            deliverSignedWorkerTick(composition, { at: now(), ...input })
        : null,
    dispose: () => composition.dispose(),
  };
}

/**
 * PA-025: delivers ONE SIGNED worker.tick job to the host's mounted endpoint
 * through the REAL handleWorkerTick dispatch — the exact request shape the
 * QStash scheduled transport delivers (the pinned signature header over the
 * byte-exact job body, signed at the transport's current instant — within
 * the verifier's replay window of the receiver's clock).
 */
async function deliverSignedWorkerTick(
  composition: PortalHostComposition,
  input: { readonly at?: string; readonly body?: string },
): Promise<Response> {
  const body = input.body ?? WORKER_TICK_JOB_BODY;
  const at = input.at ?? T0;
  const signature = renderQStashSignatureHeader(
    WORKER_TICK_SIGNING_KEY,
    Math.floor(Date.parse(at) / 1000),
    body,
  );
  const request = new Request("https://host.test/api/worker/tick", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [QSTASH_SIGNATURE_HEADER]: signature,
    },
    body,
  });
  return handleWorkerTick(request, runtimeOf(composition));
}

/** Registers a user through the REAL @roamlink/auth administration boundary. */
export async function registerHostedUser(
  composition: PortalHostComposition,
  seed: number,
  email: string,
  password = "correct-horse-battery",
): Promise<HostedIdentity> {
  const userId: UserId = parseUserId(deterministicUuidFromSeed(seed));
  const administration = new AccountAdministrationService({
    users: composition.identity.users,
    directory: composition.identity.directory,
    credentials: composition.identity.credentials,
    organizations: composition.identity.organizations,
    memberships: composition.identity.memberships,
    ledger: composition.identity.ledger,
    hasher: composition.identity.hasher,
    authorization: new AuthorizationService(
      composition.identity.memberships,
      composition.identity.organizations,
    ),
    now: () => T0,
    generateMembershipId: () => crypto.randomUUID(),
  });
  await administration.registerUser(
    fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      idempotencyKey: `e2e-register-${seed}`,
      correlationId: `e2e-corr-${seed}`,
      createdAt: T0,
    }),
    { userId, email, displayName: `E2E Traveler ${seed}`, password: parsePasswordSecret(password) },
  );
  return {
    userId,
    tenantId: tenantIdFromUser(userId),
    actorId: `usr:${userId}`,
    email,
  };
}

/**
 * Registers an organization (owner = the already-registered hosted user)
 * through the REAL @roamlink/auth administration boundary — the same
 * boundary the portal-host's demo-account seeding drives. Returns the
 * organization's tenant id; the owner's session token authorizes reads in
 * that tenant through the boundary's own membership resolution.
 */
export async function registerHostedOrganization(
  composition: PortalHostComposition,
  owner: HostedIdentity,
  organizationSeed: number,
  name: string,
): Promise<TenantId> {
  const organizationId = deterministicUuidFromSeed(organizationSeed);
  const tenantId = `org:${organizationId}` as TenantId;
  const administration = new AccountAdministrationService({
    users: composition.identity.users,
    directory: composition.identity.directory,
    credentials: composition.identity.credentials,
    organizations: composition.identity.organizations,
    memberships: composition.identity.memberships,
    ledger: composition.identity.ledger,
    hasher: composition.identity.hasher,
    authorization: new AuthorizationService(
      composition.identity.memberships,
      composition.identity.organizations,
    ),
    now: () => T0,
    generateMembershipId: () => crypto.randomUUID(),
  });
  await administration.createOrganization(
    fixtureCommandEnvelope({
      commandId: deterministicUuidFromSeed(organizationSeed + 1),
      actorId: owner.actorId,
      tenantId,
      idempotencyKey: `e2e-create-org-${organizationSeed}`,
      correlationId: `e2e-corr-org-${organizationSeed}`,
      createdAt: T0,
    }),
    { organizationId, name },
  );
  return tenantId;
}

/**
 * Binds a typed app-kit client + the REAL customer web app over an
 * EXISTING hosted journey's transport, scoped to the ORGANIZATION tenant
 * (the owner's session token + the org tenant context; the boundary's
 * actor->tenant resolution authorizes the membership). The PA-024
 * enterprise workspace journey reads compose through this scope.
 */
export function orgScopedApp(
  journey: HostedJourney,
  orgTenantId: TenantId,
): { readonly client: RoamLinkApiClient; readonly app: CustomerWebApp } {
  const client = new RoamLinkApiClient({
    transport: journey.transport,
    actor: { actorId: journey.identity.actorId, tenantId: orgTenantId },
    ids: new DeterministicUuidGenerator(50_000),
  });
  return { client, app: new CustomerWebApp({ client }) };
}

async function transportRequest(
  composition: PortalHostComposition,
  token: string,
  request: HttpRequest,
): Promise<HttpResponse> {
  const response = await handleV1(
    new Request(`https://host.test${request.path}`, {
      method: request.method,
      headers: { ...request.headers, authorization: `Bearer ${token}` },
      ...(request.body !== undefined ? { body: request.body } : {}),
    }),
    runtimeOf(composition),
  );
  return toHttpResponse(response);
}

async function rawTransportRequest(
  composition: PortalHostComposition,
  request: HttpRequest,
): Promise<HttpResponse> {
  const response = await handleV1(
    new Request(`https://host.test${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    }),
    runtimeOf(composition),
  );
  return toHttpResponse(response);
}

async function toHttpResponse(response: Response): Promise<HttpResponse> {
  const body = await response.text();
  return { status: response.status, ...(body.length > 0 ? { body } : {}) };
}

/**
 * The REAL transport seam: one `HttpTransport` that dispatches every
 * app-kit request through the host's /v1 mount handler (`handleV1`) — the
 * exact handler the Next.js route forwarders call — with the session
 * bearer token injected at the host seam (the same discipline as the
 * host's own surface transport, but over the mounted /v1 route surface).
 */
export function createHostedV1Transport(
  composition: PortalHostComposition,
  token: string,
): HttpTransport {
  return {
    request(request: HttpRequest): Promise<HttpResponse> {
      return transportRequest(composition, token, request);
    },
  };
}

/** Extracts the session token from the host's Set-Cookie binding (fail-closed). */
export function sessionCookieTokenOf(setCookie: string | null): string | undefined {
  if (setCookie === null) return undefined;
  if (!setCookie.includes("roamlink_session=")) return undefined;
  const pair = setCookie.split(";")[0] ?? "";
  const value = pair.slice(pair.indexOf("=") + 1);
  return value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Signed webhook delivery helper (the recovery loop's input plane)
// ---------------------------------------------------------------------------

export interface SignedWebhookSpec {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly eventType: string;
  readonly occurredAt?: string;
}

/** Builds one properly signed ADCOS webhook delivery request for the host. */
export function signedWebhookRequest(spec: SignedWebhookSpec): Request {
  const payload = JSON.stringify({
    event_id: spec.eventId,
    event_type: spec.eventType,
    resource_id: spec.resourceId,
    resource_kind: spec.resourceType,
    resource_version: spec.resourceVersion,
    occurred_at: spec.occurredAt ?? T0,
    api_version: "2.0",
    environment: "sandbox",
    correlation_id: `corr-${spec.eventId}`,
  });
  const message = buildAdcosWebhookSignatureMessage({
    keyId: WEBHOOK_KEY_ID,
    timestamp: T0,
    deliveryId: spec.deliveryId,
    payload,
  });
  return new Request("https://host.test/v1/webhooks/adcos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature]: signWebhookDelivery(WEBHOOK_SECRET, message),
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp]: T0,
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId]: WEBHOOK_KEY_ID,
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId]: spec.eventId,
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId]: spec.deliveryId,
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence]: "0",
      [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm]: "hmac-sha256",
    },
    body: payload,
  });
}
