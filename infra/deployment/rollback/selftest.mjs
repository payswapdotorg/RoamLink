#!/usr/bin/env node
/**
 * The rollback check's selftest (RL-112): proves the RUNNER, not a
 * deployment. Deterministic, zero-dependency, loopback only — in-process
 * node:http stubs stand in for an accepted post-rollback state, a truth-
 * ful-but-not-servable state, a lying readiness, and an unreachable host.
 * Asserts the §9 decision rule end to end:
 *  - an honest, ready deployment + green smoke PASSES (exit 0 path);
 *  - a SURFACED degraded state still PASSES (servable; the §6b law that
 *    surfacing degradation is not failure);
 *  - a truthful `not-ready:*` answer FAILS the acceptance (the stricter
 *    post-rollback rule: truth alone is not restored service);
 *  - a `ready` claim over a down dependency FAILS (the no-lie law);
 *  - an unreachable host FAILS without crashing the runner;
 *  - a misconfigured invocation exits 2.
 *
 * Run: node infra/deployment/rollback/selftest.mjs   (exit 0 on full pass)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { checkPostRollbackState, checkServableReadiness } from "./check.mjs";

async function startStub(routes) {
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const LOGIN_HTML = `<!doctype html><html><head><title>RoamLink - Sign in</title></head><body><h2>Sign in</h2><form method="POST" action="/auth/session"><label>Email<input id="email" name="email" type="email"></label><label>Password<input id="password" name="password" type="password"></label><button>Sign in</button></form></body></html>`;
const SHELL_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/shell.css"><title>RoamLink</title></head><body><main>RoamLink home</main></body></html>`;

function routesFor({ readyBody, ingressStatus = 401 }) {
  return [
    { method: "GET", path: "/healthz", answer: (_req, res) => send(res, 200, { status: "alive" }) },
    {
      method: "GET",
      path: "/readyz",
      answer: (_req, res) =>
        send(res, readyBody.status.startsWith("not-ready:") ? 503 : 200, readyBody),
    },
    {
      method: "GET",
      path: "/v1/readiness",
      answer: (_req, res) =>
        send(res, readyBody.status.startsWith("not-ready:") ? 503 : 200, readyBody),
    },
    { method: "GET", path: "/", answer: (_req, res) => sendHtml(res, 200, SHELL_HTML) },
    { method: "GET", path: "/login", answer: (_req, res) => sendHtml(res, 200, LOGIN_HTML) },
    { method: "GET", path: "/admin", answer: (_req, res) => sendHtml(res, 200, LOGIN_HTML) },
    { method: "GET", path: "/support", answer: (_req, res) => sendHtml(res, 200, LOGIN_HTML) },
    { method: "GET", path: "/_next/static/shell.css", answer: (_req, res) => sendHtml(res, 200, "body{color:#333}") },
    { method: "POST", path: "/v1/webhooks/adcos", answer: (_req, res) => send(res, ingressStatus, { outcome: "REJECTED" }) },
  ];
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const READY = { status: "ready", ready: true, checks: [{ name: "database", state: "healthy", detail: "4 migration(s) applied" }] };
const DEGRADED = { status: "degraded:qstash", ready: false, checks: [{ name: "database", state: "healthy" }, { name: "qstash", state: "degraded", detail: "the transport probe failed (detail suppressed)" }] };
const NOT_READY = { status: "not-ready:migrations", ready: false, checks: [{ name: "database", state: "healthy" }, { name: "migrations", state: "down", detail: "the schema migration ledger is empty" }] };
const LYING_READY = { status: "ready", ready: true, checks: [{ name: "database", state: "down", detail: "connection refused" }] };

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

await check("an honest ready deployment + green smoke is ACCEPTED (the exit-0 path)", async () => {
  const stub = await startStub(routesFor({ readyBody: READY }));
  try {
    const result = await checkPostRollbackState({ baseUrl: stub.origin, timeoutMs: 3000, log: () => undefined });
    assert.equal(result.failed, 0, `expected zero failures, got ${JSON.stringify(result.failures)}`);
    assert.equal(result.passed, 4);
  } finally {
    await stub.close();
  }
});

await check("a surfaced degraded state is still ACCEPTED (servable + honest)", async () => {
  const stub = await startStub(routesFor({ readyBody: DEGRADED }));
  try {
    const result = await checkPostRollbackState({ baseUrl: stub.origin, timeoutMs: 3000, log: () => undefined });
    assert.equal(result.failed, 0, `expected zero failures, got ${JSON.stringify(result.failures)}`);
  } finally {
    await stub.close();
  }
});

await check("a truthful not-ready answer is REJECTED (the rollback did not restore service)", async () => {
  const stub = await startStub(routesFor({ readyBody: NOT_READY }));
  try {
    const servable = await checkServableReadiness(`${stub.origin}/readyz`, { timeoutMs: 3000 });
    assert.equal(servable.ok, false, "not-ready must fail the servability law");
    assert.match(servable.detail, /NOT SERVABLE/);
    const result = await checkPostRollbackState({ baseUrl: stub.origin, timeoutMs: 3000, log: () => undefined });
    assert.ok(result.failed > 0);
    assert.ok(result.failures.some((failure) => failure.includes("readyz-servable")));
  } finally {
    await stub.close();
  }
});

await check("a ready claim over a down dependency is REJECTED (the no-lie law)", async () => {
  const stub = await startStub(routesFor({ readyBody: LYING_READY }));
  try {
    const result = await checkPostRollbackState({ baseUrl: stub.origin, timeoutMs: 3000, log: () => undefined });
    assert.ok(result.failed > 0);
    assert.ok(result.failures.some((failure) => failure.includes("readyz-servable")));
  } finally {
    await stub.close();
  }
});

await check("an unreachable host FAILS every probe without crashing the runner", async () => {
  const result = await checkPostRollbackState({
    baseUrl: "http://127.0.0.1:9", // the discard port: nothing listens
    timeoutMs: 1500,
    log: () => undefined,
  });
  assert.equal(result.passed, 0);
  assert.ok(result.failures.length >= 3);
});

await check("a misconfigured invocation (no BASE_URL) exits 2", () => {
  const script = join(fileURLToPath(new URL(".", import.meta.url)), "check.mjs");
  const run = spawnSync(process.execPath, [script], { env: { ...process.env, BASE_URL: "" } });
  assert.equal(run.status, 2);
  assert.match(run.stderr.toString(), /BASE_URL is required/);
});

if (failures.length > 0) {
  console.error(`rollback selftest: ${failures.length} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log(`rollback selftest: all ${passed} checks passed`);
}
