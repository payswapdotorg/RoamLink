#!/usr/bin/env node
/**
 * The smoke suite's selftest (RL-100): proves the RUNNER, not a deployment.
 *
 * Deterministic, zero-dependency, zero-network (loopback only): in-process
 * node:http stub servers stand in for an honest deployment, a LYING
 * deployment and a misbehaving one. Asserts:
 *  - the honest stub passes EVERY check (the exit-0 path);
 *  - a readiness claim of `ready` while a dependency reports down FAILS
 *    (the no-fake-success law - the exact lie the smoke exists to catch);
 *  - an out-of-vocabulary status FAILS;
 *  - a servability-code mismatch (not-ready body on HTTP 200) FAILS;
 *  - a status that hides an unexplained unhealthy dependency FAILS;
 *  - an unreachable target FAILS without crashing the runner;
 *  - a fail-closed webhook ingress and a mounted one are told apart;
 *  - degraded states SURFACED honestly PASS (surfacing is not failure).
 *
 * Run: node infra/deployment/smoke/selftest.mjs   (exit 0 on full pass)
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { checkReadinessEndpoint, runSmoke } from "./run.mjs";

/** Starts an in-process stub server; the handler answers each request. */
async function startStub(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "stub failure" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function handlerFor(routes) {
  return (request, response) => {
    const url = new URL(request.url, "http://stub.local");
    const route = routes.find((candidate) => candidate.method === request.method && candidate.path === url.pathname);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no route" }));
      return;
    }
    route.answer(request, response);
  };
}

const LOGIN_HTML = `<!doctype html><html><head><title>RoamLink - Sign in</title></head><body><h2>Sign in</h2><form method="POST" action="/auth/session"><label>Email<input id="email" name="email" type="email"></label><label>Password<input id="password" name="password" type="password"></label><button>Sign in</button></form></body></html>`;
const SHELL_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/shell.css"><title>RoamLink</title></head><body><main>RoamLink home</main></body></html>`;

function honestRoutes({ readyBody = { status: "ready", ready: true, checks: [{ name: "database", state: "healthy", detail: "4 migration(s) applied" }] }, ingressStatus = 401 } = {}) {
  return [
    { method: "GET", path: "/healthz", answer: (_req, res) => send(res, 200, { status: "alive" }) },
    { method: "GET", path: "/readyz", answer: (_req, res) => send(res, readyBody.status === "not-ready:migrations" ? 503 : 200, readyBody) },
    { method: "GET", path: "/v1/readiness", answer: (_req, res) => send(res, 200, readyBody) },
    { method: "GET", path: "/", answer: (_req, res) => redirect(res, 303, "/login") },
    { method: "GET", path: "/login", answer: (_req, res) => sendHtml(res, 200, LOGIN_HTML) },
    { method: "GET", path: "/admin", answer: (_req, res) => redirect(res, 303, "/login") },
    { method: "GET", path: "/_next/static/shell.css", answer: (_req, res) => sendHtml(res, 200, "body{color:#333}") },
    { method: "POST", path: "/v1/webhooks/adcos", answer: (_req, res) => send(res, ingressStatus, { outcome: "REJECTED", code: "webhook-signature-invalid" }) },
  ];
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

async function main() {
  let failures = 0;

  // 1. The honest deployment: every check passes.
  {
    const stub = await startStub(handlerFor(honestRoutes()));
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.equal(result.failed, 0, `honest stub must pass every check: ${JSON.stringify(result.failures)}`);
      assert.equal(result.passed, 7);
      console.log(`[ok] honest deployment passes all ${result.passed} checks`);
    } finally {
      await stub.close();
    }
  }

  // 2. THE LIE: readyz claims ready while a dependency reports down.
  {
    const stub = await startStub(
      handlerFor(honestRoutes({ readyBody: { status: "ready", ready: true, checks: [{ name: "database", state: "healthy" }, { name: "redis", state: "down" }] } })),
    );
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.ok(result.failed > 0, "a lying readiness answer MUST fail the smoke");
      assert.ok(
        result.failures.some((failure) => failure.includes("readyz-vocabulary") && failure.includes("DEPENDENCY LIES")),
        `the failure must name the lie: ${JSON.stringify(result.failures)}`,
      );
      console.log("[ok] a ready-claim over a down dependency FAILS (no-fake-success law)");
    } finally {
      await stub.close();
    }
  }

  // 3. Out-of-vocabulary status.
  {
    const stub = await startStub(handlerFor(honestRoutes({ readyBody: { status: "operational", ready: true, checks: [{ name: "database", state: "healthy" }] } })));
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.ok(result.failures.some((failure) => failure.includes("honest vocabulary")));
      console.log("[ok] an out-of-vocabulary readiness status FAILS");
    } finally {
      await stub.close();
    }
  }

  // 4. Servability-code mismatch: not-ready body on HTTP 200.
  {
    const stub = await startStub(handlerFor([
      { method: "GET", path: "/readyz", answer: (_req, res) => send(res, 200, { status: "not-ready:database", ready: false, checks: [{ name: "database", state: "down", detail: "x" }] }) },
      { method: "GET", path: "/v1/readiness", answer: (_req, res) => send(res, 200, { status: "ready", ready: true, checks: [{ name: "database", state: "healthy" }] }) },
      { method: "GET", path: "/healthz", answer: (_req, res) => send(res, 200, { status: "alive" }) },
      { method: "GET", path: "/", answer: (_req, res) => sendHtml(res, 200, SHELL_HTML) },
      { method: "GET", path: "/admin", answer: (_req, res) => redirect(res, 303, "/login") },
      { method: "GET", path: "/_next/static/shell.css", answer: (_req, res) => sendHtml(res, 200, "body{}") },
      { method: "POST", path: "/v1/webhooks/adcos", answer: (_req, res) => send(res, 400, { outcome: "REJECTED" }) },
    ]));
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.ok(result.failures.some((failure) => failure.includes("servability code mismatch")));
      console.log("[ok] a not-ready body on HTTP 200 FAILS (servability code law)");
    } finally {
      await stub.close();
    }
  }

  // 5. HONEST degradation passes: degraded:redis surfaced with 200 (servable).
  {
    const stub = await startStub(
      handlerFor(honestRoutes({ readyBody: { status: "degraded:redis", ready: true, checks: [{ name: "database", state: "healthy" }, { name: "redis", state: "down", detail: "the accelerator did not answer PING (detail suppressed)" }] } })),
    );
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.equal(result.failed, 0, `surfaced degradation must PASS: ${JSON.stringify(result.failures)}`);
      console.log("[ok] an honestly surfaced degraded:<dep> state PASSES (surfacing is not failure)");
    } finally {
      await stub.close();
    }
  }

  // 6. HIDDEN state fails: degraded status but the unhealthy check unexplained
  //    and unmentioned.
  {
    const stub = await startStub(
      handlerFor(honestRoutes({ readyBody: { status: "degraded:redis", ready: true, checks: [{ name: "database", state: "healthy" }, { name: "object-storage", state: "down" }] } })),
    );
    try {
      const result = await runSmoke({ baseUrl: stub.origin, timeoutMs: 2_000, log: () => {} });
      assert.ok(result.failures.some((failure) => failure.includes("hidden state")));
      console.log("[ok] an unexplained, unnamed unhealthy dependency FAILS (hidden state)");
    } finally {
      await stub.close();
    }
  }

  // 7. The webhook ingress is told apart: mounted fail-closed vs NOT mounted (404).
  {
    const notMounted = await startStub(handlerFor(honestRoutes({ ingressStatus: 404 })));
    try {
      const result = await runSmoke({ baseUrl: notMounted.origin, timeoutMs: 2_000, log: () => {} });
      assert.ok(result.failures.some((failure) => failure.includes("webhook-ingress-fail-closed") && failure.includes("NOT mounted")));
      console.log("[ok] a missing webhook ingress FAILS (reachable-endpoint requirement)");
    } finally {
      await notMounted.close();
    }
  }

  // 8. An unreachable target fails every check without crashing the runner.
  {
    const dead = await startStub(() => {});
    const { origin } = dead;
    await dead.close(); // the port is now closed -> connection refused
    const result = await runSmoke({ baseUrl: origin, timeoutMs: 2_000, log: () => {} });
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 7);
    console.log("[ok] an unreachable target fails cleanly (exit-1 path, no crash)");
  }

  // 9. checkReadinessEndpoint direct pins (unit-level).
  {
    const unreachable = await checkReadinessEndpoint("http://127.0.0.1:1/v1/readiness", { timeoutMs: 1_000 });
    assert.equal(unreachable.ok, false);
    const honest = await startStub(handlerFor([
      { method: "GET", path: "/v1/readiness", answer: (_req, res) => send(res, 200, { status: "ready", ready: true, checks: [{ name: "database", state: "healthy" }] }) },
    ]));
    try {
      const ok = await checkReadinessEndpoint(`${honest.origin}/v1/readiness`, { timeoutMs: 2_000 });
      assert.equal(ok.ok, true, ok.detail);
    } finally {
      await honest.close();
    }
    console.log("[ok] checkReadinessEndpoint direct pins hold");
  }

  console.log(`smoke selftest complete: all assertions hold${failures > 0 ? ` (${failures} failures)` : ""}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("selftest crashed:", error);
  process.exit(1);
});
