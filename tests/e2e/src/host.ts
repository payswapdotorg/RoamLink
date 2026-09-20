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
 * command-status reads, webhook admission) and answers every business read
 * model with the typed 501 READ_MODEL_NOT_COMPOSED (honest unavailability,
 * never invented data). The journeys below assert exactly what the real
 * composition produces — completion where the command plane reaches,
 * fail-closed where it does not — and never fabricate an eighth state.
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
  type PortalHostComposition,
} from "../../../apps/portal-host/src/index.js";

/** The repo root (this file lives at <root>/tests/e2e/src/host.ts). */
const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

/** The deterministic epoch every hosted journey starts at. */
export const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");

export const WEBHOOK_KEY_ID = "whk-e2e-journey";
export const WEBHOOK_SECRET = "e2e-journey-signing-secret-never-prod";

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
  dispose(): Promise<void>;
}

export interface HostedJourneyOptions {
  /** Registration seed (also derives the deterministic user id). */
  readonly seed: number;
  readonly email: string;
  readonly password?: string;
  /** Optional now() override for the composition clock. */
  readonly now?: () => UtcInstant;
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
    dispose: () => composition.dispose(),
  };
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
