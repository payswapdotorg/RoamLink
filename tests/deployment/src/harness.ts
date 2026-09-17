/**
 * The deterministic deployment/recovery world (RL-075).
 *
 * Composes the REAL stateful components exactly as a service process
 * would - inbox, projections, outbox, audit, notifications,
 * reconciliation - over the persistence primitives, with THREE
 * deployment-specific capabilities the suites drive:
 *
 *  - RESTART: `makeDataPlane(world.persistence, world.projectionStore)`
 *    rebuilds the boundary over the SAME durable state (a process
 *    restart with its database and projection store intact);
 *  - SNAPSHOT/RESTORE: canonical-state export/import through the public
 *    reader contracts (the backup/restore story);
 *  - FAILURE INJECTION: a `FailingPersistence` decorator (storage
 *    full/failing), the §10 ADCOS fake's transport fault knobs, and
 *    testkit clock offsets.
 *
 * Deterministic throughout: testkit clock/ids, no sleeps, no network,
 * no ADCOS internals (RL-LOCK-018 discipline: the durability invariants
 * are asserted on observable public state, never on package internals).
 */
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import type { UtcInstant } from "@roamlink/contracts";
import { epochMsOf } from "@roamlink/contracts";
import {
  createInMemoryPersistence,
  type InMemoryPersistence,
} from "@roamlink/persistence";
import { InMemoryProjectionStore } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
  type WebhookAdmissionResult,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import type { AdcosClient } from "@roamlink/adcos";

import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import type { FakeAdcosDelivery } from "../../../packages/integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

/** The platform tenant the reconciliation boundary records jobs under. */
export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
/** The deterministic epoch every deployment scenario starts at. */
export const T0 = "2026-04-01T06:00:00.000Z";
/** The default projection freshness TTL (matches the load suite constant). */
export const EVENT_TTL_MS = 60_000;

/** Deterministic instant arithmetic over ISO strings (no ambient Date.now). */
export function instantPlusMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

/** The canonical-state snapshot (plain, JSON-serializable). */
export interface DataPlaneSnapshot {
  readonly takenAt: string;
  readonly records: Readonly<Record<string, readonly { recordId: string; version: number; value: unknown }[]>>;
  readonly outbox: readonly {
    readonly idempotencyKey: string;
    readonly deliveryState: string;
    readonly retryCount: number;
    readonly payload: string;
  }[];
  readonly inbox: readonly {
    sequence: number;
    state: string;
    dedupeKey: string;
    externalEventId: string;
    source: string;
    receivedAt: string;
  }[];
  readonly projections: readonly Record<string, unknown>[];
}

/** Everything one composed data-plane deployment process holds. */
export interface DataPlane {
  readonly boundary: ReturnType<typeof createAdcosReconciliationBoundary>;
  readonly projectionStore: InMemoryProjectionStore;
}

/** Builds the data plane over the GIVEN durable state (the restart shape). */
export function makeDataPlane(
  persistence: InMemoryPersistence,
  projectionStore: InMemoryProjectionStore,
  client: AdcosClient,
  clock: DeterministicClock,
  jobIdGenerator: { next(): string },
): DataPlane {
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const boundary = createAdcosReconciliationBoundary({
    client,
    projectionStore,
    persistence,
    persistenceReader: persistence,
    verifier,
    clock,
    platformTenantId: PLATFORM_TENANT,
    jobIdGenerator,
  });
  return { boundary, projectionStore };
}

export interface DeploymentWorld {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicUuidGenerator;
  readonly fake: FakeAdcos;
  readonly persistence: InMemoryPersistence;
  readonly projectionStore: InMemoryProjectionStore;
  /** The composed data plane (rebuild with makeDataPlane after a "restart"). */
  readonly plane: DataPlane;
  /** A fresh §6 admission through the real inbox. */
  admit: (delivery: {
    readonly headers: Record<string, string>;
    readonly payload: string;
  }) => Promise<WebhookAdmissionResult>;
  /** Admits every delivery the fake currently shows, in order. */
  admitAll: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<readonly string[]>;
  /** Admits + projects every current delivery (the §6 async step). */
  admitAndProject: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<void>;
}

export interface DeploymentWorldOptions {
  readonly startAt?: string;
}

/** Builds one deterministic deployment world. */
export function makeDeploymentWorld(options: DeploymentWorldOptions = {}): DeploymentWorld {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const ids = new DeterministicUuidGenerator(1);
  const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
  const persistence = createInMemoryPersistence();
  const projectionStore = new InMemoryProjectionStore();
  let jobId = 0;
  const plane = makeDataPlane(persistence, projectionStore, fake, clock, {
    next(): string {
      jobId += 1;
      return `00000000-0000-4000-8000-${(0xd000 + jobId).toString(16).padStart(12, "0")}`;
    },
  });

  const toSpec = (delivery: FakeAdcosDelivery) => ({
    eventId: delivery.event.event_id,
    eventType: delivery.event.event_type,
    resourceId: delivery.event.resource_id,
    resourceKind: delivery.event.resource_kind,
    resourceVersion: delivery.event.resource_version,
    occurredAt: delivery.event.occurred_at,
    correlationId: delivery.event.correlation_id,
    environment: "sandbox" as const,
  });

  const admit = (delivery: {
    readonly headers: Record<string, string>;
    readonly payload: string;
  }) =>
    plane.boundary.inbox.admitDelivery({
      headers: delivery.headers,
      payload: delivery.payload,
      receivedAt: clock.now(),
    });

  const admitAll = async (deliveries?: readonly FakeAdcosDelivery[]) => {
    const list = deliveries ?? fake.deliveries();
    const outcomes: string[] = [];
    for (const delivery of list) {
      const signed = fakeWebhookDelivery({
        spec: toSpec(delivery),
        deliveryId: delivery.deliveryId,
        sequence: delivery.sequence,
        receivedAt: clock.now(),
      });
      const admission = await admit(signed);
      outcomes.push(admission.outcome);
    }
    return outcomes;
  };

  const admitAndProject = async (deliveries?: readonly FakeAdcosDelivery[]) => {
    await admitAll(deliveries);
    await plane.boundary.inbox.processPending();
  };

  return { clock, ids, fake, persistence, projectionStore, plane, admit, admitAll, admitAndProject };
}

// ---------------------------------------------------------------------------
// Backup/restore: canonical-state export/import through PUBLIC contracts
// ---------------------------------------------------------------------------

/** The repositories the composed data plane persists under (public constants). */
export const DATA_PLANE_REPOSITORIES = [
  "adcos-webhook-inbox",
  "adcos-reconciliation-jobs",
] as const;

/** Exports the canonical state through the public reader contracts. */
export async function snapshotDataPlane(
  world: DeploymentWorld,
): Promise<DataPlaneSnapshot> {
  const records: Record<string, { recordId: string; version: number; value: unknown }[]> = {};
  for (const repository of DATA_PLANE_REPOSITORIES) {
    records[repository] = (await world.persistence.records(repository).list()).map((record) => ({
      recordId: record.recordId,
      version: record.version,
      value: record.value,
    }));
  }
  const outbox = (await world.persistence.outbox.list()).map((record) => ({
    idempotencyKey: record.idempotencyKey,
    deliveryState: record.deliveryState,
    retryCount: record.retryCount,
    payload: new TextDecoder().decode(record.payloadBytes),
  }));
  const inbox = (await world.persistence.inbox.list()).map((record) => ({
    sequence: record.sequence,
    state: record.admissionState,
    dedupeKey: record.dedupeKey,
    externalEventId: record.externalEventId,
    source: record.source,
    receivedAt: record.receivedAt,
  }));
  const projections = (await world.plane.boundary.projections.list()).map((record) =>
    JSON.parse(JSON.stringify(record)),
  );
  return Object.freeze({
    takenAt: world.clock.now(),
    records: Object.freeze(records),
    outbox: Object.freeze(outbox),
    inbox: Object.freeze(inbox),
    projections: Object.freeze(projections),
  });
}

/**
 * Imports a snapshot into a FRESH persistence (the restore path).
 *
 * Recovery semantics (the verified runbook's restore step):
 *  - named record repositories: re-inserted at their recorded versions
 *    (optimistic-concurrency tokens continue from where the backup left
 *    off - the restore never rewrites content);
 *  - the inbox ADMISSION LOG: ADMITTED dedupe keys are re-admitted so a
 *    replayed event into the restored deployment is still a DUPLICATE
 *    (exactly-once admission survives the restore); rejection audit rows
 *    are historical (they never occupied a dedupe key) and are skipped;
 *  - the outbox: UNSETTLED obligations (PENDING/DELIVERING in the backup)
 *    are re-enqueued claimable (at-least-once continuation - an obligation
 *    mid-flight at backup time restarts as claimable); TERMINAL records
 *    (DELIVERED/FAILED) are NEVER re-enqueued (their effect is settled -
 *    re-enqueue would duplicate it).
 */
export async function restoreDataPlane(
  snapshot: DataPlaneSnapshot,
): Promise<InMemoryPersistence> {
  const persistence = createInMemoryPersistence();
  for (const [repository, entries] of Object.entries(snapshot.records)) {
    if (entries.length === 0) continue;
    const unitOfWork = await persistence.begin();
    for (const entry of entries) {
      await unitOfWork.records(repository).insert(entry.recordId, entry.value as never);
      for (let version = 1; version < entry.version; version += 1) {
        await unitOfWork
          .records(repository)
          .compareAndSwap(entry.recordId, version, entry.value as never);
      }
    }
    await unitOfWork.commit();
  }

  // The inbox admission log: re-admit every ADMITTED dedupe key, in the
  // recorded sequence order (deterministic ordering).
  const unitOfWork = await persistence.begin();
  for (const entry of [...snapshot.inbox]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((record) => record.state === "ADMITTED")) {
    await unitOfWork.inbox.admit({
      source: entry.source,
      externalEventId: entry.externalEventId,
      receivedAt: entry.receivedAt,
      dedupeKey: entry.dedupeKey,
    });
  }
  await unitOfWork.commit();

  // The outbox: re-enqueue unsettled obligations only.
  for (const record of snapshot.outbox) {
    if (record.deliveryState === "DELIVERED" || record.deliveryState === "FAILED") continue;
    const outboxUnit = await persistence.begin();
    await outboxUnit.outbox.enqueue({
      idempotencyKey: record.idempotencyKey,
      payload: JSON.parse(record.payload) as never,
      createdAt: snapshot.takenAt,
    });
    await outboxUnit.commit();
  }
  return persistence;
}

// ---------------------------------------------------------------------------
// Storage failure injection: a failing UnitOfWorkFactory decorator
// ---------------------------------------------------------------------------

/**
 * A persistence decorator that fails COMMITS deterministically after a
 * caller-chosen number of successful commits ("storage full" / "storage
 * failing"). All reads pass through to the real persistence.
 */
export class FailingPersistence {
  readonly #inner: InMemoryPersistence;
  #commitsRemaining: number;
  #failure: Error;
  #commitCount = 0;

  constructor(inner: InMemoryPersistence, options: { readonly succeedCommits: number; readonly failure: Error }) {
    this.#inner = inner;
    this.#commitsRemaining = options.succeedCommits;
    this.#failure = options.failure;
  }

  /** The number of commits attempted (successful or failed). */
  get commitCount(): number {
    return this.#commitCount;
  }

  /** The decorated factory (a UnitOfWorkFactory whose commits can fail). */
  readonly factory = {
    begin: async () => {
      const inner = await this.#inner.begin();
      return {
        outbox: inner.outbox,
        inbox: inner.inbox,
        records: (repository: string) => inner.records(repository),
        commit: async (): Promise<void> => {
          this.#commitCount += 1;
          if (this.#commitsRemaining > 0) {
            this.#commitsRemaining -= 1;
            return inner.commit();
          }
          throw this.#failure;
        },
        rollback: async (): Promise<void> => inner.rollback(),
      };
    },
  };

  /** The underlying committed-state reader (reads are honest). */
  get reader(): InMemoryPersistence {
    return this.#inner;
  }
}

/** True when `at` is within `windowMs` of `now` (the testkit clock). */
export function withinWindow(now: UtcInstant, at: UtcInstant, windowMs: number): boolean {
  return Math.abs(epochMsOf(at) - epochMsOf(now)) <= windowMs;
}
