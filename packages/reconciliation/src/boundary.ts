/**
 * The reconciliation boundary factory (RL-035, spec/adcos-integration.md §8).
 *
 * "Only the reconciler/integration boundary may write ADCOS-derived
 * projections." This factory is that boundary as ONE composition point:
 *
 *  - it constructs the Wave-2 projection engine over the raw projection
 *    store and NEVER leaks the writer surface - the writer is captured in a
 *    closure (a capability) handed only to the engine;
 *  - it constructs the durable webhook inbox bound to a BoundaryWebhookProjector
 *    so webhook-driven projection also flows through the boundary-owned
 *    engine (RL-033 -> RL-034 inside the boundary);
 *  - it constructs the reconciliation engine + its job store;
 *  - consumers receive the READ surface only (`projections`), the inbox
 *    service and the reconciler.
 *
 * Callers that need direct writes must not exist; the architecture test
 * (test/boundary-enforcement.test.ts + tests/architecture) fails the build
 * when a non-boundary package imports the projection writer surface.
 */
import { ValidationError, type TenantId } from "@roamlink/contracts";
import type { AdcosClient, WebhookVerifier } from "@roamlink/adcos";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import {
  AdcosProjectionEngine,
  type FreshnessPolicy,
  type ProjectionReader,
  type ProjectionStore,
  type ProjectionWriter,
} from "@roamlink/projections";
import { AdcosWebhookInboxService } from "@roamlink/webhook-inbox";
import type { Clock, IdGenerator } from "@roamlink/testkit";
import { BoundaryWebhookProjector } from "./projector.js";
import { AdcosReconciliationEngine, type ReconciliationCompatibilityGate } from "./engine.js";
import { ReconciliationJobStore } from "./job-store.js";
import type { ReconciliationPolicy } from "./policy.js";
import { AdcosClientResourceDiscovery, type CanonicalResourceDiscovery } from "./resource-discovery.js";
import type { ReconciliationSloObserver } from "./slo-emission.js";

/** Everything the boundary needs. All inputs are validated/typed seams. */
export interface ReconciliationBoundaryOptions {
  /** The public ADCOS client (reads for canonical refresh; never mutated by the boundary). */
  readonly client: AdcosClient;
  /** The raw projection store; its WRITE surface is captured inside the boundary. */
  readonly projectionStore: ProjectionStore;
  /** Persistence for the durable job records (units of work). */
  readonly persistence: UnitOfWorkFactory;
  /** Committed-state reads (job records + inbox). */
  readonly persistenceReader: PersistenceReader;
  /** The webhook verifier (RL-033) admitting signals into the durable inbox. */
  readonly verifier: WebhookVerifier;
  readonly clock: Clock;
  /** The platform/deployment tenant all reconciliation jobs run under. */
  readonly platformTenantId: TenantId | string;
  readonly policy?: ReconciliationPolicy;
  readonly freshness?: FreshnessPolicy;
  readonly discovery?: CanonicalResourceDiscovery;
  readonly compatibility?: ReconciliationCompatibilityGate;
  readonly jobIdGenerator?: IdGenerator;
  /**
   * Optional §11 SLO emission port (additive RL-052 wiring), passed through
   * to the reconciliation engine — see `slo-emission.ts`. The
   * `@roamlink/observability` product-SLO recorder satisfies it structurally.
   */
  readonly sloObserver?: ReconciliationSloObserver;
}

/** The composed boundary. Write capabilities stay inside. */
export interface ReconciliationBoundary {
  /** The reconciliation engine (runJob is the §7 orchestration). */
  readonly reconciler: AdcosReconciliationEngine;
  /** The durable webhook inbox, projecting through the boundary-owned engine. */
  readonly inbox: AdcosWebhookInboxService;
  /** The projection READ surface for everyone else (no write methods exist on it). */
  readonly projections: ProjectionReader;
}

/**
 * Wraps a projection store so the write capability is held by closure. The
 * returned writer is created exactly once per boundary and handed only to
 * the projection engine - this is the runtime shape of "only the boundary
 * writes" (compile-time enforcement lives in the architecture tests).
 */
export function createBoundaryProjectionWriter(store: ProjectionStore): ProjectionWriter {
  return {
    apply: (record, expectedProjectionVersion) =>
      store.apply(record, expectedProjectionVersion),
  };
}

/** A read-only facade over a projection store (get/list/count only). */
export function readOnlyProjectionReader(store: ProjectionStore): ProjectionReader {
  return {
    get: (resourceType, resourceId) => store.get(resourceType, resourceId),
    list: (resourceType) => store.list(resourceType),
    count: (resourceType) => store.count(resourceType),
  };
}

/**
 * Composes the whole reconciliation boundary. The raw projection store
 * crosses in and never crosses back out as a writer.
 */
export function createAdcosReconciliationBoundary(
  options: ReconciliationBoundaryOptions,
): ReconciliationBoundary {
  const platformTenantId = options.platformTenantId as TenantId;
  if (typeof platformTenantId !== "string" || !platformTenantId.startsWith("org:")) {
    throw new ValidationError(
      "ReconciliationBoundaryOptions.platformTenantId must be the 'org:<uuid>' deployment tenant reconciliation jobs run under",
      {
        reason: "RECONCILIATION_BOUNDARY_INVALID",
        details: [{ path: "platformTenantId", issue: "not an organization tenant id" }],
      },
    );
  }

  // The §8 write capability: captured here, handed to the engine, never returned.
  const writer = createBoundaryProjectionWriter(options.projectionStore);
  const projectionEngine = new AdcosProjectionEngine({
    writer,
    reader: options.projectionStore,
    clock: options.clock,
    ...(options.freshness !== undefined ? { freshness: options.freshness } : {}),
  });

  const inbox = new AdcosWebhookInboxService({
    verifier: options.verifier,
    persistence: options.persistence,
    reader: options.persistenceReader,
    clock: options.clock,
    projector: new BoundaryWebhookProjector(projectionEngine),
  });

  const jobs = new ReconciliationJobStore(options.persistence, options.persistenceReader);
  const reconciler = new AdcosReconciliationEngine({
    client: options.client,
    projectionEngine,
    projectionReader: options.projectionStore,
    jobs,
    inbox,
    clock: options.clock,
    tenantId: platformTenantId,
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    ...(options.discovery !== undefined
      ? { discovery: options.discovery }
      : { discovery: new AdcosClientResourceDiscovery(options.client) }),
    ...(options.compatibility !== undefined ? { compatibility: options.compatibility } : {}),
    ...(options.jobIdGenerator !== undefined ? { jobIdGenerator: options.jobIdGenerator } : {}),
    ...(options.sloObserver !== undefined ? { sloObserver: options.sloObserver } : {}),
  });

  return {
    reconciler,
    inbox,
    projections: readOnlyProjectionReader(options.projectionStore),
  };
}
