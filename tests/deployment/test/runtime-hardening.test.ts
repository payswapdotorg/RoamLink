/**
 * RL-105/RL-106/RL-107/RL-108 deployment pins — the runtime-hardening
 * behaviors, verified through the deterministic deployment world:
 *
 *  - WORKER DRAIN LIFECYCLE (RL-107): the production drain loop sweeps
 *    stranded claims BEFORE its first claim (the AR-007/RL-093 restart
 *    discipline this wave was gated on), drains bounded batches, lands
 *    terminal states that are never resurrected, and an abandoned
 *    mid-batch claim re-owns on the restarted drain;
 *  - CRON ROUTE (RL-107): /api/maintenance/daily is a THIN, AUTHENTICATED,
 *    IDEMPOTENT kick — fail-closed on a missing/foreign bearer, one bounded
 *    sweep per call, deterministic per-day job ids on the event-driven path;
 *  - PROBE FAIL-CLOSED (RL-108): the production ADCOS probe is honest-
 *    not-configured when the env is absent (exit-distinct, never blocking
 *    local/CI), and when configured it applies the fail-closed state —
 *    an incompatible endpoint refuses mutations diagnosably;
 *  - ENV-GATED REAL LEGS (PA-013): the distributed limiter under live
 *    load over the operator-provided Upstash Redis accelerator, and the
 *    RL-107 escalation kick over the live QStash publish API — absent
 *    keys produce the NAMED skips (the AR-010 operator-phase discipline).
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { nowUtc } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import {
  InMemoryJobDeliveryQueue,
  tryParseQStashEnv,
  UpstashQStashClient,
} from "@roamlink/provider-qstash";
import {
  DistributedFixedWindowLimiter,
  tryParseUpstashRedisEnv,
  UpstashRedisRestClient,
} from "@roamlink/provider-redis";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";

import {
  createOutboxDrain,
  ManualWorkerTimer,
  type OutboxDeliveryPort,
} from "@roamlink/workers";
import { isAuthorizedCronRequest, runDailyMaintenance } from "../../../apps/portal-host/src/maintenance.js";
import {
  runAdcosProductionProbe,
  ADCOS_PROBE_EXIT_CODES,
  ADCOS_INTEGRATION_HEALTH_STATES,
  adcosIntegrationHealthStateOf,
} from "@roamlink/compat";
import { AdcosCompatibilityState } from "@roamlink/integration";

const T0 = "2026-10-01T06:00:00.000Z";
const T1 = "2026-10-01T06:00:01.000Z";

function deliveredPort(delivered: string[]): OutboxDeliveryPort {
  return {
    async deliver(record) {
      delivered.push(record.idempotencyKey);
      return { outcome: "DELIVERED" };
    },
  };
}

describe("RL-107 pin: the worker drain lifecycle", () => {
  it("sweeps stranded claims BEFORE the first claim, drains bounded batches, and never resurrects terminals", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);

    // Seed the crash window: one claim committed, its outcome never did.
    const seed = await persistence.begin();
    for (const key of ["pin-a", "pin-b", "pin-c"]) {
      await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: clock.now() });
    }
    await seed.commit();
    const crashedClaim = await persistence.begin();
    const claimed = await crashedClaim.outbox.claimDue(clock.now(), 10);
    expect(claimed.length).toBe(3);
    await crashedClaim.commit();
    expect(await persistence.outbox.count("DELIVERING")).toBe(3);

    // The restarted worker's drain: start() sweeps BEFORE the first claim.
    const delivered: string[] = [];
    const drain = createOutboxDrain({
      persistence,
      delivery: deliveredPort(delivered),
      now: () => clock.now(),
      timer: new ManualWorkerTimer(),
      batchSize: 2,
    });
    drain.start();
    await drain.whenStartupSettled();
    expect(drain.snapshot().recoveredOnStart).toBe(3); // every stranded claim re-owned
    expect(await persistence.outbox.count("DELIVERING")).toBe(0); // swept to PENDING first
    expect(await persistence.outbox.count("PENDING")).toBe(3); // budget untouched by recovery

    // Bounded batches: 2 + 1 across two ticks; terminal DELIVERED.
    await drain.tickOnce();
    await drain.tickOnce();
    expect(delivered.sort()).toEqual(["pin-a", "pin-b", "pin-c"]);
    expect(await persistence.outbox.count("DELIVERED")).toBe(3);

    // Terminal states are never resurrected: a further tick claims nothing,
    // and the sweep re-owns nothing (no live claims, terminals stay terminal).
    const further = await drain.tickOnce();
    expect(further.claimed).toBe(0);
    const sweepUnit = await persistence.begin();
    expect(await sweepUnit.outbox.recoverInFlight(clock.now())).toEqual([]);
    await sweepUnit.rollback();
  });

  it("a mid-batch loss re-owns on the restart drain (graceful shutdown is safe by construction)", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const seed = await persistence.begin();
    for (const key of ["pin-x", "pin-y"]) {
      await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: clock.now() });
    }
    await seed.commit();

    // Batch 1 claims both records; the "process" is lost before any outcome.
    const lostWorker = await persistence.begin();
    await lostWorker.outbox.claimDue(clock.now(), 10);
    await lostWorker.commit();

    // The restart: sweep-before-claim re-owns, the obligations complete.
    const delivered: string[] = [];
    const drain = createOutboxDrain({
      persistence,
      delivery: deliveredPort(delivered),
      now: () => clock.now(),
      timer: new ManualWorkerTimer(),
    });
    drain.start();
    await drain.whenStartupSettled();
    await drain.tickOnce();
    expect(delivered.sort()).toEqual(["pin-x", "pin-y"]);
    expect(await persistence.outbox.count("DELIVERED")).toBe(2);
  });
});

describe("RL-107 pin: the /api/maintenance/daily cron route", () => {
  it("is fail-closed on authentication (no secret -> refuses every trigger)", () => {
    const probe = (authorization?: string) => ({
      headers: { get: (name: string) => (name === "authorization" ? (authorization ?? null) : null) },
    });
    expect(isAuthorizedCronRequest(probe("Bearer x"), undefined)).toBe(false);
    expect(isAuthorizedCronRequest(probe("Bearer right-secret"), "wrong-secret")).toBe(false);
    expect(isAuthorizedCronRequest(probe("Bearer right-secret"), "right-secret")).toBe(true);
  });

  it("the inline kick is ONE bounded sweep (idempotent), never a long-running job", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const seed = await persistence.begin();
    await seed.outbox.enqueue({ idempotencyKey: "cron-pin-1", payload: {}, createdAt: clock.now() });
    await seed.commit();
    const claim = await persistence.begin();
    await claim.outbox.claimDue(clock.now(), 10);
    await claim.commit();

    const first = await runDailyMaintenance({ persistence, now: () => clock.now() });
    expect(first).toMatchObject({ mode: "inline", outbox: { recovered: 1 } });
    // Idempotent: a retried cron call converges (nothing more to re-own).
    const retry = await runDailyMaintenance({ persistence, now: () => clock.now() });
    expect(retry).toMatchObject({ mode: "inline", outbox: { recovered: 0 } });
    expect(await persistence.outbox.count("PENDING")).toBe(1); // the obligation continues, never faked
  });

  it("the event-driven kick uses deterministic per-day job ids (cron retries are duplicates)", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const queue = new InMemoryJobDeliveryQueue({
      clock,
      signingKey: "qstash-signing-key-never-in-prod",
    });
    const destination = "https://host.example.test/api/maintenance/receiver";
    await runDailyMaintenance({
      persistence,
      asyncDelivery: queue,
      asyncDestination: destination,
      now: () => clock.now(),
    });
    const retry = await runDailyMaintenance({
      persistence,
      asyncDelivery: queue,
      asyncDestination: destination,
      now: () => clock.now(),
    });
    expect(retry.mode).toBe("enqueued");
    if (retry.mode === "enqueued") {
      expect(retry.jobs.map((job) => `${job.jobId}:${job.duplicate ? "dup" : "new"}`).sort()).toEqual([
        "maintenance-daily-20261001-inbox:dup",
        "maintenance-daily-20261001-outbox:dup",
      ]);
    }
  });
});

describe("RL-108 pin: the production ADCOS probe is honest and fail-closed", () => {
  it("an absent ADCOS env reports not-configured (exit-distinct, never blocking local/CI)", async () => {
    const result = await runAdcosProductionProbe({ env: {}, at: T1 });
    expect(result.status).toBe("not-configured");
    expect(ADCOS_PROBE_EXIT_CODES["not-configured"]).toBe(2);
    expect(ADCOS_PROBE_EXIT_CODES["compatible"]).toBe(0);
    expect(ADCOS_PROBE_EXIT_CODES["incompatible"]).toBe(1);
  });

  it("a half-configured ADCOS env fails LOUD, naming the missing keys (never half-configured)", async () => {
    await expect(
      runAdcosProductionProbe({
        env: { ADCOS_API_BASE_URL: "https://adcos.example.test", ADCOS_CLIENT_ID: "roamlink" },
        at: T1,
      }),
    ).rejects.toThrow(/ADCOS_PROBE_CONFIG_INCOMPLETE|incomplete/i);
  });

  it("a compatible endpoint opens the gate; an incompatible one refuses mutations (the §9 law)", async () => {
    const clock = new DeterministicClock(T1);
    const compatible = await runAdcosProductionProbe({
      env: {
        ADCOS_API_BASE_URL: "https://adcos.example.test",
        ADCOS_CLIENT_ID: "roamlink-worker",
        ADCOS_CLIENT_SECRET: "env-only-never-committed",
        ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
      },
      client: new FakeAdcos({ now: () => clock.now() }),
      at: T1,
    });
    expect(compatible.status).toBe("compatible");
    if (compatible.status !== "not-configured") {
      compatible.state.assertMutationsAllowed(); // the gate OPENS on compatible
    }

    const broken = new FakeAdcos({ now: () => clock.now() });
    broken.disableRoute("application_self");
    const incompatible = await runAdcosProductionProbe({
      env: {
        ADCOS_API_BASE_URL: "https://adcos.example.test",
        ADCOS_CLIENT_ID: "roamlink-worker",
        ADCOS_CLIENT_SECRET: "env-only-never-committed",
        ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
      },
      client: broken,
      at: T1,
    });
    expect(incompatible.status).toBe("incompatible");
    if (incompatible.status !== "not-configured") {
      expect(incompatible.state.status()).toBe("incompatible");
      expect(() => incompatible.state.assertMutationsAllowed()).toThrowError(/incompatible/i);
    }
  });

  it("PA-010: the read-only health-state mapping renders the recorded outcome — never a guess", async () => {
    const clock = new DeterministicClock(T1);
    // not-configured: the env gate is off — a first-class honest state.
    const notConfigured = await runAdcosProductionProbe({ env: {}, at: T1 });
    expect(adcosIntegrationHealthStateOf(notConfigured, null)).toBe("not-configured");

    // compatible: the recorded report's status is the surface state.
    const compatible = await runAdcosProductionProbe({
      env: {
        ADCOS_API_BASE_URL: "https://adcos.example.test",
        ADCOS_CLIENT_ID: "roamlink-worker",
        ADCOS_CLIENT_SECRET: "env-only-never-committed",
        ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
      },
      client: new FakeAdcos({ now: () => clock.now() }),
      at: T1,
    });
    expect(adcosIntegrationHealthStateOf(compatible, null)).toBe("compatible");

    // incompatible: same law, fail-closed.
    const broken = new FakeAdcos({ now: () => clock.now() });
    broken.disableRoute("application_self");
    const incompatible = await runAdcosProductionProbe({
      env: {
        ADCOS_API_BASE_URL: "https://adcos.example.test",
        ADCOS_CLIENT_ID: "roamlink-worker",
        ADCOS_CLIENT_SECRET: "env-only-never-committed",
        ADCOS_WEBHOOK_SECRET: "webhook-secret-env-only",
      },
      client: broken,
      at: T1,
    });
    expect(adcosIntegrationHealthStateOf(incompatible, null)).toBe("incompatible");

    // unknown: the AdcosCompatibilityState default before any report is
    // applied (the fail-closed gate) — and nothing recorded at all.
    expect(adcosIntegrationHealthStateOf(null, new AdcosCompatibilityState())).toBe("unknown");
    expect(adcosIntegrationHealthStateOf(null, null)).toBe("unknown");

    // The closed surface vocabulary stays the four honest states.
    expect([...ADCOS_INTEGRATION_HEALTH_STATES]).toEqual([
      "compatible",
      "incompatible",
      "not-configured",
      "unknown",
    ]);
  });
});

// --------------------------------------------------------------------------------
// The env-gated REAL legs (PA-013): the real limiter under load over the
// operator-provided Upstash Redis accelerator (UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN) and the RL-107 escalation path's real transport
// over the operator-provided QStash account (QSTASH_* keys). Absent keys ->
// the NAMED skips below (the AR-010 operator-phase discipline; CI stays
// green with the deterministic cores above). The batteries' skip messages
// and per-leg details live in `packages/provider-redis/test/env-health.test.ts`
// and `packages/provider-qstash/test/client-wire.test.ts` (Legs 1+2 of the
// PA-013 transport batteries); these legs are the deployment-plane pins:
// admission under CONCURRENT load and the maintenance kick over the real
// publish API.
// --------------------------------------------------------------------------------

const REDIS_PARSED = tryParseUpstashRedisEnv(process.env);
const REDIS_CONFIG = REDIS_PARSED.ok ? REDIS_PARSED.config : undefined;

if (!REDIS_CONFIG) {
  console.log(
    "[RL-096/PA-013] SKIPPING the real limiter-under-load leg: the Upstash Redis env surface is not fully configured " +
      "(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN). The leg runs in the operator phase against the live " +
      "accelerator (atomic fixed-window admission under concurrent load, real TTLs) — this skip is named, never a " +
      "silent pass.",
  );
}

const redisReal = REDIS_CONFIG ? it : it.skip;
const RUN_ID = Date.now().toString(36);

describe("RL-096/PA-013 real leg: the distributed limiter under live load", () => {
  redisReal(
    "admits exactly maxCost under concurrent load over the live accelerator (atomic increments, real TTL)",
    async () => {
      const config = REDIS_CONFIG;
      if (!config) throw new Error("unreachable: the gate above decides these legs");
      const port = new UpstashRedisRestClient({ baseUrl: config.baseUrl, token: config.token });
      const windowMs = 60_000;
      const maxCost = 25;
      const keyPrefix = `ratelimit:pa013:${RUN_ID}`;
      const limiter = new DistributedFixedWindowLimiter({ windowMs, maxCost, keyPrefix }, port);
      const subject = "load-1";
      // ONE caller instant -> ONE epoch-aligned bucket BY CONSTRUCTION (the
      // bucket derives purely from `at`), so the concurrent burst counts
      // against a single window key regardless of wire timing.
      const at = new Date().toISOString();
      const decisions = await Promise.all(
        Array.from({ length: 50 }, () => limiter.tryTake(subject, 1, at)),
      );
      const allowed = decisions.filter((decision) => decision.allowed).length;
      const denied = decisions.filter(
        (decision): decision is Extract<typeof decision, { allowed: false }> => !decision.allowed,
      );
      // Atomicity on the live wire: the pinned EVAL increment assigns a
      // distinct count to every caller, so exactly maxCost are admitted —
      // a lost update would over-admit, a race would double-count.
      expect(allowed).toBe(maxCost);
      expect(denied).toHaveLength(50 - maxCost);
      for (const decision of denied) {
        expect(decision.remaining).toBe(0);
        expect(decision.retryAfterMs).toBeGreaterThan(0);
        expect(decision.retryAfterMs).toBeLessThanOrEqual(windowMs);
      }
      // The window key carries a real TTL (bounded state self-destructs).
      const bucket = Math.floor(Date.parse(at) / windowMs);
      const ttl = await port.timeToLiveMs(`${keyPrefix}:${subject}:${bucket}`);
      expect(ttl).not.toBeNull();
      expect(ttl as number).toBeGreaterThan(0);
      expect(ttl as number).toBeLessThanOrEqual(windowMs);
    },
    60_000,
  );
});

const QSTASH_PARSED = tryParseQStashEnv(process.env);
const QSTASH_CONFIG = QSTASH_PARSED.ok ? QSTASH_PARSED.config : undefined;

if (!QSTASH_CONFIG) {
  console.log(
    "[RL-097/PA-013] SKIPPING the escalation-path real-transport leg: the QStash env surface is not configured " +
      "(QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, optional QSTASH_URL). The leg runs in " +
      "the operator phase against the live publish API (the RL-107 event-driven maintenance kick over the real " +
      "transport) — this skip is named, never a silent pass.",
  );
}

const qstashReal = QSTASH_CONFIG ? it : it.skip;

/** UTC `yyyymmdd` stamp mirroring the maintenance module's per-day ids. */
function utcDateStamp(at: string): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}${month}${day}`;
}

describe("RL-107/PA-013 real leg: the escalation kick over the live transport", () => {
  qstashReal(
    "enqueues its deterministic per-day jobs through the REAL publish API",
    async () => {
      const config = QSTASH_CONFIG;
      if (!config) throw new Error("unreachable: the gate above decides these legs");
      const client = new UpstashQStashClient({
        token: config.token,
        ...(config.baseUrl !== null ? { baseUrl: config.baseUrl } : {}),
      });
      const persistence = createInMemoryPersistence();
      // The battery's destination: the operator-configured maintenance
      // receiver when present (the production wiring reads the same key),
      // else the battery's RFC 2606 `.invalid` sink — a hostname that can
      // NEVER resolve, so nothing beyond the operator's own QStash account
      // is contacted (the leg proves the ENQUEUE transport contract; the
      // signed delivery round-trip is the client-wire battery's receiver
      // leg). The per-day ids make any same-day replay a transport-side
      // duplicate — durable idempotency stays the LEDGER's job (RL-LOCK-014).
      const destination =
        process.env.ROAMLINK_MAINTENANCE_DESTINATION?.trim() ||
        "https://receiver.invalid/roamlink-transport-battery";
      const result = await runDailyMaintenance({
        persistence,
        asyncDelivery: client,
        asyncDestination: destination,
        now: () => nowUtc(),
      });
      expect(result.mode).toBe("enqueued");
      if (result.mode !== "enqueued") return;
      const day = utcDateStamp(new Date().toISOString());
      expect(result.jobs.map((job) => job.jobId).sort()).toEqual([
        `maintenance-daily-${day}-inbox`,
        `maintenance-daily-${day}-outbox`,
      ]);
      for (const job of result.jobs) {
        expect(job.accepted).toBe(true);
      }
    },
    60_000,
  );
});
