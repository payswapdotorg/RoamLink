/**
 * RL-043 adapter tests: the desired-state loop driver - execution replay
 * safety, offline queue + dedupe + replay, sync-boundary projection updates,
 * crash recovery redelivery and authoritative-result projection
 * (RL-LOCK-014/015, spec/mobile.md "Offline").
 */
import { describe, expect, it } from "vitest";
import { ConflictError } from "@roamlink/contracts";
import {
  DeviceActionResult,
  claimEdgeOutboxRecord,
  type EdgeSyncDelivery,
  type EdgeSyncDeliveryOutcome,
  type EdgeSyncTransport,
} from "@roamlink/edge";

import {
  DeviceActionAdapter,
  InMemoryDeviceActionProjectionStore,
  type InMemoryPlatformActionExecutor,
} from "../src/index.js";
import {
  actionRequest,
  enqueueContext,
  outboxWiring,
  snapshot,
  succeedingExecutor,
  T0,
} from "./helpers.js";

function makeAdapter(overrides?: {
  executor?: InMemoryPlatformActionExecutor;
  withOutbox?: boolean;
  snapshotProvider?: () => ReturnType<typeof snapshot> | null;
}): {
  adapter: DeviceActionAdapter;
  store: ReturnType<typeof outboxWiring>["store"];
  projection: InMemoryDeviceActionProjectionStore;
  executor: InMemoryPlatformActionExecutor;
} {
  const executor = overrides?.executor ?? succeedingExecutor();
  const projection = new InMemoryDeviceActionProjectionStore();
  const wiring = outboxWiring();
  const adapterInstance = new DeviceActionAdapter({
    capabilitySnapshotProvider: overrides?.snapshotProvider ?? (() => snapshot()),
    executor,
    projection,
    ...(overrides?.withOutbox === false ? {} : { outbox: wiring.outbox, outboxStore: wiring.store }),
  });
  return { adapter: adapterInstance, store: wiring.store, projection, executor };
}

function transport(
  outcomes: (index: number, delivery: EdgeSyncDelivery) => EdgeSyncDeliveryOutcome,
): EdgeSyncTransport & { deliveries: EdgeSyncDelivery[] } {
  const deliveries: EdgeSyncDelivery[] = [];
  return {
    deliveries,
    deliver: async (delivery) => {
      const index = deliveries.length;
      deliveries.push(delivery);
      return outcomes(index, delivery);
    },
  };
}

describe("DeviceActionAdapter.execute", () => {
  it("executes an admitted action and records the projection entry", async () => {
    const { adapter, projection } = makeAdapter();
    const request = actionRequest();
    const result = await adapter.execute(request, T0);
    expect(result.status).toBe("executed-observed");
    const entry = await projection.get(request.actionId);
    expect(entry?.latestResult?.status).toBe("executed-observed");
    expect(entry?.latestResultSource).toBe("local-execution");
    expect(entry?.commandId).toBe(request.command.commandId);
    expect(entry?.actionDedupeKey).toBe(request.dedupeKey);
  });

  it("is replay-safe: a second delivery of an executed action does not re-apply the physical action (RL-LOCK-014)", async () => {
    const { adapter, executor } = makeAdapter();
    const request = actionRequest();
    const first = await adapter.execute(request, T0);
    const second = await adapter.execute(request, T0);
    expect(second.status).toBe("executed-observed");
    expect(second.toPlain()).toEqual(first.toPlain());
    expect(executor.requests()).toHaveLength(1); // physical action applied once
  });

  it("absent capability snapshot (absent evidence) fails closed without touching the platform", async () => {
    const { adapter, executor, projection } = makeAdapter({
      withOutbox: false,
      snapshotProvider: () => null,
    });
    const request = actionRequest();
    const result = await adapter.execute(request, T0);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("capability-unknown");
    expect(executor.requests()).toHaveLength(0); // never reached the platform
    const entry = await projection.get(request.actionId);
    expect(entry?.latestResult?.reason).toBe("capability-unknown");
  });

  it("a degraded admission is recorded, not executed", async () => {
    const degraded = snapshot({
      entries: {
        wifi_control: {
          status: "requires-permission",
          evidenceClass: "OBSERVED",
          observedAt: T0,
          evidence: { kind: "user-permission-state", source: "OS.PermissionCenter" },
        },
      },
    });
    const { adapter, executor, projection } = makeAdapter({
      withOutbox: false,
      snapshotProvider: () => degraded,
    });
    const request = actionRequest({ capability: "wifi_control", seed: 4 });
    const result = await adapter.execute(request, T0);
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("capability-requires-permission");
    expect(executor.requests()).toHaveLength(0);
    expect((await projection.get(request.actionId))?.latestResult?.status).toBe("degraded");
  });
});

describe("DeviceActionAdapter.queue + sync (offline loop, RL-LOCK-015)", () => {
  it("queues an admitted command and projects pending + accepted (never executed)", async () => {
    const { adapter, store, projection } = makeAdapter();
    const request = actionRequest();
    const outcome = await adapter.queue(request, enqueueContext(), T0);
    expect(outcome.outcome).toBe("ENQUEUED");
    expect(store.contents()).toHaveLength(1);
    expect(store.contents()[0]?.state).toBe("pending");
    const entry = await projection.get(request.actionId);
    expect(entry?.latestResult?.status).toBe("accepted"); // NOT executed
    expect(entry?.syncBoundary).toBe("pending");
  });

  it("re-queueing the same command is idempotent (ALREADY_ENQUEUED, no second record)", async () => {
    const { adapter, store } = makeAdapter();
    const request = actionRequest();
    const first = await adapter.queue(request, enqueueContext(), T0);
    const second = await adapter.queue(request, enqueueContext(), T0);
    expect(first.outcome).toBe("ENQUEUED");
    expect(second.outcome).toBe("ALREADY_ENQUEUED");
    expect(store.contents()).toHaveLength(1);
  });

  it("a different command under the same physical dedupe key is a typed conflict", async () => {
    const { adapter } = makeAdapter();
    await adapter.queue(actionRequest({ seed: 1 }), enqueueContext(), T0);
    await expect(
      adapter.queue(
        actionRequest({ seed: 2, dedupeKey: "action-1" }),
        enqueueContext(),
        T0,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocked actions are never queued (the gate precedes the queue)", async () => {
    // esim install unavailable on this device
    const unavailable = snapshot({
      entries: {
        esim_profile_install: {
          status: "unavailable",
          evidenceClass: "OBSERVED",
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe.framework" },
        },
      },
    });
    const { adapter, store, projection } = makeAdapter({
      snapshotProvider: () => unavailable,
    });
    const request = actionRequest({ capability: "esim_profile_install", seed: 3 });
    const outcome = await adapter.queue(request, enqueueContext(), T0);
    expect(outcome.outcome).toBe("BLOCKED");
    expect(store.contents()).toHaveLength(0); // nothing queued
    const entry = await projection.get(request.actionId);
    expect(entry?.latestResult?.status).toBe("unsupported");
  });

  it("syncs accepted commands and projects the honest boundary (synced != executed)", async () => {
    const { adapter, store, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    const report = await adapter.sync(T0, transport(() => ({ outcome: "accepted" })));
    expect(report.synced).toHaveLength(1);
    expect(store.contents()[0]?.state).toBe("synced");
    const entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("synced");
    expect(entry?.latestResult?.status).toBe("accepted"); // server acceptance is not physical success
  });

  it("requeues retryable failures with backoff until they converge", async () => {
    const { adapter, store, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    // First attempt fails (T0), second (T0+100ms) fails, third (T0+300ms) accepted.
    const failingThenAccepting = transport((index) =>
      index < 2 ? { outcome: "retryable-failure" as const } : { outcome: "accepted" as const },
    );
    const first = await adapter.sync(T0, failingThenAccepting);
    expect(first.requeued).toHaveLength(1);
    let entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("pending");
    const second = await adapter.sync("2026-01-15T08:30:00.100Z", failingThenAccepting);
    expect(second.requeued).toHaveLength(1);
    const third = await adapter.sync("2026-01-15T08:30:00.300Z", failingThenAccepting);
    expect(third.synced).toHaveLength(1);
    expect(store.contents()[0]?.state).toBe("synced");
    entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("synced");
    expect(failingThenAccepting.deliveries).toHaveLength(3);
  });

  it("dead-letters after the retry budget is exhausted and projects degraded", async () => {
    const { adapter, store, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    const alwaysFailing = transport(() => ({ outcome: "retryable-failure" as const }));
    await adapter.sync(T0, alwaysFailing);
    await adapter.sync("2026-01-15T08:30:00.100Z", alwaysFailing);
    await adapter.sync("2026-01-15T08:30:00.300Z", alwaysFailing);
    expect(store.contents()[0]?.state).toBe("dead-lettered");
    const entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("degraded");
  });

  it("conflicts park honestly (require-manual projects conflict)", async () => {
    const { adapter, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    const conflicting = transport(() => ({ outcome: "conflict" as const }));
    await adapter.sync(T0, conflicting);
    const entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("conflict");
  });

  it("recovers records left in-flight by a crash and replays them (replay-safe redelivery)", async () => {
    const { adapter, store, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    // Simulate a crash mid-sync: claim the record (pending -> in-flight) and
    // abandon it, exactly like a process that died between claim and outcome.
    const pendingRecord = store.contents()[0];
    if (pendingRecord === undefined || pendingRecord.state !== "pending") {
      throw new Error("expected a pending outbox record after queue");
    }
    const claimed = claimEdgeOutboxRecord(pendingRecord, T0);
    await store.save(claimed);
    expect(store.contents()[0]?.state).toBe("in-flight");

    const recovered = await adapter.recoverInFlight(T0);
    expect(recovered).toHaveLength(1);
    expect(store.contents()[0]?.state).toBe("pending"); // re-queued for redelivery

    // Redelivery converges: the replayed command is accepted exactly once.
    // The recovered record is due again after its backoff (initialBackoffMs).
    const accepting = transport(() => ({ outcome: "accepted" as const }));
    const report = await adapter.sync("2026-01-15T08:30:00.100Z", accepting);
    expect(report.synced).toHaveLength(1);
    expect(accepting.deliveries).toHaveLength(1);
    const entry = await projection.get(request.actionId);
    expect(entry?.syncBoundary).toBe("synced");
  });

  it("duplicate deliveries re-deliver the SAME command id (idempotent at the server)", async () => {
    // The outbox guarantees at-least-once delivery; the SERVER dedupes by
    // command idempotency key. Here we assert the adapter re-delivers the
    // same command id (not a mutated one) across retries.
    const { adapter } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    const seen: string[] = [];
    const capturing: EdgeSyncTransport = {
      deliver: async (delivery: EdgeSyncDelivery) => {
        seen.push(delivery.record.commandId);
        return { outcome: "retryable-failure" };
      },
    };
    await adapter.sync(T0, capturing);
    await adapter.sync("2026-01-15T08:30:00.100Z", capturing);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1); // same command id both times
  });
});

describe("DeviceActionAdapter.receiveAuthoritativeResult", () => {
  it("records a server-authoritative result for a known queued action", async () => {
    const { adapter, projection } = makeAdapter();
    const request = actionRequest();
    await adapter.queue(request, enqueueContext(), T0);
    const result = new DeviceActionResult({
      actionId: request.actionId,
      status: "executed-observed",
      completedAt: T0,
      evidence: { kind: "os-statement", source: "EnterpriseMDM.relay" },
    });
    await adapter.receiveAuthoritativeResult(result, undefined, T0);
    const entry = await projection.get(request.actionId);
    expect(entry?.latestResultSource).toBe("server-authoritative");
    expect(entry?.latestResult?.status).toBe("executed-observed");
  });

  it("records a result for an unknown action only with a full descriptor", async () => {
    const { adapter, projection } = makeAdapter({ withOutbox: false });
    const result = new DeviceActionResult({
      actionId: "00000000-0000-4000-8000-00000000f00d",
      status: "failed",
      completedAt: T0,
      reason: "execution-failed",
    });
    await expect(adapter.receiveAuthoritativeResult(result, undefined, T0)).rejects.toMatchObject({
      reason: "EDGE_ACTION_RESULT_UNCORRELATABLE",
    });
    await adapter.receiveAuthoritativeResult(
      result,
      {
        capability: "wifi_control",
        commandId: "00000000-0000-4000-8000-0000000000c1",
        correlationId: "corr-server",
        actionDedupeKey: "action-server-1",
      },
      T0,
    );
    const entry = await projection.get("00000000-0000-4000-8000-00000000f00d");
    expect(entry?.latestResult?.status).toBe("failed");
    expect(entry?.capability).toBe("wifi_control");
  });
});

describe("DeviceActionAdapter wiring discipline (fail-closed)", () => {
  it("queue/sync without a wired outbox fail closed with a typed error", async () => {
    const { adapter } = makeAdapter({ withOutbox: false });
    await expect(adapter.queue(actionRequest(), enqueueContext(), T0)).rejects.toMatchObject({
      reason: "EDGE_ACTION_QUEUE_NOT_WIRED",
    });
    await expect(
      adapter.sync(T0, transport(() => ({ outcome: "accepted" }))),
    ).rejects.toMatchObject({ reason: "EDGE_ACTION_QUEUE_NOT_WIRED" });
    await expect(adapter.recoverInFlight(T0)).rejects.toMatchObject({
      reason: "EDGE_ACTION_QUEUE_NOT_WIRED",
    });
  });

  it("an outbox without its store is rejected at construction", () => {
    const wiring = outboxWiring();
    expect(
      () =>
        new DeviceActionAdapter({
          capabilitySnapshotProvider: () => snapshot(),
          executor: succeedingExecutor(),
          projection: new InMemoryDeviceActionProjectionStore(),
          outbox: wiring.outbox,
        }),
    ).toThrowError(/requires its store/);
  });
});
