/**
 * The portal-host composition root (RL-089).
 *
 * Framework-free and env-driven: the ONLY place in the hosted runtime where
 * the real bindings are assembled. Every binding follows spec/deployment.md:
 *
 *   - PostgreSQL is the durable source of truth -> the REAL
 *     `@roamlink/persistence-postgres` adapter behind the frozen
 *     @roamlink/persistence ports (RL-091); the in-memory adapter is NEVER
 *     bound here (spec/deployment.md §7 "no in-memory adapter for
 *     production");
 *   - the identity stores bind the @roamlink/auth in-memory repositories -
 *     the DOCUMENTED durability gap of this wave (identity/schema persistence
 *     adapters are a later work item; see services/api README "Honest gaps")
 *     - composed once per process, never per request;
 *   - the webhook signing-key registry is parsed from the environment; with
 *     no keys configured every delivery is rejected (fail-closed, no
 *     default secret anywhere in code);
 *   - all secrets arrive through the environment; nothing is hard-coded
 *     (RL-LOCK-016).
 *
 * Database selection (explicit, never silent):
 *   - `postgres://` / `postgresql://` URL -> the real pg pool driver;
 *   - `pglite://`                         -> the embedded real PostgreSQL
 *     engine (pglite) for local development and tests ONLY - refused in
 *     production mode;
 *   - missing/unknown                     -> the composition REFUSES to
 *     boot (fail closed) instead of degrading to a fake.
 */
import { createHash } from "node:crypto";

import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import {
  createPgDriver,
  createPgliteDriver,
  createPostgresPersistence,
  databaseHealthCheck,
  type PgPoolLike,
  type SqlDriver,
} from "@roamlink/persistence-postgres";
import { nowUtc, type UtcInstant } from "@roamlink/contracts";
import {
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  type PasswordHasher,
} from "@roamlink/auth";
import { createApiService, composeReadiness, type ApiService, type ReadinessCheckBinding } from "@roamlink/api-service";
import type { HealthCheck } from "@roamlink/observability";

import { createRemoteApiReadinessProbe, remoteApiReadinessCheck } from "./readiness.js";

import { ScryptPasswordHasher } from "./scrypt-password-hasher.js";

/** The identity stores of one hosted process (the documented durability gap). */
export interface HostIdentityStores {
  readonly users: InMemoryUserRepository;
  readonly directory: InMemoryUserDirectory;
  readonly credentials: InMemoryCredentialRepository;
  readonly sessions: InMemoryAuthSessionRepository;
  readonly memberships: InMemoryMembershipRepository;
  readonly organizations: InMemoryOrganizationRepository;
  readonly ledger: InMemoryIdempotencyLedger;
  /** The production KDF binding (see scrypt-password-hasher.ts). */
  readonly hasher: PasswordHasher;
}

export interface PortalHostComposition {
  /** The authenticated API/BFF (RL-090) over REAL persistence. */
  readonly api: ApiService;
  /** The real SQL driver (health/readiness + the migration runner bind it). */
  readonly driver: SqlDriver;
  /**
   * The identity stores of this process. Host-internal: exposed as the
   * honest seam until the identity persistence adapters land (ops tooling
   * and tests seed through the REAL @roamlink/auth services over them).
   */
  readonly identity: HostIdentityStores;
  /**
   * REAL readiness (never fake): the database answers AND the schema
   * migration ledger is present. Unmigrated databases are NOT ready.
   */
  readonly readyCheck: () => Promise<ReadinessReport>;
  /** Releases the pool / closes the embedded engine. */
  readonly dispose: () => Promise<void>;
}

export interface ReadinessReport {
  /**
   * The honest vocabulary string (RL-100):
   * `ready \| degraded:<dependency,...> \| not-ready:<reason,...>`.
   */
  readonly status: string;
  /** Servability truth: false ONLY for not-ready:<...>. */
  readonly ready: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly state: "healthy" | "degraded" | "down";
    readonly detail?: string;
  }[];
}

export interface PortalHostEnv {
  /** "production" refuses embedded engines; "development" allows `pglite://`. */
  readonly mode: "production" | "development";
  readonly databaseUrl: string | undefined;
  /** `keyId:secret` pairs separated by commas (empty/absent -> all deliveries 401). */
  readonly webhookSigningKeys?: string | undefined;
  /** ADCOS webhook environment pin (version/environment policy). */
  readonly webhookEnvironment?: string | undefined;
  /**
   * The remote API service base URL (RL-100): when configured, the host's
   * readiness composition adds a REQUIRED bounded-timeout probe of that
   * API's GET /v1/readiness. Absent -> no remote probe is registered (the
   * in-process API is the truth; an uncomposed dependency is never
   * reported - no fake surface).
   */
  readonly apiBaseUrl?: string | undefined;
  /** Clock + id seams (defaults: real time, canonical UUIDv4). */
  readonly now?: () => UtcInstant;
  readonly newId?: () => string;
  /** Fetch seam for the remote readiness probe (tests); defaults to global fetch. */
  readonly fetchLike?: typeof fetch;
}

/** Thrown when the composition refuses to boot (fail-closed policy). */
export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/** Parses `ROAMLINK_WEBHOOK_SIGNING_KEYS` ("id:secret,id2:secret2"). */
export function parseWebhookSigningKeys(
  raw: string | undefined,
): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim().length === 0) return {};
  const keys: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) {
      throw new CompositionError(
        "ROAMLINK_WEBHOOK_SIGNING_KEYS must be comma-separated `keyId:secret` pairs (the malformed entry is refused; nothing is half-configured)",
      );
    }
    const keyId = pair.slice(0, separator).trim();
    const secret = pair.slice(separator + 1).trim();
    if (keyId.length === 0 || secret.length === 0) {
      throw new CompositionError(
        "ROAMLINK_WEBHOOK_SIGNING_KEYS carries an empty keyId or secret (refusing to boot)",
      );
    }
    keys[keyId] = secret;
  }
  return keys;
}

export function createPortalHostComposition(env: PortalHostEnv): Promise<PortalHostComposition> {
  if (env.databaseUrl === undefined || env.databaseUrl.trim().length === 0) {
    return Promise.reject(
      new CompositionError(
        "DATABASE_URL is not configured: the hosted runtime runs on real PostgreSQL (spec/deployment.md). Set DATABASE_URL to a postgres:// connection string (or pglite:// for local development only). The host never silently falls back to an in-memory adapter.",
      ),
    );
  }
  return createPortalHostCompositionWithDriver(env);
}

async function createPortalHostCompositionWithDriver(
  env: PortalHostEnv,
): Promise<PortalHostComposition> {
  const databaseUrl = env.databaseUrl?.trim() ?? "";
  const { driver, dispose } = await bindDriver(databaseUrl, env.mode);

  const now: () => UtcInstant = env.now ?? (() => new Date().toISOString() as UtcInstant);
  const newId: () => string = env.newId ?? (() => crypto.randomUUID());

  // --------------------------------------------------------------------------
  // The composed readiness bindings (RL-100): one binding per dependency THIS
  // process actually composed, each check probing through its provider port
  // (the persistence driver's liveness probe; the migration-ledger query; the
  // optional remote-API probe). The SAME bindings feed the api service's
  // GET /v1/readiness AND the host's readyz - one truth, two surfaces.
  // --------------------------------------------------------------------------
  const readinessBindings: ReadinessCheckBinding[] = [
    { check: databaseHealthCheck(driver), criticality: "required" },
    { check: migrationLedgerHealthCheck(driver), criticality: "required" },
  ];
  if (env.apiBaseUrl !== undefined && env.apiBaseUrl.trim().length > 0) {
    const probe = createRemoteApiReadinessProbe({
      baseUrl: env.apiBaseUrl.trim(),
      ...(env.fetchLike !== undefined ? { fetchLike: env.fetchLike } : {}),
    });
    readinessBindings.push({ check: remoteApiReadinessCheck({ probe }), criticality: "required" });
  }
  const readiness = composeReadiness({ checks: readinessBindings });

  // The identity stores (documented durability gap - see the module doc).
  // The password KDF is the PRODUCTION binding (Node scrypt) - never the
  // test double (packages/auth/src/password.ts makes accidental use loud).
  const hasher: PasswordHasher = new ScryptPasswordHasher();
  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const sessions = new InMemoryAuthSessionRepository();
  const memberships = new InMemoryMembershipRepository();
  const organizations = new InMemoryOrganizationRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const identity: HostIdentityStores = { users, directory, credentials, sessions, memberships, organizations, ledger, hasher };

  // The webhook verifier: env-parsed key registry; NO keys -> EVERY delivery
  // is rejected (fail-closed; there is no default signing secret in code).
  const webhookKeys = parseWebhookSigningKeys(env.webhookSigningKeys);
  const webhookEnvironment = env.webhookEnvironment ?? "sandbox";
  if (webhookEnvironment !== "sandbox" && webhookEnvironment !== "production") {
    throw new CompositionError(
      `ROAMLINK_WEBHOOK_ENVIRONMENT must be "sandbox" or "production" (got "${webhookEnvironment}")`,
    );
  }
  const webhookVerifier = new HmacWebhookVerifier({
    environment: webhookEnvironment,
    keys: new StaticWebhookSigningKeyRegistry(webhookKeys),
  });

  const api = createApiService({
    persistence: createPostgresPersistence(driver),
    identity,
    webhookVerifier,
    now,
    newId,
    readinessChecks: readinessBindings,
  });

  const readyCheck = async (): Promise<ReadinessReport> => {
    const report = await readiness.report();
    return {
      status: report.status,
      ready: report.ready,
      checks: report.checks.map((check) => ({
        name: check.name,
        state: check.state,
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
      })),
    };
  };

  return { api, driver, identity, readyCheck, dispose };
}

async function bindDriver(
  databaseUrl: string,
  mode: "production" | "development",
): Promise<{ driver: SqlDriver; dispose: () => Promise<void> }> {
  if (databaseUrl.startsWith("pglite:")) {
    if (mode === "production") {
      throw new CompositionError(
        "pglite:// is the embedded development engine and is REFUSED in production mode: point DATABASE_URL at a real PostgreSQL server (spec/deployment.md).",
      );
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    return {
      driver: createPgliteDriver(db),
      dispose: async () => {
        await db.close();
      },
    };
  }
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl, max: 5 });
    pool.on("error", () => {
      // Idle-client errors must not crash the host process; the readiness
      // check and the next query surface the failure honestly instead.
    });
    const driver = createPgDriver(pool as unknown as PgPoolLike);
    return {
      driver,
      dispose: async () => {
        await pool.end();
      },
    };
  }
  throw new CompositionError(
    `DATABASE_URL is not a supported PostgreSQL connection string (expected postgres://, postgresql://, or pglite:// for local development): got the scheme "${databaseUrl.slice(0, Math.min(16, databaseUrl.length))}"`,
  );
}

/**
 * The migration-ledger readiness probe as a HealthCheck (RL-100): the
 * ledger table (migration 0001) must exist AND carry at least one applied
 * version. A database that has never been migrated is honestly reported
 * NOT ready.
 */
function migrationLedgerHealthCheck(driver: SqlDriver): HealthCheck {
  return {
    name: "migrations",
    run: async () => {
      const checkedAt = nowUtc();
      try {
        const result = await driver.query("SELECT count(*)::int AS applied FROM roamlink_schema_migrations");
        const rows = result.rows as { applied?: number }[];
        const applied = rows[0]?.applied ?? 0;
        return applied > 0
          ? { name: "migrations", state: "healthy", detail: `${applied} migration(s) applied`, checkedAt }
          : { name: "migrations", state: "down", detail: "the schema migration ledger is empty (run infra/migrations first)", checkedAt };
      } catch (error) {
        return {
          name: "migrations",
          state: "down",
          detail: `the schema migration ledger is not reachable (${error instanceof Error ? error.name : "unknown error"})`,
          checkedAt,
        };
      }
    },
  };
}

/** Stable digest helper for hosts that key derived state by content. */
export function stableDigestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
