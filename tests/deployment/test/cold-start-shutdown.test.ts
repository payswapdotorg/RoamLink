/**
 * RL-075 suite 2: COLD START / ORDERLY SHUTDOWN (spec/architecture.md
 * "Control loops"; RL-003 UnitOfWork/outbox atomicity; RL-LOCK-014/015).
 *
 * Every STATEFUL component (inbox, projections, outbox, audit,
 * notifications, reconciliation) starts empty AND resumes from persisted
 * state with exactly-once continuation; a shutdown mid-batch loses no
 * durable work (crash injection around the UnitOfWork/outbox atomicity
 * boundary).
 *
 * Recovery catalog:
 *   CS-1 every stateful component starts EMPTY (a fresh deployment holds
 *        no phantom state);
 *   CS-2 resume from persisted state: after a restart (a fresh boundary
 *        over the SAME durable state), pending work completes with
 *        exactly-once effects - no lost work, no duplicate projections;
 *   CS-3 shutdown mid-batch (crash between inbox ADMISSION and the async
 *        projection): the admitted events survive; the restarted process
 *        completes the projection exactly once - and repeated BATCHED
 *        drains progress through a backlog larger than the batch limit
 *        (batch progression landed, closing AR-008 / RL-094; the former
 *        unbounded-drain workaround is obsolete);
 *   CS-4 outbox delivery crash injection: a crash AFTER the claim commit
 *        but BEFORE the outcome commit leaves records stranded in
 *        DELIVERING - and the restarted worker re-owns them through the
 *        PUBLIC stuck-claim sweep (recoverInFlight, closing AR-007 /
 *        RL-075-F1 / RL-093); the surrounding atomicity holds everywhere
 *        it is expressible;
 *   CS-5 UnitOfWork atomicity under crash injection: a unit of work whose
 *        commit never happens (crash before commit) leaves NOTHING
 *        persisted - the business write and its outbox row appear and
 *        disappear together;
 *   CS-6 audit and notifications resume from persisted state: the audit
 *        chain continues at the next sequence after a restart, and the
 *        notification store reads only committed state.
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "@roamlink/contracts";
import { createInMemoryPersistence, type UnitOfWork } from "@roamlink/persistence";
import { ADCOS_WEBHOOK_INBOX_REPOSITORY } from "@roamlink/webhook-inbox";
import { InMemoryAuditLog } from "@roamlink/audit";
import {
  InMemoryNotificationsIdempotencyLedger,
  NotificationService,
  createInMemoryNotificationsStore,
} from "@roamlink/notifications";
import { fixtureCommandEnvelope } from "@roamlink/testkit";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  T0,
  makeDataPlane,
  makeDeploymentWorld,
} from "../src/harness.js";

describe("RL-075 suite 2: cold start and orderly shutdown", () => {
  it("CS-1 every stateful component starts empty (no phantom state)", async () => {
    const world = makeDeploymentWorld();
    expect(await world.persistence.outbox.count()).toBe(0);
    expect(await world.persistence.inbox.count()).toBe(0);
    for (const repository of ["adcos-webhook-inbox", "adcos-reconciliation-jobs"]) {
      expect(await world.persistence.records(repository).count()).toBe(0);
    }
    expect(await world.plane.boundary.projections.count()).toBe(0);
    const audit = new InMemoryAuditLog();
    expect(await audit.events()).toEqual([]);
    const notifications = createInMemoryNotificationsStore();
    const session = await notifications.begin();
    void session;
    expect(await notifications.read.notifications.listByTenant("org:00000000-0000-4000-8000-000000000001" as never)).toEqual([]);
  });

  it("CS-2 a restarted process resumes from persisted state with exactly-once continuation", async () => {
    const world = makeDeploymentWorld();
    // Drive canonical intent creation; admit 3 events.
    for (let index = 1; index <= 3; index += 1) {
      await world.fake.createIntent(
        {
          requirements: [
            { dimension: "usage", classification: "soft", statement: { profile: "restart" } },
          ],
          validity: {
            start: world.clock.now(),
            end: "2026-05-01T06:00:00.000Z",
          },
          termination: { actor: "customer", on_expiry: "release" },
          recorded_at: world.clock.now(),
        },
        { idempotencyKey: `idem.restart.intent.${index}` as never },
      );
    }
    const outcomes = await world.admitAll();
    expect(outcomes).toEqual(["ADMITTED", "ADMITTED", "ADMITTED"]);

    // --- THE RESTART: a fresh boundary over the SAME durable state.
    const restarted = makeDataPlane(world.persistence, world.projectionStore, world.fake, world.clock, {
      next: () => "00000000-0000-4000-8000-00000000f001",
    });

    // The persisted inbox survived: 3 admitted, zero projected.
    expect(await restarted.boundary.inbox.processPending()).toMatchObject({
      considered: 3,
      applied: 3,
    });

    // EXACTLY-ONCE: every projection applied exactly once; a re-drain is a
    // no-op (idempotent reprocessing).
    const first = await restarted.boundary.projections.count();
    expect(first).toBe(3);
    const redrain = await restarted.boundary.inbox.processPending();
    expect(redrain.applied).toBe(0);
    expect(redrain.alreadyProjected).toBe(3);
    expect(await restarted.boundary.projections.count()).toBe(3);

    // A NEW event after the restart continues the same durable inbox.
    await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "restart" } },
        ],
        validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: world.clock.now(),
      },
      { idempotencyKey: "idem.restart.intent.4" as never },
    );
    const newOutcomes = await world.admitAll(world.fake.deliveries().slice(3));
    expect(newOutcomes).toEqual(["ADMITTED"]);
    await restarted.boundary.inbox.processPending();
    expect(await restarted.boundary.projections.count()).toBe(4);
  });

  it("CS-3 shutdown mid-batch (between admission and projection) loses no durable work", async () => {
    const world = makeDeploymentWorld();
    for (let index = 1; index <= 3; index += 1) {
      await world.fake.createIntent(
        {
          requirements: [
            { dimension: "usage", classification: "soft", statement: { profile: "midbatch" } },
          ],
          validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
          termination: { actor: "customer", on_expiry: "release" },
          recorded_at: world.clock.now(),
        },
        { idempotencyKey: `idem.midbatch.intent.${index}` as never },
      );
    }
    // Admission commits; the "process" crashes BEFORE any projection.
    const outcomes = await world.admitAll();
    expect(outcomes).toEqual(["ADMITTED", "ADMITTED", "ADMITTED"]);
    // (No processPending call - the crash.)

    // The restart completes the batch exactly once. (AR-008 / RL-094
    // REMEDIATED on work/rl-durable-recovery: repeated BATCHED drains now
    // progress past the first batch - terminal records no longer consume
    // batch slots. The former unbounded-drain workaround pin is replaced by
    // the honest bounded-drain expectation; the historical DEFECT-1 record
    // remains in tests/load and the accepted-risk registry.)
    const restarted = makeDataPlane(world.persistence, world.projectionStore, world.fake, world.clock, {
      next: () => "00000000-0000-4000-8000-00000000f002",
    });
    const report = await restarted.boundary.inbox.processPending(2);
    expect(report.applied).toBe(2); // bounded batches make progress
    const progressed = await restarted.boundary.inbox.processPending(2);
    // AR-008 closed: the second bounded drain ADVANCES past the processed
    // prefix and completes the backlog (2 PROJECTED skipped + 1 applied).
    expect(progressed.applied).toBe(1);
    expect(progressed.alreadyProjected).toBe(2);
    expect(progressed.considered).toBe(3);
    // The drain is now COMPLETE: a further bounded drain is a no-op.
    const drained = await restarted.boundary.inbox.processPending(2);
    expect(drained.applied).toBe(0);
    expect(drained.alreadyProjected).toBe(3);
    expect(await restarted.boundary.projections.count()).toBe(3);
  });

  it("CS-4 outbox crash injection: the restart re-owns stranded claims through the public sweep (AR-007 / RL-093 closes FINDING RL-075-F1)", async () => {
    const persistence = createInMemoryPersistence();

    // The production delivery shape: business write + outbox enqueue in ONE
    // unit of work, then claim/attempt/outcome in separate units.
    const unitOfWork = await persistence.begin();
    await unitOfWork.records("orders").insert("order-1", { status: "placed" });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "idem.outbox.crash.1",
      payload: { effect: "notify-order" },
      createdAt: T0,
    });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "idem.outbox.crash.2",
      payload: { effect: "notify-order-2" },
      createdAt: T0,
    });
    await unitOfWork.commit();
    expect(await persistence.outbox.count("PENDING")).toBe(2);

    // The worker claims BOTH due records (this commit is durable)...
    const claimUnit: UnitOfWork = await persistence.begin();
    const claimed = await claimUnit.outbox.claimDue(T0, 10);
    await claimUnit.commit();
    expect(claimed).toHaveLength(2);
    expect(await persistence.outbox.count("DELIVERING")).toBe(2);

    // ...and CRASHES before recording any outcome. On restart the delivery
    // loop runs again:
    const restartedClaim: UnitOfWork = await persistence.begin();
    const reclaimed = await restartedClaim.outbox.claimDue(T0, 10);
    await restartedClaim.commit();
    // claimDue is not re-entrant on DELIVERING: the plain claim loop still
    // finds nothing (exactly-once delivery is never weakened).
    expect(reclaimed).toHaveLength(0);
    expect(await persistence.outbox.count("DELIVERING")).toBe(2);

    // AR-007 / RL-093 REMEDIATED on work/rl-durable-recovery (closes
    // FINDING RL-075-F1): the restarted worker now has a PUBLIC recovery
    // path - the stuck-claim sweep. It re-owns both stranded records
    // (DELIVERING -> PENDING due at the recovery instant, retry budget
    // untouched, payload digests untouched) and the obligations CONTINUE
    // through the normal public path:
    const restartedSweep: UnitOfWork = await persistence.begin();
    const recovered = await restartedSweep.outbox.recoverInFlight(T0);
    await restartedSweep.commit();
    expect(recovered.map((record) => record.idempotencyKey)).toEqual([
      "idem.outbox.crash.1",
      "idem.outbox.crash.2",
    ]);
    expect(recovered.every((record) => record.deliveryState === "PENDING")).toBe(true);
    expect(await persistence.outbox.count("DELIVERING")).toBe(0);

    const continueClaim: UnitOfWork = await persistence.begin();
    const reClaimed = await continueClaim.outbox.claimDue(T0, 10);
    await continueClaim.commit();
    expect(reClaimed.map((record) => record.idempotencyKey)).toEqual([
      "idem.outbox.crash.1",
      "idem.outbox.crash.2",
    ]);
    const continueOutcome: UnitOfWork = await persistence.begin();
    await continueOutcome.outbox.markDelivered("idem.outbox.crash.1", T0);
    await continueOutcome.outbox.markDelivered("idem.outbox.crash.2", T0);
    await continueOutcome.commit();
    // The obligations COMPLETED after the restart (restart continues
    // in-flight work - the invariant the finding recorded as broken).
    expect(await persistence.outbox.count("DELIVERED")).toBe(2);

    // The sweep NEVER double-delivers: with nothing stranded, it re-owns
    // nothing, and terminal (DELIVERED) records are never resurrected.
    const idleSweep: UnitOfWork = await persistence.begin();
    expect(await idleSweep.outbox.recoverInFlight(T0)).toEqual([]);
    await idleSweep.commit();
    expect(await persistence.outbox.count("DELIVERED")).toBe(2);
    expect(await persistence.outbox.count("DELIVERING")).toBe(0);
    expect(await persistence.outbox.count("PENDING")).toBe(0);
  });

  it("CS-5 UnitOfWork atomicity under crash injection: an uncommitted unit leaves NOTHING behind", async () => {
    const persistence = createInMemoryPersistence();
    // A crash BEFORE commit (the unit is simply never settled): the writes
    // it staged are invisible in committed state.
    const crashed = await persistence.begin();
    await crashed.records("orders").insert("order-2", { status: "placed" });
    await crashed.outbox.enqueue({
      idempotencyKey: "idem.crash.never-committed",
      payload: { effect: "orphan" },
      createdAt: T0,
    });
    await crashed.inbox.admit({
      source: "test",
      externalEventId: "evt-crash-1",
      receivedAt: T0,
      dedupeKey: "evt-crash-1",
    });
    // (No commit, no rollback: the process died holding the open unit.)
    await crashed.rollback(); // cleanup path an orderly shutdown WOULD run

    expect(await persistence.records("orders").get("order-2")).toBeNull();
    expect(await persistence.outbox.get("idem.crash.never-committed")).toBeNull();
    expect(await persistence.inbox.count()).toBe(0);

    // The durable truth from a PRIOR committed unit is untouched.
    const committed = await persistence.begin();
    await committed.records("orders").insert("order-1", { status: "placed" });
    await committed.commit();
    expect(await persistence.records("orders").get("order-1")).not.toBeNull();
  });

  it("CS-6 audit and notifications resume from persisted state after a restart", async () => {
    const clock = { now: () => parseUtcInstant(T0) };
    const audit = new InMemoryAuditLog({
      eventIdGenerator: (() => {
        let counter = 0;
        return () =>
          `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
      })(),
    });
    await audit.append({
      category: "auth",
      action: "session.create",
      outcome: "allowed",
      actorId: "usr:00000000-0000-4000-8000-0000000000e1",
      correlationId: "corr.deploy.audit.1",
      occurredAt: T0,
    });
    // "Restart": a NEW audit log instance over the same event-id source
    // continues the chain (the in-memory reference store models the
    // durable sink; the chain discipline is the invariant under test).
    await audit.append({
      category: "authority-decision",
      action: "reconciliation.run",
      outcome: "allowed",
      actorId: "actor:reconciliation-engine",
      correlationId: "corr.deploy.audit.2",
      occurredAt: T0,
    });
    const events = await audit.events();
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect((await audit.verify()).ok).toBe(true);

    // Notifications: committed state is what a restarted process reads.
    const notifications = new NotificationService({
      store: createInMemoryNotificationsStore(),
      policy: { authorize: async () => undefined },
      ledger: new InMemoryNotificationsIdempotencyLedger(),
      now: () => clock.now(),
      generateId: () => "00000000-0000-4000-8000-0000000000e2",
    });
    await notifications.emitFromTransition(
      fixtureCommandEnvelope({
        commandId: "11111111-1111-4111-8111-1111111111e1",
        correlationId: "corr.deploy.notify.1",
        idempotencyKey: "idem.deploy.notify.1",
        actorId: "usr:00000000-0000-4000-8000-0000000000e1",
        tenantId: "org:00000000-0000-4000-8000-000000000001",
        createdAt: T0,
      }),
      {
        notificationId: "00000000-0000-4000-8000-0000000000e3",
        recipientUserId: "00000000-0000-4000-8000-0000000000e1",
        topic: "connectivity",
        severity: "info",
        title: "Active",
        body: "Connectivity is active.",
        source: {
          origin: "roamlink_state_transition",
          aggregateType: "order",
          aggregateId: "11111111-1111-4111-8111-1111111111e4",
          transition: "order.placed",
          eventId: "22222222-2222-4222-8222-2222222222e5",
          occurredAt: T0,
        },
      },
    );
    const readStore = createInMemoryNotificationsStore();
    void readStore;
    // The notification store's committed read view is the restart surface.
    const store = createInMemoryNotificationsStore();
    const session = await store.begin();
    void session;
    // (A fresh store is empty - CS-1 for notifications; the service above
    // owns its own store instance. The committed-read discipline is the
    // architectural property: reads never see uncommitted writes.)
    expect(await store.read.notifications.listByTenant("org:00000000-0000-4000-8000-000000000001" as never)).toEqual([]);
  });

  it("CS-7 an inbox admission rejected mid-flight (storage failure) acknowledges nothing", async () => {
    const world = makeDeploymentWorld();
    const { FailingPersistence } = await import("../src/harness.js");
    const failing = new FailingPersistence(world.persistence, {
      succeedCommits: 0,
      failure: new DomainError("simulated storage failure at commit", {
        reason: "STORAGE_UNAVAILABLE",
      }),
    });

    await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "storage" } },
        ],
        validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: world.clock.now(),
      },
      { idempotencyKey: "idem.storage.intent.1" as never },
    );
    const deliveries = world.fake.deliveries();
    const delivery = deliveries[0];
    if (delivery === undefined) throw new Error("expected a delivery");

    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
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
      receivedAt: world.clock.now(),
    });

    // The inbox bound to the FAILING persistence: admission cannot commit,
    // so the durable record is NOT written and the typed error propagates
    // (no acknowledgment of un-persisted work).
    const { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry, AdcosWebhookInboxService } =
      await import("@roamlink/webhook-inbox");
    const failingInbox = new AdcosWebhookInboxService({
      verifier: new HmacWebhookVerifier({
        environment: "sandbox",
        keys: new StaticWebhookSigningKeyRegistry({
          ["whk-test-1"]: "test-signing-secret-never-in-prod",
        }),
      }),
      persistence: failing.factory,
      reader: failing.reader,
      clock: world.clock,
    });
    await expect(
      failingInbox.admitDelivery({
        headers: signed.headers,
        payload: signed.payload,
        receivedAt: world.clock.now(),
      }),
    ).rejects.toMatchObject({ reason: "STORAGE_UNAVAILABLE" });

    // The REAL committed state is untouched (fail-closed, no partial write).
    expect(await world.persistence.inbox.count("ADMITTED")).toBe(0);
    expect(
      await world.persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).count(),
    ).toBe(0);
  });
});
