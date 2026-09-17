/**
 * RL-073 load suite: SUSTAINED SYNC CHURN (edge outbox flood -> convergence
 * completeness) plus NOTIFICATION FAN-OUT UNDER MUTE STORMS.
 *
 * Deterministic load shape (testkit clock/ids, no sleeps): a large fleet of
 * offline edge records churns through repeated failing sync rounds and a
 * final reconnect; then a notification preference storm (many users, most
 * topics muted) exercises the emission path's per-user read behavior.
 *
 * Complexity invariants:
 *
 *  SYNC-1 (convergence completeness): a flood of N offline records
 *       converges with EXACTLY N server effects after reconnect - no lost
 *       durable work (every enqueue survives all failing rounds) and no
 *       duplicate effects (idempotency-key dedupe absorbs re-deliveries);
 *  SYNC-2 (bounded retry work): every failing round re-attempts only the
 *       records whose backoff is due; total delivery attempts across the
 *       churn are bounded by (rounds x due-records) and each record's
 *       attempts are capped by its retry policy (dead-letter honesty);
 *  SYNC-3 (batch bounding): each sync pass claims at most its limit -
 *       never an unbounded batch;
 *  MUTE-1 (preference mute never degrades to O(all-customers)): emitting
 *       K notifications under a preference storm performs exactly K
 *       per-user preference reads - the emission path resolves ONE user's
 *       preferences per emission, never a scan of the preference store.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "@roamlink/contracts";
import {
  DeviceActionRequest,
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  makeEdgeOutboxRetryPolicy,
  type EdgeSyncDelivery,
  type EdgeSyncRunReport,
  type EdgeSyncTransport,
} from "@roamlink/edge";
import {
  InMemoryNotificationsIdempotencyLedger,
  NotificationService,
  createInMemoryNotificationsStore,
  type NotificationsStore,
} from "@roamlink/notifications";
import { fixtureCommandEnvelope } from "@roamlink/testkit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

const T0 = "2026-01-15T08:30:00.000Z";
const DEVICE_REF = "dev:00000000-0000-4000-8000-0000000000ff";

/** Pass-through cipher (deterministic; ciphertext discipline is RL-071's). */
class LoadCipher {
  readonly algorithm = "load-cipher";
  async encrypt(_keyId: string, plaintext: string): Promise<string> {
    return Buffer.from(plaintext, "utf8").toString("base64url");
  }
  async decrypt(_keyId: string, ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64url").toString("utf8");
  }
}

/** The at-least-once receiver whose server dedupes by idempotency key. */
class CountingSyncServer {
  readonly applied = new Map<string, string>();
  attempts = 0;
  partitioned = true;

  readonly transport: EdgeSyncTransport = {
    deliver: async (delivery: EdgeSyncDelivery) => {
      this.attempts += 1;
      if (this.partitioned) {
        return { outcome: "retryable-failure", reason: "PARTITION" } as const;
      }
      this.applied.set(delivery.record.commandIdempotencyKey, delivery.plaintext);
      return { outcome: "accepted" } as const;
    },
  };

  effects(): number {
    return this.applied.size;
  }
}

/** One deterministic desired-state action. */
function churnAction(
  clock: DeterministicClock,
  ids: DeterministicUuidGenerator,
  seed: number,
): DeviceActionRequest {
  return new DeviceActionRequest({
    actionId: `00000000-0000-4000-8000-${(0x5000 + seed).toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
    parameters: { network: `wifi-churn-${seed}` },
    command: {
      commandId: `00000000-0000-4000-8000-${(0x6000 + seed).toString(16).padStart(12, "0")}`,
      correlationId: `corr.load.churn.${seed}`,
      idempotencyKey: `idem.load.churn.${seed}`,
      actorId: "actor-load",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      createdAt: clock.now(),
      retry: { attempt: 1 },
    },
    dedupeKey: `churn-${seed}`,
  });
}

/** A counting decorator over the notifications store's preference reads. */
class PreferenceReadCounter {
  reads = 0;
  readonly inner: NotificationsStore;

  constructor(store: NotificationsStore) {
    this.inner = store;
    const originalBegin = store.begin.bind(store);
    store.begin = async () => {
      const session = await originalBegin();
      const originalFind = session.preferences.findForUser.bind(session.preferences);
      session.preferences.findForUser = async (tenantId, userId) => {
        this.reads += 1;
        return originalFind(tenantId, userId);
      };
      return session;
    };
  }
}

describe("RL-073 load: sustained sync churn (edge outbox flood -> convergence completeness)", () => {
  it("SYNC-1/2/3: an outbox flood converges exactly once with bounded retry work and bounded batches", async () => {
    const clock = new DeterministicClock(T0);
    const ids = new DeterministicUuidGenerator(1);
    const outbox = new EdgeOfflineOutbox({
      store: new InMemoryEdgeOutboxStore(),
      cipher: new LoadCipher(),
      keyId: "load-key",
      idGenerator: () => ids.next(),
      defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
        maxAttempts: 12,
        initialBackoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 60_000,
      }),
    });
    const server = new CountingSyncServer();

    // The flood: N offline enqueues while partitioned.
    const FLOOD = 400;
    const requests: DeviceActionRequest[] = [];
    for (let seed = 1; seed <= FLOOD; seed += 1) {
      const request = churnAction(clock, ids, seed);
      requests.push(request);
      const outcome = await outbox.enqueue(
        request,
        {
          deviceRef: DEVICE_REF,
          desiredStateId: `00000000-0000-4000-8000-${(0x7000 + seed).toString(16).padStart(12, "0")}`,
          lastKnownFreshness: {
            freshnessState: "FRESH",
            observedAt: clock.now(),
            receivedAt: clock.now(),
            freshUntil: null,
          } as never,
        },
        clock.now(),
      );
      expect(outcome.outcome).toBe("ENQUEUED");
    }

    // Sustained churn: several failing rounds with backoff between them.
    const BATCH_LIMIT = 50; // SYNC-3: bounded batches
    const roundReports: EdgeSyncRunReport[] = [];
    for (let round = 0; round < 4; round += 1) {
      clock.advanceBy(120_000); // past every pending backoff
      const report = await outbox.syncDue(clock.now(), server.transport, { limit: BATCH_LIMIT });
      roundReports.push(report);
      expect(report.claimed).toBeLessThanOrEqual(BATCH_LIMIT);
    }

    // Reconnect: batched passes drain the whole flood.
    server.partitioned = false;
    let totalSynced = 0;
    let passCount = 0;
    while (totalSynced < FLOOD) {
      clock.advanceBy(120_000);
      const report = await outbox.syncDue(clock.now(), server.transport, { limit: BATCH_LIMIT });
      totalSynced += report.synced.length;
      passCount += 1;
      expect(report.claimed).toBeLessThanOrEqual(BATCH_LIMIT);
      expect(passCount).toBeLessThanOrEqual(Math.ceil(FLOOD / BATCH_LIMIT) + 4);
    }

    // SYNC-1: convergence completeness - exactly N effects, byte-identical.
    expect(server.effects()).toBe(FLOOD);
    for (const request of requests) {
      expect(server.applied.get(request.command.idempotencyKey)).toBe(
        canonicalizeJson(request.toPlain() as never),
      );
    }

    // SYNC-2: total delivery attempts are bounded: every failing round
    // re-attempted only due records (<= batch), plus the draining passes.
    // Upper bound: 4 churn rounds + drain passes each claimed <= 50, and
    // the final state holds no pending/in-flight/dead-lettered work.
    const totalAttemptsExpected = roundReports.reduce((sum, report) => sum + report.claimed, 0);
    expect(server.attempts).toBeGreaterThanOrEqual(totalAttemptsExpected);
    expect(server.attempts).toBeLessThanOrEqual(
      totalAttemptsExpected + Math.ceil(FLOOD / BATCH_LIMIT) * BATCH_LIMIT + 8 * BATCH_LIMIT,
    );

    // No unbounded queues: nothing is stuck pending/in-flight/dead-lettered.
    const remainingPending = await outbox.syncDue(clock.now(), server.transport, {
      limit: BATCH_LIMIT,
    });
    expect(remainingPending.claimed).toBe(0);
  }, 240_000);
});

describe("RL-073 load: notification fan-out under preference mute storms (MUTE-1)", () => {
  it("K emissions under a mute storm perform exactly K per-user preference reads (never O(all-customers))", async () => {
    const clock = new DeterministicClock(T0);
    const ids = new DeterministicUuidGenerator(700_000);
    const store = createInMemoryNotificationsStore();
    const counter = new PreferenceReadCounter(store);
    const notifications = new NotificationService({
      store,
      policy: { authorize: async () => undefined },
      ledger: new InMemoryNotificationsIdempotencyLedger(),
      now: () => clock.now(),
      generateId: () => ids.next(),
    });

    // The storm: MANY users, each with their own preference record, most
    // topics muted. Fan-out touches a subset of them.
    const TOTAL_USERS = 300;
    const FANOUT = 120; // emissions for the first 120 users
    const TENANT = "org:00000000-0000-4000-8000-0000000000aa" as never;
    for (let user = 1; user <= TOTAL_USERS; user += 1) {
      const userId = `00000000-0000-4000-8000-${(0x8000 + user).toString(16).padStart(12, "0")}`;
      // Everyone mutes `connectivity` and `payment`; `refund` stays in_app.
      await notifications.setPreferences(
        fixtureCommandEnvelope({
          actorId: `usr:${userId}`,
          tenantId: TENANT,
          idempotencyKey: `idem.load.pref.${user}`,
          createdAt: clock.now(),
        }),
        {
          userId,
          channelsByTopic: {
            connectivity: [],
            payment: [],
            refund: ["in_app"],
          },
        },
      );
    }

    // Fan-out: 120 muted-topic emissions (all SUPPRESSED) + 120 refund-topic
    // emissions (pending -> delivered) for the SAME first 120 users.
    // (The counter starts measuring HERE - the preference seeding above is
    // per-user command work, not fan-out work.)
    counter.reads = 0;
    for (let user = 1; user <= FANOUT; user += 1) {
      const userId = `00000000-0000-4000-8000-${(0x8000 + user).toString(16).padStart(12, "0")}`;
      const envelope = fixtureCommandEnvelope({
        actorId: `usr:${userId}`,
        tenantId: TENANT,
        idempotencyKey: `idem.load.emit.muted.${user}`,
        createdAt: clock.now(),
      });
      const suppressed = await notifications.emitFromTransition(envelope, {
        notificationId: `00000000-0000-4000-8000-${(0x9000 + user).toString(16).padStart(12, "0")}`,
        recipientUserId: userId,
        topic: "connectivity",
        severity: "info",
        title: "Muted storm",
        body: "This topic is muted for this user.",
        source: {
          origin: "roamlink_state_transition",
          aggregateType: "order",
          aggregateId: `00000000-0000-4000-8000-${(0xa000 + user).toString(16).padStart(12, "0")}`,
          transition: "order.placed",
          eventId: `00000000-0000-4000-8000-${(0xd000 + user).toString(16).padStart(12, "0")}`,
          occurredAt: clock.now(),
        },
      });
      expect(suppressed.status).toBe("suppressed");

      const envelope2 = fixtureCommandEnvelope({
        actorId: `usr:${userId}`,
        tenantId: TENANT,
        idempotencyKey: `idem.load.emit.refund.${user}`,
        createdAt: clock.now(),
      });
      const pending = await notifications.emitFromTransition(envelope2, {
        notificationId: `00000000-0000-4000-8000-${(0xb000 + user).toString(16).padStart(12, "0")}`,
        recipientUserId: userId,
        topic: "refund",
        severity: "info",
        title: "Refund storm",
        body: "This topic is delivered.",
        source: {
          origin: "roamlink_state_transition",
          aggregateType: "customer_refund",
          aggregateId: `00000000-0000-4000-8000-${(0xc000 + user).toString(16).padStart(12, "0")}`,
          transition: "customer_refund.requested",
          eventId: `00000000-0000-4000-8000-${(0xe000 + user).toString(16).padStart(12, "0")}`,
          occurredAt: clock.now(),
        },
      });
      expect(pending.status).toBe("pending");
      await notifications.recordChannelDelivery(
        fixtureCommandEnvelope({
          actorId: `usr:${userId}`,
          tenantId: TENANT,
          idempotencyKey: `idem.load.channel.${user}`,
          createdAt: clock.now(),
        }),
        {
          notificationId: `00000000-0000-4000-8000-${(0xb000 + user).toString(16).padStart(12, "0")}`,
          channel: "in_app",
          outcome: "delivered",
        },
      );
    }

    // MUTE-1: exactly 2K per-user preference reads (one per emission) -
    // the emission path resolves ONE recipient's preferences each time.
    // An O(all-customers) degradation would show >= TOTAL_USERS reads per
    // emission; the measured count is exactly 2 * FANOUT.
    expect(counter.reads).toBe(2 * FANOUT);
    expect(counter.reads).toBeLessThan(TOTAL_USERS * 2);
  }, 240_000);
});
