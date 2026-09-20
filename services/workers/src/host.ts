/**
 * The worker host (RL-107): the production process that drains the durable
 * queues and drives reconciliation.
 *
 * services/api records commands and admits webhooks; NOTHING else drains
 * them. This host composes the SAME persistence/reconciliation seams the
 * verification suites use:
 *
 *  - OUTBOX DRAIN: the bounded `claimDue` loop over the delivery port,
 *    with the RL-093 `recoverInFlight` startup sweep BEFORE the first
 *    claim (crash/restart discipline: claims re-own, obligations never
 *    lose). The delivery channel is composition-resolved:
 *      1. an explicit delivery port (composers/tests),
 *      2. the QStash durable-jobs handoff when QSTASH_TOKEN + the
 *         destination are configured (the sanctioned async channel),
 *      3. otherwise NO drain is composed: the readiness surface reports
 *         `outbox-delivery` degraded with the honest reason and the
 *         records stay PENDING (the documented wave gap) — never a fake
 *         delivery, never a silently idle queue.
 *  - INBOX DRAIN: the webhook inbox's bounded `processPending` schedule
 *    (projection is the worker's concern — admission is not truth,
 *    RL-LOCK-009), composed with the reconciliation boundary's projector.
 *  - RECONCILIATION: the `AdcosReconciliationScheduler` over the
 *    `createAdcosReconciliationBoundary` composition, on the injectable
 *    timer (deterministic in tests, wall-clock paced in production).
 *  - ADCOS COMPATIBILITY PROBE (RL-108): env-gated; when configured the
 *    §9 suite runs against the REAL endpoint at startup and its report is
 *    applied to the exposed `AdcosCompatibilityState` (fail-closed
 *    mutations); when absent the probe honestly reports not-configured
 *    and never blocks the host.
 *  - READINESS: the closed honest vocabulary (ready | degraded:<deps> |
 *    not-ready:<reasons>) over the REAL probes — the database and the
 *    migration ledger are REQUIRED (a worker that cannot reach the DB is
 *    not-ready, never ready-with-secrets-suppressed); the outbox-delivery
 *    channel and the ADCOS compatibility state are OPTIONAL degradations.
 */
import { nowUtc, type UtcInstant } from "@roamlink/contracts";
import {
  databaseHealthCheck,
  createPgDriver,
  createPgliteDriver,
  createPostgresPersistence,
  type PgPoolLike,
  type PostgresPersistence,
  type SqlDriver,
} from "@roamlink/persistence-postgres";
import { InMemoryProjectionStore } from "@roamlink/projections";
import { UpstashQStashClient } from "@roamlink/provider-qstash";
import type { AdcosClient } from "@roamlink/adcos";
import { createAdcosReconciliationBoundary, AdcosReconciliationScheduler, SystemReconciliationTimer, type ReconciliationBoundary } from "@roamlink/reconciliation";
import {
  composeReadiness,
  type ComposedReadiness,
  type ReadinessCheckBinding,
} from "@roamlink/api-service";
import { type HealthCheck } from "@roamlink/observability";
import { createAdcosClient, createAdcosHttpTransport, type AdcosCompatibilityState } from "@roamlink/integration";
import { runAdcosProductionProbe, type AdcosProbeResult } from "@roamlink/compat";
import { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry } from "@roamlink/webhook-inbox";

import { createOutboxDrain, type OutboxDrainHandle } from "./outbox-drain.js";
import { createInboxDrain, type InboxDrainHandle } from "./inbox-drain.js";
import {
  qstashOutboxDeliveryPort,
  type OutboxDeliveryPort,
} from "./delivery.js";
import { SystemWorkerTimer, type WorkerTimer } from "./timer.js";

/** The platform tenant reconciliation jobs run under (deployment-level identity). */
export const DEFAULT_WORKER_PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";

export interface WorkerHostEnv {
  readonly mode: "production" | "development";
  readonly databaseUrl: string | undefined;
  /** QStash durable-jobs env: when set (+ destination) the outbox drain is composed. */
  readonly qstashToken?: string | undefined;
  readonly qstashBaseUrl?: string | undefined;
  readonly outboxDeliveryDestination?: string | undefined;
  /**
   * The ADCOS probe env (RL-108): ADCOS_API_BASE_URL / ADCOS_CLIENT_ID /
   * ADCOS_CLIENT_SECRET / ADCOS_WEBHOOK_SECRET (+ the optional probe
   * resource ids). Absent -> the probe reports not-configured (honest).
   */
  readonly adcOsEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /** The ADCOS signing-key registry for webhook ADMISSION in this process. */
  readonly webhookSigningKeys?: Readonly<Record<string, string>> | undefined;
  readonly webhookEnvironment?: "sandbox" | "production" | undefined;
  /** The reconciliation schedule period (default 300_000ms = 5 minutes). */
  readonly reconciliationIntervalMs?: number;
  /** The platform tenant for reconciliation jobs (validated org:<uuid>). */
  readonly platformTenantId?: string | undefined;
  readonly outboxBatchSize?: number;
  readonly outboxIdleDelayMs?: number;
  readonly inboxBatchLimit?: number;
  readonly inboxIntervalMs?: number;
}

/** Composition seams (tests override; production uses the env bindings). */
export interface WorkerHostSeams {
  readonly timer?: WorkerTimer;
  readonly delivery?: OutboxDeliveryPort;
  readonly adcOsClient?: AdcosClient;
  readonly fetchLike?: typeof fetch;
  readonly now?: () => UtcInstant;
  /**
   * A PRE-COMPOSED persistence (tests/composers that own the driver).
   * When absent the host binds its own driver from DATABASE_URL
   * (fail-closed: postgres:// or pglite:// in development only).
   */
  readonly persistence?: PostgresPersistence;
  /** The driver backing the seam persistence (probes run through it). */
  readonly driver?: SqlDriver;
  /** Releases the seam-owned driver when the host is disposed (tests). */
  readonly disposePersistence?: () => Promise<void>;
}

/** Thrown when the composition refuses to boot (fail-closed policy). */
export class WorkerCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCompositionError";
  }
}

export interface WorkerHost {
  readonly outbox: OutboxDrainHandle | null;
  readonly inbox: InboxDrainHandle | null;
  readonly reconciliation: { readonly schedule: { readonly stop: () => void }; readonly boundary: ReconciliationBoundary } | null;
  /** The compatibility state with the probe report applied (when configured). */
  readonly compatibility: AdcosCompatibilityState | null;
  readonly probeResult: AdcosProbeResult | null;
  readonly readyCheck: () => Promise<{
    readonly status: string;
    readonly ready: boolean;
    readonly checks: readonly { readonly name: string; readonly state: string; readonly detail?: string }[];
  }>;
  /** Resolves when the composed loops' startup work settled (tests/observability). */
  whenSettled(): Promise<void>;
  /** Releases the composed driver (the long-running process exits). */
  dispose(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export async function createWorkerHost(
  env: WorkerHostEnv,
  seams: WorkerHostSeams = {},
): Promise<WorkerHost> {
  const now = seams.now ?? (() => new Date().toISOString() as UtcInstant);
  const timer = seams.timer ?? new SystemWorkerTimer();

  // --- the REAL persistence (fail-closed selection, same law as the host) --
  const bound = seams.persistence === undefined ? await bindDriver(env) : null;
  const driver: SqlDriver | undefined = bound?.driver ?? seams.driver;
  const dispose: () => Promise<void> = bound?.dispose ?? seams.disposePersistence ?? (async () => undefined);
  if (driver === undefined) {
    throw new WorkerCompositionError(
      "the persistence seam requires its driver (the readiness probes run through the same connection truth)",
    );
  }
  const persistence: PostgresPersistence = seams.persistence ?? createPostgresPersistence(driver);

  const readinessBindings: ReadinessCheckBinding[] = [
    { check: databaseHealthCheck(driver), criticality: "required" },
    { check: migrationLedgerHealthCheck(driver), criticality: "required" },
  ];

  // --- the outbox delivery channel (explicit seam > QStash env > none) -----
  let delivery: OutboxDeliveryPort | undefined = seams.delivery;
  if (delivery === undefined && env.qstashToken !== undefined && env.outboxDeliveryDestination !== undefined) {
    const client = new UpstashQStashClient({
      token: env.qstashToken,
      ...(env.qstashBaseUrl !== undefined ? { baseUrl: env.qstashBaseUrl } : {}),
    });
    delivery = qstashOutboxDeliveryPort({ port: client, destination: env.outboxDeliveryDestination });
  }
  let outbox: OutboxDrainHandle | null = null;
  if (delivery !== undefined) {
    outbox = createOutboxDrain({
      persistence,
      delivery,
      now,
      timer,
      ...(env.outboxBatchSize !== undefined ? { batchSize: env.outboxBatchSize } : {}),
      ...(env.outboxIdleDelayMs !== undefined ? { idleDelayMs: env.outboxIdleDelayMs } : {}),
    });
  } else {
    readinessBindings.push({
      check: staticHealthCheck("outbox-delivery", "degraded", "no delivery channel is composed (configure QStash or bind a delivery port); records stay PENDING - the documented wave gap, never a fake delivery"),
      criticality: "optional",
    });
  }

  // --- the ADCOS compatibility probe (RL-108, env-gated, fail-closed) ------
  let compatibility: AdcosCompatibilityState | null = null;
  let probeResult: AdcosProbeResult | null = null;
  let adcOsClient: AdcosClient | undefined = seams.adcOsClient;
  if (env.adcOsEnv !== undefined) {
    probeResult = await runAdcosProductionProbe({
      env: env.adcOsEnv,
      ...(seams.adcOsClient !== undefined ? { client: seams.adcOsClient } : {}),
      ...(seams.fetchLike !== undefined ? { fetchLike: seams.fetchLike } : {}),
    });
    if (probeResult.status !== "not-configured") {
      compatibility = probeResult.state;
      // The REAL client from the same env the probe validated.
      adcOsClient = adcOsClient ?? buildAdcOsClientFromEnv(env.adcOsEnv);
      // The probe RAN -> the compatibility check is a composed dependency.
      // (not-configured composes nothing: an unprobed dependency is never
      // reported - the readiness law.)
      readinessBindings.push({
        check: adcosCompatibilityHealthCheck(() => probeResult),
        criticality: "optional",
      });
    }
  }

  // --- the reconciliation boundary + inbox drain ----------------------------
  let reconciliation: WorkerHost["reconciliation"] = null;
  let inbox: InboxDrainHandle | null = null;
  if (adcOsClient !== undefined) {
    const platformTenantId = env.platformTenantId ?? DEFAULT_WORKER_PLATFORM_TENANT;
    const verifier = new HmacWebhookVerifier({
      environment: env.webhookEnvironment ?? "sandbox",
      keys: new StaticWebhookSigningKeyRegistry(env.webhookSigningKeys ?? {}),
    });
    const boundary = createAdcosReconciliationBoundary({
      client: adcOsClient,
      // Projections are DISPOSABLE (spec/architecture.md §5): the in-memory
      // store is the sanctioned projection store in this tree; a restart
      // re-discovers and re-repairs through reconciliation by design.
      projectionStore: new InMemoryProjectionStore(),
      persistence,
      persistenceReader: persistence,
      verifier,
      clock: { now },
      platformTenantId,
      ...(compatibility !== null
        ? { compatibility: { status: () => compatibility?.status() ?? "unknown" } }
        : {}),
    });
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: boundary.reconciler,
      intervalMs: env.reconciliationIntervalMs ?? 300_000,
      timer: new SystemReconciliationTimer(),
    });
    reconciliation = { schedule: scheduler.start(), boundary };
    inbox = createInboxDrain({
      inbox: boundary.inbox,
      now,
      timer,
      ...(env.inboxBatchLimit !== undefined ? { batchLimit: env.inboxBatchLimit } : {}),
      ...(env.inboxIntervalMs !== undefined ? { intervalMs: env.inboxIntervalMs } : {}),
    });
  }

  // --- the composed readiness (the honest vocabulary, one truth) -----------
  const readiness: ComposedReadiness = composeReadiness({ checks: readinessBindings });

  return {
    outbox,
    inbox,
    reconciliation,
    compatibility,
    probeResult,
    readyCheck: async () => {
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
    },
    whenSettled(): Promise<void> {
      return Promise.all([outbox?.whenStartupSettled() ?? Promise.resolve()]).then(() => undefined);
    },
    dispose(): Promise<void> {
      return dispose();
    },
    start(): void {
      outbox?.start();
      inbox?.start();
    },
    stop(): Promise<void> {
      reconciliation?.schedule.stop();
      return Promise.all([outbox?.stop() ?? Promise.resolve(), inbox?.stop() ?? Promise.resolve()]).then(
        () => undefined,
      );
    },
  };

  function buildAdcOsClientFromEnv(adcOsEnv: Readonly<Record<string, string | undefined>>): AdcosClient {
    const baseUrl = adcOsEnv["ADCOS_API_BASE_URL"];
    const clientId = adcOsEnv["ADCOS_CLIENT_ID"];
    const clientSecret = adcOsEnv["ADCOS_CLIENT_SECRET"];
    const environmentRaw = adcOsEnv["ADCOS_ENVIRONMENT"];
    const transport = createAdcosHttpTransport({
      environment: environmentRaw === "production" ? "production" : "sandbox",
      baseUrl: baseUrl as string,
      application: clientId as string,
      credential: clientSecret as string,
      ...(seams.fetchLike !== undefined ? { fetchLike: seams.fetchLike } : {}),
    });
    return createAdcosClient({
      transport,
      environment: environmentRaw === "production" ? "production" : "sandbox",
    });
  }
}

async function bindDriver(env: WorkerHostEnv): Promise<{ driver: SqlDriver; dispose: () => Promise<void> }> {
  const databaseUrl = env.databaseUrl?.trim() ?? "";
  if (databaseUrl.startsWith("pglite:")) {
    if (env.mode === "production") {
      throw new WorkerCompositionError(
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
      // Idle-client errors must not crash the worker; the readiness probes
      // and the next query surface the failure honestly.
    });
    return {
      driver: createPgDriver(pool as unknown as PgPoolLike),
      dispose: async () => {
        await pool.end();
      },
    };
  }
  throw new WorkerCompositionError(
    "DATABASE_URL is not configured: the worker host runs on real PostgreSQL (spec/deployment.md). The host never silently falls back to an in-memory adapter.",
  );
}

/** The migration-ledger readiness probe (the ledger must exist AND be applied). */
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
          : { name: "migrations", state: "down", detail: "the schema migration ledger is empty (apply infra/migrations first)", checkedAt };
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

/** A readiness check with a FIXED state + honest detail (composition facts). */
function staticHealthCheck(name: string, state: "degraded" | "down", detail: string): HealthCheck {
  return {
    name,
    run: async () => ({ name, state, detail, checkedAt: nowUtc() }),
  };
}

/**
 * The ADCOS compatibility readiness check (RL-108): reflects the LATEST
 * probe result - compatible -> healthy; incompatible -> degraded (the
 * diagnosable, value-free failed-check names ride the report); a probe
 * that has not run (not-configured) is never registered as a check.
 */
function adcosCompatibilityHealthCheck(latest: () => AdcosProbeResult | null): HealthCheck {
  return {
    name: "adcos-compatibility",
    run: async () => {
      const checkedAt = nowUtc();
      const result = latest();
      if (result === null || result.status === "not-configured") {
        return {
          name: "adcos-compatibility",
          state: "degraded" as const,
          detail: "the ADCOS probe has not run (not configured)",
          checkedAt,
        };
      }
      if (result.status === "compatible") {
        return {
          name: "adcos-compatibility",
          state: "healthy" as const,
          detail: `compatible (suite ${String(result.report.suiteVersion)}, ${result.report.checks.length} checks passed)`,
          checkedAt,
        };
      }
      const failed = result.report.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .sort();
      return {
        name: "adcos-compatibility",
        state: "degraded" as const,
        detail: `INCOMPATIBLE: mutations fail closed; failed checks: ${failed.join(", ")}`,
        checkedAt,
      };
    },
  };
}

