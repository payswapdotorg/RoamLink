/**
 * RL-073 load suite: HIGH-VOLUME WEBHOOK INGESTION.
 *
 * Thousands of events through the durable inbox -> projection engine ->
 * read models, WITH duplicates and reorderings included, under exact
 * operation counting (testkit clock only - no wall-clock timing, no sleeps,
 * no network).
 *
 * Complexity invariants (mechanically checkable through the counting proxy
 * over the PUBLIC ProjectionStore port):
 *
 *  INV-1 (O(1) projection per event): projecting N DISTINCT events performs
 *       exactly N store reads and exactly N successful writes - the engine
 *       consults ONLY the target record (one get per event), never the full
 *       history: operation counts are linear in DISTINCT work, zero rescans;
 *  INV-2 (duplicates are O(1) admission, ZERO projection work): duplicate
 *       deliveries are absorbed AT ADMISSION (DUPLICATE outcome, no inbox
 *       row, no projection read/write); N duplicates cost 0 reads/writes;
 *  INV-3 (reordering is O(1) defense): a REVERSED stream of versioned events
 *       still performs exactly one read per event; late events are SKIPPED
 *       with no write - and the final state equals the in-order outcome
 *       (convergence) with no extra work;
 *  INV-4 (idempotent drain): a re-drain over P projected records touches
 *       the projection store ZERO times (the terminal-state check reads the
 *       inbox's own committed processing status) - no re-projection work
 *       at any volume;
 *  INV-5 (no duplicate effects): the read model holds exactly one record
 *       per canonical resource with monotone projection versions, even
 *       under duplicates + reordering.
 *
 * DEFECT-1 (recorded, reproduced at the bottom of this file): the inbox
 * drain cannot progress past the first batch-limit records of a larger
 * backlog - see the reproducer test for the minimal case and the honest
 * bounded-behavior documentation.
 */
import { describe, expect, it } from "vitest";

import { ingestIntents, makeLoadWorld } from "../src/harness.js";

const HIGH_VOLUME = 1_000;
const DUPLICATE_FACTOR = 2; // 2,000 deliveries total in the duplicate suite

describe("RL-073 load: high-volume webhook ingestion -> projections -> read models", () => {
  it("INV-1: N distinct events project with exactly N reads and N writes (O(1) per event, no rescan)", async () => {
    const world = makeLoadWorld();
    const deliveries = await ingestIntents(world.fake, world.clock, HIGH_VOLUME);
    expect(deliveries).toHaveLength(HIGH_VOLUME);

    const admissions = await world.admitAll(deliveries);
    expect(admissions.every((outcome) => outcome === "ADMITTED")).toBe(true);

    world.store.reset();
    const report = await world.boundary.inbox.processPending(HIGH_VOLUME);
    expect(report.applied).toBe(HIGH_VOLUME);

    // EXACT operation counts: one read + one write per distinct event. A
    // history rescan (O(n) per event) would show N*(N+1)/2 reads - the
    // measured count is exactly N, proving the per-event O(1) invariant.
    expect(world.store.reads).toBe(HIGH_VOLUME);
    expect(world.store.writes).toBe(HIGH_VOLUME);
    expect(world.store.lists).toBe(0);

    // The read model holds every distinct canonical resource exactly once.
    expect(await world.boundary.projections.count("connectivity_intent")).toBe(HIGH_VOLUME);
  }, 240_000);

  it("INV-2: thousands of duplicate deliveries cost ZERO extra projection reads/writes (O(1) admission dedupe)", async () => {
    const world = makeLoadWorld();
    world.fake.webhookDelivery = {
      duplicateFactor: DUPLICATE_FACTOR,
      reorder: "none",
      dropCount: 0,
      delayCount: 0,
    };
    const deliveries = await ingestIntents(world.fake, world.clock, HIGH_VOLUME);
    expect(deliveries).toHaveLength(HIGH_VOLUME * DUPLICATE_FACTOR);

    const admissions = await world.admitAll(deliveries);
    const admitted = admissions.filter((outcome) => outcome === "ADMITTED").length;
    const duplicates = admissions.filter((outcome) => outcome === "DUPLICATE").length;
    expect(admitted).toBe(HIGH_VOLUME);
    expect(duplicates).toBe(HIGH_VOLUME);

    world.store.reset();
    const report = await world.boundary.inbox.processPending(HIGH_VOLUME);
    expect(report.applied).toBe(HIGH_VOLUME);

    // Duplicates were absorbed AT ADMISSION: the projection engine did the
    // work of exactly the DISTINCT events - zero reads/writes for the
    // duplicate half of the 2,000-delivery stream.
    expect(world.store.reads).toBe(HIGH_VOLUME);
    expect(world.store.writes).toBe(HIGH_VOLUME);

    // INV-5: one effect per canonical resource, monotone versions.
    expect(await world.boundary.projections.count("connectivity_intent")).toBe(HIGH_VOLUME);
    const all = await world.boundary.projections.list("connectivity_intent");
    expect(all.every((record) => record.projection_version === 1)).toBe(true);
  }, 240_000);

  it("INV-3: a REVERSED versioned stream converges with one read per event and zero late writes", async () => {
    const world = makeLoadWorld();
    // Build a versioned history: create (v1) -> offers selected (v1) ->
    // activated (v2) through the public client surface.
    const create = await world.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "reorder" } },
        ],
        validity: { start: world.clock.now(), end: "2026-02-15T08:30:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: world.clock.now(),
      },
      { idempotencyKey: "idem.load.reorder.create" as never },
    );
    const intentId = (create as Record<string, unknown>)["id"] as string;
    const contract = await world.fake.acceptOffers(
      intentId,
      { offers: [], recorded_at: world.clock.now() },
      { idempotencyKey: "idem.load.reorder.offers" as never },
    );
    const contractId = (contract as Record<string, unknown>)["id"] as string;
    await world.fake.activateContract(
      intentId,
      { activated_at: world.clock.now(), signature_refs: [] },
      { idempotencyKey: "idem.load.reorder.activate" as never },
    );

    // Deliver the whole stream REVERSED (the worst reordering).
    const deliveries = [...world.fake.deliveries()].reverse();
    const admissions = await world.admitAll(deliveries);
    expect(admissions.every((outcome) => outcome === "ADMITTED")).toBe(true);

    world.store.reset();
    const report = await world.boundary.inbox.processPending(deliveries.length);
    expect(report.considered).toBe(deliveries.length);
    // Late (out-of-order) events were SKIPPED without writes: only the
    // newest-versioned event per resource wrote.
    expect(report.skipped).toBe(deliveries.length - report.applied);

    // The ordering defense is O(1) per event (one read each, no rescans);
    // only the applied events wrote.
    expect(world.store.reads).toBe(deliveries.length);
    expect(world.store.writes).toBe(report.applied);

    // Convergence: the final projection equals the in-order outcome.
    const contractProjection = await world.boundary.projections.get(
      "connectivity_contract",
      contractId,
    );
    expect(contractProjection?.source_version).toBe(2);
    expect((contractProjection?.payload as Record<string, unknown>)["event_type"]).toBe(
      "connectivity_contract.activated",
    );
    const intentProjection = await world.boundary.projections.get(
      "connectivity_intent",
      intentId,
    );
    expect(intentProjection?.source_version).toBe(1);
  });

  it("INV-4: re-draining P projected records performs exactly P reads and ZERO writes (idempotent drain)", async () => {
    const world = makeLoadWorld();
    const deliveries = await ingestIntents(world.fake, world.clock, 200);
    await world.admitAll(deliveries);
    const first = await world.boundary.inbox.processPending(200);
    expect(first.applied).toBe(200);

    // The re-drain: every record is in its terminal PROJECTED state; the
    // check consults the inbox's own committed processing status - the
    // PROJECTION STORE is not touched at all (zero reads, zero writes).
    world.store.reset();
    const second = await world.boundary.inbox.processPending(200);
    expect(second.considered).toBe(200);
    expect(second.alreadyProjected).toBe(200);
    expect(second.applied).toBe(0);
    expect(world.store.reads).toBe(0);
    expect(world.store.writes).toBe(0);

    // A third drain behaves identically (no degradation over repetition).
    world.store.reset();
    const third = await world.boundary.inbox.processPending(200);
    expect(third.applied).toBe(0);
    expect(world.store.reads).toBe(0);
    expect(world.store.writes).toBe(0);
  }, 240_000);

  // -------------------------------------------------------------------------
  // DEFECT-1 (recorded for the Tech Lead - fix ownership decided there;
  // packages/* is out of this work item's scope). Minimal reproducer + the
  // honest bounded-behavior documentation. The assertions below pin the
  // CURRENT observable behavior so the eventual fix FLIPS them (the
  // repository's own negative-proof discipline: a suite must be able to
  // fail).
  //
  //   DEFECT: AdcosWebhookInboxService.processPending(limit) slices the
  //   ADMITTED inbox list from index 0 on EVERY call. Admission state never
  //   changes after projection (processing status lives on the extended
  //   record), so with a backlog larger than `limit` the first `limit`
  //   records are re-considered forever and records beyond index `limit`
  //   are NEVER processed - the drain cannot progress past the first batch.
  //
  //   IMPACT: a webhook backlog > inboxBatchLimit (default 50) does not
  //   drain through repeated processPending calls; the affected events'
  //   inbox records stay PENDING indefinitely (the reliability property
  //   "every admitted record reaches a terminal state in bounded calls"
  //   fails at the inbox level). Projection-level convergence still
  //   happens through the reconciler's canonical refresh (Phase C), but
  //   the inbox terminal-state invariant is violated.
  //
  //   MINIMAL REPRODUCER: admit 3 valid events; processPending(2) twice ->
  //   the first call applies 2; the second call reports both as
  //   alreadyProjected and applies 0; the third event is never considered
  //   (its extended record stays PENDING forever).
  // -------------------------------------------------------------------------
  it("DEFECT-1 reproducer: a backlog larger than the batch limit never drains past the first batch", async () => {
    const world = makeLoadWorld();
    const deliveries = await ingestIntents(world.fake, world.clock, 3);
    await world.admitAll(deliveries);

    const first = await world.boundary.inbox.processPending(2);
    expect(first.considered).toBe(2);
    expect(first.applied).toBe(2);

    // Repeated drains re-consider the SAME first two records; the third is
    // never reached - current (defective) observable behavior, pinned here
    // so the fix flips this assertion to `applied: 1, considered: 1`.
    for (let call = 0; call < 10; call += 1) {
      const again = await world.boundary.inbox.processPending(2);
      expect(again.applied).toBe(0);
      expect(again.alreadyProjected).toBe(2);
    }

    // Only two of three events ever projected; the read model is missing
    // the third canonical resource (repair falls to reconciliation's
    // canonical scan, not the inbox drain).
    expect(await world.boundary.projections.count("connectivity_intent")).toBe(2);
  });
});
