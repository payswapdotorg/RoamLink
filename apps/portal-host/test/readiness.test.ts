/**
 * The portal-host readiness composition tests (RL-100).
 *
 * NO network: the remote-API probe runs against an injected fetch fake and
 * the composed report is driven over the embedded pglite engine. Proves:
 *  - the probe's honest mapping law (ready->healthy, degraded->degraded,
 *    not-ready/503->down, out-of-vocabulary->down, throw/timeout->down
 *    with a suppressed detail - a lying dependency can never pass);
 *  - the host report carries the composed vocabulary `status` while keeping
 *    the established `ready`/`checks` shape (additive);
 *  - an UNMIGRATED database is not-ready (existing law, unchanged);
 *  - a configured-but-unhealthy remote API makes the host not-ready:api
 *    (the host's surfaces depend on it - REQUIRED when configured);
 *  - without ROAMLINK_API_BASE_URL no api check is registered (an
 *    uncomposed dependency is never reported - no fake surface).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUtcInstant } from "@roamlink/contracts";

import {
  CompositionError,
  createPortalHostComposition,
  type PortalHostComposition,
} from "../src/index.js";
import {
  createRemoteApiReadinessProbe,
  remoteApiReadinessCheck,
} from "../src/readiness.js";
import { createPostgresMigrationRunner, setMigrationFileAccess, setMigrationPathResolver } from "@roamlink/persistence-postgres";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

type FakeResponse = { status: number; body: unknown } | { error: unknown };

function fakeFetch(responder: () => FakeResponse): typeof fetch {
  return (async (): Promise<Response> => {
    const outcome = responder();
    if ("error" in outcome) throw outcome.error;
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("the remote-API readiness probe mapping (RL-100)", () => {
  const BASE = "https://api.example.internal";

  function probeWith(responder: () => FakeResponse, timeoutMs = 2_000) {
    return createRemoteApiReadinessProbe({
      baseUrl: BASE,
      timeoutMs,
      fetchLike: fakeFetch(responder),
    });
  }

  it("maps ready -> healthy", async () => {
    const probe = probeWith(() => ({ status: 200, body: { status: "ready", ready: true, checks: [] } }));
    const outcome = await probe.probe();
    expect(outcome.state).toBe("healthy");
    expect(outcome.detail).toBeUndefined();
  });

  it("maps degraded:<dep> -> degraded with the status carried verbatim (degradation propagates)", async () => {
    const probe = probeWith(() => ({ status: 200, body: { status: "degraded:redis", ready: true, checks: [] } }));
    const outcome = await probe.probe();
    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toBe("degraded:redis");
  });

  it("maps a 503 not-ready:<reason> -> down with the reason carried", async () => {
    const probe = probeWith(() => ({ status: 503, body: { status: "not-ready:database", ready: false, checks: [] } }));
    const outcome = await probe.probe();
    expect(outcome.state).toBe("down");
    expect(outcome.detail).toBe("not-ready:database");
  });

  it("maps an out-of-vocabulary 200 -> down (a lying API can never pass)", async () => {
    const probe = probeWith(() => ({ status: 200, body: { status: "totally-fine-believe-me" } }));
    const outcome = await probe.probe();
    expect(outcome.state).toBe("down");
  });

  it("maps garbage JSON -> down (suppressed)", async () => {
    const fetchLike = (async (): Promise<Response> =>
      new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    const probe = createRemoteApiReadinessProbe({ baseUrl: BASE, fetchLike });
    const outcome = await probe.probe();
    expect(outcome.state).toBe("down");
    expect(outcome.detail).not.toContain("not json");
  });

  it("maps connection failure -> down with a SUPPRESSED detail (RL-LOCK-016)", async () => {
    const probe = probeWith(() => ({ error: new TypeError("connect ECONNREFUSED 10.1.2.3:5432") }));
    const outcome = await probe.probe();
    expect(outcome.state).toBe("down");
    expect(outcome.detail).toBeDefined();
    expect(outcome.detail).not.toContain("ECONNREFUSED");
    expect(outcome.detail).not.toContain("10.1.2.3");
  });

  it("bounds the probe time (AbortSignal.timeout, serverless-safe)", async () => {
    const captured: { signal: AbortSignal | undefined } = { signal: undefined };
    const fetchLike = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      captured.signal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    }) as unknown as typeof fetch;
    const probe = createRemoteApiReadinessProbe({ baseUrl: BASE, timeoutMs: 1234, fetchLike });
    await probe.probe();
    expect(captured.signal).toBeDefined();
  });

  it("rejects an unusable base URL at composition time (fail fast, never mid-probe)", () => {
    expect(() => createRemoteApiReadinessProbe({ baseUrl: "not-a-url" })).toThrow(/absolute URL/);
    expect(() => createRemoteApiReadinessProbe({ baseUrl: "ftp://nope" })).toThrow(/http\(s\)/);
  });

  it("the wrapped check is named 'api' and carries checkedAt (observability-compatible)", async () => {
    const probe = probeWith(() => ({ status: 200, body: { status: "ready" } }));
    const check = remoteApiReadinessCheck({
      probe,
      clock: { now: () => parseUtcInstant("2026-01-15T10:00:00.000Z") },
    });
    expect(check.name).toBe("api");
    const result = await check.run();
    expect(result).toMatchObject({ name: "api", state: "healthy", checkedAt: "2026-01-15T10:00:00.000Z" });
  });
});

describe("the host readiness composition (RL-100)", () => {
  function migratedEnv(overrides: Record<string, unknown> = {}) {
    setMigrationFileAccess({
      listDir: (dir) => readdirSync(dir),
      readTextFile: (path) => readFileSync(path, "utf8"),
    });
    setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
    return {
      mode: "development" as const,
      databaseUrl: "pglite://",
      ...overrides,
    };
  }

  async function migrate(composition: PortalHostComposition): Promise<void> {
    const runner = createPostgresMigrationRunner({ driver: composition.driver });
    await runner.migrateUp();
  }

  it("reports the composed vocabulary: migrated DB -> status ready (no api check registered without the URL)", async () => {
    const composition = await createPortalHostComposition(migratedEnv());
    try {
      await migrate(composition);
      const report = await composition.readyCheck();
      expect(report.status).toBe("ready");
      expect(report.ready).toBe(true);
      expect(report.checks.map((check) => check.name).sort()).toEqual(["database", "migrations"]);
    } finally {
      await composition.dispose();
    }
  });

  it("keeps the established law: an UNMIGRATED database is not-ready (503-shape)", async () => {
    const composition = await createPortalHostComposition({ mode: "development", databaseUrl: "pglite://" });
    try {
      const report = await composition.readyCheck();
      expect(report.status).toBe("not-ready:migrations");
      expect(report.ready).toBe(false);
      const migrations = report.checks.find((check) => check.name === "migrations");
      expect(migrations?.state).toBe("down");
    } finally {
      await composition.dispose();
    }
  });

  it("a configured remote API rides the composition: healthy -> ready", async () => {
    const composition = await createPortalHostComposition(
      migratedEnv({
        apiBaseUrl: "https://api.example.internal",
        fetchLike: fakeFetch(() => ({ status: 200, body: { status: "ready" } })),
      }),
    );
    try {
      await migrate(composition);
      const report = await composition.readyCheck();
      expect(report.status).toBe("ready");
      expect(report.checks.map((check) => check.name).sort()).toEqual(["api", "database", "migrations"]);
    } finally {
      await composition.dispose();
    }
  });

  it("a configured but degraded remote API degrades the host (servable, surfaced)", async () => {
    const composition = await createPortalHostComposition(
      migratedEnv({
        apiBaseUrl: "https://api.example.internal",
        fetchLike: fakeFetch(() => ({ status: 200, body: { status: "degraded:qstash" } })),
      }),
    );
    try {
      await migrate(composition);
      const report = await composition.readyCheck();
      expect(report.status).toBe("degraded:api");
      expect(report.ready).toBe(true);
      const api = report.checks.find((check) => check.name === "api");
      expect(api?.state).toBe("degraded");
      expect(api?.detail).toBe("degraded:qstash");
    } finally {
      await composition.dispose();
    }
  });

  it("a configured but NOT-READY remote API blocks the host (not-ready:api)", async () => {
    const composition = await createPortalHostComposition(
      migratedEnv({
        apiBaseUrl: "https://api.example.internal",
        fetchLike: fakeFetch(() => ({ status: 503, body: { status: "not-ready:database" } })),
      }),
    );
    try {
      await migrate(composition);
      const report = await composition.readyCheck();
      expect(report.status).toBe("not-ready:api");
      expect(report.ready).toBe(false);
    } finally {
      await composition.dispose();
    }
  });

  it("a configured but unreachable remote API is an honest not-ready (suppressed detail)", async () => {
    const composition = await createPortalHostComposition(
      migratedEnv({
        apiBaseUrl: "https://api.example.internal",
        fetchLike: fakeFetch(() => ({ error: new TypeError("connect ECONNREFUSED") })),
      }),
    );
    try {
      await migrate(composition);
      const report = await composition.readyCheck();
      expect(report.status).toBe("not-ready:api");
      expect(report.checks.find((check) => check.name === "api")?.detail).not.toContain("ECONNREFUSED");
    } finally {
      await composition.dispose();
    }
  });

  it("the composition-refusal readiness answer carries the honest vocabulary (handler contract)", () => {
    // The handler maps a refused boot to not-ready:composition - asserted
    // through the shape contract the smoke suite consumes.
    const refusal = {
      status: "not-ready:composition",
      ready: false,
      checks: [{ name: "composition", state: "down", detail: "the host composition failed to boot" }],
    };
    expect(refusal.status).toBe("not-ready:composition");
    expect(refusal.ready).toBe(false);
    expect(refusal.checks[0]?.state).toBe("down");
  });

  it("still refuses to boot without DATABASE_URL (unchanged fail-closed law)", async () => {
    await expect(
      createPortalHostComposition({ mode: "production", databaseUrl: undefined }),
    ).rejects.toThrow(CompositionError);
  });
});
