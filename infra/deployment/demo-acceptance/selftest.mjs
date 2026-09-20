#!/usr/bin/env node
/**
 * The demo-acceptance gate's selftest (RL-117): proves the RUNNER, not a
 * deployment. Deterministic, loopback-only, no real infrastructure: the
 * only network touched is in-process loopback stubs (the same discipline
 * as the smoke and rollback selftests). Asserts:
 *
 *  - the TWELVE-row contract is the verbatim spec/deployment.md §7 list;
 *  - the exit semantics are closed and distinguishable: all-honest -> 0,
 *    one red row -> 1, config-invalid -> 2 (config-invalid wins);
 *  - the config-validation laws (the RL-117 gap-fill): the ADCOS/R2
 *    all-or-nothing surfaces, the Redis both-or-neither law, the
 *    pglite:// refusal, the malformed webhook-registry refusal, the
 *    scratch-equals-source refusal, the QStash next-without-current
 *    refusal — every issue names KEYS, never values (RL-LOCK-016);
 *  - THE NO-FAKE-SUCCESS PIN: against an HONEST loopback deployment the
 *    gate exits 0 with the live rows green; SABOTAGE the deployment (a
 *    `ready` claim over a down dependency — the exact lie the §6b smoke
 *    exists to catch) and the verdict MUST FLIP to exit 1 with the lying
 *    rows named red;
 *  - a config-invalid invocation is REFUSED before any check runs (exit 2);
 *  - every row of every run carries non-empty evidence — never a
 *    silently-passing row;
 *  - the root scripts are wired (pnpm demo:acceptance / :selftest).
 *
 * Run: node infra/deployment/demo-acceptance/selftest.mjs   (exit 0 = pass)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  DEMO_ACCEPTANCE_ROWS,
  ROW_STATUS,
  aggregateDemoVerdict,
  demoEnvSurfacePresent,
  parseWebhookSigningKeyIds,
  runDemoAcceptance,
  validateDemoConfig,
} from "./check.mjs";

// --------------------------------------------------------------------------------
// Loopback stubs (mirrors the smoke selftest's honest/lying deployments)
// --------------------------------------------------------------------------------

function startStub(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub.local");
    const route = routes.find((candidate) => candidate.method === request.method && candidate.path === url.pathname);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no route" }));
      return;
    }
    route.answer(request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((close) => server.close(close)) });
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, status, location) {
  res.writeHead(status, { location });
  res.end();
}

const LOGIN_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/shell.css"><title>RoamLink - Sign in</title></head><body><h2>Sign in</h2><form method="POST" action="/auth/session"><label>Email<input id="email" name="email" type="email"></label><label>Password<input id="password" name="password" type="password"></label><button>Sign in</button></form></body></html>`;

/** The composed readiness body of an HONEST demo host (database + migrations REQUIRED, rate-limit optional). */
const HONEST_READY = {
  status: "ready",
  ready: true,
  checks: [
    { name: "database", state: "healthy", detail: "pooled connection answers" },
    { name: "migrations", state: "healthy", detail: "4 migration(s) applied" },
    { name: "rate-limit", state: "healthy" },
  ],
};

/** THE LIE: a `ready` claim over a down dependency (the no-fake-success target). */
const LYING_READY = {
  status: "ready",
  ready: true,
  checks: [{ name: "database", state: "down", detail: "connection refused" }],
};

function routesFor(readyBody) {
  const code = readyBody.status.startsWith("not-ready:") ? 503 : 200;
  return [
    { method: "GET", path: "/healthz", answer: (_req, res) => send(res, 200, { status: "alive" }) },
    { method: "GET", path: "/readyz", answer: (_req, res) => send(res, code, readyBody) },
    { method: "GET", path: "/v1/readiness", answer: (_req, res) => send(res, code, readyBody) },
    { method: "GET", path: "/", answer: (_req, res) => redirect(res, 303, "/login") },
    { method: "GET", path: "/login", answer: (_req, res) => sendHtml(res, 200, LOGIN_HTML) },
    { method: "GET", path: "/admin", answer: (_req, res) => redirect(res, 303, "/login") },
    { method: "GET", path: "/_next/static/shell.css", answer: (_req, res) => sendHtml(res, 200, "body{color:#333}") },
    { method: "POST", path: "/v1/webhooks/adcos", answer: (_req, res) => send(res, 401, { outcome: "REJECTED", code: "webhook-signature-invalid" }) },
  ];
}

// --------------------------------------------------------------------------------
// The checks
// --------------------------------------------------------------------------------

let passed = 0;
const failures = [];
async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`[ok]   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("the twelve-row contract is the verbatim spec/deployment.md §7 list", async () => {
  assert.equal(DEMO_ACCEPTANCE_ROWS.length, 12);
  assert.deepEqual(
    DEMO_ACCEPTANCE_ROWS.map((row) => row.id),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
  );
  assert.deepEqual(
    DEMO_ACCEPTANCE_ROWS.map((row) => row.check),
    [
      "real database migration passes from empty state",
      "backup/restore passes",
      "health/readiness is real, not fake",
      "webhook signatures are configured",
      "ADCOS compatibility gate runs against the configured endpoint",
      "no in-memory adapter is used for production",
      "stuck outbox recovery is implemented",
      "inbox backlog processing advances beyond one batch",
      "R2 uploads use scoped credentials",
      "Redis is optional for correctness",
      "job retry is idempotent",
      "synthetic smoke journey is green",
    ],
  );
});

await check("the exit semantics are closed: all-honest 0, one-red 1, config-invalid 2 (it wins)", async () => {
  const row = (status) => ({ id: "1", check: "x", status, evidence: ["e"] });
  const statuses = Object.values(ROW_STATUS);
  assert.deepEqual([...new Set(statuses)].sort(), ["config-invalid", "green", "named-skip", "needs-deployment", "red"].sort());
  assert.equal(aggregateDemoVerdict(DEMO_ACCEPTANCE_ROWS.map(() => row(ROW_STATUS.GREEN))).exitCode, 0);
  assert.equal(aggregateDemoVerdict(DEMO_ACCEPTANCE_ROWS.map(() => row(ROW_STATUS.NAMED_SKIP))).exitCode, 0);
  assert.equal(aggregateDemoVerdict(DEMO_ACCEPTANCE_ROWS.map(() => row(ROW_STATUS.NEEDS_DEPLOYMENT))).exitCode, 0);
  const withRed = DEMO_ACCEPTANCE_ROWS.map(() => row(ROW_STATUS.GREEN));
  withRed[4].status = ROW_STATUS.RED;
  assert.equal(aggregateDemoVerdict(withRed).exitCode, 1);
  const withInvalid = DEMO_ACCEPTANCE_ROWS.map(() => row(ROW_STATUS.GREEN));
  withInvalid[0].status = ROW_STATUS.RED;
  withInvalid[5].status = ROW_STATUS.CONFIG_INVALID;
  assert.equal(aggregateDemoVerdict(withInvalid).exitCode, 2, "config-invalid wins over red");
});

await check("config laws: absent env is valid; a carried env is validated by name/shape", async () => {
  assert.equal(validateDemoConfig({}).ok, true);
  assert.equal(demoEnvSurfacePresent({}), false);
  assert.equal(demoEnvSurfacePresent({ DATABASE_URL: "postgres://x" }), true);

  const good = validateDemoConfig({
    DATABASE_URL: "postgres://demo.example/db",
    ROAMLINK_BACKUP_SCRATCH_DATABASE_URL: "postgres://demo.example/scratch",
    ROAMLINK_WEBHOOK_SIGNING_KEYS: "adcos-demo:keymaterial",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    R2_BUCKET: "roamlink-demo-artifacts",
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "token",
    ADCOS_API_BASE_URL: "https://adcos.example",
    ADCOS_CLIENT_ID: "client",
    ADCOS_CLIENT_SECRET: "secret",
    ADCOS_WEBHOOK_SECRET: "webhook-secret",
  });
  assert.equal(good.ok, true, JSON.stringify(good.issues));

  const pglite = validateDemoConfig({ DATABASE_URL: "pglite://local", NODE_ENV: "production" });
  assert.equal(pglite.ok, false);
  assert.ok(pglite.issues.some((issue) => issue.group === "database" && issue.keys.includes("DATABASE_URL")));
  assert.match(pglite.issues[0].issue, /pglite/);
  assert.doesNotMatch(JSON.stringify(pglite.issues), /pglite:\/\/local/, "the value itself must never appear in an issue (RL-LOCK-016)");

  const unknownScheme = validateDemoConfig({ DATABASE_URL: "mysql://nope" });
  assert.equal(unknownScheme.ok, false);
  assert.ok(unknownScheme.issues.some((issue) => issue.group === "database"));

  const scratchEqualsSource = validateDemoConfig({
    DATABASE_URL: "postgres://demo.example/db",
    ROAMLINK_BACKUP_SCRATCH_DATABASE_URL: "postgres://demo.example/db",
  });
  assert.equal(scratchEqualsSource.ok, false);
  assert.ok(scratchEqualsSource.issues.some((issue) => issue.group === "backup"));

  const adcosHalf = validateDemoConfig({ ADCOS_API_BASE_URL: "https://adcos.example", ADCOS_CLIENT_ID: "client" });
  assert.equal(adcosHalf.ok, false);
  const adcosIssue = adcosHalf.issues.find((issue) => issue.group === "adcos");
  assert.ok(adcosIssue, "the half-configured ADCOS group must be named");
  assert.deepEqual([...adcosIssue.keys].sort(), ["ADCOS_CLIENT_SECRET", "ADCOS_WEBHOOK_SECRET"]);

  const redisHalf = validateDemoConfig({ UPSTASH_REDIS_REST_TOKEN: "token" });
  assert.equal(redisHalf.ok, false);
  assert.ok(redisHalf.issues.some((issue) => issue.group === "redis"));

  const r2Partial = validateDemoConfig({ R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "bucket" });
  assert.equal(r2Partial.ok, false);
  assert.ok(r2Partial.issues.some((issue) => issue.group === "r2"));

  const r2BadAccount = validateDemoConfig({
    R2_ACCOUNT_ID: "not-hex",
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    R2_BUCKET: "roamlink-demo-artifacts",
  });
  assert.equal(r2BadAccount.ok, false);
  assert.ok(r2BadAccount.issues.some((issue) => issue.keys.includes("R2_ACCOUNT_ID")));

  const r2BadBucket = validateDemoConfig({
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    R2_BUCKET: "Bad_Bucket",
  });
  assert.equal(r2BadBucket.ok, false);
  assert.ok(r2BadBucket.issues.some((issue) => issue.keys.includes("R2_BUCKET")));

  const qstashNextOnly = validateDemoConfig({ QSTASH_NEXT_SIGNING_KEY: "next" });
  assert.equal(qstashNextOnly.ok, false);
  assert.ok(qstashNextOnly.issues.some((issue) => issue.group === "qstash-receiver"));

  const webhookMalformed = validateDemoConfig({ DATABASE_URL: "postgres://demo.example/db", ROAMLINK_WEBHOOK_SIGNING_KEYS: "no-separator-here" });
  assert.equal(webhookMalformed.ok, false);
  assert.ok(webhookMalformed.issues.some((issue) => issue.group === "webhook"));
  assert.doesNotMatch(JSON.stringify(webhookMalformed.issues), /keymaterial/, "secret-shaped values must never ride an issue");
});

await check("the webhook signing-key registry law mirrors the host composition", async () => {
  assert.deepEqual(parseWebhookSigningKeyIds("a:one, b:two"), { ok: true, ids: ["a", "b"] });
  assert.equal(parseWebhookSigningKeyIds("noseparator").ok, false);
  assert.equal(parseWebhookSigningKeyIds(":nosecret").ok, false);
  assert.equal(parseWebhookSigningKeyIds("noid:").ok, false);
});

await check("a config-invalid invocation is REFUSED before any check runs (exit 2, CLI)", async () => {
  const script = join(fileURLToPath(new URL(".", import.meta.url)), "check.mjs");
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, ADCOS_API_BASE_URL: "https://adcos.example", ADCOS_CLIENT_ID: "only-one-of-four" },
    encoding: "utf8",
  });
  assert.equal(run.status, 2, `expected exit 2, got ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /CONFIG-INVALID/);
  assert.match(run.stdout, /ADCOS_CLIENT_SECRET/);
  assert.match(run.stdout, /ADCOS_WEBHOOK_SECRET/);
  assert.doesNotMatch(run.stdout, /batteries/, "the refusal must happen BEFORE any verification runs");
});

await check("a malformed BASE_URL is config-invalid (exit 2), and a MISSING BASE_URL is not", async () => {
  const script = join(fileURLToPath(new URL(".", import.meta.url)), "check.mjs");
  const malformed = spawnSync(process.execPath, [script], {
    env: { ...process.env, BASE_URL: "not-a-url" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stdout, /BASE_URL/);
});

await check("THE NO-FAKE-SUCCESS PIN: the honest loopback deployment is accepted (exit 0, live rows green)", async () => {
  const stub = await startStub(routesFor(HONEST_READY));
  try {
    const result = await runDemoAcceptance({ baseUrl: stub.origin, env: {}, log: () => {} });
    assert.equal(result.rows.length, 12);
    assert.equal(result.exitCode, 0, `expected exit 0; rows: ${JSON.stringify(result.rows, null, 2)}`);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("3").status, ROW_STATUS.GREEN, `row 3: ${JSON.stringify(byId.get("3"))}`);
    assert.equal(byId.get("12").status, ROW_STATUS.GREEN, `row 12: ${JSON.stringify(byId.get("12"))}`);
    assert.equal(byId.get("6").status, ROW_STATUS.GREEN, `row 6 (live real-path evidence): ${JSON.stringify(byId.get("6"))}`);
    for (const row of result.rows) {
      assert.ok(
        Object.values(ROW_STATUS).includes(row.status),
        `row ${row.id} carries an out-of-vocabulary status ${row.status}`,
      );
      assert.ok(row.evidence.length > 0 && row.evidence.every((line) => line.length > 0), `row ${row.id} must never pass silently`);
      assert.notEqual(row.status, ROW_STATUS.RED, `row ${row.id} red on an honest deployment: ${JSON.stringify(row.evidence)}`);
    }
    const counts = result.counts;
    assert.equal(counts.green + counts["named-skip"] + counts["needs-deployment"], 12, "the counts must account for every row");
  } finally {
    await stub.close();
  }
});

await check("THE SABOTAGE PIN: a lying deployment FLIPS the verdict (exit 1, the lying rows named red)", async () => {
  const stub = await startStub(routesFor(LYING_READY));
  try {
    const result = await runDemoAcceptance({ baseUrl: stub.origin, env: {}, log: () => {} });
    assert.equal(result.exitCode, 1, `a sabotaged deployment MUST flip the verdict; rows: ${JSON.stringify(result.rows, null, 2)}`);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("3").status, ROW_STATUS.RED, "the servable-readiness row must catch the lie");
    assert.equal(byId.get("12").status, ROW_STATUS.RED, "the smoke row must catch the lie");
    const flippedEvidence = [...byId.get("3").evidence, ...byId.get("12").evidence].join("\n");
    assert.match(flippedEvidence, /DEPENDENCY LIES/, "the failure must NAME the lie (the no-fake-success law)");
  } finally {
    await stub.close();
  }
});

await check("the root scripts are wired (pnpm demo:acceptance / demo:acceptance:selftest)", async () => {
  const { readFileSync } = await import("node:fs");
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["demo:acceptance"], "node infra/deployment/demo-acceptance/check.mjs");
  assert.equal(pkg.scripts["demo:acceptance:selftest"], "node infra/deployment/demo-acceptance/selftest.mjs");
});

if (failures.length > 0) {
  console.error(`demo-acceptance selftest: ${failures.length} FAILURE(S)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`demo-acceptance selftest: all ${passed} checks passed`);
}
