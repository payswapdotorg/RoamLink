#!/usr/bin/env node
/**
 * RoamLink synthetic smoke journey (RL-100) - infra/deployment/smoke.
 *
 * spec/deployment.md §7 final gate: "synthetic smoke journey is green".
 * This suite exercises a DEPLOYED stack end-to-end WITHOUT real customer
 * data and WITHOUT secrets: it takes BASE_URL (and optional API_URL) from
 * the environment and probes the deployment's observable truth layer plus
 * the shell's public surfaces. Deterministic, bounded (every request
 * abort-timed), exit 0 only when EVERY assertion holds.
 *
 * What it asserts:
 *   1. healthz answers 200 alive (the process is up);
 *   2. readyz answers the HONEST readiness vocabulary
 *      `ready | degraded:<dep,...> | not-ready:<reason,...>` with the
 *      HTTP code tracking servability (200 ready/degraded, 503 not-ready);
 *   3. the API's composed readiness (GET /v1/readiness) does the same;
 *   4. the shell renders: the home route is reachable and the expected
 *      markup markers are present (unauthenticated visits land on the
 *      login document - that IS the expected render);
 *   5. the admin console route is reachable (mounted, never 5xx/404);
 *   6. key same-origin static assets referenced by the shell respond;
 *   7. the ADCOS webhook ingress is mounted and FAILS CLOSED (an unsigned
 *      delivery is rejected 400/401 - never admitted, never 404/5xx).
 *
 * THE NO-LIE LAW (the reason this suite exists): the smoke must FAIL if a
 * dependency lies. A readiness answer that claims `ready` while any
 * per-dependency probe reports degraded/down is a FAILED check; an answer
 * outside the honest vocabulary is a FAILED check; a 200 on a not-ready
 * body is a FAILED check. Degraded/NOT-READY states must be SURFACED as
 * such - surfacing them (even with HTTP 503) is a PASS for the vocabulary
 * checks; only dishonesty fails.
 *
 * Usage (operator):
 *   BASE_URL=https://roamlink.example.org pnpm smoke
 *   BASE_URL=https://roamlink.example.org API_URL=https://api.example.org pnpm smoke
 *   SMOKE_TIMEOUT_MS=15000 BASE_URL=... pnpm smoke
 *
 * Exit codes: 0 every check passed; 1 one or more checks FAILED (or the
 * target was unreachable); 2 misconfigured invocation (BASE_URL missing).
 * No secrets are read, printed or transmitted; the only inputs are URLs
 * and a timeout (RL-LOCK-016).
 */

/** The frozen readiness vocabulary the smoke asserts (mirrors services/api). */
export const READINESS_STATUS_PATTERN = /^(ready|degraded:[a-z0-9][a-z0-9.,-]*|not-ready:[a-z0-9][a-z0-9.,-]*)$/;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STATIC_ASSET_PROBES = 8;

// --------------------------------------------------------------------------------
// Bounded request helper (every request abort-timed; never throws out)
// --------------------------------------------------------------------------------

async function request(url, { method = "GET", headers, body, timeoutMs }) {
  const response = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

// --------------------------------------------------------------------------------
// The readiness-vocabulary assertion (shared by readyz and /v1/readiness)
// --------------------------------------------------------------------------------

/**
 * Asserts the honest readiness vocabulary for one endpoint. Returns
 * `{ ok, detail }`. Implements the no-lie law:
 *  - the top-level `status` MUST match the frozen vocabulary;
 *  - the HTTP code MUST track servability (200 ready/degraded, 503 not-ready);
 *  - `checks` MUST be a non-empty array of {name, state(healthy|degraded|down)};
 *  - a `ready` claim with ANY non-healthy check is a LIE -> FAIL;
 *  - every non-healthy check MUST be surfaced in the status string OR carry
 *    a per-check detail (an unexplained unhealthy dependency is a lie);
 *  - a degraded:/not-ready: status with zero unhealthy checks is a LIE.
 */
export async function checkReadinessEndpoint(url, { timeoutMs }) {
  let response;
  try {
    response = await request(url, { timeoutMs, headers: { accept: "application/json" } });
  } catch {
    return { ok: false, detail: "unreachable (connection failure or timeout)" };
  }
  if (response.status !== 200 && response.status !== 503) {
    return { ok: false, detail: `unexpected HTTP status ${response.status} (expected 200 or 503)` };
  }
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    return { ok: false, detail: `HTTP ${response.status} but the body is not JSON` };
  }
  if (body === null || typeof body !== "object") {
    return { ok: false, detail: `HTTP ${response.status} but the body is not a JSON object` };
  }
  const status = body["status"];
  if (typeof status !== "string" || !READINESS_STATUS_PATTERN.test(status)) {
    return {
      ok: false,
      detail: `the status field is outside the honest vocabulary (got ${
        typeof status === "string" ? JSON.stringify(status.slice(0, 64)) : typeof status
      }; expected ready | degraded:<dep> | not-ready:<reason>)`,
    };
  }
  const checks = body["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    return { ok: false, detail: `status ${JSON.stringify(status)} carries no per-dependency checks (unprovable readiness)` };
  }
  const unhealthy = [];
  for (const entry of checks) {
    if (entry === null || typeof entry !== "object" || typeof entry["name"] !== "string" || entry["name"].length === 0) {
      return { ok: false, detail: "a checks[] entry has no dependency name" };
    }
    const state = entry["state"];
    if (state !== "healthy" && state !== "degraded" && state !== "down") {
      return { ok: false, detail: `dependency ${entry["name"]} reported an out-of-vocabulary state ${JSON.stringify(String(state).slice(0, 32))}` };
    }
    if (state !== "healthy") {
      const detail = entry["detail"];
      unhealthy.push({
        name: entry["name"],
        state,
        explained: typeof detail === "string" && detail.length > 0,
      });
    }
  }
  const codeMatches =
    status === "ready" || status.startsWith("degraded:") ? response.status === 200 : response.status === 503;
  if (!codeMatches) {
    return {
      ok: false,
      detail: `status ${JSON.stringify(status)} with HTTP ${response.status} (servability code mismatch: ready/degraded must be 200, not-ready must be 503)`,
    };
  }
  if (status === "ready" && unhealthy.length > 0) {
    const liars = unhealthy.map((entry) => `${entry.name}=${entry.state}`).join(", ");
    return { ok: false, detail: `A DEPENDENCY LIES: status claims ready while ${liars} (no-fake-success law)` };
  }
  if (status.startsWith("degraded:") || status.startsWith("not-ready:")) {
    if (unhealthy.length === 0) {
      return { ok: false, detail: `status claims ${status} but every dependency probed healthy (inverted lie)` };
    }
    const unsurfaced = unhealthy.filter((entry) => !status.includes(entry.name) && !entry.explained);
    if (unsurfaced.length > 0) {
      return {
        ok: false,
        detail: `unhealthy dependency(ies) ${unsurfaced.map((entry) => entry.name).join(", ")} are neither named in the status nor explained per-check (hidden state)`,
      };
    }
  }
  return {
    ok: true,
    detail: `status=${status}; deps=${checks.map((entry) => `${entry.name}:${entry.state}`).join(", ")}`,
  };
}

// --------------------------------------------------------------------------------
// The surface/asset checks
// --------------------------------------------------------------------------------

const ASSET_REFERENCE_PATTERN = /(?:src|href)="(\/[^"#?]*)/g;
const EXCLUDED_PREFIXES = ["/v1", "/healthz", "/readyz", "/auth", "/login", "/admin"];
const ASSET_SUFFIX_PATTERN = /\.(css|js|mjs|ico|svg|png|jpg|jpeg|webp|woff2?)$/i;

function extractAssetRefs(html) {
  const refs = new Set();
  for (const match of html.matchAll(ASSET_REFERENCE_PATTERN)) {
    const ref = match[1];
    if (EXCLUDED_PREFIXES.some((prefix) => ref === prefix || ref.startsWith(`${prefix}/`))) {
      continue;
    }
    if (ASSET_SUFFIX_PATTERN.test(ref) || ref.startsWith("/_next/")) {
      refs.add(ref);
    }
  }
  return [...refs].sort();
}

function markupMarkersOk(html, requiredMarkers) {
  const missing = requiredMarkers.filter((marker) => !html.includes(marker));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// --------------------------------------------------------------------------------
// The smoke journey
// --------------------------------------------------------------------------------

/**
 * Runs the smoke suite against the configured targets.
 *
 * @param {object} config
 * @param {string} config.baseUrl  the web host origin (healthz/readyz/shell)
 * @param {string} [config.apiUrl] the API origin (defaults to baseUrl; the
 *                                 host mounts /v1 itself)
 * @param {number} [config.timeoutMs] per-request bound (default 10000)
 * @param {(line: string) => void} [config.log] per-check output sink
 * @returns {Promise<{passed: number, failed: number, failures: string[]}>}
 */
export async function runSmoke(config) {
  const baseUrl = stripTrailingSlash(config.baseUrl);
  const apiUrl = stripTrailingSlash(config.apiUrl ?? config.baseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = config.log ?? ((line) => console.log(line));

  /** HTML collected by surface checks (input for the static-asset check). */
  const collectedHtml = [];
  const checks = [
    {
      name: "healthz",
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
          ? { ok: true, detail: "the process answers alive" }
          : { ok: false, detail: `expected status "alive", got ${JSON.stringify(body["status"])}` };
      },
    },
    {
      name: "readyz-vocabulary",
      run: () => checkReadinessEndpoint(`${baseUrl}/readyz`, { timeoutMs }),
    },
    {
      name: "api-readiness-vocabulary",
      run: () => checkReadinessEndpoint(`${apiUrl}/v1/readiness`, { timeoutMs }),
    },
    {
      name: "home-surface",
      run: async () => {
        let first;
        try {
          first = await request(`${baseUrl}/`, { timeoutMs });
        } catch {
          return { ok: false, detail: "unreachable (connection failure or timeout)" };
        }
        if (first.status === 200) {
          collectedHtml.push(first.text);
          const markers = markupMarkersOk(first.text, ["RoamLink"]);
          return markers.ok
            ? { ok: true, detail: "the authenticated shell rendered with the expected markers" }
            : { ok: false, detail: `the home document is missing markup marker(s): ${markers.missing.join(", ")}` };
        }
        if (first.status === 303) {
          const location = first.headers.get("location") ?? "";
          if (!location.includes("/login")) {
            return { ok: false, detail: `the unauthenticated home visit redirected to ${JSON.stringify(location)} (expected /login)` };
          }
          const loginUrl = new URL(location, baseUrl).toString();
          let login;
          try {
            login = await request(loginUrl, { timeoutMs });
          } catch {
            return { ok: false, detail: "the /login redirect target is unreachable" };
          }
          if (login.status !== 200) return { ok: false, detail: `the login document answered ${login.status}` };
          collectedHtml.push(login.text);
          const markers = markupMarkersOk(login.text, ["RoamLink", "Sign in", "<form"]);
          return markers.ok
            ? { ok: true, detail: "the unauthenticated visit renders the login document with the expected markers" }
            : { ok: false, detail: `the login document is missing markup marker(s): ${markers.missing.join(", ")}` };
        }
        return { ok: false, detail: `expected 200 (shell) or 303 (login redirect), got ${first.status}` };
      },
    },
    {
      name: "admin-surface",
      run: async () => {
        let response;
        try {
          response = await request(`${baseUrl}/admin`, { timeoutMs });
        } catch {
          return { ok: false, detail: "unreachable (connection failure or timeout)" };
        }
        if (response.status === 200) return { ok: true, detail: "the admin console route rendered" };
        if (response.status === 303) {
          const location = response.headers.get("location") ?? "";
          return location.includes("/login")
            ? { ok: true, detail: "the admin console route is mounted and its auth gate redirects to /login" }
            : { ok: false, detail: `the admin route redirected to ${JSON.stringify(location)} (expected /login)` };
        }
        return { ok: false, detail: `expected 200 or 303, got ${response.status} (the console surface is not correctly mounted)` };
      },
    },
    {
      name: "static-assets",
      run: async () => {
        if (collectedHtml.length === 0) {
          // No surface rendered -> there is no evidence to verify assets
          // against. Absence of evidence is not a pass (the surface checks
          // have already failed; this check must not paper over them).
          return { ok: false, detail: "no surface HTML was collected by the surface checks (assets unverifiable)" };
        }
        const refs = [...new Set(collectedHtml.flatMap((html) => extractAssetRefs(html)))]
          .sort()
          .slice(0, MAX_STATIC_ASSET_PROBES);
        if (refs.length === 0) {
          return { ok: true, detail: "no same-origin static assets are referenced by the shell (nothing to break)" };
        }
        const failures = [];
        for (const ref of refs) {
          try {
            const response = await request(new URL(ref, baseUrl).toString(), { timeoutMs });
            if (response.status >= 400) failures.push(`${ref} -> ${response.status}`);
          } catch {
            failures.push(`${ref} -> unreachable`);
          }
        }
        return failures.length === 0
          ? { ok: true, detail: `${refs.length} referenced asset(s) respond (${refs.join(", ")})` }
          : { ok: false, detail: `referenced asset(s) failing: ${failures.join("; ")}` };
      },
    },
    {
      name: "webhook-ingress-fail-closed",
      run: async () => {
        // A deterministic, secret-free, UNSIGNED delivery: the ingress must
        // reject it (400 policy / 401 signature) and never admit it. This
        // creates NO durable state (admission is verification-gated).
        let response;
        try {
          response = await request(`${apiUrl}/v1/webhooks/adcos`, {
            method: "POST",
            timeoutMs,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              specversion: "1.0",
              type: "io.roamlink.smoke.probe",
              source: "/smoke",
              id: "smoke-unsigned-probe",
              time: "2026-01-01T00:00:00Z",
              data: { note: "synthetic smoke probe - unsigned, expected to fail closed" },
            }),
          });
        } catch {
          return { ok: false, detail: "unreachable (connection failure or timeout)" };
        }
        if (response.status === 400 || response.status === 401) {
          return { ok: true, detail: `the ingress rejected the unsigned delivery with HTTP ${response.status} (fail-closed)` };
        }
        return {
          ok: false,
          detail: `expected 400/401 for an unsigned delivery (fail-closed), got ${response.status} - ${
            response.status === 404 ? "the ingress is NOT mounted" : "the ingress admitted or mishandled an unsigned delivery"
          }`,
        };
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const check of checks) {
    let outcome;
    try {
      outcome = await check.run();
    } catch {
      outcome = { ok: false, detail: "the check itself failed unexpectedly (details suppressed)" };
    }
    if (outcome.ok) {
      passed += 1;
      log(`[ok]   ${check.name} - ${outcome.detail}`);
    } else {
      failed += 1;
      failures.push(`${check.name}: ${outcome.detail}`);
      log(`[FAIL] ${check.name} - ${outcome.detail}`);
    }
  }
  return { passed, failed, failures };
}

function stripTrailingSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// --------------------------------------------------------------------------------
// CLI entry (the library surface above is what the selftest drives)
// --------------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const baseUrl = process.env["BASE_URL"]?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    console.error("BASE_URL is required (the deployed web host origin), e.g.:");
    console.error("  BASE_URL=https://roamlink-demo.example.org pnpm smoke");
    console.error("Optional: API_URL (the API origin when split from the host), SMOKE_TIMEOUT_MS (default 10000).");
    process.exit(2);
  }
  const apiUrl = process.env["API_URL"]?.trim() || baseUrl;
  const timeoutRaw = Number(process.env["SMOKE_TIMEOUT_MS"] ?? "");
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;
  console.log(`RoamLink synthetic smoke (RL-100) against ${baseUrl} (api: ${apiUrl})`);
  try {
    const result = await runSmoke({ baseUrl, apiUrl, timeoutMs });
    console.log(`smoke complete: ${result.passed} passed, ${result.failed} failed`);
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`smoke run aborted: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exit(1);
  }
}
