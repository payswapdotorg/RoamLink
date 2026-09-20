/**
 * RL-110 — the scheduled/event-driven RECOVERY JOB BATTERY.
 *
 * The RL-107 production machinery is LANDED (the worker host, the
 * authenticated idempotent /api/maintenance/daily cron route, the QStash
 * DurableJobDeliveryPort + receiver verifier, the RL-093/094 recovery
 * semantics). THIS battery proves recovery actually HAPPENS through the
 * PUBLIC entry points only — no test-only backdoors, no seams opened:
 *
 *   (1) SCHEDULED PATH: a composed data plane with seeded failure states —
 *       outbox records stuck DELIVERING across a simulated crash/restart,
 *       and an inbox backlog DEEPER than one processPending batch — driven
 *       through the CRON ROUTE exactly as the scheduler would
 *       (authenticated, Bearer CRON_SECRET, via the real route handler).
 *       The obligations complete: the sweep re-owns and the worker drain
 *       delivers; repeated bounded kicks ADVANCE beyond the first batch and
 *       drain the backlog (ceil(N/limit) kicks);
 *   (2) EVENT-DRIVEN ESCALATION: when the scheduled window is missed, the
 *       QStash event path fires the same recovery — the cron trigger
 *       enqueues the durable jobs (deterministic per-day ids), the
 *       transport delivers to the REAL receiver (signature VERIFIED, then
 *       the same bounded sweeps execute through the receiver);
 *   (3) HONEST NOT-CONFIGURED: without the receiver-side QStash signing
 *       keys the receiver refuses EVERY delivery (503, typed reason) and
 *       never fakes a trigger (AR-009 discipline);
 *   (4) REAL-DATABASE leg (DATABASE_URL-gated, honest skip otherwise): the
 *       scheduled-path scenario over a REAL pooled PostgreSQL.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { createInMemoryPersistence, type InMemoryPersistence } from "@roamlink/persistence";
import { InMemoryJobDeliveryQueue, renderQStashSignatureHeader } from "@roamlink/provider-qstash";

import { createOutboxDrain, ManualWorkerTimer, type OutboxDeliveryPort } from "@roamlink/workers";
import {
  handleMaintenanceDaily,
  handleMaintenanceReceiver,
} from "../../../apps/portal-host/src/handlers.js";
import {
  runDailyMaintenance,
  isAuthorizedCronRequest,
} from "../../../apps/portal-host/src/maintenance.js";
import { createMaintenanceReceiver } from "../../../apps/portal-host/src/maintenance-receiver.js";
import { makeDeploymentWorld, EVENT_TTL_MS } from "../src/harness.js";

const T0 = "2026-10-01T06:00:00.000Z";
const CRON_SECRET = "battery-cron-secret-env-shaped";
const RECEIVER_DESTINATION = "https://host.example.test/api/maintenance/receiver";
/** The bounded batch the battery's scheduler uses (the backlog is DEEPER). */
const INBOX_BATCH_LIMIT = 2;
const OUTBOX_KEYS = ["battery-outbox-a", "battery-outbox-b", "battery-outbox-c"];

function deliveredPort(delivered: string[]): OutboxDeliveryPort {
  return {
    async deliver(record) {
      delivered.push(record.idempotencyKey);
      return { outcome: "DELIVERED" };
    },
  };
}

/** Seeds the crash window: N claims committed, their outcomes never did. */
async function seedStrandedClaims(persistence: InMemoryPersistence, keys: readonly string[], clock: DeterministicClock) {
  const seed = await persistence.begin();
  for (const key of keys) {
    await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: clock.now() });
  }
  await seed.commit();
  const crashedClaim = await persistence.begin();
  const claimed = await crashedClaim.outbox.claimDue(clock.now(), keys.length);
  expect(claimed.length).toBe(keys.length);
  await crashedClaim.commit();
  expect(await persistence.outbox.count("DELIVERING")).toBe(keys.length);
}

/** The cron route request exactly as the scheduler delivers it (Vercel cron: Bearer). */
function cronRequest(): Request {
  return new Request("https://host.example.test/api/maintenance/daily", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

/** The battery's host runtime: the real handlers over the real maintenance seam. */
function batteryRuntime(run: () => ReturnType<typeof runDailyMaintenance>, receiver: unknown = null) {
  return {
    ok: true as const,
    composition: {
      maintenance: { cronSecret: CRON_SECRET, run, receiver },
    },
  };
}

/** The data plane the battery composes: persistence + the REAL inbox boundary. */
async function batteryWorld(clock: DeterministicClock, backlogSize: number) {
  const world = makeDeploymentWorld({ startAt: T0 });
  // The webhook backlog: DEEPER than one bounded batch (admission order).
  for (let index = 1; index <= backlogSize; index += 1) {
    await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: `battery-${index}` } },
        ],
        validity: { start: clock.now(), end: "2026-12-01T06:00:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: clock.now(),
      },
      { idempotencyKey: `idem.battery.intent.${index}` as never },
    );
  }
  const outcomes = await world.admitAll();
  expect(outcomes.every((outcome) => outcome === "ADMITTED")).toBe(true);
  return world;
}

describe("RL-110 (1) the scheduled path: the cron route re-owns stranded claims and drains a deeper-than-one-batch backlog", () => {
  it("repeated authenticated kicks + the worker drain complete every obligation (ceil(N/limit) kicks)", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const world = await batteryWorld(clock, 7); // 7 admitted; the batch is 2
    await seedStrandedClaims(persistence, OUTBOX_KEYS, clock);
    expect(await world.plane.boundary.projections.count()).toBe(0);

    // The production consumer: the worker drain over the SAME persistence.
    const delivered: string[] = [];
    const drain = createOutboxDrain({
      persistence,
      delivery: deliveredPort(delivered),
      now: () => clock.now(),
      timer: new ManualWorkerTimer(),
      batchSize: 2,
    });

    // The scheduler's trigger: the REAL cron route handler, AUTHENTICATED.
    const kick = async () => {
      const response = await handleMaintenanceDaily(
        cronRequest(),
        batteryRuntime(() =>
          runDailyMaintenance({
            persistence,
            inbox: world.plane.boundary.inbox,
            now: () => clock.now(),
            inboxBatchLimit: INBOX_BATCH_LIMIT,
          }),
        ) as never,
      );
      expect(response.status).toBe(200);
      return (JSON.parse(await response.text()) as {
        mode: "inline";
        outbox: { recovered: number };
        inbox: { drained: boolean; report?: { applied: number } };
      });
    };

    // Kick 1: the sweep re-owns ALL stranded claims; one bounded batch (2)
    // of the backlog projects. The drain delivers the first two obligations.
    const first = await kick();
    expect(first.mode).toBe("inline");
    expect(first.outbox.recovered).toBe(3); // the RL-093 sweep re-owns
    expect(await persistence.outbox.count("DELIVERING")).toBe(0);
    expect(await persistence.outbox.count("PENDING")).toBe(3); // budget untouched
    expect(first.inbox.drained && first.inbox.report?.applied).toBe(2); // ONE bounded batch
    expect(await world.plane.boundary.projections.count()).toBe(2); // ADVANCED beyond nothing

    await drain.tickOnce();
    expect(delivered.length).toBe(2);

    // Kick 2 + drain: the backlog ADVANCES past the first batch (2 more);
    // the drain's second bounded batch delivers the remaining obligation.
    const second = await kick();
    expect(second.outbox.recovered).toBe(0); // nothing stranded any more
    expect(second.inbox.drained && second.inbox.report?.applied).toBe(2);
    await drain.tickOnce();
    expect(delivered.length).toBe(3); // bounded batches: 2 then 1
    expect(await persistence.outbox.count("DELIVERED")).toBe(3);
    expect(await world.plane.boundary.projections.count()).toBe(4);

    // Kicks 3 + 4 drain the backlog tail (2 + 1 = the full 7).
    await kick();
    await kick();
    expect(await world.plane.boundary.projections.count()).toBe(7); // FULLY DRAINED
    expect(await persistence.outbox.count("PENDING")).toBe(0);

    // The run is complete: further kicks are idempotent no-ops.
    const settled = await kick();
    expect(settled.outbox.recovered).toBe(0);
    expect(settled.inbox.drained && settled.inbox.report?.applied).toBe(0);
    expect(delivered.sort()).toEqual([...OUTBOX_KEYS].sort());
  });

  it("an UNAUTHENTICATED cron request never triggers the sweep (fail-closed)", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    await seedStrandedClaims(persistence, ["battery-unauth"], clock);
    const response = await handleMaintenanceDaily(
      new Request("https://host.example.test/api/maintenance/daily"),
      batteryRuntime(() => runDailyMaintenance({ persistence, now: () => clock.now() })) as never,
    );
    expect(response.status).toBe(401);
    expect(await persistence.outbox.count("DELIVERING")).toBe(1); // untouched
  });
});

describe("RL-110 (2) the event-driven escalation: the QStash path fires the same recovery through the verified receiver", () => {
  it("missed scheduled window -> durable jobs -> signature-verified receiver executes the sweeps", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const world = await batteryWorld(clock, 3);
    await seedStrandedClaims(persistence, ["battery-esc-1", "battery-esc-2"], clock);

    // The event-driven channel: the deterministic provider fake over the
    // SAME DurableJobDeliveryPort contract the Upstash client implements.
    const queue = new InMemoryJobDeliveryQueue({
      clock,
      signingKey: "battery-receiver-signing-key",
    });

    // The REAL receiver the jobs are delivered to (verify-before-acting).
    const receiver = createMaintenanceReceiver({
      persistence,
      inbox: world.plane.boundary.inbox,
      signingKeys: { current: "battery-receiver-signing-key" },
      now: () => clock.now(),
      inboxBatchLimit: INBOX_BATCH_LIMIT,
    });
    const receiverStatus = async (delivery: {
      destination: string;
      payload: string;
      signatureHeader: string;
    }): Promise<number> => {
      const response = await receiver.handle(
        new Request(delivery.destination, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "upstash-signature": delivery.signatureHeader,
          },
          body: delivery.payload,
        }),
      );
      return response.status;
    };

    // The scheduled window is MISSED (no cron kick runs the sweeps inline):
    // the trigger enqueues the two durable jobs (deterministic per-day ids).
    const enqueued = await runDailyMaintenance({
      persistence,
      asyncDelivery: queue,
      asyncDestination: RECEIVER_DESTINATION,
      now: () => clock.now(),
    });
    expect(enqueued.mode).toBe("enqueued");
    if (enqueued.mode === "enqueued") {
      expect(enqueued.jobs.map((job) => job.jobId).sort()).toEqual([
        `maintenance-daily-${"20261001"}-inbox`,
        `maintenance-daily-${"20261001"}-outbox`,
      ]);
    }

    // The transport delivers; the receiver VERIFIES every signature (2xx).
    const attempts = await queue.runDueDeliveries(receiverStatus);
    expect(attempts).toBe(2);
    // The SAME recovery the inline kick performs has happened:
    expect(await persistence.outbox.count("DELIVERING")).toBe(0); // sweep re-owned
    expect(await persistence.outbox.count("PENDING")).toBe(2);
    expect(await world.plane.boundary.projections.count()).toBe(INBOX_BATCH_LIMIT); // bounded batch applied
  });

  it("a TAMPERED signature is refused (401) and the sweep NEVER runs", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    await seedStrandedClaims(persistence, ["battery-tampered"], clock);
    const receiver = createMaintenanceReceiver({
      persistence,
      signingKeys: { current: "battery-receiver-signing-key" },
      now: () => clock.now(),
    });
    const body = JSON.stringify({ kind: "maintenance.outbox-sweep", at: clock.now() });
    const forged = renderQStashSignatureHeader("a-foreign-signing-key", Math.floor(Date.parse(T0) / 1000), body);
    const response = await receiver.handle(
      new Request(RECEIVER_DESTINATION, {
        method: "POST",
        headers: { "content-type": "application/json", "upstash-signature": forged },
        body,
      }),
    );
    expect(response.status).toBe(401);
    expect(await persistence.outbox.count("DELIVERING")).toBe(1); // untouched
  });
});

describe("RL-110 (3) the honest not-configured: no QStash receiver keys -> the gap is reported, never faked", () => {
  it("the receiver route answers 503 MAINTENANCE_RECEIVER_NOT_CONFIGURED and nothing is triggered", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    await seedStrandedClaims(persistence, ["battery-unconfigured"], clock);
    // The composition leaves receiver = null when the signing keys are absent.
    const response = await handleMaintenanceReceiver(
      new Request(RECEIVER_DESTINATION, {
        method: "POST",
        headers: { "content-type": "application/json", "upstash-signature": "t=1,v1=aa" },
        body: JSON.stringify({ kind: "maintenance.outbox-sweep", at: clock.now() }),
      }),
      batteryRuntime(() => runDailyMaintenance({ persistence, now: () => clock.now() }), null) as never,
    );
    expect(response.status).toBe(503);
    const body = (JSON.parse(await response.text()) as { reason: string });
    expect(body.reason).toBe("MAINTENANCE_RECEIVER_NOT_CONFIGURED");
    expect(await persistence.outbox.count("DELIVERING")).toBe(1); // no faked trigger

    // The fail-closed cron AUTH still passes authentication; without the
    // QStash env the trigger runs the bounded sweeps INLINE (the documented
    // mode), proving the scheduled path never depends on the event path.
    const inline = await runDailyMaintenance({ persistence, now: () => clock.now() });
    expect(inline.mode).toBe("inline");
    expect(await persistence.outbox.count("DELIVERING")).toBe(0);
  });

  it("the receiver helper itself refuses every delivery when the keys are absent", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const receiver = createMaintenanceReceiver({
      persistence,
      signingKeys: { current: undefined },
      now: () => clock.now(),
    });
    const response = await receiver.handle(
      new Request(RECEIVER_DESTINATION, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    const body = (JSON.parse(await response.text()) as { reason: string });
    expect(body.reason).toMatch(/signing keys are not configured/);
  });

  it("the cron authentication law holds (the route is the only trigger surface)", () => {
    const probe = (authorization?: string) => ({
      headers: { get: (name: string) => (name === "authorization" ? (authorization ?? null) : null) },
    });
    expect(isAuthorizedCronRequest(probe(`Bearer ${CRON_SECRET}`), CRON_SECRET)).toBe(true);
    expect(isAuthorizedCronRequest(probe("Bearer wrong"), CRON_SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(probe(undefined), CRON_SECRET)).toBe(false);
  });
});

// --------------------------------------------------------------------------------
// (4) The REAL-database leg: the scheduled path over a REAL pooled PostgreSQL.
// DATABASE_URL-gated with the explicit honest skip (zero skipped-as-passed lies).
// --------------------------------------------------------------------------------

import { Pool } from "pg";
import {
  createPgDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryProjectionStore } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import { fakeWebhookDelivery, TEST_SIGNING_KEY_ID, TEST_SIGNING_SECRET } from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

const RAW_DATABASE_URL = process.env["DATABASE_URL"]?.trim() || undefined;
const DATABASE_URL =
  RAW_DATABASE_URL !== undefined &&
  (RAW_DATABASE_URL.startsWith("postgres://") || RAW_DATABASE_URL.startsWith("postgresql://"))
    ? RAW_DATABASE_URL
    : undefined;

const realDatabase = DATABASE_URL !== undefined ? describe : describe.skip;
if (DATABASE_URL === undefined) {
  console.log(
    "[RL-110] SKIPPING the real-database scheduled-path leg: no PostgreSQL DATABASE_URL is configured " +
      "(postgres:// or postgresql:// required). The scheduled recovery scenario (stranded-claim sweep + " +
      "inbox backlog beyond one batch) runs against a real pooled database in the operator phase; " +
      "CI stays green with the deterministic cores above — this skip is named, never a silent pass.",
  );
}

realDatabase("RL-110 (4) the scheduled path over a REAL database", () => {
  it("the authenticated cron kick recovers stranded claims and advances a deeper-than-one-batch backlog", async () => {
    setMigrationFileAccess({
      listDir: (dir) => readdirSync(dir),
      readTextFile: (path) => readFileSync(path, "utf8"),
    });
    setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
    const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const driver = createPgDriver(pool);
    try {
      // The real schema (idempotent; the ledger makes re-runs no-ops).
      await createPostgresMigrationRunner({ driver }).migrateUp();
      const persistence = createPostgresPersistence(driver);

      const clock = new DeterministicClock(T0);
      await seedStrandedClaims(persistence as never, ["battery-real-a", "battery-real-b"], clock);

      // The REAL inbox boundary over the real persistence (admission +
      // processing are the public reconciliation composition's seams).
      const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
      for (let index = 1; index <= 3; index += 1) {
        await fake.createIntent(
          {
            requirements: [
              { dimension: "usage", classification: "soft", statement: { profile: `battery-real-${index}` } },
            ],
            validity: { start: clock.now(), end: "2026-12-01T06:00:00.000Z" },
            termination: { actor: "customer", on_expiry: "release" },
            recorded_at: clock.now(),
          },
          { idempotencyKey: `idem.battery.real.${index}` as never },
        );
      }
      const projectionStore = new InMemoryProjectionStore();
      const verifier = new HmacWebhookVerifier({
        environment: "sandbox",
        keys: new StaticWebhookSigningKeyRegistry({ [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET }),
      });
      const boundary = createAdcosReconciliationBoundary({
        client: fake,
        projectionStore,
        persistence,
        persistenceReader: persistence,
        verifier,
        clock,
        platformTenantId: "org:00000000-0000-4000-8000-000000000001",
        jobIdGenerator: { next: () => "00000000-0000-4000-8000-0000000000b1" },
      });
      const deliveries = fake.deliveries();
      expect(deliveries.length).toBe(3); // a backlog deeper than the batch of 2
      for (const delivery of deliveries) {
        const signed = fakeWebhookDelivery({
          spec: {
            eventId: delivery.event.event_id,
            eventType: delivery.event.event_type,
            resourceId: delivery.event.resource_id,
            resourceKind: delivery.event.resource_kind,
            resourceVersion: delivery.event.resource_version,
            occurredAt: delivery.event.occurred_at,
            correlationId: delivery.event.correlation_id,
            environment: "sandbox" as const,
          },
          deliveryId: delivery.deliveryId,
          sequence: delivery.sequence,
          receivedAt: clock.now(),
        });
        const admission = await boundary.inbox.admitDelivery({
          headers: signed.headers,
          payload: signed.payload,
          receivedAt: clock.now(),
        });
        expect(admission.outcome).toBe("ADMITTED");
      }

      // The scheduler's authenticated kick #1: sweep (2 re-owned) + batch (2).
      const firstResponse = await handleMaintenanceDaily(
        cronRequest(),
        batteryRuntime(() =>
          runDailyMaintenance({
            persistence,
            inbox: boundary.inbox,
            now: () => clock.now(),
            inboxBatchLimit: INBOX_BATCH_LIMIT,
          }),
        ) as never,
      );
      expect(firstResponse.status).toBe(200);
      const first = (JSON.parse(await firstResponse.text()) as {
        outbox: { recovered: number };
        inbox: { drained: boolean; report?: { applied: number } };
      });
      expect(first.outbox.recovered).toBe(2);
      expect(await persistence.outbox.count("DELIVERING")).toBe(0);
      expect(first.inbox.drained && first.inbox.report?.applied).toBe(2);

      // Kick #2: the backlog ADVANCES beyond the first batch (1 more).
      const secondResponse = await handleMaintenanceDaily(
        cronRequest(),
        batteryRuntime(() =>
          runDailyMaintenance({
            persistence,
            inbox: boundary.inbox,
            now: () => clock.now(),
            inboxBatchLimit: INBOX_BATCH_LIMIT,
          }),
        ) as never,
      );
      const second = (JSON.parse(await secondResponse.text()) as {
        inbox: { drained: boolean; report?: { applied: number } };
      });
      expect(second.inbox.drained && second.inbox.report?.applied).toBe(1);

      // The events never age out mid-battery (freshness is bounded by TTL).
      expect(Date.parse(T0) + EVENT_TTL_MS).toBeGreaterThan(Date.parse(clock.now()));
    } finally {
      await pool.end();
    }
  }, 60_000);
});
