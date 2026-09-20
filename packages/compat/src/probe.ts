/**
 * The production ADCOS compatibility probe (RL-108).
 *
 * The compatibility MACHINERY is frozen (`runAdcosCompatibilitySuite`,
 * packages/compat; `AdcosCompatibilityState`, packages/integration). What
 * was missing is the PRODUCTION entry point: running the suite against a
 * REAL, env-configured ADCOS endpoint as a deployment gate.
 *
 * Laws:
 *  - ENV-CONFIGURED: ADCOS_API_BASE_URL / ADCOS_CLIENT_ID /
 *    ADCOS_CLIENT_SECRET / ADCOS_WEBHOOK_SECRET (templated in
 *    infra/deployment/environments/*.env.example). ADCOS_API_VERSION, when
    *    present, must equal the ONE pinned supported version (single-site
 *    law) — a mismatch is a loud misconfiguration, never a guess.
 *  - HONEST NOT-CONFIGURED: when the env is absent the probe reports
 *    `not-configured` (exit-distinct from compatible/incompatible) and
 *    NEVER blocks local/CI runs. No real credential is ever needed in any
 *    committed file — env-only (RL-LOCK-016).
 *  - FAIL-CLOSED: when configured, the full §9 suite runs against the real
 *    endpoint (including webhook signature semantics over the configured
 *    secret and a sample delivery) and the report is applied to the
 *    returned `AdcosCompatibilityState` — mutations gated on
 *    unknown/incompatible by the EXISTING semantics.
 *
 * Runnable standalone (services/workers `adcos:probe` script) AND composed
 * as a readiness dependency in the worker host.
 */
import { ValidationError, type UtcInstant } from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  parseAdcosEnvironment,
  parseAdcosWebhookEvent,
  type AdcosClient,
  type AdcosEnvironment,
  type AdcosWebhookEvent,
} from "@roamlink/adcos";
import {
  AdcosCompatibilityState,
  type AdcosCompatibilityReport,
} from "@roamlink/integration";
import { createAdcosClient, createAdcosHttpTransport } from "@roamlink/integration";

import {
  runAdcosCompatibilitySuite,
  type AdcosCompatibilitySuiteProbe,
  type AdcosCompatibilitySuiteReport,
} from "./suite.js";

/** The environment keys the probe reads (documented in the env templates). */
export const ADCOS_PROBE_ENV_KEYS = {
  baseUrl: "ADCOS_API_BASE_URL",
  apiVersion: "ADCOS_API_VERSION",
  clientId: "ADCOS_CLIENT_ID",
  clientSecret: "ADCOS_CLIENT_SECRET",
  webhookSecret: "ADCOS_WEBHOOK_SECRET",
  environment: "ADCOS_ENVIRONMENT",
  probeIntentId: "ADCOS_PROBE_INTENT_ID",
  probeContractId: "ADCOS_PROBE_CONTRACT_ID",
  probeLeaseId: "ADCOS_PROBE_LEASE_ID",
} as const;

export type AdcosProbeEnvSource = Readonly<Record<string, string | undefined>>;

/** The validated, env-parsed probe configuration (secrets redacted). */
export interface AdcosProbeConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  /** The server-side ADCOS credential; never logged (RL-LOCK-016). */
  readonly clientSecret: string;
  /** The webhook signing secret used for the signature-semantics sample. */
  readonly webhookSecret: string;
  readonly environment: AdcosEnvironment;
  readonly probe: AdcosCompatibilitySuiteProbe;
}

function redact(value: string): string {
  return `<${value.length} chars, redacted>`;
}

/** The configuration stringifies WITHOUT any secret material (RL-LOCK-016). */
export function describeAdcosProbeConfig(config: AdcosProbeConfig): string {
  return `AdcosProbeConfig(baseUrl=${config.baseUrl}, clientId=${config.clientId}, clientSecret=${redact(config.clientSecret)}, webhookSecret=${redact(config.webhookSecret)}, environment=${config.environment})`;
}

/**
 * Parses the probe env. All-absent -> `not-configured` (honest); present-
 * but-incomplete -> the typed error naming the MISSING KEYS (fail loud at
 * composition, never half-configured).
 */
export function parseAdcosProbeEnv(
  source: AdcosProbeEnvSource,
): { readonly configured: false } | { readonly configured: true; readonly config: AdcosProbeConfig } {
  const requiredKeys: (keyof typeof ADCOS_PROBE_ENV_KEYS)[] = [
    "baseUrl",
    "clientId",
    "clientSecret",
    "webhookSecret",
  ];
  const present = requiredKeys.filter((key) => {
    const value = source[ADCOS_PROBE_ENV_KEYS[key]];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (present.length === 0) {
    return { configured: false };
  }
  const missing = requiredKeys.filter((key) => !present.includes(key));
  if (missing.length > 0) {
    throw new ValidationError(
      "the ADCOS probe configuration is incomplete (every required key must be set together; the deployment refuses to be half-configured)",
      {
        reason: "ADCOS_PROBE_CONFIG_INCOMPLETE",
        details: missing.map((key) => ({ path: ADCOS_PROBE_ENV_KEYS[key], issue: "required when the probe is configured" })),
      },
    );
  }
  const versionRaw = source[ADCOS_PROBE_ENV_KEYS.apiVersion];
  if (versionRaw !== undefined && versionRaw.trim().length > 0 && versionRaw.trim() !== ADCOS_API_VERSION) {
    throw new ValidationError(
      `ADCOS_API_VERSION must name the ONE pinned supported version ("${ADCOS_API_VERSION}"); the version pin is configured in a single place and environment overrides cannot fork it`,
      { reason: "ADCOS_VERSION_PIN_MISMATCH", details: [{ path: ADCOS_PROBE_ENV_KEYS.apiVersion, issue: "disagrees with the single-site pin" }] },
    );
  }
  const environmentRaw = source[ADCOS_PROBE_ENV_KEYS.environment];
  const environment = parseAdcosEnvironment(environmentRaw ?? "sandbox");
  const intentId = nonEmpty(source[ADCOS_PROBE_ENV_KEYS.probeIntentId]);
  const contractId = nonEmpty(source[ADCOS_PROBE_ENV_KEYS.probeContractId]);
  const leaseId = nonEmpty(source[ADCOS_PROBE_ENV_KEYS.probeLeaseId]);
  const probe: AdcosCompatibilitySuiteProbe = {
    ...(intentId !== undefined ? { intentId } : {}),
    ...(contractId !== undefined ? { contractId } : {}),
    ...(leaseId !== undefined ? { leaseId } : {}),
  };
  return {
    configured: true,
    config: {
      baseUrl: (source[ADCOS_PROBE_ENV_KEYS.baseUrl] as string).trim(),
      clientId: (source[ADCOS_PROBE_ENV_KEYS.clientId] as string).trim(),
      clientSecret: source[ADCOS_PROBE_ENV_KEYS.clientSecret] as string,
      webhookSecret: source[ADCOS_PROBE_ENV_KEYS.webhookSecret] as string,
      environment,
      probe,
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

// --------------------------------------------------------------------------------
// The probe result
// --------------------------------------------------------------------------------

/** The exit-distinct probe statuses. */
export type AdcosProbeStatus =
  | "not-configured"
  | { readonly compatible: true }
  | { readonly compatible: false };

export type AdcosProbeResult =
  | { readonly status: "not-configured" }
  | {
      readonly status: "compatible" | "incompatible";
      readonly report: AdcosCompatibilitySuiteReport;
      /** The runtime state with the report APPLIED (fail-closed mutations). */
      readonly state: AdcosCompatibilityState;
    };

/** Exit codes for the standalone probe (honest and distinct). */
export const ADCOS_PROBE_EXIT_CODES = {
  compatible: 0,
  incompatible: 1,
  "not-configured": 2,
} as const;

export interface RunAdcosProductionProbeOptions {
  readonly env: AdcosProbeEnvSource;
  /** Explicit evaluation instant (deterministic tests). */
  readonly at?: UtcInstant | string;
  /** Request timeout for the real HTTP transport (default 10s). */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests); defaults to global fetch. */
  readonly fetchLike?: typeof fetch;
  /**
   * Test seam: run the suite against an explicit client instead of the
   * env-built HTTP transport (the env still gates configuration).
   */
  readonly client?: AdcosClient;
}

/**
 * Runs the production probe: env-gated, suite-backed, fail-closed. The
 * returned state carries the applied report so adapters refuse mutations
 * on unknown/incompatible (the existing §9 semantics, unchanged).
 */
export async function runAdcosProductionProbe(
  options: RunAdcosProductionProbeOptions,
): Promise<AdcosProbeResult> {
  const parsed = parseAdcosProbeEnv(options.env);
  if (!parsed.configured) {
    return { status: "not-configured" };
  }
  const config = parsed.config;
  const client = options.client ?? buildEnvClient(config, options);

  const state = new AdcosCompatibilityState();
  const webhookSecretSample = buildWebhookSemanticsSample(config, options.at);
  const report = await runAdcosCompatibilitySuite({
    client,
    ...(Object.keys(config.probe).length > 0 ? { probe: config.probe } : {}),
    ...(webhookSecretSample !== undefined ? { webhookSemantics: webhookSecretSample } : {}),
    ...(options.at !== undefined ? { at: options.at } : {}),
    state,
  });
  return { status: report.status, report, state };
}

/** The report flattened for the observability health vocabulary. */
export function probeReportAsHealthReport(result: AdcosProbeResult): AdcosCompatibilityReport | null {
  if (result.status === "not-configured") return null;
  return { status: result.status, checks: result.report.checks, at: result.report.at };
}

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

function buildEnvClient(
  config: AdcosProbeConfig,
  options: Pick<RunAdcosProductionProbeOptions, "fetchLike" | "timeoutMs">,
): AdcosClient {
  const transport = createAdcosHttpTransport({
    environment: config.environment,
    baseUrl: config.baseUrl,
    application: config.clientId,
    credential: config.clientSecret,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchLike !== undefined ? { fetchLike: options.fetchLike } : {}),
  });
  return createAdcosClient({ transport, environment: config.environment });
}

/**
 * The §9 signature-semantics sample: a representative, contract-pinned
 * event envelope signed with the CONFIGURED secret (the secret crosses this
 * call boundary only; it never appears in any report — RL-LOCK-016).
 */
function buildWebhookSemanticsSample(
  config: AdcosProbeConfig,
  at: UtcInstant | string | undefined,
): Parameters<typeof runAdcosCompatibilitySuite>[0]["webhookSemantics"] {
  const occurredAt = at ?? new Date().toISOString();
  const sampleEvent: AdcosWebhookEvent = parseAdcosWebhookEvent({
    event_id: "evt-rl108-compat-probe-sample",
    event_type: "connectivity_lease.granted",
    resource_id: "lease-rl108-compat-probe",
    resource_kind: "connectivity_lease",
    resource_version: 1,
    occurred_at: occurredAt,
    api_version: ADCOS_API_VERSION,
    environment: config.environment,
    correlation_id: "corr-rl108-compat-probe",
  });
  return {
    environment: config.environment,
    keys: { [config.clientId]: config.webhookSecret },
    sampleEvent,
    signingKeyId: config.clientId,
    signingSecret: config.webhookSecret,
  };
}
