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
  type PostgresPersistence,
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
import {
  DistributedFixedWindowLimiter,
  tryParseUpstashRedisEnv,
  UPSTASH_REDIS_ENV_KEYS,
} from "@roamlink/provider-redis";
import {
  createApiService,
  composeReadiness,
  rateLimitReadinessCheck,
  resolveApiRateLimitBinding,
  type ApiRateLimiter,
  type ApiService,
  type ReadinessCheckBinding,
} from "@roamlink/api-service";
import type { HealthCheck } from "@roamlink/observability";
import type { DurableJobDeliveryPort } from "@roamlink/provider-qstash";
import { createWorkerTickEndpoint, type WorkerTickEndpoint } from "@roamlink/worker-endpoint";

import { createRemoteApiReadinessProbe, remoteApiReadinessCheck } from "./readiness.js";
import { runDailyMaintenance, type DailyMaintenanceResult } from "./maintenance.js";
import { createMaintenanceReceiver, type MaintenanceReceiver } from "./maintenance-receiver.js";
import { createHostSloBindings, type HostSloBindings } from "./slo.js";
import { seedDemoAccounts, type DemoAccountView } from "./demo-accounts.js";

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
   * The REAL persistence ports of this process (RL-107): the maintenance
   * trigger's recovery sweeps run through them (sweep = set-transition on
   * the durable outbox), never ad-hoc database mutation in a route.
   */
  readonly persistence: PostgresPersistence;
  /**
   * The maintenance trigger seam (RL-107) - authenticated by the handler.
   * `receiver` is the EVENT-DRIVEN path's signed-job endpoint (RL-110):
   * composed ONLY when the receiver-side QStash signing keys are configured
   * (an uncomposed receiver is never reported - the route answers the
   * honest 503 instead).
   */
  readonly maintenance: {
    readonly cronSecret: string | undefined;
    readonly run: () => Promise<DailyMaintenanceResult>;
    readonly receiver: MaintenanceReceiver | null;
  };
  /**
   * PA-025 — the live command-execution path: the authenticated bounded
   * worker-tick endpoint, composed ONLY when the receiver-side QStash
   * signing keys are configured (the SAME keys the maintenance receiver
   * uses). Uncomposed -> the route answers the honest 503 and accepted
   * commands keep their PENDING obligations (the documented wave gap,
   * never a fake execution).
   */
  readonly worker: {
    readonly tickEndpoint: WorkerTickEndpoint | null;
  };
  /**
   * The host's §11 SLO bindings (RL-109): the REAL observability recorder
   * this process emits through, plus the deployment-configured objectives.
   * The ops surface (see ops-slo-page.ts) renders their state read-only.
   */
  readonly slo: HostSloBindings;
  /**
   * The public demo accounts (quick action logins): the seeded roster view
   * for the login document - EMPTY unless ROAMLINK_DEMO_ACCOUNTS explicitly
   * enables the demo environment's public fixtures (see demo-accounts.ts).
   * The accounts themselves live in the identity stores like any other
   * account; this seam only exposes the public login view.
   */
  readonly demo: { readonly accounts: readonly DemoAccountView[] };
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
  /**
   * The Upstash Redis accelerator env (RL-105): when configured, the
   * composition binds the DISTRIBUTED fixed-window limiter over the
   * Upstash REST port as the API edge's admission control; when absent in
   * development the honest in-memory fallback is composed (with its loud
   * composition line + degraded readiness entry); when absent in production
   * the fallback is REFUSED and the readiness surface reports
   * `degraded:rate-limit` (never a silent single-process downgrade).
   */
  readonly upstashRedisRestUrl?: string | undefined;
  readonly upstashRedisRestToken?: string | undefined;
  /** Clock + id seams (defaults: real time, canonical UUIDv4). */
  readonly now?: () => UtcInstant;
  readonly newId?: () => string;
  /** Fetch seam for the remote readiness probe (tests); defaults to global fetch. */
  readonly fetchLike?: typeof fetch;
  /**
   * CRON_SECRET (RL-107): when set, /api/maintenance/daily answers ONLY
   * `Authorization: Bearer <secret>` (Vercel cron delivers exactly that);
   * when unset the route refuses EVERY trigger (fail-closed).
   */
  readonly cronSecret?: string | undefined;
  /**
   * QSTASH_TOKEN + ROAMLINK_MAINTENANCE_DESTINATION (RL-107): when both are
   * set, the maintenance trigger kicks the sweeps EVENT-DRIVEN (the
   * sanctioned async path) with deterministic per-day job ids; otherwise
   * the trigger runs the bounded sweeps inline.
   */
  readonly qstashToken?: string | undefined;
  readonly qstashBaseUrl?: string | undefined;
  readonly maintenanceDestination?: string | undefined;
  /**
   * The RECEIVER-side QStash signing keys (RL-097 runbook step 2.3 / RL-110):
   * when configured, /api/maintenance/receiver VERIFIES every delivered job
   * before acting (rotation keeps BOTH keys configured). Unset -> the
   * receiver refuses every delivery with the honest 503 (fail-closed).
   *
   * The SAME keys gate the PA-025 worker-tick endpoint: when the current
   * key is configured, /api/worker/tick verifies every scheduled tick
   * delivery before executing ONE bounded tick over the workers execution
   * seam; unset -> the endpoint refuses every delivery (fail-closed).
   */
  readonly qstashSigningKeyCurrent?: string | undefined;
  readonly qstashSigningKeyNext?: string | undefined;
  /**
   * PA-025 tuning (optional): the bounded claim per tick
   * (ROAMLINK_WORKER_TICK_BATCH_SIZE) and the max-duration guard in ms
   * (ROAMLINK_WORKER_TICK_MAX_DURATION_MS). Absent -> the tick's own
   * bounded defaults (10 per batch; the 45s guard).
   */
  readonly workerTickBatchSize?: number | undefined;
  readonly workerTickMaxDurationMs?: number | undefined;
  /**
   * ROAMLINK_SLO_OBJECTIVES (RL-109): the deployment's budgeted §11 SLO
   * objectives, `id:targetRatio:windowMs[:atRiskBurnRate]` entries keyed by
   * the closed §11 SLO ids. Absent -> every SLO renders honestly
   * measured-only (never silently classified). See ./slo.ts.
   */
  readonly sloObjectivesRaw?: string | undefined;
  /**
   * ROAMLINK_DEMO_ACCOUNTS (the demo environment's public fixtures): "1" or
   * "true" seeds the public demo roster (quick action logins on the login
   * document) through the REAL auth boundary at composition time;
   * unset/empty, "0" or "false" seeds NOTHING. Any other value refuses to
   * boot (fail-closed: a typo'd gate must never silently disable - or
   * half-enable - the demo surface).
   */
  readonly demoAccounts?: string | undefined;
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

/**
 * Parses `ROAMLINK_DEMO_ACCOUNTS`: "1"/"true" (case-insensitive) enables the
 * public demo roster; unset/empty, "0"/"false" disables it; ANY other value
 * refuses to boot (an ambiguous gate is never silently interpreted).
 */
export function parseDemoAccountsGate(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim().length === 0) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new CompositionError(
    "ROAMLINK_DEMO_ACCOUNTS must be exactly \"1\"/\"true\" (enable the public demo accounts) or \"0\"/\"false\"/unset (disable them); the value is otherwise ambiguous and the host refuses to boot half-configured",
  );
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

  // --------------------------------------------------------------------------
  // The Redis accelerator binding (RL-105): the DISTRIBUTED admission-control
  // limiter over the ephemeral-coordination port when the Upstash REST env is
  // configured; otherwise the api-service's honest resolution law applies
  // (in-memory fallback in development with its loud composition line + a
  // degraded readiness entry; refused in production -> disabled + degraded).
  // Redis stays OPTIONAL for correctness (deployment.md §7): the surface is
  // servable without it, the readiness vocabulary carries the degradation.
  // --------------------------------------------------------------------------
  let edgeRateLimiter: ApiRateLimiter | undefined;
  if (
    env.upstashRedisRestUrl !== undefined &&
    env.upstashRedisRestUrl.trim().length > 0 &&
    env.upstashRedisRestToken !== undefined &&
    env.upstashRedisRestToken.trim().length > 0
  ) {
    const parsed = tryParseUpstashRedisEnv({
      [UPSTASH_REDIS_ENV_KEYS[0]]: env.upstashRedisRestUrl,
      [UPSTASH_REDIS_ENV_KEYS[1]]: env.upstashRedisRestToken,
    });
    if (!parsed.ok) {
      throw new CompositionError(
        `the Upstash Redis configuration is invalid and the host refuses to boot half-configured: ${parsed.error.message}`,
      );
    }
    const { UpstashRedisRestClient } = await import("@roamlink/provider-redis");
    const coordination = new UpstashRedisRestClient({
      baseUrl: parsed.config.baseUrl,
      token: parsed.config.token,
    });
    edgeRateLimiter = new DistributedFixedWindowLimiter(
      { windowMs: 60_000, maxCost: 600, keyPrefix: "roamlink-api-edge" },
      coordination,
    );
  }
  const rateLimitBinding = resolveApiRateLimitBinding(env.mode, edgeRateLimiter !== undefined ? { rateLimiter: edgeRateLimiter } : undefined);
  readinessBindings.push({ check: rateLimitReadinessCheck(rateLimitBinding.state), criticality: "optional" });

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

  // The public demo accounts (ROAMLINK_DEMO_ACCOUNTS, demo environment only):
  // seeded ONCE per process through the REAL administration boundary - the
  // fixed deterministic identities make every boot rebuild the identical
  // roster, and a disabled gate seeds NOTHING (the login document then has
  // no demo surface at all). A seed failure refuses the whole boot
  // (fail-closed: a half-seeded demo environment is never served).
  const demo = parseDemoAccountsGate(env.demoAccounts)
    ? { accounts: await seedDemoAccounts({ users, directory, credentials, organizations, memberships, ledger, hasher, now }) }
    : { accounts: [] as readonly DemoAccountView[] };

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
    mode: env.mode,
    edge: edgeRateLimiter !== undefined ? { rateLimiter: edgeRateLimiter } : {},
  });

  // --------------------------------------------------------------------------
  // The maintenance trigger seam (RL-107): the REAL persistence for the
  // recovery sweeps, plus the event-driven kick when the QStash env + the
  // destination are configured (the sanctioned async path).
  // --------------------------------------------------------------------------
  const persistence: PostgresPersistence = createPostgresPersistence(driver);
  let asyncDelivery: DurableJobDeliveryPort | undefined;
  if (
    env.qstashToken !== undefined &&
    env.qstashToken.trim().length > 0 &&
    env.maintenanceDestination !== undefined &&
    env.maintenanceDestination.trim().length > 0
  ) {
    const { UpstashQStashClient } = await import("@roamlink/provider-qstash");
    asyncDelivery = new UpstashQStashClient({
      token: env.qstashToken,
      ...(env.qstashBaseUrl !== undefined ? { baseUrl: env.qstashBaseUrl } : {}),
    });
  }
  const maintenance = {
    cronSecret: env.cronSecret,
    run: (): Promise<DailyMaintenanceResult> =>
      runDailyMaintenance({
        persistence,
        // The host admits webhooks only (RL-LOCK-009); projection stays in
        // the worker host, so no inbox drain is bound here - the result
        // reports the skip honestly.
        now,
        ...(asyncDelivery !== undefined && env.maintenanceDestination !== undefined
          ? { asyncDelivery, asyncDestination: env.maintenanceDestination }
          : {}),
      }),
    // The event-driven path's signed-job receiver (RL-110): composed only
    // when the receiver-side signing keys exist (fail-closed otherwise).
    receiver:
      env.qstashSigningKeyCurrent !== undefined && env.qstashSigningKeyCurrent.trim().length > 0
        ? createMaintenanceReceiver({
            persistence,
            now,
            signingKeys: {
              current: env.qstashSigningKeyCurrent,
              ...(env.qstashSigningKeyNext !== undefined
                ? { next: env.qstashSigningKeyNext }
                : {}),
            },
          })
        : null,
  };

  // --------------------------------------------------------------------------
  // The PA-025 live command-execution path: the authenticated bounded
  // worker-tick endpoint over the workers execution seam. Composed ONLY
  // when the receiver-side QStash signing keys are configured (the same
  // fail-closed gate as the maintenance receiver) — uncomposed means the
  // route answers the honest 503 and accepted commands keep their PENDING
  // outbox obligations (the documented wave gap, never a fake execution).
  // --------------------------------------------------------------------------
  const workerTickEndpoint =
    env.qstashSigningKeyCurrent !== undefined && env.qstashSigningKeyCurrent.trim().length > 0
      ? createWorkerTickEndpoint({
          persistence,
          now,
          mode: env.mode,
          signingKeys: {
            current: env.qstashSigningKeyCurrent,
            ...(env.qstashSigningKeyNext !== undefined ? { next: env.qstashSigningKeyNext } : {}),
          },
          ...(env.workerTickBatchSize !== undefined ? { outboxBatchSize: env.workerTickBatchSize } : {}),
          ...(env.workerTickMaxDurationMs !== undefined ? { maxDurationMs: env.workerTickMaxDurationMs } : {}),
        })
      : null;
  const worker = { tickEndpoint: workerTickEndpoint };

  // --------------------------------------------------------------------------
  // The §11 SLO bindings (RL-109): the REAL recorder + the deployment's
  // configured objectives. The ops surface renders their state read-only
  // (ops-slo-page.ts) - real recorder state, zero invented numbers.
  // --------------------------------------------------------------------------
  const slo = createHostSloBindings({ objectivesRaw: env.sloObjectivesRaw, now });

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

  return { api, driver, persistence, maintenance, worker, slo, demo, identity, readyCheck, dispose };
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
