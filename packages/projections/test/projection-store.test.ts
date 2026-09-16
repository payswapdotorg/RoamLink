import { describe, expect, it } from "vitest";
import { ConflictError } from "@roamlink/contracts";
import { InMemoryProjectionStore } from "../src/index.js";
import type { AdcosProjectionRecord } from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";

function record(version: number, payloadVersion = 4): AdcosProjectionRecord {
  return {
    projection_id: "prj.connectivity_contract.contract-77",
    source_authority: "adcos",
    canonical_resource_type: "connectivity_contract",
    canonical_resource_id: "contract-77",
    source_version: payloadVersion,
    event_id: `evt-${version}`,
    payload_digest: "a".repeat(64),
    observed_at: T0,
    received_at: T0,
    fresh_until: "2026-01-15T08:31:00.000Z",
    freshness_state: "FRESH",
    evidence_class: "AUTHENTICATED",
    projection_version: version,
    payload: { resource_version: payloadVersion },
  } as unknown as AdcosProjectionRecord;
}

describe("the projection store (RL-034: optimistic-concurrency writes)", () => {
  it("applies the first record at version 1 with expectedVersion null", async () => {
    const store = new InMemoryProjectionStore();
    const applied = await store.apply(record(1), null);
    expect(applied.projection_version).toBe(1);
    await expect(store.get("connectivity_contract", "contract-77")).resolves.toMatchObject({
      projection_version: 1,
    });
  });

  it("rejects a first write when the projection already exists", async () => {
    const store = new InMemoryProjectionStore();
    await store.apply(record(1), null);
    await expect(store.apply(record(2), null)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a CAS write with a stale expected version (never silent overwrite)", async () => {
    const store = new InMemoryProjectionStore();
    await store.apply(record(1), null);
    await store.apply(record(2), 1);
    // concurrent writer still believes version is 1
    await expect(store.apply(record(3), 1)).rejects.toBeInstanceOf(ConflictError);
    const current = await store.get("connectivity_contract", "contract-77");
    expect(current?.projection_version).toBe(2);
  });

  it("rejects a CAS write for a missing projection", async () => {
    const store = new InMemoryProjectionStore();
    await expect(store.apply(record(1), 1)).rejects.toBeInstanceOf(ConflictError);
  });

  it("every apply must advance the version by exactly one", async () => {
    const store = new InMemoryProjectionStore();
    await store.apply(record(1), null);
    await expect(store.apply(record(5), 1)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.apply(record(1), 1)).rejects.toBeInstanceOf(ConflictError);
  });

  it("the first record must be at projection_version 1", async () => {
    const store = new InMemoryProjectionStore();
    await expect(store.apply(record(2), null)).rejects.toBeInstanceOf(ConflictError);
  });

  it("list and count filter by resource type; records validate on read", async () => {
    const store = new InMemoryProjectionStore();
    await store.apply(record(1), null);
    const other: AdcosProjectionRecord = {
      ...record(1),
      projection_id: "prj.connectivity_intent.intent-1",
      canonical_resource_type: "connectivity_intent",
      canonical_resource_id: "intent-1",
      payload: { resource_version: 1 },
    } as unknown as AdcosProjectionRecord;
    await store.apply(other, null);
    expect(await store.count()).toBe(2);
    expect(await store.count("connectivity_contract")).toBe(1);
    expect(await store.count("connectivity_intent")).toBe(1);
    expect((await store.list()).map((r) => r.projection_id)).toEqual([
      "prj.connectivity_contract.contract-77",
      "prj.connectivity_intent.intent-1",
    ]);
    await expect(store.get("connectivity_lease", "lease-1")).resolves.toBeNull();
  });
});
