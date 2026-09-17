/**
 * Deterministic reconciliation test harness (RL-035).
 *
 * Assembles the full boundary exactly like production composition would:
 * the Wave-2 ADCOS fake (public interface only, spec §10), the in-memory
 * persistence adapter, the in-memory projection store, the HMAC webhook
 * verifier with signed fake deliveries, and the boundary factory. The
 * DeterministicClock drives every time-dependent decision; job ids come from
 * the deterministic UUID generator.
 */
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import { parseUtcInstant } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore, type AdcosProjectionRecord } from "@roamlink/projections";
import { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry } from "@roamlink/webhook-inbox";
import type { AdcosClient } from "@roamlink/adcos";
import { FakeAdcos } from "../../integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "../../webhook-inbox/test/fake-adcos-webhooks.js";
import type { FakeAdcosDelivery } from "../../integration/test/fake-adcos.js";
import { createAdcosReconciliationBoundary } from "../src/index.js";
import type { ReconciliationBoundary } from "../src/boundary.js";
import type { ReconciliationCompatibilityGate } from "../src/engine.js";
import type { CanonicalResourceDiscovery } from "../src/resource-discovery.js";
import type { ReconciliationSloObserver } from "../src/slo-emission.js";
import {
  DEFAULT_RECONCILIATION_POLICY,
  type ReconciliationPolicy,
} from "../src/policy.js";

export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
export const T0 = "2026-01-15T08:30:00.000Z";

export interface HarnessOptions {
  readonly policy?: Partial<ReconciliationPolicy>;
  readonly seedProbe?: boolean;
  readonly compatibility?: ReconciliationCompatibilityGate;
  readonly discovery?: CanonicalResourceDiscovery;
  readonly startAt?: string;
  /** Overrides the ADCOS client handed to the boundary (counting proxies etc.). */
  readonly client?: AdcosClient;
  /** Optional §11 SLO emission observer wired into the boundary (additive). */
  readonly sloObserver?: ReconciliationSloObserver;
}

export interface Harness {
  readonly clock: DeterministicClock;
  readonly fake: FakeAdcos;
  readonly store: InMemoryProjectionStore;
  readonly boundary: ReconciliationBoundary;
  readonly jobIds: DeterministicUuidGenerator;
  /** Admits signed fake deliveries through the durable inbox. */
  admit: (deliveries: readonly FakeAdcosDelivery[]) => Promise<readonly string[]>;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const fake = new FakeAdcos({ seedProbe: options.seedProbe ?? false, now: () => clock.now() });
  const persistence = createInMemoryPersistence();
  const store = new InMemoryProjectionStore();
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const jobIds = new DeterministicUuidGenerator(1);
  const policy: ReconciliationPolicy = {
    ...DEFAULT_RECONCILIATION_POLICY,
    ...options.policy,
  };
  const boundary = createAdcosReconciliationBoundary({
    client: options.client ?? fake,
    projectionStore: store,
    persistence,
    persistenceReader: persistence,
    verifier,
    clock,
    platformTenantId: PLATFORM_TENANT,
    policy,
    jobIdGenerator: jobIds,
    ...(options.compatibility !== undefined ? { compatibility: options.compatibility } : {}),
    ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
    ...(options.sloObserver !== undefined ? { sloObserver: options.sloObserver } : {}),
  });

  const admit = async (deliveries: readonly FakeAdcosDelivery[]): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (const delivery of deliveries) {
      const spec: FakeWebhookEventSpec = {
        eventId: delivery.event.event_id,
        eventType: delivery.event.event_type,
        resourceId: delivery.event.resource_id,
        resourceKind: delivery.event.resource_kind,
        resourceVersion: delivery.event.resource_version,
        occurredAt: delivery.event.occurred_at,
        correlationId: delivery.event.correlation_id,
        environment: "sandbox",
      };
      const signed = fakeWebhookDelivery({
        spec,
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

  return { clock, fake, store, boundary, jobIds, admit };
}

/** Convenience: fetch one projection or fail with a clear message. */
export async function mustGetProjection(
  harness: Harness,
  resourceType: AdcosProjectionRecord["canonical_resource_type"],
  resourceId: string,
): Promise<AdcosProjectionRecord> {
  const record = await harness.boundary.projections.get(resourceType, resourceId);
  if (record === null) {
    throw new Error(`test expected a projection for ${resourceType}/${resourceId}`);
  }
  return record;
}

/** A compatibility gate fake with a fixed status. */
export function fixedGate(status: "unknown" | "compatible" | "incompatible"): ReconciliationCompatibilityGate {
  return { status: () => status };
}

/**
 * A counting proxy over an ADCOS client: records every read/list call so
 * tests can prove the reconciler performed (or performed NO) canonical I/O.
 */
export function countingAdcosClient(client: AdcosClient): { client: AdcosClient; reads: { count: number } } {
  const reads = { count: 0 };
  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof value === "function" &&
        typeof property === "string" &&
        (property.startsWith("get") || property.startsWith("list"))
      ) {
        return (...args: readonly unknown[]) => {
          reads.count += 1;
          return (value as (...rest: readonly unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  });
  return { client: proxy as AdcosClient, reads };
}

/** The canonical intent request the fake accepts (mirrors the compat probe). */
export const TEST_INTENT_REQUEST = Object.freeze({
  requirements: Object.freeze([
    Object.freeze({ dimension: "usage", classification: "soft", statement: Object.freeze({ profile: "test" }) }),
  ]),
  validity: Object.freeze({
    start: parseUtcInstant("2026-01-15T08:30:00.000Z"),
    end: parseUtcInstant("2026-01-16T08:30:00.000Z"),
  }),
  termination: Object.freeze({ actor: "roamlink", on_expiry: "release" }),
  recorded_at: parseUtcInstant("2026-01-15T08:30:00.000Z"),
});

/** Creates one intent on the fake and returns its id (emits evt v1). */
export async function createIntentOnFake(harness: Harness, idempotencyKey: string): Promise<string> {
  const document = await harness.fake.createIntent(TEST_INTENT_REQUEST, {
    idempotencyKey: idempotencyKey as never,
  });
  return (document as { id: string }).id;
}
