import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import type { UtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import { AdcosProjectionEngine, InMemoryProjectionStore, canonicalizeUnknown } from "../src/index.js";
import type { AdcosProjectionRecord } from "../src/index.js";
import type { AdcosWebhookEvent } from "@roamlink/adcos";
import { FakeCanonicalAdcos } from "./fake-adcos-reads.js";

/**
 * The projection-boundary lifecycle (RL-034 against the reads-only fake):
 * webhook signals (with duplicates, reordering, dropped events) + canonical
 * refresh (silent state changes) + unreachable-source degradation and
 * recovery. This is the shape the reconciliation engine (RL-035) will drive
 * on top of the same engine.
 */
const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");
const CONTRACT = "contract-77";

function event(n: number, occurredAt: UtcInstant | string): AdcosWebhookEvent {
  return {
    event_id: `evt-${n}`,
    event_type: "connectivity_contract.state_changed",
    resource_id: CONTRACT,
    resource_kind: "connectivity_contract",
    resource_version: n,
    occurred_at: occurredAt,
    api_version: "2.0",
    environment: "sandbox",
    correlation_id: `corr-${n}`,
  } as AdcosWebhookEvent;
}

describe("projection lifecycle against the canonical fake (RL-034)", () => {
  it("duplicate + reordered + dropped events converge; silent changes need canonical refresh", async () => {
    const store = new InMemoryProjectionStore();
    const clock = new DeterministicClock(T0);
    const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
    const fake = new FakeCanonicalAdcos().seed({
      id: CONTRACT,
      kind: "connectivity_contract",
      version: 3,
      state: "OFFER_SELECTED",
    });

    // A scrambled delivery stream: v2 duplicate, v3 before v1, v4 dropped.
    const stream: readonly { readonly at: string; readonly event: AdcosWebhookEvent }[] = [
      { at: T0, event: event(2, T0) },
      { at: T0, event: event(2, T0) }, // duplicate delivery of the same event
      { at: T0, event: event(3, T0) },
      { at: T0, event: event(1, T0) }, // late/reordered older event
    ];
    for (const delivery of stream) {
      await engine.projectVerifiedEvent(delivery.event, parseUtcInstant(delivery.at));
    }
    let current = await store.get("connectivity_contract", CONTRACT);
    expect(current?.source_version).toBe(3); // the highest delivered version won
    expect(current?.projection_version).toBe(2); // v2 then v3 applied; dup + late skipped

    // The canonical state moved SILENTLY to v5 (dropped webhook): only a
    // canonical read can catch it - exactly the RL-035 repair loop.
    fake.mutateVersion(CONTRACT, "CONTRACT_ACTIVE"); // -> v4
    fake.mutateVersion(CONTRACT, "EXECUTION_ACTIVE"); // -> v5
    const canonical = await fake.getContract(CONTRACT);
    const refreshed = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: CONTRACT,
      payload: canonicalizeUnknown(canonical),
      observedAt: parseUtcInstant("2026-01-15T08:35:00.000Z"),
    });
    expect(refreshed.outcome).toBe("APPLIED");
    current = await store.get("connectivity_contract", CONTRACT);
    expect(current?.payload).toMatchObject({ state: "EXECUTION_ACTIVE", resource_version: 5 });
    expect(current?.freshness_state).toBe("FRESH");

    // The dropped v4 event finally arrives late: it is older than the
    // canonical snapshot's observation -> skipped (never regress).
    const late = await engine.projectVerifiedEvent(
      event(4, parseUtcInstant("2026-01-15T08:20:00.000Z")),
      parseUtcInstant("2026-01-15T08:36:00.000Z"),
    );
    expect(late.outcome).toBe("SKIPPED_OUTDATED");
  });

  it("unreachable canonical source degrades to UNKNOWN, then recovers via a canonical read", async () => {
    const store = new InMemoryProjectionStore();
    const clock = new DeterministicClock(T0);
    const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
    const fake = new FakeCanonicalAdcos().seed({
      id: CONTRACT,
      kind: "connectivity_contract",
      version: 3,
      state: "CONTRACT_ACTIVE",
    });
    await engine.projectVerifiedEvent(event(3, T0), parseUtcInstant(T0));

    // The reconciler tries a canonical refresh but the source is unreachable.
    fake.failNextRead({ kind: "unreachable" });
    await expect(fake.getContract(CONTRACT)).rejects.toMatchObject({ code: "store-failed" });
    // Degradation is explicit: UNKNOWN, never a guess, payload retained.
    await engine.markUnknown("connectivity_contract", CONTRACT, "TRANSPORT_UNAVAILABLE");
    let current = await store.get("connectivity_contract", CONTRACT);
    expect(current?.freshness_state).toBe("UNKNOWN");
    expect(current?.evidence_class).toBe("UNKNOWN");

    // Source recovers: the next canonical read restores an honest FRESH
    // snapshot at the (now higher) canonical version.
    fake.mutateVersion(CONTRACT, "EXECUTION_ACTIVE");
    const canonical = await fake.getContract(CONTRACT);
    const recovery = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: CONTRACT,
      payload: canonicalizeUnknown(canonical),
      observedAt: parseUtcInstant("2026-01-15T09:00:00.000Z"),
      sourceVersion: 4,
    });
    expect(recovery.outcome).toBe("APPLIED");
    current = await store.get("connectivity_contract", CONTRACT);
    expect(current?.freshness_state).toBe("FRESH");
    expect(current?.evidence_class).toBe("AUTHENTICATED");
    expect(current?.source_version).toBe(4);
    expect(current?.payload).toMatchObject({ state: "EXECUTION_ACTIVE" });
  });

  it("an expired freshness guarantee degrades to STALE even without new observations", async () => {
    const store = new InMemoryProjectionStore();
    const clock = new DeterministicClock(T0);
    const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
    await engine.projectVerifiedEvent(event(2, T0), parseUtcInstant(T0));
    clock.advanceTo("2026-01-15T08:31:30.000Z"); // past the 60s TTL
    const report = await engine.refreshFreshnessStates();
    expect(report.transitionedToStale).toBe(1);
    const current = await store.get("connectivity_contract", CONTRACT);
    expect(current?.freshness_state).toBe("STALE");
    expect(current?.evidence_class).toBe("STALE");
  });

  it("the projection boundary never mutates ADCOS (capability-denied on mutations)", async () => {
    const fake = new FakeCanonicalAdcos().seed({
      id: CONTRACT,
      kind: "connectivity_contract",
      version: 1,
      state: "OFFER_SELECTED",
    });
    await expect(
      fake.createIntent({} as never, { idempotencyKey: "idem-x" as never }),
    ).rejects.toMatchObject({ code: "capability-denied" });
    await expect(
      fake.terminateContract(CONTRACT, {} as never, { idempotencyKey: "idem-x" as never }),
    ).rejects.toMatchObject({ code: "capability-denied" });
  });

  it("projection records round-trip through the §8 parser at every write", async () => {
    const store = new InMemoryProjectionStore();
    const clock = new DeterministicClock(T0);
    const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
    await engine.projectVerifiedEvent(event(1, T0), parseUtcInstant(T0));
    await engine.projectVerifiedEvent(event(2, T0), parseUtcInstant(T0));
    await engine.markStale("connectivity_contract", CONTRACT, "PROBE_FAILED");
    const current = await store.get("connectivity_contract", CONTRACT);
    expect(current).not.toBeNull();
    const record: AdcosProjectionRecord = current as AdcosProjectionRecord;
    expect(record.projection_id).toBe(`prj.connectivity_contract.${CONTRACT}`);
    expect(record.projection_version).toBe(3);
    expect(record.freshness_state).toBe("STALE");
    expect(record.source_version).toBe(2);
  });
});
