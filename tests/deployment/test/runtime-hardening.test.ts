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
 *    an incompatible endpoint refuses mutations diagnosably.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryJobDeliveryQueue } from "@roamlink/provider-qstash";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";

import {
  createOutboxDrain,
  ManualWorkerTimer,
  type OutboxDeliveryPort,
} from "@roamlink/workers";
import { isAuthorizedCronRequest, runDailyMaintenance } from "../../../apps/portal-host/src/maintenance.js";
import { runAdcosProductionProbe, ADCOS_PROBE_EXIT_CODES } from "@roamlink/compat";

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
});
