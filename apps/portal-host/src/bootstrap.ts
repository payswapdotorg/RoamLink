/**
 * The hosted runtime's composition bootstrap (RL-089).
 *
 * ONE memoized composition per process, built from the environment ONLY
 * (spec/deployment.md: all secrets arrive through the environment; nothing
 * is hard-coded, RL-LOCK-016). A refusal to boot is MEMOIZED too: the
 * fail-closed answer must not depend on request order, and the readiness
 * endpoint keeps reporting the refusal honestly instead of flapping.
 */
import { createPortalHostComposition, type PortalHostComposition } from "./composition.js";

export type HostRuntime =
  | { readonly ok: true; readonly composition: PortalHostComposition }
  | { readonly ok: false; readonly error: unknown };

let memoized: Promise<HostRuntime> | undefined;

/** The host environment (parsed once per process; no defaults, no fakes). */
export function portalHostEnvFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  mode: "production" | "development";
  databaseUrl: string | undefined;
  webhookSigningKeys: string | undefined;
  webhookEnvironment: string | undefined;
  apiBaseUrl: string | undefined;
  upstashRedisRestUrl: string | undefined;
  upstashRedisRestToken: string | undefined;
  cronSecret: string | undefined;
  qstashToken: string | undefined;
  qstashBaseUrl: string | undefined;
  maintenanceDestination: string | undefined;
  qstashSigningKeyCurrent: string | undefined;
  qstashSigningKeyNext: string | undefined;
  sloObjectives: string | undefined;
} {
  return {
    mode: env["NODE_ENV"] === "production" ? "production" : "development",
    databaseUrl: env["DATABASE_URL"],
    webhookSigningKeys: env["ROAMLINK_WEBHOOK_SIGNING_KEYS"],
    webhookEnvironment: env["ROAMLINK_WEBHOOK_ENVIRONMENT"],
    // RL-100: when configured, the host's readiness composition probes the
    // remote API service's GET /v1/readiness (bounded timeout, REQUIRED).
    apiBaseUrl: env["ROAMLINK_API_BASE_URL"],
    // RL-105: when configured, the API edge's admission control is the
    // DISTRIBUTED fixed-window limiter over the Upstash REST port.
    upstashRedisRestUrl: env["UPSTASH_REDIS_REST_URL"],
    upstashRedisRestToken: env["UPSTASH_REDIS_REST_TOKEN"],
    // RL-107: the fail-closed maintenance trigger secret + the optional
    // event-driven kick (QStash) for the /api/maintenance/daily route.
    cronSecret: env["CRON_SECRET"],
    qstashToken: env["QSTASH_TOKEN"],
    qstashBaseUrl: env["QSTASH_URL"],
    maintenanceDestination: env["ROAMLINK_MAINTENANCE_DESTINATION"],
    // RL-110: the RECEIVER-side QStash signing keys (verify before acting).
    qstashSigningKeyCurrent: env["QSTASH_CURRENT_SIGNING_KEY"],
    qstashSigningKeyNext: env["QSTASH_NEXT_SIGNING_KEY"],
    // RL-109: the deployment's budgeted §11 SLO objectives (see src/slo.ts).
    sloObjectives: env["ROAMLINK_SLO_OBJECTIVES"],
  };
}

/** The memoized composition (or the memoized refusal). */
export function portalHostRuntime(): Promise<HostRuntime> {
  memoized ??= createPortalHostComposition(portalHostEnvFromProcessEnv()).then(
    (composition): HostRuntime => ({ ok: true, composition }),
    (error: unknown): HostRuntime => ({ ok: false, error }),
  );
  return memoized;
}

/** Test seam: resets the memoized runtime (process-level state). */
export function resetPortalHostRuntime(): void {
  memoized = undefined;
}
