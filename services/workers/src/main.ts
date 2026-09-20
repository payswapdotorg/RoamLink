/**
 * The worker host's standalone entry (RL-107).
 *
 * A long-running process: outbox drain (recoverInFlight startup sweep ->
 * bounded claim loop), inbox drain, reconciliation schedule — composed from
 * the environment ONLY (no secrets in code, RL-LOCK-016), readiness logged,
 * graceful on SIGTERM/SIGINT (the in-flight tick finishes; abandoned claims
 * re-own on the next start).
 *
 * Run: `pnpm --filter @roamlink/workers start` (see infra/deployment docs).
 */
import { createCorrelatedLogger, createConsoleStructuredLogSink, createManualCorrelationCarrier } from "@roamlink/observability";

import { createWorkerHost, type WorkerHostEnv } from "./host.js";

export function workerHostEnvFromProcessEnv(env: NodeJS.ProcessEnv = process.env): WorkerHostEnv {
  return {
    mode: env["NODE_ENV"] === "production" ? "production" : "development",
    databaseUrl: env["DATABASE_URL"],
    qstashToken: env["QSTASH_TOKEN"],
    qstashBaseUrl: env["QSTASH_URL"],
    outboxDeliveryDestination: env["ROAMLINK_OUTBOX_DELIVERY_DESTINATION"],
    adcOsEnv: env,
    webhookSigningKeys: parseWebhookSigningKeys(env["ROAMLINK_WEBHOOK_SIGNING_KEYS"]),
    webhookEnvironment: env["ROAMLINK_WEBHOOK_ENVIRONMENT"] === "production" ? "production" : "sandbox",
    platformTenantId: env["ROAMLINK_PLATFORM_TENANT_ID"],
  };
}

function parseWebhookSigningKeys(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const keys: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue; // the fail-closed parse lives at the edges; here a malformed pair is skipped
    keys[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return keys;
}

async function main(): Promise<void> {
  const logger = createCorrelatedLogger({
    sink: createConsoleStructuredLogSink(),
    carrier: createManualCorrelationCarrier(),
    minLevel: "info",
  });
  let host;
  try {
    host = await createWorkerHost(workerHostEnvFromProcessEnv());
  } catch (error) {
    // The composition refusal is LOUD and value-free (RL-LOCK-016).
    console.error("worker host composition refused:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
    return;
  }
  logger.info("worker_host_starting", {
    outbox: host.outbox !== null,
    inbox: host.inbox !== null,
    reconciliation: host.reconciliation !== null,
  });
  host.start();

  const shutdown = (signal: string): void => {
    logger.info("worker_host_shutdown", { reason: signal });
    void host.stop().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Periodic honest readiness (every 30s): never ready-with-secrets-suppressed.
  const readinessTimer = setInterval(() => {
    void host
      .readyCheck()
      .then((report) => {
        logger.info("worker_host_readiness", { status: report.status, ready: report.ready });
      })
      .catch(() => {
        logger.warn("worker_host_readiness", { status: "not-ready:readiness-probe", ready: false });
      });
  }, 30_000);
  readinessTimer.unref?.();
}

// Run only when executed directly (node/bun script entry, never on import).
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void main();
}
