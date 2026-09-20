#!/usr/bin/env node
/**
 * The post-rollback state check (RL-112) — the EXECUTABLE deployment-level
 * rollback decision rule (infra/deployment/runbooks/deployment-runbook.md
 * §9 "Rollback"). Not prose-only: THIS script is the gate the runbook
 * requires an operator to run after redeploying the previous SHA.
 *
 * THE DECISION RULE (the migration decision law of §9):
 *   A rollback NEVER auto-runs migrateDown. The rule it pairs with is:
 *     (a) FORWARD-FIX (the default): redeploy the previous application SHA
 *         against the ADDITIVE schema that is already applied; acceptance
 *         requires the post-rollback state to be SERVABLE and TRUTHFUL:
 *           1. healthz: the process answers 200 {status:"alive"};
 *           2. readyz: the honest readiness vocabulary AND SERVABLE —
 *              `ready` or `degraded:<deps>` (HTTP 200). A `not-ready:*`
 *              answer is honestly rendered truth, but the rollback did NOT
 *              restore service -> the check FAILS (this is the stricter
 *              deployment-acceptance rule, on top of the smoke's no-lie
 *              law, which passing vocabulary alone would satisfy);
 *           3. /v1/readiness: the same servability + vocabulary law;
 *           4. the §6b synthetic smoke runs GREEN (every check, including
 *              the no-lie law over the surfaces and the fail-closed
 *              webhook ingress);
 *     (b) DELIBERATE DOWN-MIGRATION (the exception): when the rollback
 *         MUST shed an applied migration, the down-migration is an
 *         operator-commanded maintenance action run via
 *         `pnpm --filter @roamlink/persistence-postgres db:rollback -- <target>`
 *         — never an automatic step — because the RL-112 round-trip
 *         (packages/persistence-postgres test/rollback-roundtrip.test.ts)
 *         proves the baseline down migrations DROP the data tables (the
 *         honest non-survivable case). It therefore pairs with a
 *         restore-from-backup (RL-111) and an explicit maintenance window,
 *         and its acceptance is the SAME post-rollback state check as (a),
 *         run afterwards.
 *
 * Usage (operator):
 *   BASE_URL=https://<host-origin> pnpm rollback:check
 *   BASE_URL=... API_URL=https://<api-origin> pnpm rollback:check
 *
 * Exit codes: 0 the post-rollback state is accepted (health + smoke green);
 * 1 one or more checks FAILED (the rollback is NOT accepted); 2
 * misconfigured invocation (BASE_URL missing). No secrets are read,
 * printed or transmitted (RL-LOCK-016): the only inputs are URLs and a
 * timeout.
 */
import { READINESS_STATUS_PATTERN, checkReadinessEndpoint, runSmoke } from "../smoke/run.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Bounded request helper (every request abort-timed; never throws out). */
async function request(url, { timeoutMs }) {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * The servable-readiness law: the honest vocabulary (via the smoke's
 * no-lie check) AND the deployment actually serves (ready | degraded:*,
 * HTTP 200). A not-ready answer is truthful but NOT an accepted rollback.
 */
export async function checkServableReadiness(url, { timeoutMs }) {
  const vocabulary = await checkReadinessEndpoint(url, { timeoutMs });
  if (!vocabulary.ok) return vocabulary;
  let response;
  try {
    response = await request(url, { timeoutMs });
  } catch {
    return { ok: false, detail: "unreachable on re-read (connection failure or timeout)" };
  }
  let status;
  try {
    status = JSON.parse(response.text)["status"];
  } catch {
    return { ok: false, detail: "the body stopped being JSON on re-read" };
  }
  if (typeof status !== "string" || !READINESS_STATUS_PATTERN.test(status)) {
    return {
      ok: false,
      detail: `the re-read status is outside the honest vocabulary (${JSON.stringify(String(status).slice(0, 64))})`,
    };
  }
  if (status.startsWith("not-ready:")) {
    return {
      ok: false,
      detail: `the deployment answers truthfully but is NOT SERVABLE (${status}; HTTP ${response.status}): the rollback did not restore service — fix before accepting (§9 decision rule)`,
    };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      detail: `servable status ${status} answered with HTTP ${response.status} (expected 200)`,
    };
  }
  return { ok: true, detail: `${vocabulary.detail} — servable, rollback accepted for this endpoint` };
}

/**
 * The full post-rollback state check. Returns the per-check results and
 * the pass/fail counts; the caller (main) turns that into the exit code.
 *
 * @param {object} config
 * @param {string} config.baseUrl  the redeployed host origin
 * @param {string} [config.apiUrl] the API origin (defaults to baseUrl)
 * @param {number} [config.timeoutMs] per-request bound (default 10000)
 * @param {(line: string) => void} [config.log] per-check output sink
 */
export async function checkPostRollbackState(config) {
  const baseUrl = stripTrailingSlash(config.baseUrl);
  const apiUrl = stripTrailingSlash(config.apiUrl ?? config.baseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = config.log ?? ((line) => console.log(line));

  const checks = [
    {
      name: "healthz-liveness",
      run: async () => {
        let response;
        try {
          response = await request(`${baseUrl}/healthz`, { timeoutMs });
        } catch {
          return { ok: false, detail: "unreachable (connection failure or timeout)" };
        }
        if (response.status !== 200) return { ok: false, detail: `expected 200, got ${response.status}` };
        let body;
        try {
          body = JSON.parse(response.text);
        } catch {
          return { ok: false, detail: "the body is not JSON" };
        }
        return body["status"] === "alive"
          ? { ok: true, detail: "the redeployed process answers alive" }
          : { ok: false, detail: `expected status "alive", got ${JSON.stringify(body["status"])}` };
      },
    },
    {
      name: "readyz-servable",
      run: () => checkServableReadiness(`${baseUrl}/readyz`, { timeoutMs }),
    },
    {
      name: "api-readiness-servable",
      run: () => checkServableReadiness(`${apiUrl}/v1/readiness`, { timeoutMs }),
    },
    {
      name: "synthetic-smoke",
      run: async () => {
        const lines = [];
        const result = await runSmoke({
          baseUrl: config.baseUrl,
          ...(config.apiUrl !== undefined ? { apiUrl: config.apiUrl } : {}),
          timeoutMs,
          log: (line) => lines.push(line),
        });
        for (const line of lines) log(`    ${line}`);
        return result.failed === 0
          ? { ok: true, detail: `the §6b smoke journey is green (${result.passed} checks)` }
          : {
              ok: false,
              detail: `the §6b smoke journey FAILED (${result.failed} of ${result.passed + result.failed} checks): ${result.failures.join("; ")}`,
            };
      },
    },
  ];

  let passed = 0;
  const failures = [];
  for (const check of checks) {
    let outcome;
    try {
      outcome = await check.run();
    } catch (error) {
      outcome = {
        ok: false,
        detail: `the check itself threw (${error instanceof Error ? error.name : "unknown"})`,
      };
    }
    if (outcome.ok) {
      passed += 1;
      log(`[ok]   ${check.name}: ${outcome.detail}`);
    } else {
      failures.push(`${check.name}: ${outcome.detail}`);
      log(`[FAIL] ${check.name}: ${outcome.detail}`);
    }
  }
  return { passed, failed: checks.length - passed, failures };
}

function stripTrailingSlash(origin) {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

// --------------------------------------------------------------------------------
// The entry point (env-driven; exit-faithful)
// --------------------------------------------------------------------------------

async function main() {
  const baseUrl = process.env["BASE_URL"]?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    console.error("rollback:check is misconfigured: BASE_URL is required (the redeployed host origin)");
    process.exitCode = 2;
    return;
  }
  const apiUrl = process.env["API_URL"]?.trim();
  const timeoutMs = Number(process.env["SMOKE_TIMEOUT_MS"] ?? "") || DEFAULT_TIMEOUT_MS;
  console.log(
    `RoamLink post-rollback state check (RL-112 §9): ${baseUrl}${apiUrl !== undefined && apiUrl !== baseUrl ? ` (api: ${apiUrl})` : ""}`,
  );
  const result = await checkPostRollbackState({
    baseUrl,
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    timeoutMs,
  });
  console.log(`post-rollback summary: ${result.passed} passed, ${result.failed} failed`);
  process.exitCode = result.failed === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1] === new URL(import.meta.url).pathname ||
    process.argv[1]?.endsWith("infra/deployment/rollback/check.mjs"));
if (invokedDirectly) {
  await main();
}
