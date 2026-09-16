import { describe, expect, it } from "vitest";
import { parseUtcInstant, canonicalizeJson } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import { AdcosProjectionEngine, InMemoryProjectionStore, payloadDigestOf } from "../src/index.js";
import type { AdcosWebhookEvent } from "@roamlink/adcos";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function event(n: number, overrides?: Partial<AdcosWebhookEvent>): AdcosWebhookEvent {
  return {
    event_id: `evt-${n}`,
    event_type: "connectivity_contract.state_changed",
    resource_id: "contract-77",
    resource_kind: "connectivity_contract",
    resource_version: n,
    occurred_at: T0,
    api_version: "2.0",
    environment: "sandbox",
    correlation_id: `corr-${n}`,
    ...overrides,
  } as AdcosWebhookEvent;
}

function makeEngine(startAt: string = T0) {
  const store = new InMemoryProjectionStore();
  const clock = new DeterministicClock(startAt);
  const engine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
  return { store, clock, engine };
}

describe("event-driven projection (RL-034, RL-LOCK-009 signals)", () => {
  it("applies the first verified event as a complete §8 record", async () => {
    const { engine } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    const outcome = await engine.projectVerifiedEvent(event(3), receivedAt);
    expect(outcome.outcome).toBe("APPLIED");
    if (outcome.outcome !== "APPLIED") return;
    const record = outcome.record;
    expect(record.projection_id).toBe("prj.connectivity_contract.contract-77");
    expect(record.source_authority).toBe("adcos");
    expect(record.canonical_resource_type).toBe("connectivity_contract");
    expect(record.canonical_resource_id).toBe("contract-77");
    expect(record.source_version).toBe(3);
    expect(record.event_id).toBe("evt-3");
    expect(record.observed_at).toBe(T0);
    expect(record.received_at).toBe(T0);
    expect(record.fresh_until).toBe("2026-01-15T08:31:00.000Z"); // received + 60s TTL
    expect(record.freshness_state).toBe("FRESH");
    expect(record.evidence_class).toBe("AUTHENTICATED");
    expect(record.projection_version).toBe(1);
    // the payload IS the authenticated event envelope (the signal)
    expect(record.payload).toMatchObject({ event_id: "evt-3", resource_version: 3 });
    expect(record.payload_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("higher versions apply and advance the projection version", async () => {
    const { engine } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(3), receivedAt);
    const second = await engine.projectVerifiedEvent(event(4), receivedAt);
    expect(second.outcome).toBe("APPLIED");
    if (second.outcome !== "APPLIED") return;
    expect(second.record.source_version).toBe(4);
    expect(second.record.projection_version).toBe(2);
    expect(second.record.event_id).toBe("evt-4");
  });

  it("OUT-OF-ORDER events: strictly-lower versions are skipped, never regress state", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(5), receivedAt);
    const late = await engine.projectVerifiedEvent(event(3), receivedAt);
    expect(late.outcome).toBe("SKIPPED_OUTDATED");
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.source_version).toBe(5);
    expect(current?.projection_version).toBe(1); // unchanged
    expect(current?.event_id).toBe("evt-5");
  });

  it("SAME version events are idempotent no-ops (duplicate/reordered delivery)", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(5), receivedAt);
    const replay = await engine.projectVerifiedEvent(event(5), receivedAt);
    expect(replay.outcome).toBe("SKIPPED_SAME_VERSION");
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.projection_version).toBe(1);
  });

  it("a reordered stream converges to the highest version deterministically", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    // deliver v3, v1, v2, v4 in scrambled order
    for (const version of [3, 1, 2, 4]) {
      await engine.projectVerifiedEvent(event(version), receivedAt);
    }
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.source_version).toBe(4);
    expect(current?.projection_version).toBe(2); // v3 applied (1), v4 applied (2)
    expect(current?.event_id).toBe("evt-4");
  });
});

describe("canonical-read projection (RL-034 authoritative snapshots)", () => {
  it("applies an unversioned authoritative snapshot with AUTHENTICATED evidence", async () => {
    const { engine } = makeEngine();
    const outcome = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { state: "CONTRACT_ACTIVE", resource_version: 7 },
      observedAt: parseUtcInstant(T0),
    });
    expect(outcome.outcome).toBe("APPLIED");
    if (outcome.outcome !== "APPLIED") return;
    expect(outcome.record.source_version).toBeNull();
    expect(outcome.record.event_id).toBeNull();
    expect(outcome.record.payload).toMatchObject({ resource_version: 7 });
    expect(outcome.record.evidence_class).toBe("AUTHENTICATED");
    expect(outcome.record.projection_version).toBe(1);
  });

  it("honors the version-ordering rules when the caller knows the version", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(4), receivedAt);
    const lower = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { stale: true },
      observedAt: parseUtcInstant(T0),
      sourceVersion: 3,
    });
    expect(lower.outcome).toBe("SKIPPED_OUTDATED");
    const same = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { same: true },
      observedAt: parseUtcInstant(T0),
      sourceVersion: 4,
    });
    expect(same.outcome).toBe("SKIPPED_SAME_VERSION");
    const higher = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { fresh: true },
      observedAt: parseUtcInstant(T0),
      sourceVersion: 5,
    });
    expect(higher.outcome).toBe("APPLIED");
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.source_version).toBe(5);
  });

  it("an event that OCCURRED BEFORE a canonical snapshot is skipped (late delivery)", async () => {
    const { engine, store } = makeEngine();
    const snapshotAt = parseUtcInstant("2026-01-15T09:00:00.000Z");
    await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { snapshot: true },
      observedAt: snapshotAt,
    });
    const lateEvent = await engine.projectVerifiedEvent(
      event(9, { occurred_at: parseUtcInstant("2026-01-15T08:00:00.000Z") }),
      parseUtcInstant("2026-01-15T09:05:00.000Z"),
    );
    expect(lateEvent.outcome).toBe("SKIPPED_OUTDATED");
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.payload).toMatchObject({ snapshot: true });
    // an event AT or AFTER the snapshot supersedes it
    const freshEvent = await engine.projectVerifiedEvent(
      event(10, { occurred_at: parseUtcInstant("2026-01-15T09:10:00.000Z") }),
      parseUtcInstant("2026-01-15T09:11:00.000Z"),
    );
    expect(freshEvent.outcome).toBe("APPLIED");
  });
});

describe("freshness transitions (RL-034, RL-LOCK-010)", () => {
  it("FRESH at write time; the guarantee expires; refreshFreshnessStates degrades monotonically", async () => {
    const { engine, store, clock } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(3), receivedAt);
    let current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("FRESH");
    expect(current?.evidence_class).toBe("AUTHENTICATED");

    // still within the 60s TTL
    clock.advanceTo("2026-01-15T08:30:30.000Z");
    await engine.refreshFreshnessStates();
    current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("FRESH");

    // past the TTL -> STALE
    clock.advanceTo("2026-01-15T08:31:01.000Z");
    const report = await engine.refreshFreshnessStates();
    expect(report.transitionedToStale).toBe(1);
    current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("STALE");
    expect(current?.evidence_class).toBe("STALE");
    expect(current?.projection_version).toBe(2);
    // the payload is retained (known prior state)
    expect(current?.payload).toMatchObject({ resource_version: 3 });

    // monotone: refresh never returns STALE to FRESH
    const again = await engine.refreshFreshnessStates();
    expect(again.transitionedToStale).toBe(0);
  });

  it("markStale degrades honestly and retains the last-known payload", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(3), receivedAt);
    const outcome = await engine.markStale("connectivity_contract", "contract-77", "TRANSPORT_UNAVAILABLE");
    expect(outcome.outcome).toBe("MARKED_STALE");
    if (outcome.outcome !== "MARKED_STALE") return;
    expect(outcome.cause).toBe("TRANSPORT_UNAVAILABLE");
    expect(outcome.record.freshness_state).toBe("STALE");
    expect(outcome.record.evidence_class).toBe("STALE");
    expect(outcome.record.payload).toMatchObject({ resource_version: 3 });
    expect(outcome.record.observed_at).toBe(T0);
    expect(outcome.record.projection_version).toBe(2);
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("STALE");
  });

  it("markUnknown records unobtainable truth WITHOUT a freshness guarantee (never guess)", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(3), receivedAt);
    const outcome = await engine.markUnknown("connectivity_contract", "contract-77", "TIMEOUT_OUTCOME_UNKNOWN");
    expect(outcome.outcome).toBe("MARKED_UNKNOWN");
    if (outcome.outcome !== "MARKED_UNKNOWN") return;
    expect(outcome.record.freshness_state).toBe("UNKNOWN");
    expect(outcome.record.evidence_class).toBe("UNKNOWN");
    expect(outcome.record.fresh_until).toBeNull();
    // last-known payload retained for diagnostics, uncertified
    expect(outcome.record.payload).toMatchObject({ resource_version: 3 });
    expect(outcome.record.projection_version).toBe(2);
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("UNKNOWN");
  });

  it("degradation on never-observed resources is NO_RECORD (absence is already unknown)", async () => {
    const { engine } = makeEngine();
    const stale = await engine.markStale("connectivity_contract", "contract-nope", "PROBE_FAILED");
    expect(stale.outcome).toBe("NO_RECORD");
    const unknown = await engine.markUnknown("connectivity_contract", "contract-nope", "PROBE_FAILED");
    expect(unknown.outcome).toBe("NO_RECORD");
  });

  it("recovery: a canonical read after UNKNOWN restores an honest FRESH snapshot", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    await engine.projectVerifiedEvent(event(3), receivedAt);
    await engine.markUnknown("connectivity_contract", "contract-77", "TRANSPORT_UNAVAILABLE");
    const recovery = await engine.projectCanonicalRead({
      resourceType: "connectivity_contract",
      resourceId: "contract-77",
      payload: { state: "CONTRACT_ACTIVE", resource_version: 8 },
      observedAt: parseUtcInstant("2026-01-15T09:00:00.000Z"),
    });
    expect(recovery.outcome).toBe("APPLIED");
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.freshness_state).toBe("FRESH");
    expect(current?.evidence_class).toBe("AUTHENTICATED");
    expect(current?.payload).toMatchObject({ resource_version: 8 });
    expect(current?.projection_version).toBe(3);
  });
});

describe("payload determinism and the §8 digest (RL-034)", () => {
  it("same event -> same payload digest, independent of envelope key order", () => {
    const a = payloadDigestOf({ b: 1, a: { y: 2, x: 1 } });
    const b = payloadDigestOf({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different payloads -> different digests", () => {
    expect(payloadDigestOf({ a: 1 })).not.toBe(payloadDigestOf({ a: 2 }));
  });
});

describe("resource-type coverage for webhook kinds (RL-034)", () => {
  it("every webhook resource kind projects onto its canonical type", async () => {
    const { engine, store } = makeEngine();
    const receivedAt = parseUtcInstant(T0);
    const intentEvent = event(1, {
      event_type: "connectivity_intent.created",
      resource_id: "intent-1" as never,
      resource_kind: "connectivity_intent",
    });
    const leaseEvent = event(1, {
      event_type: "connectivity_lease.granted",
      resource_id: "lease-1" as never,
      resource_kind: "connectivity_lease",
    });
    const endpointEvent = event(2, {
      event_type: "webhook_endpoint.registered",
      resource_id: "we-1" as never,
      resource_kind: "webhook_endpoint",
    });
    for (const e of [intentEvent, leaseEvent, endpointEvent]) {
      const outcome = await engine.projectVerifiedEvent(e, receivedAt);
      expect(outcome.outcome).toBe("APPLIED");
    }
    expect(await store.count("connectivity_intent")).toBe(1);
    expect(await store.count("connectivity_lease")).toBe(1);
    expect(await store.count("webhook_endpoint")).toBe(1);
    const all = await store.list();
    for (const record of all) {
      // canonical serialization of the record is stable (§8 digestable)
      expect(() => canonicalizeJson(record)).not.toThrow();
    }
  });
});
