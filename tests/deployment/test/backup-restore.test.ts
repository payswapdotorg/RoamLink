/**
 * RL-075 suite 3: BACKUP/RESTORE SEMANTICS (spec/architecture.md
 * "Projection model": "Projections are disposable; canonical ADCOS state
 * is not"; spec/repository-layout.md "Infrastructure choices may be
 * swapped behind contracts").
 *
 * The canonical-state export/import round-trips through the PUBLIC
 * contracts (the plain, JSON-serializable record forms every reader
 * exposes), and the RESTORED deployment must pass the conformance-core
 * assertions and continue working - with reconciliation (RL-035)
 * repairing any drift between restored projections and domain truth.
 *
 * Recovery catalog:
 *   B-1 the export/import round-trip: a snapshot taken mid-flight (records,
 *        outbox, inbox, projections) survives a JSON round-trip; the
 *        restored deployment's state equals the source state (projections
 *        digest-identical, inbox preserved, outbox preserved);
 *   B-2 the restored state passes the conformance core: every projection
 *        carries the full §8 field set (provenance, freshness, evidence),
 *        and the exported audit chain still VERIFIES after the round-trip;
 *   B-3 continuation after restore: new work continues (the inbox dedupe
 *        keys survived - a replayed event is DUPLICATE, not re-applied;
 *        new events project; projection versions continue monotonically);
 *   B-4 reconciliation repairs drift between the restored projections and
 *        domain truth: (a) the TORN-WRITE drift (a record whose payload no
 *        longer digests to its recorded payload_digest) is repaired by an
 *        AUTHORITATIVE REPLACEMENT with digest-verified payload; (b) the
 *        MISSED-WEBHOOK drift (a silent canonical change while the backup
 *        was stale) is repaired by the canonical refresh after freshness
 *        decay.
 */
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@roamlink/contracts";
import { InMemoryProjectionStore } from "@roamlink/projections";
import { InMemoryAuditLog, verifyAuditChain } from "@roamlink/audit";
import {
  EVENT_TTL_MS,
  makeDataPlane,
  makeDeploymentWorld,
  restoreDataPlane,
  snapshotDataPlane,
} from "../src/harness.js";

/** Drives one canonical intent creation through the fake's client surface. */
async function createIntent(world: ReturnType<typeof makeDeploymentWorld>, key: string) {
  await world.fake.createIntent(
    {
      requirements: [
        { dimension: "usage", classification: "soft", statement: { profile: "backup" } },
      ],
      validity: { start: world.clock.now(), end: "2026-05-01T06:00:00.000Z" },
      termination: { actor: "customer", on_expiry: "release" },
      recorded_at: world.clock.now(),
    },
    { idempotencyKey: key as never },
  );
}

describe("RL-075 suite 3: backup/restore semantics", () => {
  it("B-1 the export/import round-trip preserves the canonical state exactly", async () => {
    const world = makeDeploymentWorld();
    for (let index = 1; index <= 3; index += 1) {
      await createIntent(world, `idem.backup.intent.${index}`);
    }
    await world.admitAndProject();

    // An outbox obligation is also in flight (mid-backup state).
    const unitOfWork = await world.persistence.begin();
    await unitOfWork.records("deployment-journal").insert("journal-1", { event: "backup-taken" });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "idem.backup.outbox.1",
      payload: { effect: "post-backup-notification" },
      createdAt: world.clock.now(),
    });
    await unitOfWork.commit();

    // A reconciliation job record exists too.
    await world.plane.boundary.reconciler.runJob({ reason: "scheduled" });

    // EXPORT through the public reader contracts, then the JSON
    // round-trip (what a backup file / network transfer sees).
    const snapshot = await snapshotDataPlane(world);
    const throughJson = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    // IMPORT into a fresh persistence + projection store.
    const restoredPersistence = await restoreDataPlane(throughJson);
    const restoredProjections = new InMemoryProjectionStore();
    for (const record of throughJson.projections) {
      await restoredProjections.apply(record as never, null);
    }
    const restored = makeDataPlane(
      restoredPersistence,
      restoredProjections,
      world.fake,
      world.clock,
      { next: () => "00000000-0000-4000-8000-00000000f101" },
    );

    // EQUALITY: projections digest-identical, one per canonical resource.
    const sourceProjections = await world.plane.boundary.projections.list();
    const restoredProjectionsList = await restored.boundary.projections.list();
    expect(restoredProjectionsList).toHaveLength(sourceProjections.length);
    for (const source of sourceProjections) {
      const twin = await restored.boundary.projections.get(
        source.canonical_resource_type,
        source.canonical_resource_id,
      );
      expect(twin).not.toBeNull();
      expect(twin?.payload_digest).toBe(source.payload_digest);
      expect(canonicalJsonDigest(twin?.payload as never)).toBe(twin?.payload_digest);
      expect(twin?.projection_version).toBe(source.projection_version);
      expect(twin?.freshness_state).toBe(source.freshness_state);
      expect(twin?.evidence_class).toBe(source.evidence_class);
    }

    // The inbox and outbox obligations survived verbatim.
    expect(throughJson.inbox.map((record) => record.state)).toEqual([
      "ADMITTED",
      "ADMITTED",
      "ADMITTED",
    ]);
    expect(throughJson.outbox.map((record) => record.idempotencyKey)).toEqual([
      "idem.backup.outbox.1",
    ]);
    expect(throughJson.outbox[0]?.deliveryState).toBe("PENDING");
    const restoredOutbox = await restoredPersistence.outbox.get("idem.backup.outbox.1");
    expect(restoredOutbox?.deliveryState).toBe("PENDING");
    expect(restoredOutbox?.payloadDigest).toBeDefined();
  });

  it("B-2 the restored state passes the conformance core (§8 shape + audit chain)", async () => {
    const world = makeDeploymentWorld();
    for (let index = 1; index <= 2; index += 1) {
      await createIntent(world, `idem.conf.intent.${index}`);
    }
    await world.admitAndProject();

    // An audit history travels with the backup (plain form, JSON-safe).
    const audit = new InMemoryAuditLog({
      eventIdGenerator: (() => {
        let counter = 0;
        return () =>
          `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
      })(),
    });
    for (let index = 1; index <= 3; index += 1) {
      await audit.append({
        category: "auth",
        action: `session.event-${index}`,
        outcome: index % 2 === 0 ? "denied" : "allowed",
        actorId: "usr:00000000-0000-4000-8000-0000000000d1",
        correlationId: `corr.deploy.backup.${index}`,
        occurredAt: world.clock.now(),
      });
    }

    const snapshot = await snapshotDataPlane(world);
    const throughJson = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    // CONFORMANCE CORE on the restored projections: the full §8 field set.
    const REQUIRED_FIELDS = [
      "projection_id",
      "source_authority",
      "canonical_resource_type",
      "canonical_resource_id",
      "source_version",
      "event_id",
      "payload_digest",
      "observed_at",
      "received_at",
      "fresh_until",
      "freshness_state",
      "evidence_class",
      "projection_version",
    ] as const;
    for (const record of throughJson.projections) {
      for (const field of REQUIRED_FIELDS) {
        expect(record, `restored projection missing §8 field '${field}'`).toHaveProperty(field);
      }
      expect(record["source_authority"]).toBe("adcos");
      // The digest is honest: it digests the payload it carries.
      expect(canonicalJsonDigest(record["payload"] as never)).toBe(record["payload_digest"]);
    }

    // The audit chain still verifies after the JSON round-trip (tamper
    // detection is a property of the plain records themselves).
    const plainAudit = (await audit.events()).map((event) => event.toPlain());
    const roundTrippedAudit = JSON.parse(JSON.stringify(plainAudit));
    expect(verifyAuditChain(roundTrippedAudit)).toMatchObject({ ok: true });
    // And tampering with the RESTORED copy is still detected.
    const tampered = JSON.parse(JSON.stringify(plainAudit)) as { outcome: string }[];
    const second = tampered[1];
    if (second === undefined) throw new Error("expected the second event");
    second.outcome = "allowed";

    const verification = verifyAuditChain(tampered);
    expect(verification.ok).toBe(false);
  });

  it("B-3 continuation after restore: dedupe keys survive and versions continue", async () => {
    const world = makeDeploymentWorld();
    for (let index = 1; index <= 2; index += 1) {
      await createIntent(world, `idem.continue.intent.${index}`);
    }
    const deliveries = [...world.fake.deliveries()];
    const outcomes = await world.admitAll(deliveries);
    expect(outcomes).toEqual(["ADMITTED", "ADMITTED"]);
    await world.plane.boundary.inbox.processPending();

    const snapshot = await snapshotDataPlane(world);
    const throughJson = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const restoredPersistence = await restoreDataPlane(throughJson);
    const restoredProjections = new InMemoryProjectionStore();
    for (const record of throughJson.projections) {
      await restoredProjections.apply(record as never, null);
    }
    const restored = makeDataPlane(
      restoredPersistence,
      restoredProjections,
      world.fake,
      world.clock,
      { next: () => "00000000-0000-4000-8000-00000000f102" },
    );

    // A replayed event (the SAME event id) into the RESTORED deployment is
    // DUPLICATE: the dedupe keys survived the backup/restore exactly.
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const first = deliveries[0];
    if (first === undefined) throw new Error("expected a delivery");
    const replay = await restored.boundary.inbox.admitDelivery({
      headers: fakeWebhookDelivery({
        spec: {
          eventId: first.event.event_id,
          eventType: first.event.event_type,
          resourceId: first.event.resource_id,
          resourceKind: first.event.resource_kind,
          resourceVersion: first.event.resource_version,
          occurredAt: first.event.occurred_at,
          correlationId: first.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: "delivery-replay-restored-1",
        sequence: first.sequence,
        receivedAt: world.clock.now(),
      }).headers,
      payload: fakeWebhookDelivery({
        spec: {
          eventId: first.event.event_id,
          eventType: first.event.event_type,
          resourceId: first.event.resource_id,
          resourceKind: first.event.resource_kind,
          resourceVersion: first.event.resource_version,
          occurredAt: first.event.occurred_at,
          correlationId: first.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: "delivery-replay-restored-1",
        sequence: first.sequence,
        receivedAt: world.clock.now(),
      }).payload,
      receivedAt: world.clock.now(),
    });
    expect(replay.outcome).toBe("DUPLICATE");
    expect(await restored.boundary.projections.count()).toBe(2); // no duplicate effect

    // NEW work continues in the restored deployment: versions advance
    // monotonically from where the backup left off.
    await createIntent(world, "idem.continue.intent.3");
    const newDelivery = world.fake.deliveries()[2];
    if (newDelivery === undefined) throw new Error("expected the new delivery");
    const newAdmission = await restored.boundary.inbox.admitDelivery({
      headers: fakeWebhookDelivery({
        spec: {
          eventId: newDelivery.event.event_id,
          eventType: newDelivery.event.event_type,
          resourceId: newDelivery.event.resource_id,
          resourceKind: newDelivery.event.resource_kind,
          resourceVersion: newDelivery.event.resource_version,
          occurredAt: newDelivery.event.occurred_at,
          correlationId: newDelivery.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: newDelivery.deliveryId,
        sequence: newDelivery.sequence,
        receivedAt: world.clock.now(),
      }).headers,
      payload: fakeWebhookDelivery({
        spec: {
          eventId: newDelivery.event.event_id,
          eventType: newDelivery.event.event_type,
          resourceId: newDelivery.event.resource_id,
          resourceKind: newDelivery.event.resource_kind,
          resourceVersion: newDelivery.event.resource_version,
          occurredAt: newDelivery.event.occurred_at,
          correlationId: newDelivery.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: newDelivery.deliveryId,
        sequence: newDelivery.sequence,
        receivedAt: world.clock.now(),
      }).payload,
      receivedAt: world.clock.now(),
    });
    expect(newAdmission.outcome).toBe("ADMITTED");
    await restored.boundary.inbox.processPending();
    expect(await restored.boundary.projections.count()).toBe(3);
  });

  it("B-4 reconciliation repairs drift between restored projections and domain truth", async () => {
    // (a) TORN-WRITE drift: a restored projection whose payload no longer
    //     digests to its recorded payload_digest (a torn write during the
    //     restore, or corruption in the backup itself).
    const world = makeDeploymentWorld();
    await createIntent(world, "idem.drift.intent.1");
    await world.admitAndProject();
    const pristine = (await world.plane.boundary.projections.list())[0];
    if (pristine === undefined) throw new Error("expected the pristine projection");

    const torn = JSON.parse(JSON.stringify(pristine)) as typeof pristine & {
      payload: Record<string, unknown>;
    };
    torn.payload["corrupted_field"] = "torn-write-garbage"; // digest breaks
    (torn as { projection_version: number }).projection_version =
      pristine.projection_version + 1; // advance by one
    await world.projectionStore.apply(torn, pristine.projection_version);
    const tornStored = await world.plane.boundary.projections.get(
      pristine.canonical_resource_type,
      pristine.canonical_resource_id,
    );
    expect(
      canonicalJsonDigest(tornStored?.payload as never) === tornStored?.payload_digest,
    ).toBe(false); // the drift is real

    const repairJob = await world.plane.boundary.reconciler.runJob({ reason: "scheduled" });
    const repairAction = repairJob.actions.find(
      (action) =>
        action.action_type === "CANONICAL_REFRESH" &&
        action.resource_id === pristine.canonical_resource_id,
    );
    expect(repairAction?.outcome).toBe("REPAIRED");
    const repaired = await world.plane.boundary.projections.get(
      pristine.canonical_resource_type,
      pristine.canonical_resource_id,
    );
    expect(repaired).not.toBeNull();
    // The repair is digest-verified against the CANONICAL truth.
    const canonical = await world.fake.getIntent(pristine.canonical_resource_id as never);
    expect(repaired?.payload).toEqual(canonical);
    expect(canonicalJsonDigest(repaired?.payload as never)).toBe(repaired?.payload_digest);

    // (b) MISSED-WEBHOOK drift: a contract was created canonically while
    //     the backup was being restored, but its event was never delivered
    //     (the backup predates it).
    const contractWorld = makeDeploymentWorld();
    const intentDocument = (await contractWorld.fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "drift-b" } },
        ],
        validity: { start: contractWorld.clock.now(), end: "2026-05-01T06:00:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: contractWorld.clock.now(),
      },
      { idempotencyKey: "idem.drift.b.intent" as never },
    )) as Record<string, unknown>;
    const intentId = intentDocument["id"] as string;
    const contractDocument = (await contractWorld.fake.acceptOffers(
      intentId,
      { offers: [], recorded_at: contractWorld.clock.now() },
      { idempotencyKey: "idem.drift.b.offers" as never },
    )) as Record<string, unknown>;
    const contractId = contractDocument["id"] as string;

    // Only the INTENT event is admitted + projected; the contract event was
    // missed entirely (the backup predates it).
    const intentDelivery = contractWorld
      .fake.deliveries()
      .find((delivery) => delivery.event.resource_kind === "connectivity_intent");
    if (intentDelivery === undefined) throw new Error("expected the intent delivery");
    await contractWorld.admitAndProject([intentDelivery]);
    const intentProjection = await contractWorld.plane.boundary.projections.get(
      "connectivity_intent",
      intentDelivery.event.resource_id,
    );
    expect(intentProjection?.freshness_state).toBe("FRESH");

    // The missed contract resource is DISCOVERED by the reconciler's
    // canonical scan and repaired (discovery + canonical read).
    contractWorld.clock.advanceBy(EVENT_TTL_MS + 5_000);
    const job = await contractWorld.plane.boundary.reconciler.runJob({ reason: "scheduled" });
    const contractRepair = job.actions.find(
      (action) =>
        action.action_type === "CANONICAL_REFRESH" &&
        action.resource_id === contractId &&
        action.outcome === "REPAIRED",
    );
    expect(contractRepair).toBeDefined();
    const repairedContract = await contractWorld.plane.boundary.projections.get(
      "connectivity_contract",
      contractId,
    );
    expect(repairedContract).not.toBeNull();
    expect(repairedContract?.payload_digest).toBe(
      canonicalJsonDigest(
        (await contractWorld.fake.getContract(contractId)) as never,
      ),
    );
  });
});
