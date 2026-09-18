/**
 * The hosted runtime end-to-end (RL-089): the REAL composition over the REAL
 * PostgreSQL (pglite) with the REAL infra/migrations - the full hosted chain
 *
 *   HTTP surface/route handler -> application command/query (services/api)
 *   -> @roamlink/auth boundary -> REAL persistence (RL-091)
 *
 * exercised through the HOST layer: the login form binding, the httpOnly
 * session cookie, the mounted surfaces and the /v1 mount. Nothing here is a
 * fake: where a read model is not composed the page renders the API's typed
 * 501 panel (honest unavailability, never invented data).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUserId, parseUtcInstant, tenantIdFromUser, type UtcInstant, type UserId } from "@roamlink/contracts";
import { deterministicUuidFromSeed, fixtureCommandEnvelope } from "@roamlink/testkit";
import {
  AccountAdministrationService,
  AuthorizationService,
  parsePasswordSecret,
} from "@roamlink/auth";
import {
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import {
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  buildAdcosWebhookSignatureMessage,
} from "@roamlink/adcos";
import { signWebhookDelivery } from "@roamlink/webhook-inbox";

import {
  CompositionError,
  createPortalHostComposition,
  handleCustomerSurface,
  handleHealthz,
  handleLoginSubmit,
  handleReadyz,
  handleV1,
  type HostIdentityStores,
  type PortalHostComposition,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");
const WEBHOOK_KEY_ID = "whk-host-test";
const WEBHOOK_SECRET = "host-journey-signing-secret-never-prod";

// The REAL migration file access (infra/migrations) - exactly what the
// deployment runner uses (RL-092).
function pinRealMigrations(): void {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
}

/** Boots one migrated host composition over its own embedded PostgreSQL. */
async function createMigratedHost(
  webhookKeys?: string,
): Promise<PortalHostComposition> {
  pinRealMigrations();
  const composition = await createPortalHostComposition({
    mode: "development",
    databaseUrl: "pglite://",
    webhookSigningKeys: webhookKeys,
    webhookEnvironment: "sandbox",
    now: () => T0,
  });
  const applied = await createPostgresMigrationRunner({ driver: composition.driver }).migrateUp();
  expect(applied.length).toBeGreaterThanOrEqual(4);
  return composition;
}

/** Registers a user through the REAL @roamlink/auth administration boundary. */
async function registerUser(
  identity: HostIdentityStores,
  seed: number,
  email: string,
  password: string,
): Promise<UserId> {
  const userId = parseUserId(deterministicUuidFromSeed(seed));
  const administration = new AccountAdministrationService({
    users: identity.users,
    directory: identity.directory,
    credentials: identity.credentials,
    organizations: identity.organizations,
    memberships: identity.memberships,
    ledger: identity.ledger,
    hasher: identity.hasher,
    authorization: new AuthorizationService(identity.memberships, identity.organizations),
    now: () => T0,
    generateMembershipId: () => crypto.randomUUID(),
  });
  await administration.registerUser(
    fixtureCommandEnvelope({
      actorId: `usr:${userId}`,
      tenantId: tenantIdFromUser(userId),
      idempotencyKey: `host-register-${seed}`,
      correlationId: `host-corr-${seed}`,
      createdAt: T0,
    }),
    { userId, email, displayName: `Host User ${seed}`, password: parsePasswordSecret(password) },
  );
  return userId;
}

function runtimeOf(composition: PortalHostComposition) {
  return { ok: true as const, composition };
}

function sessionCookieValueOf(setCookie: string | null): string {
  expect(setCookie).toContain("roamlink_session=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  const token = setCookie?.split(";")[0]?.split("=")[1] ?? "";
  expect(token.length).toBeGreaterThan(0);
  return token;
}

describe("the hosted runtime health/readiness (real, not fake)", () => {
  it("liveness answers without touching any dependency", () => {
    const response = handleHealthz();
    expect(response.status).toBe(200);
  });

  it("readiness answers 503 with the honest refusal when the composition refused to boot", async () => {
    const response = await handleReadyz({
      ok: false,
      error: new CompositionError("DATABASE_URL is not configured: the hosted runtime runs on real PostgreSQL"),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ready: boolean;
      checks: { state: string; detail?: string }[];
    };
    expect(body.ready).toBe(false);
    expect(body.checks[0]?.state).toBe("down");
    expect(body.checks[0]?.detail).toContain("DATABASE_URL is not configured");
  });

  it("readiness tracks the real database + migration ledger of the composed process", async () => {
    const composition = await createMigratedHost();
    try {
      const response = await handleReadyz(runtimeOf(composition));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ready: boolean };
      expect(body.ready).toBe(true);
    } finally {
      await composition.dispose();
    }
  });
});

describe("the hosted login/session layer", () => {
  it("binds the API session into an httpOnly cookie and serves the principal view", async () => {
    const composition = await createMigratedHost();
    try {
      const userId = await registerUser(
        composition.identity,
        1,
        "user-1@example.com",
        "correct-horse-battery",
      );
      const form = new FormData();
      form.set("email", "user-1@example.com");
      form.set("password", "correct-horse-battery");
      const response = await handleLoginSubmit(
        new Request("https://host.example/auth/session", { method: "POST", body: form }),
        runtimeOf(composition),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      const token = sessionCookieValueOf(response.headers.get("set-cookie"));

      // The principal view through the /v1 mount with the presented token.
      const me = await handleV1(
        new Request("https://host.example/v1/users/me", {
          headers: { authorization: `Bearer ${token}` },
        }),
        runtimeOf(composition),
      );
      expect(me.status).toBe(200);
      const principal = (await me.json()) as Record<string, unknown>;
      expect(principal["actorId"]).toBe(`usr:${userId}`);
      expect(principal["tenantId"]).toBe(tenantIdFromUser(userId));
      expect(principal["scope"]).toBe("user");
      expect(Array.isArray(principal["permissions"])).toBe(true);
    } finally {
      await composition.dispose();
    }
  });

  it("re-renders the login document with the typed rejection for wrong credentials", async () => {
    const composition = await createMigratedHost();
    try {
      await registerUser(composition.identity, 2, "user-2@example.com", "correct-horse-battery");
      const form = new FormData();
      form.set("email", "user-2@example.com");
      form.set("password", "a-totally-wrong-password");
      const response = await handleLoginSubmit(
        new Request("https://host.example/auth/session", { method: "POST", body: form }),
        runtimeOf(composition),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("authentication failed");
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await composition.dispose();
    }
  });

  it("never lets an unauthenticated surface through (303 to the login document)", async () => {
    const composition = await createMigratedHost();
    try {
      const response = await handleCustomerSurface(
        new Request("https://host.example/"),
        runtimeOf(composition),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    } finally {
      await composition.dispose();
    }
  });
});

describe("the mounted customer surface over the real runtime", () => {
  it("renders the surface for a valid session and shows the honest not-composed panel (no invented data)", async () => {
    const composition = await createMigratedHost();
    try {
      await registerUser(composition.identity, 3, "user-3@example.com", "correct-horse-battery");
      const form = new FormData();
      form.set("email", "user-3@example.com");
      form.set("password", "correct-horse-battery");
      const login = await handleLoginSubmit(
        new Request("https://host.example/auth/session", { method: "POST", body: form }),
        runtimeOf(composition),
      );
      const token = sessionCookieValueOf(login.headers.get("set-cookie"));

      const page = await handleCustomerSurface(
        new Request("https://host.example/", {
          headers: { cookie: `roamlink_session=${token}` },
        }),
        runtimeOf(composition),
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("RoamLink");
      // The read model is NOT composed on the real runtime in this wave: the
      // surface renders the API's typed 501 panel - the host invents NOTHING.
      expect(html).toContain("READ_MODEL_NOT_COMPOSED");
    } finally {
      await composition.dispose();
    }
  });

  it("re-authenticates (303 to /login) when the presented token is not a live session", async () => {
    const composition = await createMigratedHost();
    try {
      const page = await handleCustomerSurface(
        new Request("https://host.example/", {
          headers: { cookie: "roamlink_session=not-a-real-token" },
        }),
        runtimeOf(composition),
      );
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe("/login");
    } finally {
      await composition.dispose();
    }
  });

  it("answers an honest 404 document for a path that is not a surface page", async () => {
    const composition = await createMigratedHost();
    try {
      const page = await handleCustomerSurface(
        new Request("https://host.example/definitely-not-a-page"),
        runtimeOf(composition),
      );
      expect(page.status).toBe(404);
    } finally {
      await composition.dispose();
    }
  });
});

describe("the /v1 mount over real PostgreSQL: durable commands (RL-LOCK-014)", () => {
  it("ingests a command durably and replays the SAME acknowledgement on the same idempotency key", async () => {
    const composition = await createMigratedHost();
    try {
      const userId = await registerUser(
        composition.identity,
        4,
        "user-4@example.com",
        "correct-horse-battery",
      );
      const tenantId = tenantIdFromUser(userId);
      const loginHeaders = {
        "x-roamlink-request-id": "req-login-4",
        "x-roamlink-correlation-id": "corr-login-4",
        "idempotency-key": "host-login-4",
        "x-roamlink-actor-id": `usr:${userId}`,
        "x-roamlink-tenant-id": tenantId,
      };
      const login = await handleV1(
        new Request("https://host.example/v1/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json", ...loginHeaders },
          body: JSON.stringify({ email: "user-4@example.com", password: "correct-horse-battery" }),
        }),
        runtimeOf(composition),
      );
      expect(login.status).toBe(200);
      const token = (await login.json() as Record<string, unknown>)["token"] as string;

      const mutationHeaders = {
        authorization: `Bearer ${token}`,
        "x-roamlink-request-id": "req-enroll-4",
        "x-roamlink-correlation-id": "corr-enroll-4",
        "idempotency-key": "host-enroll-4",
        "x-roamlink-actor-id": `usr:${userId}`,
        "x-roamlink-tenant-id": tenantId,
      };
      const accepted = await handleV1(
        new Request("https://host.example/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json", ...mutationHeaders },
          body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
        }),
        runtimeOf(composition),
      );
      expect(accepted.status).toBe(202);
      const ack = (await accepted.json()) as Record<string, unknown>;
      // The frozen contract's MutationAcknowledgement shape (no "stage"
      // field - acceptance is carried by the 202 + acceptedAt instant).
      expect(ack["commandId"]).toBeDefined();
      expect(ack["correlationId"]).toBe("corr-enroll-4");
      expect(ack["idempotencyKey"]).toBe("host-enroll-4");
      expect(typeof ack["acceptedAt"]).toBe("string");
      expect(ack["executedAt"]).toBeUndefined();

      // Durable in real SQL: the command ledger + outbox obligation.
      const persistence = createPostgresPersistence(composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);
      expect(await persistence.outbox.count("PENDING")).toBe(1);

      // The replay is the SAME acknowledgement, no new rows (RL-LOCK-014).
      const replay = await handleV1(
        new Request("https://host.example/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json", ...mutationHeaders },
          body: JSON.stringify({ name: "RoamLink One", platform: "ios" }),
        }),
        runtimeOf(composition),
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(ack);
      expect(await persistence.outbox.count()).toBe(1);
    } finally {
      await composition.dispose();
    }
  });
});

describe("the webhook ingress through the host (durable inbox admission)", () => {
  const payload = JSON.stringify({
    event_id: "evt-host-0001",
    event_type: "connectivity_contract.state_changed",
    resource_id: "res-0001",
    resource_kind: "connectivity_contract",
    resource_version: 3,
    occurred_at: T0,
    api_version: "2.0",
    environment: "sandbox",
    correlation_id: "corr-host-0001",
  });

  function webhookRequest(signature: string, keyId = WEBHOOK_KEY_ID): Request {
    return new Request("https://host.example/v1/webhooks/adcos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature]: signature,
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp]: T0,
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId]: keyId,
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId]: "evt-host-0001",
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId]: "del-host-0001",
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence]: "0",
        [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm]: "hmac-sha256",
      },
      body: payload,
    });
  }

  it("FAILS CLOSED with no signing keys configured (no default secret anywhere)", async () => {
    const composition = await createMigratedHost(undefined);
    try {
      const message = buildAdcosWebhookSignatureMessage({
        keyId: WEBHOOK_KEY_ID,
        timestamp: T0,
        deliveryId: "del-host-0001",
        payload,
      });
      const response = await handleV1(
        webhookRequest(signWebhookDelivery(WEBHOOK_SECRET, message)),
        runtimeOf(composition),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["outcome"]).toBe("REJECTED");
    } finally {
      await composition.dispose();
    }
  });

  it("admits a properly signed delivery into the REAL durable inbox", async () => {
    const composition = await createMigratedHost(`${WEBHOOK_KEY_ID}:${WEBHOOK_SECRET}`);
    try {
      const message = buildAdcosWebhookSignatureMessage({
        keyId: WEBHOOK_KEY_ID,
        timestamp: T0,
        deliveryId: "del-host-0001",
        payload,
      });
      const response = await handleV1(
        webhookRequest(signWebhookDelivery(WEBHOOK_SECRET, message)),
        runtimeOf(composition),
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["outcome"]).toBe("ADMITTED");
      // The admission row is in the real inbox table (durable, replay-safe).
      const persistence = createPostgresPersistence(composition.driver);
      expect(await persistence.inbox.count("ADMITTED")).toBe(1);
    } finally {
      await composition.dispose();
    }
  });
});

describe("an unbooted runtime answers every route with the honest 503", () => {
  it("the /v1 mount and the surfaces never serve when the composition refused", async () => {
    const refused = {
      ok: false as const,
      error: new CompositionError("DATABASE_URL is not configured"),
    };
    const api = await handleV1(
      new Request("https://host.example/v1/users/me"),
      refused,
    );
    expect(api.status).toBe(503);
    expect(((await api.json()) as Record<string, unknown>)["reason"]).toBe("HOST_NOT_READY");
    const surface = await handleCustomerSurface(
      new Request("https://host.example/", { headers: { cookie: "roamlink_session=x" } }),
      refused,
    );
    expect(surface.status).toBe(503);
  });
});
