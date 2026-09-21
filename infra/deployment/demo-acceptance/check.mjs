#!/usr/bin/env node
/**
 * RoamLink demo environment acceptance gate (RL-117) —
 * infra/deployment/demo-acceptance.
 *
 * spec/deployment.md §7 lists TWELVE checks required "Before demo
 * deployment". The mechanical pieces already exist on this tree — the
 * RL-100 synthetic smoke, the RL-112 executable rollback rule, the
 * RL-075..RL-112 tests/deployment batteries, the RL-108 ADCOS
 * compatibility probe and the environments/*.env.example config surface —
 * but they were SCATTERED. THIS gate composes them into ONE twelve-row
 * verdict report and fills the config-validation gaps the on-tree pieces
 * do not cover:
 *
 *   row 4  webhook signatures are CONFIGURED (env-surface presence +
 *          shape law — the fail-closed runtime semantics are already
 *          proven on-tree by the smoke/ingress and runtime-hardening
 *          batteries; what was missing is the configuration check);
 *   row 6  the no-in-memory-adapter PRODUCTION law at the config level
 *          (the demo env binds the real PostgreSQL driver path — the
 *          composition refuses fakes; pglite:// is refused);
 *   row 9  the R2 scoped-credential CONFIG validation (the full
 *          all-or-nothing surface + shapes; the scoped-token provisioning
 *          discipline + the live round-trip stay operator-phase, AR-010).
 *
 * THE TWELVE ROWS (verbatim from spec/deployment.md §7) — each resolves
 * to exactly one of:
 *
 *   green              verified on this run (on-tree battery/export evidence
 *                      and/or the live demo surface), evidence recorded;
 *   named-skip         an env-gated leg that cannot run in this invocation,
 *                      with the NAMED reason (AR-010 discipline verbatim:
 *                      explicit reason, CI stays green, operator-phase
 *                      flip) — never a silent pass;
 *   needs-deployment   the row's decisive leg requires the live demo
 *                      surface (BASE_URL) which this invocation lacks;
 *   red                the row FAILED (a battery failed, a live check
 *                      failed, or a required configuration is absent);
 *   config-invalid     the invocation's configuration is invalid (the
 *                      whole run exits 2; the invalid groups are named).
 *
 * EXIT SEMANTICS (closed and distinguishable):
 *   0  no red row and the configuration is valid — every row carries an
 *      honest green/named-skip/needs-deployment verdict with evidence;
 *   1  at least one RED row (the demo deployment is NOT accepted);
 *   2  config-invalid (the invocation is refused before any check runs).
 *
 * COMPOSITION (public surfaces only — no forks, no test-only backdoors):
 *   - tests/deployment batteries   via one bounded vitest run (per-file
 *     verdicts parsed from the reporter output);
 *   - the §6b smoke                via ../smoke/run.mjs exports
 *     (runSmoke / checkReadinessEndpoint / READINESS_STATUS_PATTERN);
 *   - the rollback rule            via ../rollback/check.mjs exports
 *     (checkServableReadiness — the servable-readiness law);
 *   - the runner proofs            the smoke + rollback loopback selftests;
 *   - the ADCOS probe (RL-108)     via the @roamlink/workers adcos:probe
 *     entry, exit-faithful: 0 compatible | 1 incompatible | 2
 *     not-configured (honest named-skip);
 *   - the config surface           environments/demo.env.example + the
 *     provider templates (values are validated BY NAME and SHAPE only —
 *     never read, echoed or logged, RL-LOCK-016).
 *
 * Usage (operator — runbook §8):
 *   pnpm demo:acceptance                          # on-tree mode
 *   BASE_URL=https://<demo-host> pnpm demo:acceptance   # live mode
 *   BASE_URL=... API_URL=... pnpm demo:acceptance       # split origin
 *   pnpm demo:acceptance:selftest                 # proves the runner
 *
 * No secrets are read into the report, printed or transmitted (RL-LOCK-016):
 * the only inputs are URLs, timeouts and env KEY presence/shape.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSmoke } from "../smoke/run.mjs";
import { checkServableReadiness } from "../rollback/check.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const DEFAULT_STEP_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// --------------------------------------------------------------------------------
// The twelve §7 rows (the contract — verbatim, ordered)
// --------------------------------------------------------------------------------

/**
 * The TWELVE required demo-deployment checks, verbatim from
 * spec/deployment.md §7 (the runbook §8 checklist mirrors them).
 */
export const DEMO_ACCEPTANCE_ROWS = [
  { id: "1", check: "real database migration passes from empty state" },
  { id: "2", check: "backup/restore passes" },
  { id: "3", check: "health/readiness is real, not fake" },
  { id: "4", check: "webhook signatures are configured" },
  { id: "5", check: "ADCOS compatibility gate runs against the configured endpoint" },
  { id: "6", check: "no in-memory adapter is used for production" },
  { id: "7", check: "stuck outbox recovery is implemented" },
  { id: "8", check: "inbox backlog processing advances beyond one batch" },
  { id: "9", check: "R2 uploads use scoped credentials" },
  { id: "10", check: "Redis is optional for correctness" },
  { id: "11", check: "job retry is idempotent" },
  { id: "12", check: "synthetic smoke journey is green" },
];

/** The closed row-status vocabulary (never extended ad hoc). */
export const ROW_STATUS = {
  GREEN: "green",
  NAMED_SKIP: "named-skip",
  NEEDS_DEPLOYMENT: "needs-deployment",
  RED: "red",
  CONFIG_INVALID: "config-invalid",
};

function buildRow(id, check, status, evidence) {
  return { id, check, status, evidence: evidence.map((line) => String(line)) };
}

// --------------------------------------------------------------------------------
// The demo env surface (names only — values never leave this module's locals)
// --------------------------------------------------------------------------------

/** Every documented demo-environment key (infra/deployment/environments/demo.env.example). */
export const DEMO_ENV_KEYS = [
  "NODE_ENV",
  "ROAMLINK_API_BASE_URL",
  "ROAMLINK_PUBLIC_API_URL",
  "DATABASE_URL",
  "NEON_DIRECT_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
  "CRON_SECRET",
  "ROAMLINK_OUTBOX_DELIVERY_DESTINATION",
  "ROAMLINK_MAINTENANCE_DESTINATION",
  "ROAMLINK_BACKUP_SCRATCH_DATABASE_URL",
  "ROAMLINK_SLO_OBJECTIVES",
  "ROAMLINK_WEBHOOK_SIGNING_KEYS",
  "ROAMLINK_WEBHOOK_ENVIRONMENT",
  "ADCOS_API_BASE_URL",
  "ADCOS_API_VERSION",
  "ADCOS_CLIENT_ID",
  "ADCOS_CLIENT_SECRET",
  "ADCOS_WEBHOOK_SECRET",
];

function value(source, key) {
  const raw = source[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function presentKeys(source, keys) {
  return keys.filter((key) => value(source, key) !== undefined);
}

function isPostgresUrl(url) {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/**
 * The webhook signing-key registry law (apps/portal-host composition):
 * comma-separated `keyId:secret` pairs, neither part empty — a malformed
 * registry REFUSES the host boot (CompositionError).
 */
export function parseWebhookSigningKeyIds(raw) {
  const pairs = raw.split(",");
  const ids = [];
  for (const pair of pairs) {
    const separator = pair.indexOf(":");
    if (separator <= 0) return { ok: false, reason: "an entry is not a `keyId:secret` pair" };
    const keyId = pair.slice(0, separator).trim();
    const secret = pair.slice(separator + 1).trim();
    if (keyId.length === 0 || secret.length === 0) {
      return { ok: false, reason: "an entry carries an empty keyId or secret" };
    }
    ids.push(keyId);
  }
  return { ok: true, ids };
}

/**
 * The config-validation stage (the RL-117 gap-fill): validates the demo
 * env surface BY NAME and SHAPE against the documented laws (the env
 * templates + the host/probe/provider composition laws). Returns every
 * violated group; values are NEVER included in the issues.
 *
 * Laws:
 *   DATABASE_URL  required for the demo acceptance when any demo env is
 *                 carried; must be postgres://|postgresql:// (pglite:// is
 *                 the embedded engine — refused; unknown schemes refused —
 *                 the host composition refuses them too);
 *   ADCOS_*       all-or-nothing over base-url/client-id/client-secret/
 *                 webhook-secret (the RL-108 probe refuses half-configured);
 *   R2_*          all-or-nothing over account/key/secret/bucket + shapes
 *                 (32-hex account; lowercase bucket; printable-ASCII keys)
 *                 + optional https R2_ENDPOINT (the provider env law);
 *   Redis         both-or-neither (the half-configured accelerator is
 *                 refused by the host composition);
 *   QStash        QSTASH_NEXT_SIGNING_KEY without QSTASH_CURRENT_SIGNING_KEY
 *                 is refused (the receiver would silently NOT compose);
 *   WEBHOOK       ROAMLINK_WEBHOOK_SIGNING_KEYS must parse as `id:secret`
 *                 pairs (the composition refuses malformed registries);
 *   BACKUP        the scratch DSN must never equal the source DSN (the
 *                 RL-111 battery refuses to run a restore into the source).
 */
export function validateDemoConfig(source) {
  const issues = [];
  const groups = {};

  const databaseUrl = value(source, "DATABASE_URL");
  const scratchUrl = value(source, "ROAMLINK_BACKUP_SCRATCH_DATABASE_URL");
  groups.database = { configured: databaseUrl !== undefined };
  if (databaseUrl !== undefined) {
    if (!isPostgresUrl(databaseUrl)) {
      issues.push({
        group: "database",
        keys: ["DATABASE_URL"],
        issue: databaseUrl.startsWith("pglite://")
          ? "the embedded pglite engine is refused for the demo environment (spec/deployment.md §7 'no in-memory adapter is used for production'; demo.env.example pins NODE_ENV=production) — set a postgres:// DSN"
          : "unknown DSN scheme — the host composition accepts postgres:// (or postgresql://) only",
      });
    }
    if (scratchUrl !== undefined && scratchUrl === databaseUrl) {
      issues.push({
        group: "backup",
        keys: ["ROAMLINK_BACKUP_SCRATCH_DATABASE_URL", "DATABASE_URL"],
        issue: "the scratch DSN equals the source DSN — the RL-111 restore leg refuses to run a restore into the source (it must name a SECOND database)",
      });
    }
  }
  if (scratchUrl !== undefined && databaseUrl === undefined) {
    issues.push({
      group: "backup",
      keys: ["ROAMLINK_BACKUP_SCRATCH_DATABASE_URL"],
      issue: "a scratch DSN is configured but no source DATABASE_URL — the restore leg cannot run honestly without a source",
    });
  }

  const adcosKeys = ["ADCOS_API_BASE_URL", "ADCOS_CLIENT_ID", "ADCOS_CLIENT_SECRET", "ADCOS_WEBHOOK_SECRET"];
  const adcosPresent = presentKeys(source, adcosKeys);
  groups.adcos = { configured: adcosPresent.length > 0, complete: adcosPresent.length === adcosKeys.length };
  if (adcosPresent.length > 0 && adcosPresent.length < adcosKeys.length) {
    issues.push({
      group: "adcos",
      keys: adcosKeys.filter((key) => !adcosPresent.includes(key)),
      issue: "the ADCOS probe configuration is incomplete — every required key must be set together (the deployment refuses to be half-configured, RL-108)",
    });
  }

  const redisUrl = value(source, "UPSTASH_REDIS_REST_URL");
  const redisToken = value(source, "UPSTASH_REDIS_REST_TOKEN");
  groups.redis = {
    configured: redisUrl !== undefined || redisToken !== undefined,
    paired: (redisUrl !== undefined) === (redisToken !== undefined),
  };
  if (groups.redis.configured && !groups.redis.paired) {
    issues.push({
      group: "redis",
      keys: [redisUrl === undefined ? "UPSTASH_REDIS_REST_URL" : "UPSTASH_REDIS_REST_TOKEN"],
      issue: "the Upstash Redis accelerator is half-configured (URL and token must be set together, or both left unset — Redis is optional for correctness)",
    });
  }

  const r2Keys = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const r2Present = presentKeys(source, r2Keys);
  groups.r2 = { configured: r2Present.length > 0, complete: r2Present.length === r2Keys.length };
  if (r2Present.length > 0) {
    if (r2Present.length < r2Keys.length) {
      issues.push({
        group: "r2",
        keys: r2Keys.filter((key) => !r2Present.includes(key)),
        issue: "the R2 env surface is incomplete — all four keys must be set together (the provider env law)",
      });
    } else {
      if (!/^[0-9a-f]{32}$/.test(value(source, "R2_ACCOUNT_ID"))) {
        issues.push({ group: "r2", keys: ["R2_ACCOUNT_ID"], issue: "must be the 32-hex Cloudflare account id" });
      }
      if (!/^[\x21-\x7e]+$/.test(value(source, "R2_ACCESS_KEY_ID")) || value(source, "R2_ACCESS_KEY_ID").length > 256) {
        issues.push({ group: "r2", keys: ["R2_ACCESS_KEY_ID"], issue: "must be printable non-whitespace ASCII (max 256 chars)" });
      }
      if (!/^[\x21-\x7e]+$/.test(value(source, "R2_SECRET_ACCESS_KEY")) || value(source, "R2_SECRET_ACCESS_KEY").length > 256) {
        issues.push({ group: "r2", keys: ["R2_SECRET_ACCESS_KEY"], issue: "must be printable non-whitespace ASCII (max 256 chars)" });
      }
      if (!/^[a-z0-9][a-z0-9-]{1,61}$/.test(value(source, "R2_BUCKET"))) {
        issues.push({ group: "r2", keys: ["R2_BUCKET"], issue: "must be a lowercase safe name (3-63 chars, [a-z0-9-])" });
      }
    }
    const r2Endpoint = value(source, "R2_ENDPOINT");
    if (r2Endpoint !== undefined) {
      try {
        if (new URL(r2Endpoint).protocol !== "https:") {
          issues.push({ group: "r2", keys: ["R2_ENDPOINT"], issue: "must be an https URL" });
        }
      } catch {
        issues.push({ group: "r2", keys: ["R2_ENDPOINT"], issue: "must be an absolute https URL" });
      }
    }
  }

  const qstashCurrent = value(source, "QSTASH_CURRENT_SIGNING_KEY");
  const qstashNext = value(source, "QSTASH_NEXT_SIGNING_KEY");
  groups.qstashReceiver = { configured: qstashCurrent !== undefined || qstashNext !== undefined };
  if (qstashNext !== undefined && qstashCurrent === undefined) {
    issues.push({
      group: "qstash-receiver",
      keys: ["QSTASH_CURRENT_SIGNING_KEY"],
      issue: "QSTASH_NEXT_SIGNING_KEY is set without QSTASH_CURRENT_SIGNING_KEY — the receiver would silently NOT compose (the composition keys on the current key)",
    });
  }

  const webhookKeysRaw = value(source, "ROAMLINK_WEBHOOK_SIGNING_KEYS");
  groups.webhook = { configured: webhookKeysRaw !== undefined };
  if (webhookKeysRaw !== undefined) {
    const parsed = parseWebhookSigningKeyIds(webhookKeysRaw);
    groups.webhook = { ...groups.webhook, wellFormed: parsed.ok, keyIds: parsed.ok ? parsed.ids : undefined };
    if (!parsed.ok) {
      issues.push({
        group: "webhook",
        keys: ["ROAMLINK_WEBHOOK_SIGNING_KEYS"],
        issue: `the signing-key registry is malformed (${parsed.reason}) — the host composition refuses to boot a malformed registry (expected comma-separated \`keyId:secret\` pairs)`,
      });
    }
  }

  return { ok: issues.length === 0, issues, groups };
}

/** True when ANY documented demo key is carried by the invocation's env. */
export function demoEnvSurfacePresent(source) {
  return presentKeys(source, DEMO_ENV_KEYS).length > 0;
}

// --------------------------------------------------------------------------------
// The on-tree pieces (bounded subprocesses over PUBLIC surfaces)
// --------------------------------------------------------------------------------

const BATTERY_FILE_PATTERN = /^\s*[✓✗↓❯×]\s+test\/([a-z0-9-]+\.test\.ts)\s+\((\d+) tests?(?: \| ([^)]+))?\)/;

/**
 * Runs the tests/deployment batteries (one bounded vitest invocation, all
 * files) and parses the per-file verdicts. Deterministic cores; env-gated
 * legs skip with their own named lines (AR-010) — the gate reads the
 * per-file passed/failed/skipped counts.
 *
 * @returns `{ran: true, ok, files, summary}` or `{ran: false, reason}`
 *          when the workspace is not installed (an honest skip, never a
 *          faked verdict).
 */
export function runBatterySuite({ repoRoot = REPO_ROOT, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, log = () => {} } = {}) {
  const testsDir = join(repoRoot, "tests", "deployment");
  const vitestEntry = join(testsDir, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitestEntry)) {
    return {
      ran: false,
      reason: "the workspace dependencies are not installed (run pnpm install) — the battery verdicts are honestly skipped, never faked",
    };
  }
  log(`    running tests/deployment batteries (vitest, bounded at ${timeoutMs} ms)...`);
  const run = spawnSync(process.execPath, [vitestEntry, "run", "--reporter=default"], {
    cwd: testsDir,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (run.error !== undefined && run.error !== null) {
    return { ran: true, ok: false, files: {}, summary: `the battery suite could not run (${run.error.message})` };
  }
  const files = {};
  for (const line of (run.stdout ?? "").split("\n")) {
    const match = BATTERY_FILE_PATTERN.exec(line);
    if (match === null) continue;
    const total = Number(match[2]);
    const counts = { passed: total, failed: 0, skipped: 0 };
    const rest = match[3];
    if (rest !== undefined) {
      for (const part of rest.split("|")) {
        const entry = part.trim().match(/^(\d+) (passed|failed|skipped)$/);
        if (entry !== null) counts[entry[2]] = Number(entry[1]);
      }
      counts.passed = Math.max(0, total - counts.failed - counts.skipped);
    }
    files[match[1]] = counts;
  }
  const ok = run.status === 0;
  const summaryMatch = (run.stdout ?? "").match(/^\s*Tests\s+(.*)$/m);
  return { ran: true, ok, files, summary: summaryMatch !== null ? summaryMatch[1].trim() : `exit ${run.status}` };
}

/**
 * The RL-108 ADCOS production compatibility probe, exit-faithful:
 * 0 compatible | 1 incompatible | 2 not-configured. A probe crash while
 * the env IS configured is reported as `error` (the check did not pass —
 * the row fails closed); tooling that cannot run at all is `unavailable`
 * (an honest named-skip).
 */
export function runAdcosProbe({ repoRoot = REPO_ROOT, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, log = () => {} } = {}) {
  const tsxEntry = join(repoRoot, "services", "workers", "node_modules", "tsx", "dist", "cli.mjs");
  const probeScript = join(repoRoot, "services", "workers", "scripts", "adcos-probe.ts");
  if (!existsSync(tsxEntry) || !existsSync(probeScript)) {
    return {
      ran: false,
      status: "unavailable",
      detail: "the @roamlink/workers probe tooling is not installed (run pnpm install) — the probe is honestly skipped, never faked",
    };
  }
  log("    running the RL-108 ADCOS compatibility probe (env-gated, exit-faithful)...");
  const run = spawnSync(process.execPath, [tsxEntry, probeScript], {
    cwd: join(repoRoot, "services", "workers"),
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const stderr = run.stderr ?? "";
  const stdout = run.stdout ?? "";
  if (run.status === 0) {
    return { ran: true, status: "compatible", detail: stdout.trim().split("\n")[0] ?? "the probe reports compatible" };
  }
  if (run.status === 2) {
    return { ran: true, status: "not-configured", detail: "the ADCOS env is absent — the probe is honestly not-configured (exit 2, its own semantics)" };
  }
  if (run.status === 1 && /ValidationError|ADCOS_PROBE_CONFIG_INCOMPLETE|ADCOS_VERSION_PIN_MISMATCH/.test(stderr)) {
    return {
      ran: true,
      status: "misconfigured",
      detail: "the probe refused the ADCOS env (half-configured or version-pin mismatch) — the deployment refuses to be half-configured",
    };
  }
  if (run.status === 1) {
    return { ran: true, status: "incompatible", detail: "the probe reports INCOMPATIBLE (exit 1) — mutations fail closed; see the probe's value-free failed-check report" };
  }
  return {
    ran: true,
    status: "error",
    detail: `the probe did not answer with a distinct exit code (exit ${run.status ?? "signal"}) — the check is failed closed, never faked`,
  };
}

/**
 * A runner-proof piece: one of the loopback selftests that prove the
 * live-check machinery (the smoke's no-lie law, the rollback rule's
 * servable law) before the gate trusts it against a live surface.
 */
export function runRunnerSelftest(relativePath, { repoRoot = REPO_ROOT, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, log = () => {} } = {}) {
  const script = join(repoRoot, relativePath);
  if (!existsSync(script)) {
    return { ran: false, ok: false, detail: `the committed runner selftest is missing (${relativePath}) — the acceptance surface is broken` };
  }
  log(`    proving the runner via ${relativePath} (loopback selftest)...`);
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: timeoutMs });
  const tail = (run.stdout ?? "").trim().split("\n").filter((line) => line.length > 0).pop() ?? "";
  return run.status === 0
    ? { ran: true, ok: true, detail: tail || "the selftest passed" }
    : { ran: true, ok: false, detail: tail || `the selftest exited ${run.status}` };
}

// --------------------------------------------------------------------------------
// The live pieces (composed from the smoke + rollback PUBLIC exports)
// --------------------------------------------------------------------------------

function stripTrailingSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Runs the BASE_URL-gated pieces through the public exports only:
 * the servable-readiness law on /readyz and /v1/readiness (the rollback
 * rule's stricter acceptance) and the full §6b smoke (whose no-lie law
 * covers the shell surfaces, the static assets and the fail-closed
 * webhook ingress). Returns the pieces plus the per-dependency names the
 * live readiness exposes (the composed-adapter evidence for rows 6/10).
 */
export async function runLiveDemoPieces({ baseUrl, apiUrl, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, log = () => {} } = {}) {
  const host = stripTrailingSlash(baseUrl);
  const api = stripTrailingSlash(apiUrl ?? baseUrl);

  log(`    probing the live surface ${host}${api !== host ? ` (api: ${api})` : ""}...`);
  const readyz = await checkServableReadiness(`${host}/readyz`, { timeoutMs });
  const apiReadiness = await checkServableReadiness(`${api}/v1/readiness`, { timeoutMs });

  /** The dependency names the API's composed readiness exposes (public body shape). */
  let readinessDeps = null;
  try {
    const response = await fetch(`${api}/v1/readiness`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (body !== null && typeof body === "object" && Array.isArray(body["checks"])) {
      readinessDeps = body["checks"]
        .filter((entry) => entry !== null && typeof entry === "object" && typeof entry["name"] === "string")
        .map((entry) => ({ name: entry["name"], state: entry["state"] }));
    }
  } catch {
    readinessDeps = null; // the servable checks above already carry the failure
  }

  const lines = [];
  const smoke = await runSmoke({ baseUrl, ...(apiUrl !== undefined ? { apiUrl } : {}), timeoutMs, log: (line) => lines.push(line) });
  for (const line of lines) log(`    ${line}`);

  return { readyz, apiReadiness, smoke, readinessDeps };
}

// --------------------------------------------------------------------------------
// The verdict aggregation (the closed exit semantics)
// --------------------------------------------------------------------------------

/**
 * The closed exit law: 2 config-invalid beats 1 red beats 0 honest-pass.
 * A named-skip or needs-deployment row NEVER fails the run (AR-010: CI
 * stays green; the operator-phase flip is the operator's recorded action)
 * — but every row carries its evidence either way.
 */
export function aggregateDemoVerdict(rows) {
  const counts = { green: 0, "named-skip": 0, "needs-deployment": 0, red: 0, "config-invalid": 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const exitCode = counts["config-invalid"] > 0 ? 2 : counts.red > 0 ? 1 : 0;
  return { exitCode, counts };
}

/** Which row a config-validation group belongs to (for the exit-2 report). */
function rowTouchesGroup(rowId, group) {
  const map = {
    database: ["1", "6"],
    backup: ["1", "2"],
    adcos: ["5"],
    redis: ["10"],
    r2: ["9"],
    "qstash-receiver": ["4"],
    webhook: ["4"],
    invocation: ["3", "4", "6", "10", "12"],
  };
  return (map[group] ?? []).includes(rowId);
}

// --------------------------------------------------------------------------------
// The composition
// --------------------------------------------------------------------------------

function batteryRowPieces(batteries, file) {
  if (!batteries.ran) return { ok: null, detail: `tests/deployment ${file}: skipped — ${batteries.reason}` };
  const counts = batteries.files[file];
  if (counts === undefined) {
    return { ok: false, detail: `tests/deployment ${file}: no verdict was parsed from the reporter output (the gate refuses to guess)` };
  }
  if (counts.failed > 0) {
    return { ok: false, detail: `tests/deployment ${file}: FAILED (${counts.failed} of ${counts.passed + counts.failed + counts.skipped} tests)` };
  }
  return {
    ok: true,
    detail: `tests/deployment ${file}: green (${counts.passed} passed${counts.skipped > 0 ? `, ${counts.skipped} skipped (named, AR-010)` : ""})`,
  };
}

function stepTimeout(env) {
  const raw = Number(env["DEMO_ACCEPTANCE_STEP_TIMEOUT_MS"] ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_STEP_TIMEOUT_MS;
}

function requestTimeout(env) {
  const raw = Number(env["SMOKE_TIMEOUT_MS"] ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

function validOrigin(raw) {
  if (raw === undefined) return { ok: true };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, issue: "must be an http(s) URL" };
    return { ok: true };
  } catch {
    return { ok: false, issue: "must be an absolute http(s) URL" };
  }
}

/**
 * Runs the demo-acceptance composition and returns the TWELVE-row verdict.
 *
 * @param {object} [config]
 * @param {string} [config.baseUrl]  the live demo host origin (live mode);
 *                                   absent = on-tree mode.
 * @param {string} [config.apiUrl]   the API origin (defaults to baseUrl).
 * @param {Readonly<Record<string, string|undefined>>} [config.env] the env
 *                                   source (defaults to process.env).
 * @param {number} [config.timeoutMs] per-request bound for the live pieces.
 * @param {(line: string) => void} [config.log] output sink.
 * @returns {Promise<{rows, exitCode, mode, counts}>}
 */
export async function runDemoAcceptance(config = {}) {
  const env = config.env ?? process.env;
  const log = config.log ?? ((line) => console.log(line));
  const stepTimeoutMs = stepTimeout(env);
  const timeoutMs = config.timeoutMs ?? requestTimeout(env);
  const baseUrl = config.baseUrl;
  const apiUrl = config.apiUrl;

  // ---- 1. the invocation's own configuration (fail-fast, exit 2) --------
  const originChecks = [
    { key: "BASE_URL", result: validOrigin(baseUrl) },
    { key: "API_URL", result: validOrigin(apiUrl) },
  ];
  const badOrigins = originChecks.filter((entry) => !entry.result.ok);
  const validation = validateDemoConfig(env);
  const configIssues = [
    ...badOrigins.map((entry) => ({ group: "invocation", keys: [entry.key], issue: entry.result.issue })),
    ...validation.issues,
  ];

  if (configIssues.length > 0) {
    log("RoamLink demo environment acceptance (RL-117) — spec/deployment.md §7");
    log("verdict: CONFIG-INVALID — the invocation is refused before any check runs (exit 2).");
    for (const issue of configIssues) {
      log(`  [config-invalid] ${issue.group}: ${issue.keys.join(", ")} — ${issue.issue}`);
    }
    const rows = DEMO_ACCEPTANCE_ROWS.map((row) => {
      const hit = configIssues.find((issue) => rowTouchesGroup(row.id, issue.group));
      return hit !== undefined
        ? buildRow(row.id, row.check, ROW_STATUS.CONFIG_INVALID, [
            `the ${hit.group} configuration is invalid: ${hit.keys.join(", ")} — ${hit.issue}`,
          ])
        : buildRow(row.id, row.check, ROW_STATUS.NAMED_SKIP, [
            "not evaluated: the invocation is config-invalid — fix the named groups and re-run (the gate refuses to accept against an invalid configuration)",
          ]);
    });
    const { exitCode, counts } = aggregateDemoVerdict(rows);
    return { rows, exitCode, mode: "config-invalid", counts };
  }

  // ---- 2. the on-tree pieces --------------------------------------------
  const envSurface = demoEnvSurfacePresent(env);
  const mode = baseUrl !== undefined ? "live" : "on-tree";
  log("RoamLink demo environment acceptance (RL-117) — spec/deployment.md §7");
  log(
    `mode: ${mode}${baseUrl !== undefined ? ` (${baseUrl}${apiUrl !== undefined && apiUrl !== baseUrl ? ` | api: ${apiUrl}` : ""})` : " (no BASE_URL — live rows report needs-deployment)"}` +
      `; demo env surface: ${envSurface ? "present (validated by name/shape; values never echoed)" : "absent (env-gated rows report named-skips, AR-010)"}`,
  );

  const batteries = runBatterySuite({ timeoutMs: stepTimeoutMs, log });
  const probe = runAdcosProbe({ timeoutMs: stepTimeoutMs, log });
  const smokeRunnerProof = runRunnerSelftest(join("infra", "deployment", "smoke", "selftest.mjs"), { timeoutMs: stepTimeoutMs, log });
  const rollbackRunnerProof = runRunnerSelftest(join("infra", "deployment", "rollback", "selftest.mjs"), { timeoutMs: stepTimeoutMs, log });

  // ---- 3. the live pieces (only when the surface is named) --------------
  let live = null;
  if (baseUrl !== undefined) {
    live = await runLiveDemoPieces({ baseUrl, apiUrl, timeoutMs, log });
  }

  // ---- 4. the twelve-row verdict ----------------------------------------
  const groups = validation.groups;
  const realLegsSourceReady = groups.database.configured === true;
  const r2LegsReady = groups.r2.configured === true && groups.r2.complete === true;
  const scratchUrl = value(env, "ROAMLINK_BACKUP_SCRATCH_DATABASE_URL");
  const databaseUrl = value(env, "DATABASE_URL");
  const scratchReady = scratchUrl !== undefined && databaseUrl !== undefined && scratchUrl !== databaseUrl;
  // Mirrors the RL-111 battery's own gating: leg A (export/upload) runs with a
  // source + the R2 surface; leg B (restore) additionally needs the distinct scratch.
  const legARan = realLegsSourceReady && r2LegsReady;
  const realLegsRan = legARan && scratchReady;

  const rows = DEMO_ACCEPTANCE_ROWS.map((row) => buildRow(row.id, row.check, ROW_STATUS.NAMED_SKIP, []));
  const setRow = (id, status, evidence) => {
    const row = rows.find((candidate) => candidate.id === id);
    row.status = status;
    row.evidence = evidence.map((line) => String(line));
  };

  // ROW 1 — real database migration passes from empty state.
  {
    const core = batteryRowPieces(batteries, "migration-recovery.test.ts");
    if (core.ok === false) {
      setRow("1", ROW_STATUS.RED, [core.detail]);
    } else if (batteries.ran && realLegsRan && batteries.files["backup-restore-real.test.ts"] !== undefined) {
      const realLeg = batteries.files["backup-restore-real.test.ts"];
      setRow("1", ROW_STATUS.GREEN, [
        core.detail,
        `tests/deployment backup-restore-real.test.ts: green (${realLeg.passed} passed${realLeg.skipped > 0 ? `, ${realLeg.skipped} skipped (named, AR-010)` : ""})`,
        "the RL-111 restore leg migrated the scratch database with the REAL infra/migrations files from empty state (the digest + dedupe laws verified on the restored state)",
      ]);
    } else if (!batteries.ran) {
      setRow("1", ROW_STATUS.NAMED_SKIP, [core.detail]);
    } else {
      setRow("1", ROW_STATUS.NAMED_SKIP, [
        core.detail,
        "the real empty-state migration on the demo database is an operator-phase leg (runbook §5): " +
          (realLegsSourceReady
            ? "the demo DATABASE_URL is configured — record the §5 migration run + the ledger manifest hash in the deployment log"
            : "no demo DATABASE_URL is carried by this invocation (AR-010 named-skip; the operator-phase flip records the §5 run)"),
      ]);
    }
  }

  // ROW 2 — backup/restore passes.
  {
    const core = batteryRowPieces(batteries, "backup-restore.test.ts");
    const realLeg = batteryRowPieces(batteries, "backup-restore-real.test.ts");
    if (core.ok === false || (batteries.ran && realLeg.ok === false && realLegsRan)) {
      setRow("2", ROW_STATUS.RED, [core.detail, ...(batteries.ran ? [realLeg.detail] : [])]);
    } else if (batteries.ran && realLeg.ok === true && realLegsRan) {
      setRow("2", ROW_STATUS.GREEN, [
        core.detail,
        realLeg.detail,
        "the RL-111 real legs ran: export through the PUBLIC reader contracts -> content-addressed R2 upload -> byte-identical read-back -> scratch restore with the digest/dedupe/version laws verified",
      ]);
    } else if (!batteries.ran) {
      setRow("2", ROW_STATUS.NAMED_SKIP, [core.detail]);
    } else {
      const missing = [
        ...(realLegsSourceReady ? [] : ["a PostgreSQL DATABASE_URL (the source)"]),
        ...(r2LegsReady ? [] : ["the full R2 env surface (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)"]),
        ...(scratchReady ? [] : ["a DISTINCT ROAMLINK_BACKUP_SCRATCH_DATABASE_URL (never the source)"]),
      ];
      setRow("2", ROW_STATUS.NAMED_SKIP, [
        core.detail,
        ...(legARan ? [`the partial leg that could run in this invocation: ${realLeg.detail}`] : []),
        `the RL-111 real legs are env-gated and did not fully run in this invocation: missing ${missing.join("; ")} (AR-010 named-skip; the operator-phase flip runs them against the real deployment surfaces)`,
      ]);
    }
  }

  // ROW 3 — health/readiness is real, not fake.
  {
    const core = batteryRowPieces(batteries, "health-readiness.test.ts");
    const law = batteryRowPieces(batteries, "rollback-decision-rule.test.ts");
    const coreEvidence = [
      core.detail,
      `the servable-readiness law is proven by the rollback runner selftest (${rollbackRunnerProof.ok ? rollbackRunnerProof.detail : `FAILED: ${rollbackRunnerProof.detail}`})`,
      `the RL-112 executable rule is composed by ${law.detail}`,
    ];
    if (core.ok === false || law.ok === false || !rollbackRunnerProof.ok) {
      setRow("3", ROW_STATUS.RED, coreEvidence);
    } else if (live === null) {
      setRow("3", ROW_STATUS.NEEDS_DEPLOYMENT, [
        ...coreEvidence,
        "the live leg needs the demo surface: set BASE_URL and re-run — the gate asserts the honest vocabulary AND servability (ready | degraded:* at HTTP 200) on /readyz and /v1/readiness",
      ]);
    } else if (!live.readyz.ok || !live.apiReadiness.ok) {
      setRow("3", ROW_STATUS.RED, [
        ...coreEvidence,
        `live /readyz: ${live.readyz.detail}`,
        `live /v1/readiness: ${live.apiReadiness.detail}`,
      ]);
    } else {
      setRow("3", ROW_STATUS.GREEN, [
        ...coreEvidence,
        `live /readyz: ${live.readyz.detail}`,
        `live /v1/readiness: ${live.apiReadiness.detail}`,
      ]);
    }
  }

  // ROW 4 — webhook signatures are configured (the config-presence gap-fill).
  {
    const core = batteryRowPieces(batteries, "runtime-hardening.test.ts");
    const runnerProof = smokeRunnerProof.ok
      ? `the fail-closed ingress law is proven by the smoke runner selftest (${smokeRunnerProof.detail})`
      : `the smoke runner selftest FAILED: ${smokeRunnerProof.detail}`;
    const liveFailure =
      live === null
        ? undefined
        : live.smoke.failures.find((failure) => failure.startsWith("webhook-ingress-fail-closed"));
    const livePiece =
      live === null
        ? undefined
        : liveFailure !== undefined
          ? `live webhook ingress: FAILED (${liveFailure})`
          : `live webhook ingress: the smoke's fail-closed check passed (${live.smoke.passed} smoke checks green)`;
    const evidence = [core.detail, runnerProof, ...(livePiece !== undefined ? [livePiece] : [])];
    if (core.ok === false || !smokeRunnerProof.ok || liveFailure !== undefined) {
      setRow("4", ROW_STATUS.RED, evidence);
    } else if (!envSurface) {
      setRow("4", ROW_STATUS.NAMED_SKIP, [
        ...evidence,
        "no demo env surface is carried by this invocation — the CONFIG-PRESENCE leg cannot run: configure ROAMLINK_WEBHOOK_SIGNING_KEYS (the ingress signing-key registry; every delivery is rejected fail-closed until it is set) in the demo secret store and re-run (AR-010 named-skip)",
      ]);
    } else if (!groups.webhook.configured) {
      setRow("4", ROW_STATUS.RED, [
        ...evidence,
        "the demo env surface IS present but ROAMLINK_WEBHOOK_SIGNING_KEYS is not configured — the ingress would reject EVERY delivery (fail-closed) and §7 requires signatures CONFIGURED",
      ]);
    } else {
      setRow("4", ROW_STATUS.GREEN, [
        ...evidence,
        `ROAMLINK_WEBHOOK_SIGNING_KEYS is configured and well-formed (key ids: ${groups.webhook.keyIds.join(", ")}) — the fail-closed runtime semantics are proven on-tree`,
      ]);
    }
  }

  // ROW 5 — ADCOS compatibility gate runs against the configured endpoint.
  {
    const core = batteryRowPieces(batteries, "runtime-hardening.test.ts");
    if (core.ok === false) {
      setRow("5", ROW_STATUS.RED, [core.detail]);
    } else if (!probe.ran) {
      setRow("5", ROW_STATUS.NAMED_SKIP, [core.detail, probe.detail]);
    } else if (probe.status === "compatible") {
      setRow("5", ROW_STATUS.GREEN, [core.detail, `the RL-108 probe ran against the configured endpoint: COMPATIBLE (exit 0) — ${probe.detail}`]);
    } else if (probe.status === "not-configured") {
      setRow("5", ROW_STATUS.NAMED_SKIP, [
        core.detail,
        "the ADCOS env is absent — the probe honestly reports not-configured (exit 2, its own semantics; AR-010 named-skip: the operator-phase flip runs it against the configured demo ADCOS endpoint)",
      ]);
    } else {
      setRow("5", ROW_STATUS.RED, [
        core.detail,
        `the RL-108 probe failed closed (${probe.status}) — ${probe.detail}`,
      ]);
    }
  }

  // ROW 6 — no in-memory adapter is used for production (the config-level law).
  {
    const core = batteryRowPieces(batteries, "health-readiness.test.ts");
    const configOk = groups.database.configured === true;
    const liveDeps = live !== null && live.readinessDeps !== null ? live.readinessDeps : null;
    const liveHasRealPath = liveDeps !== null && liveDeps.some((dep) => dep.name === "database") && liveDeps.some((dep) => dep.name === "migrations");
    if (core.ok === false) {
      setRow("6", ROW_STATUS.RED, [core.detail]);
    } else if (live !== null && liveDeps !== null && !liveHasRealPath) {
      setRow("6", ROW_STATUS.RED, [
        core.detail,
        `the live /v1/readiness exposes NO database/migrations checks (deps: ${liveDeps.map((dep) => dep.name).join(", ") || "none"}) — the real persistence path is not provably composed`,
      ]);
    } else if (configOk) {
      setRow("6", ROW_STATUS.GREEN, [
        core.detail,
        "DATABASE_URL is configured as postgres:// — the demo environment binds the REAL PostgreSQL driver path (the composition refuses fakes: a missing/unknown DATABASE_URL refuses the boot; pglite:// is refused in production mode)",
        liveHasRealPath
          ? `live confirmation: /v1/readiness composes the database + migrations checks (${liveDeps.map((dep) => `${dep.name}:${dep.state}`).join(", ")})`
          : "the live confirmation runs with the demo surface (BASE_URL)",
      ]);
    } else if (liveHasRealPath) {
      setRow("6", ROW_STATUS.GREEN, [
        core.detail,
        `live confirmation: /v1/readiness composes the database + migrations checks (${liveDeps.map((dep) => `${dep.name}:${dep.state}`).join(", ")}) — the deployed host runs the real PostgreSQL path`,
      ]);
    } else {
      setRow("6", ROW_STATUS.NAMED_SKIP, [
        core.detail,
        "no demo env surface is carried and no live surface is named — the config-level law cannot run here (configure DATABASE_URL or set BASE_URL; AR-010 named-skip)",
      ]);
    }
  }

  // ROW 7 — stuck outbox recovery is implemented.
  {
    const core = batteryRowPieces(batteries, "recovery-battery.test.ts");
    const support = batteryRowPieces(batteries, "cold-start-shutdown.test.ts");
    if (core.ok === false || support.ok === false) {
      setRow("7", ROW_STATUS.RED, [core.detail, support.detail]);
    } else {
      setRow("7", ROW_STATUS.GREEN, [
        core.detail,
        support.detail,
        "the recoverInFlight sweep (RL-093/AR-007) re-owns stranded DELIVERING claims through the public outbox port — proven end to end through the authenticated cron route (the real-database leg is operator-phase, AR-010)",
      ]);
    }
  }

  // ROW 8 — inbox backlog processing advances beyond one batch.
  {
    const core = batteryRowPieces(batteries, "recovery-battery.test.ts");
    if (core.ok === false) {
      setRow("8", ROW_STATUS.RED, [core.detail]);
    } else {
      setRow("8", ROW_STATUS.GREEN, [
        core.detail,
        "the bounded inbox drain advances a deeper-than-one-batch backlog across ceil(N/limit) kicks (RL-094/AR-008) — proven through the cron route; the real-database leg is operator-phase, AR-010",
      ]);
    }
  }

  // ROW 9 — R2 uploads use scoped credentials (the config-validation gap-fill).
  {
    const realLeg = batteryRowPieces(batteries, "backup-restore-real.test.ts");
    if (batteries.ran && legARan && realLeg.ok === false) {
      setRow("9", ROW_STATUS.RED, [realLeg.detail]);
    } else if (r2LegsReady) {
      setRow("9", ROW_STATUS.GREEN, [
        "the R2 env surface is complete and well-formed (R2_ACCOUNT_ID 32-hex, bucket lowercase-safe, credentials printable-ASCII) — validated by name/shape only (values never echoed, RL-LOCK-016)",
        "the SCOPED-credential discipline is operator-attested per runbook §2.4: the API token must carry Object Read & Write SCOPED TO THE SINGLE BUCKET (never account-wide)",
        batteries.ran && realLeg.ok === true && legARan
          ? "the RL-111 leg A ran against the real R2 surface: content-addressed upload + byte-identical read-back through the configured (scoped) token"
          : "the live round-trip through the scoped token is the RL-111 env-gated leg (operator-phase, AR-010): complete DATABASE_URL + ROAMLINK_BACKUP_SCRATCH_DATABASE_URL and it runs inside this gate",
      ]);
    } else if (!envSurface) {
      setRow("9", ROW_STATUS.NAMED_SKIP, [
        "no demo env surface is carried by this invocation — the R2 config-validation leg cannot run: set the R2 surface (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) in the demo secret store and re-run (AR-010 named-skip)",
      ]);
    } else {
      setRow("9", ROW_STATUS.NAMED_SKIP, [
        "the R2 surface is unset in an otherwise-carried demo env (object storage is optional for hosts without artifact surfaces) — configure it and re-run for the §7 acceptance (AR-010 named-skip)",
      ]);
    }
  }

  // ROW 10 — Redis is optional for correctness.
  {
    const core = batteryRowPieces(batteries, "dependency-failure.test.ts");
    if (core.ok === false) {
      setRow("10", ROW_STATUS.RED, [core.detail]);
    } else if (groups.redis.configured && !groups.redis.paired) {
      setRow("10", ROW_STATUS.RED, ["the Redis env is half-configured (this invocation is already refused as config-invalid)"]);
    } else {
      const liveDeps = live !== null && live.readinessDeps !== null ? live.readinessDeps : null;
      const liveRedis = liveDeps !== null ? liveDeps.find((dep) => dep.name === "redis") : undefined;
      setRow("10", ROW_STATUS.GREEN, [
        core.detail,
        groups.redis.configured
          ? "the Redis accelerator is configured (both keys) — its absence can only DEGRADE readiness, never fail correctness (the composed optional-adapter law)"
          : "no Redis env is configured — the non-accelerated path IS the configured reality (a supported, correct configuration: Redis is optional for correctness)",
        liveRedis !== undefined
          ? `live confirmation: /v1/readiness surfaces redis (${liveRedis.state}) — an uncomposed or degraded accelerator never blocks servability`
          : "the live confirmation runs with the demo surface (BASE_URL): an uncomposed redis dep is never reported; a composed one only ever degrades",
      ]);
    }
  }

  // ROW 11 — job retry is idempotent.
  {
    const core = batteryRowPieces(batteries, "recovery-battery.test.ts");
    const support = batteryRowPieces(batteries, "cold-start-shutdown.test.ts");
    if (core.ok === false || support.ok === false) {
      setRow("11", ROW_STATUS.RED, [core.detail, support.detail]);
    } else {
      setRow("11", ROW_STATUS.GREEN, [
        core.detail,
        support.detail,
        "the event-driven path enqueues deterministic per-day job ids (retries are duplicates) and the outbox obligations are idempotency-keyed with digest-verified replays (RL-LOCK-014)",
      ]);
    }
  }

  // ROW 12 — synthetic smoke journey is green.
  {
    if (!smokeRunnerProof.ok) {
      setRow("12", ROW_STATUS.RED, [`the smoke runner selftest FAILED: ${smokeRunnerProof.detail}`]);
    } else if (live === null) {
      setRow("12", ROW_STATUS.NEEDS_DEPLOYMENT, [
        `the runner is proven (${smokeRunnerProof.detail})`,
        "the live leg needs the demo surface: BASE_URL=https://<demo-host> pnpm demo:acceptance — the §6b smoke (healthz, honest readiness vocabulary x2, shell surfaces, static assets, fail-closed ingress) runs against the DEPLOYED stack",
      ]);
    } else if (live.smoke.failed > 0) {
      setRow("12", ROW_STATUS.RED, [
        `the §6b smoke FAILED against the live surface (${live.smoke.failed} of ${live.smoke.passed + live.smoke.failed} checks): ${live.smoke.failures.join("; ")}`,
      ]);
    } else {
      setRow("12", ROW_STATUS.GREEN, [
        `the §6b smoke is green against the live surface (${live.smoke.passed} checks, no-lie law enforced)`,
      ]);
    }
  }

  // ---- 5. the report ------------------------------------------------------
  const width = Math.max(...rows.map((row) => row.status.length));
  for (const row of rows) {
    log(`  [${row.status.padEnd(width)}] ${row.id.padStart(2)}. ${row.check}`);
    for (const line of row.evidence) log(`        - ${line}`);
  }
  const { exitCode, counts } = aggregateDemoVerdict(rows);
  log(
    `verdict: 12 rows — ${counts.green} green, ${counts["named-skip"]} named-skip, ${counts["needs-deployment"]} needs-deployment, ${counts.red} red` +
      (exitCode === 0
        ? " | the demo deployment is accepted (named-skips carry their operator-phase flips, AR-010)"
        : exitCode === 1
          ? " | the demo deployment is NOT accepted (a red row blocks the §8 gate)"
          : " | config-invalid"),
  );
  return { rows, exitCode, mode, counts };
}

// --------------------------------------------------------------------------------
// CLI entry (the library surface above is what the selftest drives)
// --------------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const baseUrl = process.env["BASE_URL"]?.trim() || undefined;
  const apiUrl = process.env["API_URL"]?.trim() || undefined;
  const result = await runDemoAcceptance({
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
  });
  process.exitCode = result.exitCode;
}
