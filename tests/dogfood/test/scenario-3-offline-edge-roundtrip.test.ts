/**
 * RL-072 dogfood scenario 3: OFFLINE EDGE ROUND-TRIP.
 *
 * The journey device goes offline; the customer keeps changing their
 * desired connectivity experience. The architectural truth properties:
 *
 *   - offline operation continues (RL-LOCK-015): the observation engine
 *     keeps folding probes into evidence-tagged snapshots while offline,
 *     and desired-state actions enqueue into the ENCRYPTED outbox
 *     (RL-042) - ciphertext-only at rest, never plaintext;
 *   - the local projection is honest: queued commands show `pending`,
 *     accepted != executed (RL-LOCK-011/014);
 *   - reconnect -> BATCHED sync -> convergence: every record is delivered
 *     and applied EXACTLY ONCE (server-side idempotency-key dedupe absorbs
 *     UNKNOWN-outcome re-deliveries - RL-LOCK-014/015);
 *   - conflict policy: a server-side desired-state change surfaces as a
 *     `conflict` boundary state, parks under require-manual, and resolves
 *     explicitly - never silently overwritten;
 *   - authoritative results update the local projection with evidence
 *     (executed-observed requires platform evidence - RL-LOCK-010/011).
 */
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "@roamlink/contracts";
import {
  MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
  evaluateProductSlo,
} from "@roamlink/observability";
import {
  createAesGcmEdgePayloadCipher,
  DeviceActionRequest,
  EdgeObservationEngine,
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  makeEdgeOutboxRetryPolicy,
  parseEdgeObservation,
  type EdgeSyncDelivery,
  type EdgeSyncTransport,
} from "@roamlink/edge";
import {
  DeviceActionAdapter,
  InMemoryDeviceActionProjectionStore,
  InMemoryPlatformActionExecutor,
} from "@roamlink/edge-actions";

import { makeDogfoodWorld, must, registerCustomer } from "../src/world.js";

const DEVICE_REF = "dev:00000000-0000-4000-8000-0000000000d1";
const KEY_BYTES = new Uint8Array(32).fill(11);
const OUTBOX_KEY_ID = "edge-outbox-key-dogfood";

/**
 * The receiving side of the sync boundary: an at-least-once transport whose
 * SERVER dedupes by command idempotency key (exactly-once EFFECT) and can
 * be scripted to lose acknowledgments or reject conflicting desired state.
 */
class SyncServer {
  readonly applied = new Map<string, string>();
  readonly deliveryAttempts: string[] = [];
  /** Keys whose delivery should return `conflict` (server-side change). */
  readonly conflicting = new Set<string>();
  /** Keys whose NEXT delivery applies server-side then loses the ack. */
  readonly loseAckOnce = new Set<string>();
  /** Fail every delivery while true (the partition). */
  partitioned = false;

  readonly transport: EdgeSyncTransport = {
    deliver: async (delivery: EdgeSyncDelivery) => this.deliver(delivery),
  };

  private async deliver(
    delivery: EdgeSyncDelivery,
  ): Promise<
    | { readonly outcome: "accepted" }
    | { readonly outcome: "retryable-failure"; readonly reason: string }
    | { readonly outcome: "conflict"; readonly detail: string }
    | { readonly outcome: "unknown" }
  > {
    const key = delivery.record.commandIdempotencyKey;
    this.deliveryAttempts.push(key);
    if (this.partitioned) {
      return { outcome: "retryable-failure", reason: "PARTITION" };
    }
    if (this.conflicting.has(key) && !this.applied.has(key)) {
      return {
        outcome: "conflict",
        detail: "SERVER_DESIRED_STATE_CHANGED",
      };
    }
    this.applied.set(key, delivery.plaintext);
    if (this.loseAckOnce.has(key)) {
      this.loseAckOnce.delete(key);
      return { outcome: "unknown" };
    }
    return { outcome: "accepted" };
  }

  /** The server-side EFFECT count (deduped) - the convergence measure. */
  effects(): number {
    return this.applied.size;
  }
}

/** Builds the deterministic edge world (no sleeps, no wall clock). */
function makeEdgeWorld() {
  const world = makeDogfoodWorld("offline-edge");
  return world;
}

/** The device's evidence-tagged capability snapshot (RL-041 folded). */
function foldCapabilitySnapshot(world: ReturnType<typeof makeEdgeWorld>) {
  const engine = new EdgeObservationEngine({
    snapshotIdGenerator: () => world.ids.next(),
    snapshotFreshnessMs: 600_000,
  });
  const probe = parseEdgeObservation({
    observationId: world.ids.next(),
    deviceRef: DEVICE_REF,
    observedAt: world.clock.now(),
    platform: { family: "ios", platformVersion: "18.2" },
    evidence: { kind: "platform-api-probe", source: "TestProbe" },
    subject: { kind: "capability-probe", capability: "wifi_control", status: "available" },
  });
  return engine.applyCapabilityObservation(null, probe, world.clock.now()).snapshot;
}

/** A canonical UUID keyed to the action's dedupe key (desired-state id). */
function desiredStateIdFor(request: DeviceActionRequest): string {
  const seed = Number(request.dedupeKey.slice("desired-wifi-".length));
  return `00000000-0000-4000-8000-${(0x4000 + seed).toString(16).padStart(12, "0")}`;
}

/** One desired-state action with a §5 command envelope. */
function desiredAction(
  world: ReturnType<typeof makeEdgeWorld>,
  actorId: string,
  tenantId: string,
  seed: number,
  network: string,
): DeviceActionRequest {
  return new DeviceActionRequest({
    actionId: `00000000-0000-4000-8000-${(0x2000 + seed).toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
    parameters: { network },
    command: {
      commandId: `00000000-0000-4000-8000-${(0x3000 + seed).toString(16).padStart(12, "0")}`,
      correlationId: `corr.dogfood.offline-edge.${seed}`,
      idempotencyKey: `idem.dogfood.offline-edge.${seed}`,
      actorId,
      tenantId,
      createdAt: world.clock.now(),
      retry: { attempt: 1 },
    },
    dedupeKey: `desired-wifi-${seed}`,
  });
}

describe("RL-072 scenario 3: offline edge round-trip (encrypted outbox -> batched sync -> convergence)", () => {
  it("the full offline round-trip with encryption, batching, unknown-ack re-delivery and conflict policy", async () => {
    const world = makeEdgeWorld();
    const customer = await registerCustomer(world, 0x41);

    const capabilitySnapshot = foldCapabilitySnapshot(world);
    let currentCapability = capabilitySnapshot;
    const executor = new InMemoryPlatformActionExecutor({
      capabilities: [
        { capability: "wifi_control", script: [InMemoryPlatformActionExecutor.evidencedSuccess()] },
      ],
    });
    const outboxStore = new InMemoryEdgeOutboxStore();
    const outbox = new EdgeOfflineOutbox({
      store: outboxStore,
      cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
      keyId: OUTBOX_KEY_ID,
      idGenerator: () => world.ids.next(),
      defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
        maxAttempts: 8,
        initialBackoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 8_000,
      }),
    });
    const projection = new InMemoryDeviceActionProjectionStore();
    const adapter = new DeviceActionAdapter({
      capabilitySnapshotProvider: () => currentCapability,
      executor,
      projection,
      outbox,
      outboxStore,
    });
    const server = new SyncServer();

    // ------------------------------------------------------------------
    // 1. The device goes OFFLINE; observation continues (RL-LOCK-015).
    // ------------------------------------------------------------------
    const offlineProbe = parseEdgeObservation({
      observationId: world.ids.next(),
      deviceRef: DEVICE_REF,
      observedAt: world.clock.now(),
      platform: { family: "ios", platformVersion: "18.2" },
      evidence: { kind: "platform-api-probe", source: "TestProbe" },
      subject: { kind: "context-observation", contextField: "connectivity-state", value: "offline" },
    });
    const observationEngine = new EdgeObservationEngine({
      snapshotIdGenerator: () => world.ids.next(),
      snapshotFreshnessMs: 600_000,
    });
    const offlineContext = observationEngine.applyContextObservation(
      null,
      offlineProbe,
      world.clock.now(),
    );
    // Offline is OBSERVED truth, not fabricated connectivity.
    expect(offlineContext.snapshot.entries["connectivity-state"]?.value).toBe("offline");
    expect(offlineContext.snapshot.entries["connectivity-state"]?.evidenceClass).toBe("OBSERVED");

    // ------------------------------------------------------------------
    // 2. Desired-state changes accumulate in the encrypted outbox.
    // ------------------------------------------------------------------
    const requests = [
      desiredAction(world, customer.actorId, customer.tenantId, 1, "wifi-acahat-5g"),
      desiredAction(world, customer.actorId, customer.tenantId, 2, "wifi-acahat-5g"),
      desiredAction(world, customer.actorId, customer.tenantId, 3, "cellular-failover"),
      desiredAction(world, customer.actorId, customer.tenantId, 4, "wifi-acahat-5g"),
      desiredAction(world, customer.actorId, customer.tenantId, 5, "cellular-failover"),
    ];
    for (const request of requests) {
      const queued = await adapter.queue(
        request,
        {
          deviceRef: DEVICE_REF,
          desiredStateId: desiredStateIdFor(request),
          lastKnownFreshness: {
            freshnessState: "FRESH",
            observedAt: world.clock.now(),
            receivedAt: world.clock.now(),
            freshUntil: null,
          } as never,
        },
        world.clock.now(),
      );
      expect(queued.outcome).toBe("ENQUEUED");
    }
    // Re-enqueueing the SAME action (same dedupe key + command) is a no-op.
    const firstRequest = must(requests[0], "first desired action");
    const reenqueue = await adapter.queue(
      firstRequest,
      {
        deviceRef: DEVICE_REF,
        desiredStateId: desiredStateIdFor(firstRequest),
        lastKnownFreshness: {
          freshnessState: "FRESH",
          observedAt: world.clock.now(),
          receivedAt: world.clock.now(),
          freshUntil: null,
        } as never,
      },
      world.clock.now(),
    );
    expect(reenqueue.outcome).toBe("ALREADY_ENQUEUED");

    // Ciphertext-only at rest: the serialized store never contains the
    // plaintext action payloads (RL-LOCK-016 discipline on the edge).
    const storeDump = JSON.stringify(outboxStore.contents());
    expect(storeDump).not.toContain("wifi-acahat-5g");
    expect(storeDump).not.toContain("cellular-failover");
    expect(storeDump).toContain(OUTBOX_KEY_ID);

    // The local projection is honest: queued shows `pending` (queued is NOT
    // executed - accepted != executed, RL-LOCK-011/014).
    const entries = await projection.list();
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.syncBoundary).toBe("pending");
      expect(entry.latestResult?.status).toBe("accepted");
    }

    // ------------------------------------------------------------------
    // 3. The partition: sync attempts fail with backoff; nothing is lost.
    // ------------------------------------------------------------------
    server.partitioned = true;
    const partitionReport = await adapter.sync(world.clock.now(), server.transport, { limit: 5 });
    expect(partitionReport.claimed).toBe(5);
    expect(partitionReport.synced).toHaveLength(0);
    expect(partitionReport.requeued).toHaveLength(5);
    // No server effect happened during the partition.
    expect(server.effects()).toBe(0);

    // ------------------------------------------------------------------
    // 4. RECONNECT: batched sync converges everything exactly once. One
    //    command's acknowledgment is LOST after the server applied it
    //    (unknown outcome -> re-delivery absorbed by dedupe); one command
    //    conflicts with a server-side desired-state change.
    // ------------------------------------------------------------------
    server.partitioned = false;
    server.loseAckOnce.add("idem.dogfood.offline-edge.2");
    server.conflicting.add("idem.dogfood.offline-edge.3");

    world.clock.advanceBy(10_000); // past the first backoff
    // Batched: limit 2 per pass. The unknown-ack record re-queues with its
    // own backoff, so the final pass claims it together with the last one.
    const pass1 = await adapter.sync(world.clock.now(), server.transport, { limit: 2 });
    expect(pass1.claimed).toBe(2);
    const pass2 = await adapter.sync(world.clock.now(), server.transport, { limit: 2 });
    expect(pass2.claimed).toBe(2);
    world.clock.advanceBy(10_000);
    const pass3 = await adapter.sync(world.clock.now(), server.transport, { limit: 2 });
    expect(pass3.claimed).toBe(2); // the last record + the unknown-ack retry

    // Four commands applied server-side exactly once so far (the conflict
    // is parked, not applied, and never retried blindly).
    expect(server.effects()).toBe(4);
    expect(server.applied.has("idem.dogfood.offline-edge.3")).toBe(false);

    // The unknown-ack record was delivered three times (partition round,
    // lost-ack round, accepted round) but has exactly ONE effect.
    expect(
      server.deliveryAttempts.filter((key) => key === "idem.dogfood.offline-edge.2").length,
    ).toBe(3);

    // ------------------------------------------------------------------
    // 5. Conflict policy: the parked record resolves explicitly.
    // ------------------------------------------------------------------
    const parked = must(
      (await outboxStore.list()).find(
        (record) => record.commandIdempotencyKey === "idem.dogfood.offline-edge.3",
      ),
      "parked conflict record",
    );
    // require-manual parks the record: the record stays in a contract-legal
    // state but the BOUNDARY honestly reports `conflict`, and the engine
    // refuses to claim it until an explicit resolution.
    expect(parked?.state).toBe("pending");
    expect(await outbox.boundaryState(parked.outboxRecordId)).toBe("conflict");
    expect(outbox.conflictDetail(parked.outboxRecordId)?.detail).toBe(
      "SERVER_DESIRED_STATE_CHANGED",
    );
    // A far-future sync pass still refuses to claim the parked record.
    world.clock.advanceBy(3_600_000);
    const parkedPass = await adapter.sync(world.clock.now(), server.transport);
    expect(parkedPass.claimed).toBe(0);

    // The operator resolves it as accept-server: the obligation discharges
    // (the server's desired state stands - never silently overwritten).
    // §11 "manual interventions per session/day" (edge-side measurement
    // point): the require-manual conflict policy PARKED this record until a
    // human resolved it - the resolution below IS the manual intervention
    // the §11 SLO counts.
    world.slo.recorder.recordManualIntervention({ tenantId: customer.tenantId });
    await outbox.resolveConflict(parked.outboxRecordId, "accept-server", world.clock.now());
    expect((await outboxStore.get(parked.outboxRecordId))?.state).toBe("synced");

    // The recorded intervention is real: one counter sample, classified
    // against the harness budget (max 2/day).
    const manualSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC);
    expect(manualSamples).toHaveLength(1);
    const manualSlo = evaluateProductSlo(
      world.slo.recorder,
      "manual-interventions-per-session-day",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(manualSlo.good).toBe(1);
    expect(manualSlo.state).toBe("within-budget");

    // ------------------------------------------------------------------
    // 6. Authoritative results update the local projection with evidence.
    //    Post-reconnect the device re-probes its capabilities (fresh
    //    evidence) before local execution of the resolved desired state.
    // ------------------------------------------------------------------
    currentCapability = foldCapabilitySnapshot(world);
    for (const request of requests) {
      if (request.dedupeKey === "desired-wifi-3") continue; // resolved accept-server
      const result = await adapter.execute(request, world.clock.now());
      expect(result.status).toBe("executed-observed");
      // Physical success ALWAYS carries platform evidence.
      expect(result.evidence?.kind).not.toBe("none");
    }
    const finalEntries = await projection.list();
    for (const entry of finalEntries) {
      // The local projection renders honest boundary states: pending,
      // synced, or conflict (parked) - never a fabricated success.
      expect(["pending", "synced", "conflict"]).toContain(entry.syncBoundary);
      if (entry.latestResult?.status === "executed-observed") {
        expect(entry.latestResultSource).toBe("local-execution");
      }
    }
    // The accept-server resolution is visible on the projection boundary.
    const conflictEntry = finalEntries.find((entry) => entry.actionDedupeKey === "desired-wifi-3");
    expect(conflictEntry?.syncBoundary).toBe("conflict");

    // ------------------------------------------------------------------
    // 7. Convergence completeness: every command delivered, applied
    //    exactly once; the server's applied payloads are byte-identical to
    //    the canonical action requests; no durable work was lost.
    // ------------------------------------------------------------------
    expect(server.effects()).toBe(4); // 4 synced + 1 accept-server discharge
    for (const request of requests) {
      if (request.dedupeKey === "desired-wifi-3") continue;
      const applied = server.applied.get(request.command.idempotencyKey);
      expect(applied).toBe(canonicalizeJson(request.toPlain() as never));
    }
    // No record is stuck in-flight or dead-lettered; the outbox drained.
    const remaining = await outboxStore.list();
    expect(remaining.filter((record) => record.state === "pending")).toHaveLength(0);
    expect(remaining.filter((record) => record.state === "in-flight")).toHaveLength(0);
    expect(remaining.filter((record) => record.state === "dead-lettered")).toHaveLength(0);
    expect(remaining.filter((record) => record.state === "synced")).toHaveLength(5);
  });

  it("dead-lettering is honest bounded work: a persistently failing command exhausts its retry budget", async () => {
    const world = makeEdgeWorld();
    const customer = await registerCustomer(world, 0x42);
    const currentCapability = foldCapabilitySnapshot(world);
    const outboxStore = new InMemoryEdgeOutboxStore();
    const outbox = new EdgeOfflineOutbox({
      store: outboxStore,
      cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
      keyId: OUTBOX_KEY_ID,
      idGenerator: () => world.ids.next(),
      defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
        maxAttempts: 3,
        initialBackoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 4_000,
      }),
    });
    const adapter = new DeviceActionAdapter({
      capabilitySnapshotProvider: () => currentCapability,
      executor: new InMemoryPlatformActionExecutor(),
      projection: new InMemoryDeviceActionProjectionStore(),
      outbox,
      outboxStore,
    });
    const server = new SyncServer();
    server.partitioned = true;

    const request = desiredAction(world, customer.actorId, customer.tenantId, 11, "wifi-acahat-5g");
    await adapter.queue(
      request,
      {
        deviceRef: DEVICE_REF,
        desiredStateId: desiredStateIdFor(request),
        lastKnownFreshness: {
          freshnessState: "FRESH",
          observedAt: world.clock.now(),
          receivedAt: world.clock.now(),
          freshUntil: null,
        } as never,
      },
      world.clock.now(),
    );

    // Three failing rounds (the retry budget) with deterministic backoff.
    let attempts = 0;
    for (let round = 0; round < 3; round += 1) {
      world.clock.advanceBy(10_000);
      const report = await adapter.sync(world.clock.now(), server.transport);
      attempts += report.claimed;
      expect(report.requeued.length + report.deadLettered.length).toBe(1);
    }
    expect(attempts).toBe(3); // bounded: exactly maxAttempts deliveries tried
    const record = must((await outboxStore.list())[0], "dead-lettered record");
    expect(record.state).toBe("dead-lettered");
    expect(record.attempts).toBe(3);
    expect(server.effects()).toBe(0);

    // Dead-lettered work is not retried blindly: a far-future sync pass
    // claims nothing (the record stays parked for manual/escalated handling).
    world.clock.advanceBy(3_600_000);
    const idle = await adapter.sync(world.clock.now(), server.transport);
    expect(idle.claimed).toBe(0);
    expect(must((await outboxStore.list())[0], "dead-lettered record").state).toBe(
      "dead-lettered",
    );
  });
});
