/**
 * The suite's environment contract (PA-021) — env-gated, fail-closed to skip.
 *
 * The suite is BLACK-BOX: it knows only the deployed origin and the demo
 * credentials (the public demo roster of spec/deployment.md §6 "demo" — the
 * personas are public fixtures by design, apps/portal-host/src/demo-accounts.ts),
 * never the repository internals.
 *
 * Environment variables (nothing is ever committed; values are never echoed
 * beyond their shape, RL-LOCK-016):
 *
 *   ACCEPTANCE_BASE_URL      the deployed web origin (required to run).
 *                            Without it the suite SKIPS with the named
 *                            reason ACCEPTANCE_BASE_URL_NOT_CONFIGURED —
 *                            never a fake pass, never a hard fail on an
 *                            unconfigured box (the house honest-skip law).
 *   ACCEPTANCE_DEMO_EMAIL    the customer persona's email (optional; defaults
 *                            to the public roster's customer persona).
 *   ACCEPTANCE_DEMO_PASSWORD the demo password (optional; defaults to the
 *                            roster's shared public password).
 *   ACCEPTANCE_ADMIN_EMAIL   the admin-journey persona (optional; defaults to
 *                            the roster's owner persona).
 *   ACCEPTANCE_TIMEOUT_MS    per-navigation bound (optional; default 45000).
 *   ACCEPTANCE_REPORT_DIR    where the JSON report is written (optional;
 *                            default <package>/.tmp — gitignored).
 *
 * Optional credential envs override the roster defaults so an operator can
 * point the suite at any deployed demo; the defaults themselves are public
 * fixtures (rendered on the demo login page), so they are not secrets.
 */
import { fileURLToPath } from "node:url";

/** One persona the suite logs in as (the public demo roster defaults). */
export interface PersonaCredentials {
  readonly label: string;
  readonly email: string;
  readonly password: string;
}

/** The public demo roster defaults (public fixtures, not secrets). */
export const DEFAULT_CUSTOMER: PersonaCredentials = Object.freeze({
  label: "customer",
  email: "customer@demo.roamlink.example",
  password: "roamlink-demo",
});

export const DEFAULT_ADMIN_PERSONA: PersonaCredentials = Object.freeze({
  label: "owner",
  email: "owner@demo.roamlink.example",
  password: "roamlink-demo",
});

/** The named skip reason when the env surface is unconfigured. */
export const SKIP_REASON_ENV_NOT_CONFIGURED =
  "ACCEPTANCE_BASE_URL_NOT_CONFIGURED (the deployed-browser acceptance suite is env-gated: set ACCEPTANCE_BASE_URL to the deployed origin to run the journey matrix; this is a named skip, not a failure)";

interface PersonaConfig {
  readonly customer: PersonaCredentials;
  readonly adminPersona: PersonaCredentials;
  readonly timeoutMs: number;
  readonly reportDir: string;
}

/** The unconfigured shape: a named skip, never a run. */
export interface AcceptanceSkippedConfig extends PersonaConfig {
  readonly status: "skipped";
  readonly skipReason: string;
}

/** The configured shape: a deploy target to run the matrix against. */
export interface AcceptanceActiveConfig extends PersonaConfig {
  readonly status: "configured";
  readonly baseUrl: string;
}

export type AcceptanceRunConfig = AcceptanceSkippedConfig | AcceptanceActiveConfig;

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 180_000;

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const bare = value.trim();
  return bare.length === 0 ? undefined : bare;
}

/**
 * Parses the run config from an env surface (Node's process.env shape: a
 * record of string | undefined). Pure and total: a missing base URL yields
 * the named skip, never a throw — the fail-closed-to-skip law.
 */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): AcceptanceRunConfig {
  const baseUrl = trimmed(env["ACCEPTANCE_BASE_URL"]);
  const email = trimmed(env["ACCEPTANCE_DEMO_EMAIL"]);
  const password = trimmed(env["ACCEPTANCE_DEMO_PASSWORD"]);
  const adminEmail = trimmed(env["ACCEPTANCE_ADMIN_EMAIL"]);
  const timeoutRaw = trimmed(env["ACCEPTANCE_TIMEOUT_MS"]);
  const reportDir = trimmed(env["ACCEPTANCE_REPORT_DIR"]);

  const customer: PersonaCredentials = {
    label: "customer",
    email: email ?? DEFAULT_CUSTOMER.email,
    password: password ?? DEFAULT_CUSTOMER.password,
  };
  const adminPersona: PersonaCredentials = {
    label: "owner",
    email: adminEmail ?? DEFAULT_ADMIN_PERSONA.email,
    password: password ?? DEFAULT_ADMIN_PERSONA.password,
  };

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`ACCEPTANCE_TIMEOUT_MS must be a positive integer (got ${JSON.stringify(timeoutRaw)})`);
    }
    timeoutMs = Math.min(parsed, MAX_TIMEOUT_MS);
  }

  if (baseUrl === undefined) {
    return {
      status: "skipped",
      skipReason: SKIP_REASON_ENV_NOT_CONFIGURED,
      customer,
      adminPersona,
      timeoutMs,
      reportDir: reportDir ?? defaultReportDir(),
    } satisfies AcceptanceSkippedConfig;
  }

  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    // A malformed configured value is an honest misconfiguration (exit-2
    // shape of the smoke law), NOT a skip: the operator asked for a run.
    throw new Error(
      `ACCEPTANCE_BASE_URL must be an absolute origin (got ${JSON.stringify(baseUrl.slice(0, 64))})`,
    );
  }
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new Error(
      "ACCEPTANCE_BASE_URL must be a bare origin (scheme://host[:port]) without path/query/hash",
    );
  }

  return {
    status: "configured",
    baseUrl: origin.origin,
    customer,
    adminPersona,
    timeoutMs,
    reportDir: reportDir ?? defaultReportDir(),
  } satisfies AcceptanceActiveConfig;
}

function defaultReportDir(): string {
  // The default report location is the package's .tmp directory (gitignored
  // by the repo's `.tmp/` pattern) — run artifacts never dirty the tree.
  const here = fileURLToPath(import.meta.url);
  const marker = "/tests/acceptance/";
  const at = here.lastIndexOf(marker);
  if (at === -1) return ".tmp";
  return `${here.slice(0, at + marker.length)}.tmp`;
}
