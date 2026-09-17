/**
 * Deterministic load-shaped instrumentation (RL-073).
 *
 * Load suites here are NOT wall-clock benchmarks: everything runs on the
 * testkit clock/id generators with no sleeps, no network and no ambient
 * time. "Load" means VOLUME under CONTROLLED MEASUREMENT:
 *
 *  - COUNTING PROXIES wrap the PUBLIC ports (the projection store, the
 *    evidence source, the notification store reads) and count every
 *    operation, so complexity invariants are expressed as exact,
 *    mechanically-checkable operation counts per unit of admitted work;
 *  - bounded-behavior proofs assert caps, budgets and shape invariants
 *    that hold for ANY input size (retry budgets, batch limits, circuit
 *    half-open probe saturation, dead-letter exhaustion, queue draining);
 *  - convergence completeness asserts that high-volume churn loses no
 *    durable work and duplicates no effects.
 *
 * The counting proxies implement the SAME public interfaces the composed
 * packages consume (they are composition-layer decorators, not mocks of
 * RoamLink logic - the REAL engines run behind them).
 */
import type { UtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore, type ProjectionReader } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import type { ProjectionStore, AdcosProjectionRecord } from "@roamlink/projections";

import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import type { FakeAdcosDelivery } from "../../../packages/integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
export const T0 = "2026-01-15T08:30:00.000Z";

/**
 * A counting decorator over the PUBLIC ProjectionStore port: passes every
 * operation through to the REAL store and records the operation counts per
 * canonical resource. Complexity invariants are asserted against these
 * counts (e.g. "projecting N distinct events performs exactly N reads" -
 * O(1) per event, no history rescan).
 */
export class CountingProjectionStore implements ProjectionStore {
  readonly #inner: InMemoryProjectionStore;
  reads = 0;
  writes = 0;
  lists = 0;
  readonly readsByResource = new Map<string, number>();

  constructor(inner: InMemoryProjectionStore) {
    this.#inner = inner;
  }

  async apply(
    record: AdcosProjectionRecord,
    expectedProjectionVersion: number | null,
  ): Promise<AdcosProjectionRecord> {
    this.writes += 1;
    return this.#inner.apply(record, expectedProjectionVersion);
  }

  async get(
    resourceType: Parameters<ProjectionReader["get"]>[0],
    resourceId: string,
  ): Promise<AdcosProjectionRecord | null> {
    this.reads += 1;
    const key = `${String(resourceType)}`;
    this.readsByResource.set(key, (this.readsByResource.get(key) ?? 0) + 1);
    return this.#inner.get(resourceType, resourceId);
  }

  async list(
    resourceType?: Parameters<ProjectionReader["list"]>[0],
  ): Promise<readonly AdcosProjectionRecord[]> {
    this.lists += 1;
    return this.#inner.list(resourceType);
  }

  async count(
    resourceType?: Parameters<ProjectionReader["count"]>[0],
  ): Promise<number> {
    return this.#inner.count(resourceType);
  }

  reset(): void {
    this.reads = 0;
    this.writes = 0;
    this.lists = 0;
    this.readsByResource.clear();
  }
}

/** The measured load world: the §8 boundary over counting proxies. */
export interface LoadWorld {
  readonly clock: DeterministicClock;
  readonly fake: FakeAdcos;
  readonly store: CountingProjectionStore;
  readonly boundary: ReturnType<typeof createAdcosReconciliationBoundary>;
  /** Admits the given deliveries (signed, in order). */
  admitAll: (deliveries: readonly FakeAdcosDelivery[]) => Promise<readonly string[]>;
}

export interface LoadWorldOptions {
  readonly startAt?: string;
}

/** Builds the deterministic measured world. */
export function makeLoadWorld(options: LoadWorldOptions = {}): LoadWorld {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
  const persistence = createInMemoryPersistence();
  const store = new CountingProjectionStore(new InMemoryProjectionStore());
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const boundary = createAdcosReconciliationBoundary({
    client: fake,
    projectionStore: store,
    persistence,
    persistenceReader: persistence,
    verifier,
    clock,
    platformTenantId: PLATFORM_TENANT,
    jobIdGenerator: (() => {
      let counter = 0;
      return {
        next(): string {
          counter += 1;
          return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
        },
      };
    })(),
  });

  const admitAll = async (
    deliveries: readonly FakeAdcosDelivery[],
  ): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (const delivery of deliveries) {
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
        receivedAt: clock.now(),
      });
      const admission = await boundary.inbox.admitDelivery({
        headers: signed.headers,
        payload: signed.payload,
        receivedAt: clock.now(),
      });
      outcomes.push(admission.outcome);
    }
    return outcomes;
  };

  return { clock, fake, store, boundary, admitAll };
}

/**
 * Load-scale helper: drives N canonical intent creations through the fake's
 * public client surface (the same mutations production submits), each with
 * a distinct idempotency key, and returns the webhook deliveries.
 */
export async function ingestIntents(
  fake: FakeAdcos,
  clock: { now(): UtcInstant },
  count: number,
): Promise<readonly FakeAdcosDelivery[]> {
  for (let index = 0; index < count; index += 1) {
    await fake.createIntent(
      {
        requirements: [
          { dimension: "usage", classification: "soft", statement: { profile: "load" } },
        ],
        validity: { start: clock.now(), end: "2026-02-15T08:30:00.000Z" as UtcInstant },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: clock.now(),
      },
      { idempotencyKey: `idem.load.intent.${index + 1}` as never },
    );
  }
  return fake.deliveries();
}
