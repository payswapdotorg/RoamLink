/**
 * The composed readiness surface contract tests (RL-100).
 *
 * spec/deployment.md §7: "health/readiness is real, not fake"; "Redis is
 * optional for correctness". These tests prove, with NO network and NO real
 * infrastructure:
 *
 *  - the exact honest vocabulary `ready | degraded:<dep> | not-ready:<reason>`
 *    (never anything else on the wire, never a hard-coded ready);
 *  - the classification law: a REQUIRED dependency (the PostgreSQL source
 *    of truth, the migration ledger) being down is `not-ready`; an OPTIONAL
 *    accelerator/transport (Redis/QStash/R2) being down only ever DEGRADES
 *    - its absence can never fail readiness for correctness it does not own;
 *  - every dependency state comes from an ACTUAL probe through the adapter
 *    ports (the provider packages' in-memory fakes drive the same
 *    health-check factories the hosted composition binds) - no business
 *    event is ever consulted;
 *  - the aggregation is LIVE (flipping a dependency's state flips the very
 *    next answer) and probes that throw/return garbage are `down` with a
 *    SUPPRESSED detail (RL-LOCK-016);
 *  - the route is unauthenticated (load balancers/smoke probe it) and the
 *    HTTP code tracks servability (200 ready/degraded, 503 not-ready).
 */
import { describe, expect, it } from "vitest";
import { parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import type { HttpRequest, HttpResponse } from "@roamlink/app-kit";
import type { WebhookVerifier } from "@roamlink/adcos";
import {
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "@roamlink/auth";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import { databaseHealthCheck, type SqlDriver } from "@roamlink/persistence-postgres";
import {
  createRedisHealthCheck,
  InMemoryEphemeralCoordination,
} from "@roamlink/provider-redis";
import {
  createObjectStorageHealthCheck,
  InMemoryObjectStorage,
  type ObjectStoragePort,
} from "@roamlink/provider-r2";
import {
  composeReadiness,
  createApiService,
  READINESS_STATUS_PATTERN,
  type ComposedReadinessReport,
  type ReadinessCheckBinding,
  type ReadinessCriticality,
} from "../src/index.js";
import type { HealthCheck, HealthCheckOutput, HealthState } from "@roamlink/observability";

const T0: UtcInstant = parseUtcInstant("2026-01-15T08:30:00.000Z");
const T1: UtcInstant = parseUtcInstant("2026-01-15T08:30:01.000Z");

// --------------------------------------------------------------------------------
// Deterministic fake probes (the check-layer equivalent of the provider fakes)
// --------------------------------------------------------------------------------

type FakeProbeMode = HealthState | "throw" | "garbage";

/** A controllable check: `set` flips the dependency's REAL probe outcome. */
function controllableCheck(
  name: string,
  initial: FakeProbeMode = "healthy",
): { readonly check: HealthCheck; readonly set: (mode: FakeProbeMode) => void } {
  let mode: FakeProbeMode = initial;
  return {
    set: (next) => {
      mode = next;
    },
    check: {
      name,
      run: (): HealthCheckOutput => {
        if (mode === "throw") throw new Error("probe failure that may embed endpoint details");
        if (mode === "garbage") {
          return { name, state: "excellent", detail: "not a state", checkedAt: T0 };
        }
        return {
          name,
          state: mode,
          ...(mode === "healthy" ? {} : { detail: `${name} reported ${mode} (suppressed-safe detail)` }),
          checkedAt: T0,
        };
      },
    },
  };
}

function binding(
  name: string,
  criticality: ReadinessCriticality,
  initial: FakeProbeMode = "healthy",
): { readonly binding: ReadinessCheckBinding; readonly set: (mode: FakeProbeMode) => void } {
  const controlled = controllableCheck(name, initial);
  return { binding: { check: controlled.check, criticality }, set: controlled.set };
}

// --------------------------------------------------------------------------------
// composeReadiness: the classification law
// --------------------------------------------------------------------------------

describe("composeReadiness (RL-100): the honest vocabulary", () => {
  it("reports ready ONLY when every composed dependency probed healthy", async () => {
    const database = binding("database", "required");
    const migrations = binding("migrations", "required");
    const composed = composeReadiness({
      checks: [database.binding, migrations.binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("ready");
    expect(report.ready).toBe(true);
    expect(report.evaluatedAt).toBe(T1);
    expect(report.checks.map((check) => check.name).sort()).toEqual(["database", "migrations"]);
  });

  it("is not-ready when the REQUIRED database is down (correctness owner)", async () => {
    const database = binding("database", "required", "down");
    const composed = composeReadiness({
      checks: [database.binding, binding("migrations", "required").binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:database");
    expect(report.ready).toBe(false);
    expect(READINESS_STATUS_PATTERN.test(report.status)).toBe(true);
  });

  it("is not-ready when the migration ledger check is down (schema not applied)", async () => {
    const migrations = binding("migrations", "required", "down");
    const composed = composeReadiness({
      checks: [binding("database", "required").binding, migrations.binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:migrations");
    expect(report.ready).toBe(false);
  });

  it("never lets an OPTIONAL accelerator's absence fail readiness (degraded, still servable)", async () => {
    // deployment.md §7 "Redis is optional for correctness": a down Redis is
    // degraded:redis + ready=true - NEVER not-ready, NEVER hidden.
    const redis = binding("redis", "optional", "down");
    const composed = composeReadiness({
      checks: [binding("database", "required").binding, binding("migrations", "required").binding, redis.binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("degraded:redis");
    expect(report.ready).toBe(true);
    const redisResult = report.checks.find((check) => check.name === "redis");
    expect(redisResult?.state).toBe("down");
    expect(redisResult?.detail).toBeDefined();
  });

  it("maps a REQUIRED dependency's degraded state onto degraded:<dep> (servable, surfaced)", async () => {
    const migrations = binding("migrations", "required", "degraded");
    const composed = composeReadiness({
      checks: [binding("database", "required").binding, migrations.binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("degraded:migrations");
    expect(report.ready).toBe(true);
  });

  it("sorts multiple unhealthy dependencies deterministically", async () => {
    const composed = composeReadiness({
      checks: [
        binding("database", "required").binding,
        binding("qstash", "optional", "down").binding,
        binding("redis", "optional", "down").binding,
        binding("object-storage", "optional", "down").binding,
      ],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("degraded:object-storage,qstash,redis");
  });

  it("blocks on the required failure even when an accelerator is also down", async () => {
    const composed = composeReadiness({
      checks: [
        binding("database", "required", "down").binding,
        binding("redis", "optional", "down").binding,
      ],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:database");
    expect(report.ready).toBe(false);
    // The degraded accelerator is still honestly visible per-check.
    expect(report.checks.find((check) => check.name === "redis")?.state).toBe("down");
  });

  it("refuses to fake readiness when NO checks are registered (fail closed)", async () => {
    const composed = composeReadiness({ checks: [], now: () => T1 });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:composition");
    expect(report.ready).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.name).toBe("composition");
    expect(report.checks[0]?.state).toBe("down");
    expect(READINESS_STATUS_PATTERN.test(report.status)).toBe(true);
  });

  it("treats a throwing probe as down with a SUPPRESSED detail (RL-LOCK-016)", async () => {
    const database = binding("database", "required", "throw");
    const composed = composeReadiness({
      checks: [database.binding, binding("migrations", "required").binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:database");
    const result = report.checks.find((check) => check.name === "database");
    expect(result?.state).toBe("down");
    expect(result?.detail).toBeDefined();
    expect(result?.detail).not.toContain("endpoint details");
    expect(result?.detail).not.toContain("probe failure");
  });

  it("treats a garbage probe result as down (a lying check can never pass)", async () => {
    const database = binding("database", "required", "garbage");
    const composed = composeReadiness({
      checks: [database.binding, binding("migrations", "required").binding],
      now: () => T1,
    });
    const report = await composed.report();
    expect(report.status).toBe("not-ready:database");
    expect(report.checks.find((check) => check.name === "database")?.state).toBe("down");
  });

  it("re-aggregates LIVE: flipping a dependency flips the very next answer (no snapshot)", async () => {
    const redis = binding("redis", "optional");
    const composed = composeReadiness({
      checks: [binding("database", "required").binding, redis.binding],
      now: () => T1,
    });
    const first = await composed.report();
    expect(first.status).toBe("ready");

    redis.set("down");
    const second = await composed.report();
    expect(second.status).toBe("degraded:redis");
    expect(second.ready).toBe(true);

    redis.set("healthy");
    const third = await composed.report();
    expect(third.status).toBe("ready");
  });

  it("rejects duplicate check names at composition time (fail loud, never silent skip)", () => {
    const first = binding("redis", "optional");
    const second = binding("redis", "optional");
    expect(() =>
      composeReadiness({ checks: [first.binding, second.binding], now: () => T1 }),
    ).toThrow(/already registered/i);
  });
});

// --------------------------------------------------------------------------------
// The provider-port integration: the SAME health-check factories the hosted
// composition binds, driven by the packages' in-memory fakes (no network).
// --------------------------------------------------------------------------------

describe("composeReadiness (RL-100): dependency checks through the adapter ports", () => {
  it("the PostgreSQL check is the persistence driver's REAL liveness probe", async () => {
    const healthyDriver: SqlDriver = {
      label: "stub-pg",
      query: async () => ({ rows: [], rowCount: 0 }),
      exec: async () => ({ rows: [], rowCount: 0 }),
      begin: async () => {
        throw new Error("not exercised by the probe");
      },
      ping: async () => {},
      close: async () => {},
    };
    const downDriver: SqlDriver = {
      ...healthyDriver,
      ping: async () => {
        throw new Error("connection refused ep-host.example.internal:5432");
      },
    };
    const composed = composeReadiness({
      checks: [
        { check: databaseHealthCheck(healthyDriver), criticality: "required" },
        binding("migrations", "required").binding,
      ],
      now: () => T1,
    });
    expect((await composed.report()).status).toBe("ready");

    const broken = composeReadiness({
      checks: [
        { check: databaseHealthCheck(downDriver), criticality: "required" },
        binding("migrations", "required").binding,
      ],
      now: () => T1,
    });
    const report = await broken.report();
    expect(report.status).toBe("not-ready:database");
    const detail = report.checks.find((check) => check.name === "database")?.detail;
    // Suppressed: the driver error may embed the endpoint (RL-LOCK-016).
    expect(detail).toBeDefined();
    expect(detail).not.toContain("ep-host.example.internal");
  });

  it("the Redis check rides the EphemeralCoordinationPort (fake healthy, stub down)", async () => {
    const clock = new DeterministicClock(T0);
    const healthy = new InMemoryEphemeralCoordination({ clock });
    const downPort = {
      get: async () => null,
      setWithTtl: async () => ({ stored: false }),
      delete: async () => false,
      incrementWithTtl: async () => ({ count: 1, firstIncrement: true }),
      timeToLiveMs: async () => null,
      ping: async () => false,
    };

    const composed = composeReadiness({
      checks: [
        { check: createRedisHealthCheck({ port: healthy, clock }), criticality: "optional" },
      ],
      now: () => T1,
    });
    expect((await composed.report()).status).toBe("ready");

    const degraded = composeReadiness({
      checks: [{ check: createRedisHealthCheck({ port: downPort, clock }), criticality: "optional" }],
      now: () => T1,
    });
    const report = await degraded.report();
    expect(report.status).toBe("degraded:redis");
    expect(report.ready).toBe(true);
  });

  it("the object-storage check rides the ObjectStoragePort (fake healthy, stub down)", async () => {
    const healthy = new InMemoryObjectStorage();
    const downPort: ObjectStoragePort = {
      put: async () => {
        throw new Error("unreachable");
      },
      get: async () => {
        throw new Error("signature round trip failed (may embed credentials)");
      },
      delete: async () => {
        throw new Error("unreachable");
      },
      list: async () => {
        throw new Error("unreachable");
      },
      presign: async () => {
        throw new Error("unreachable");
      },
    };

    const composed = composeReadiness({
      checks: [
        { check: createObjectStorageHealthCheck({ port: healthy }), criticality: "optional" },
      ],
      now: () => T1,
    });
    expect((await composed.report()).status).toBe("ready");

    const degraded = composeReadiness({
      checks: [{ check: createObjectStorageHealthCheck({ port: downPort }), criticality: "optional" }],
      now: () => T1,
    });
    const report = await degraded.report();
    expect(report.status).toBe("degraded:object-storage");
    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.name === "object-storage")?.detail).not.toContain("credentials");
  });
});

// --------------------------------------------------------------------------------
// The service route: GET /v1/readiness (unauthenticated, servable codes)
// --------------------------------------------------------------------------------

function createServiceWithReadiness(
  readinessChecks?: readonly ReadinessCheckBinding[],
): { handle(request: HttpRequest): Promise<HttpResponse> } {
  const clock = new DeterministicClock(T0);
  const ids = new DeterministicUuidGenerator(30_000);
  const users = new InMemoryUserRepository();
  const directory = new InMemoryUserDirectory(users);
  const credentials = new InMemoryCredentialRepository();
  const organizations = new InMemoryOrganizationRepository();
  const memberships = new InMemoryMembershipRepository();
  const sessions = new InMemoryAuthSessionRepository();
  const ledger = new InMemoryIdempotencyLedger();
  const hasher = new InsecureTestPasswordHasher();
  const webhookVerifier: WebhookVerifier = {
    verify: async () => {
      throw new Error("the webhook verifier must be configured for webhook tests");
    },
  };
  const service = createApiService({
    persistence: createInMemoryPersistence(),
    identity: { users, directory, credentials, sessions, memberships, organizations, ledger, hasher },
    webhookVerifier,
    now: () => clock.now(),
    newId: () => ids.next(),
    ...(readinessChecks !== undefined ? { readinessChecks } : {}),
  });
  return service;
}

async function getReadiness(service: ReturnType<typeof createServiceWithReadiness>): Promise<{
  status: number;
  report: ComposedReadinessReport;
}> {
  const response = await service.handle({ method: "GET", path: "/v1/readiness", headers: {} });
  return { status: response.status, report: JSON.parse(response.body ?? "") as ComposedReadinessReport };
}

describe("GET /v1/readiness (RL-100): the unauthenticated composed surface", () => {
  it("answers the honest vocabulary WITHOUT any session/authorization", async () => {
    const service = createServiceWithReadiness([
      { check: binding("database", "required").binding.check, criticality: "required" },
      { check: binding("migrations", "required").binding.check, criticality: "required" },
    ]);
    const { status, report } = await getReadiness(service);
    expect(status).toBe(200);
    expect(report.status).toBe("ready");
    expect(report.ready).toBe(true);
    expect(READINESS_STATUS_PATTERN.test(report.status)).toBe(true);
    expect(report.checks.length).toBe(2);
  });

  it("answers 503 not-ready:<dep> when a required dependency is down", async () => {
    const database = binding("database", "required", "down");
    const service = createServiceWithReadiness([
      database.binding,
      { check: binding("migrations", "required").binding.check, criticality: "required" },
    ]);
    const { status, report } = await getReadiness(service);
    expect(status).toBe(503);
    expect(report.status).toBe("not-ready:database");
    expect(report.ready).toBe(false);
  });

  it("answers 200 degraded:<dep> when only an optional accelerator is down", async () => {
    const redis = binding("redis", "optional", "down");
    const service = createServiceWithReadiness([
      { check: binding("database", "required").binding.check, criticality: "required" },
      redis.binding,
    ]);
    const { status, report } = await getReadiness(service);
    expect(status).toBe(200);
    expect(report.status).toBe("degraded:redis");
    expect(report.ready).toBe(true);
  });

  it("re-probes on every request (the endpoint never caches a boot-time verdict)", async () => {
    const redis = binding("redis", "optional");
    const service = createServiceWithReadiness([
      { check: binding("database", "required").binding.check, criticality: "required" },
      redis.binding,
    ]);
    expect((await getReadiness(service)).report.status).toBe("ready");
    redis.set("degraded");
    const second = await getReadiness(service);
    expect(second.report.status).toBe("degraded:redis");
    expect(second.status).toBe(200);
  });

  it("with no readiness bindings the endpoint honestly reports not-ready:composition (503)", async () => {
    const { status, report } = await getReadiness(createServiceWithReadiness(undefined));
    expect(status).toBe(503);
    expect(report.status).toBe("not-ready:composition");
    expect(report.ready).toBe(false);
  });
});
