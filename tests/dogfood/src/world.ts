/**
 * The deterministic end-to-end dogfood world (RL-072).
 *
 * Composes the REAL public packages exactly as production composition
 * would - no ADCOS internals, and the ONLY external stand-in is the §10
 * ADCOS fake (the public-client test double, per RL-LOCK-001/002). Every
 * piece is driven by the testkit clock/id generators: no sleeps, no
 * network, no ambient time, no randomness. One scenario = one world = one
 * correlation-ID family threaded end to end.
 *
 * The composed planes:
 *
 *   AUTH (RL-004)        AccountAdministrationService / AuthorizationService
 *   EXPERIENCE (RL-010/011/013) DeviceRegistryService, ExperienceIntentService,
 *                        buildExperienceDecision (the RL-013 read model)
 *   COMMERCE (RL-020/021/022) Catalog/Order/Subscription/Payment services
 *   COMPILER (RL-012)    compileExperienceIntent -> ConnectivityIntent command
 *   ADCOS BOUNDARY (RL-031/032) AdcosIntentAdapter + AdcosOfferReservationAdapter
 *                        over FakeAdcos (§10), behind AdcosCompatibilityState
 *   DATA PLANE (RL-033/034/035) createAdcosReconciliationBoundary: durable
 *                        webhook inbox -> projection engine -> reconciler,
 *                        with the §8 read-only projection reader exposed
 *   REFERENCES (RL-023)  ConnectivityReferenceService (commerce <-> connectivity
 *                        evidence layer; payment is not delivery)
 *   NOTIFICATIONS (RL-014) NotificationService (durable notifications emitted
 *                        only from RoamLink durable state transitions)
 *   AUDIT (RL-051)       InMemoryAuditLog (tamper-evident SHA-256 chain)
 */
import { fixtureCommandEnvelope } from "@roamlink/testkit";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  type Clock,
} from "@roamlink/testkit";
import type { CommandEnvelope, TenantId, UtcInstant, UserId } from "@roamlink/contracts";
import { parseUserId, tenantIdFromUser } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore, type ProjectionReader } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import {
  AdcosCompatibilityState,
  AdcosIntentAdapter,
  AdcosOfferReservationAdapter,
} from "@roamlink/integration";
import {
  AccountAdministrationService,
  AuthorizationService,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger as InMemoryAuthIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "@roamlink/auth";
import {
  DeviceRegistryService,
  ExperienceIntentService,
  InMemoryDeviceCapabilitySnapshotRepository,
  InMemoryDeviceContextSnapshotRepository,
  InMemoryDeviceRepository,
  InMemoryExperienceIntentRepository,
  InMemoryExperienceIntentVersionRepository,
  InMemoryIdempotencyLedger as InMemoryExperienceIdempotencyLedger,
} from "@roamlink/domain-experience";
import {
  CatalogService,
  InMemoryCommerceIdempotencyLedger,
  OrderService,
  PaymentService,
  SubscriptionService,
  createInMemoryCommerceStore,
  type CommerceServiceDeps,
} from "@roamlink/domain-commerce";
import {
  ConnectivityReferenceService,
  commerceReadViewsAsSubjectReader,
  createInMemoryConnectivityReferenceStore,
  type DeliveryEvidenceObservation,
  type DeliveryEvidenceSource,
} from "@roamlink/commerce-connectivity";
import {
  InMemoryNotificationsIdempotencyLedger,
  NotificationService,
  createInMemoryNotificationsStore,
} from "@roamlink/notifications";
import { InMemoryAuditLog } from "@roamlink/audit";

import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import type { FakeAdcosDelivery } from "../../../packages/integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

/** The platform tenant the reconciliation boundary records jobs under. */
export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
/** The deterministic epoch every dogfood scenario starts at. */
export const T0 = "2026-01-15T08:30:00.000Z";
/** A short hop used between journey steps (well inside webhook TTLs). */
export const STEP_MS = 1_000;

/** Deterministic instant arithmetic over ISO strings (no ambient Date.now). */
export function instantPlusMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

/**
 * Narrows a nullable lookup with an explicit, labeled failure (the suites
 * avoid non-null assertions: every missing record is a scenario failure).
 */
export function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`dogfood scenario expected a present ${label}`);
  }
  return value;
}

export interface DogfoodWorldOptions {
  readonly startAt?: string;
  /** Seed the fake's probe resources for the compatibility gate. */
  readonly seedProbe?: boolean;
}

/**
 * The composition-layer binding: the boundary's exposed read-only §8
 * projection reader adapted to the reference model's evidence port.
 * Records every read so scenarios can assert observation discipline.
 */
export class BoundaryEvidenceSource implements DeliveryEvidenceSource {
  readonly #reader: ProjectionReader;
  readonly #clock: Clock;
  readonly reads: { readonly type: string; readonly id: string; readonly at: UtcInstant }[] = [];

  constructor(reader: ProjectionReader, clock: Clock) {
    this.#reader = reader;
    this.#clock = clock;
  }

  async get(
    canonicalResourceType: string,
    canonicalResourceId: string,
  ): Promise<DeliveryEvidenceObservation | null> {
    this.reads.push({
      type: canonicalResourceType,
      id: canonicalResourceId,
      at: this.#clock.now(),
    });
    const record = await this.#reader.get(
      canonicalResourceType as never,
      canonicalResourceId,
    );
    if (record === null) return null;
    return {
      source_authority: record.source_authority,
      canonical_resource_type: record.canonical_resource_type,
      canonical_resource_id: record.canonical_resource_id,
      source_version: record.source_version,
      event_id: record.event_id,
      payload_digest: record.payload_digest,
      observed_at: record.observed_at,
      received_at: record.received_at,
      fresh_until: record.fresh_until,
      freshness_state: record.freshness_state,
      evidence_class: record.evidence_class,
      payload: record.payload,
    };
  }
}

/** A deterministic correlation-ID family: `corr.dogfood.<scene>.<n>`. */
export class CorrelationFamily {
  readonly #scene: string;
  #next = 0;

  constructor(scene: string) {
    this.#scene = scene;
  }

  next(): string {
    this.#next += 1;
    return `corr.dogfood.${this.#scene}.${this.#next}`;
  }

  issued(): number {
    return this.#next;
  }
}

export interface DogfoodWorld {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicUuidGenerator;
  readonly correlation: CorrelationFamily;
  readonly fake: FakeAdcos;
  readonly compatibility: AdcosCompatibilityState;
  readonly adcos: {
    readonly intents: AdcosIntentAdapter;
    readonly offers: AdcosOfferReservationAdapter;
  };
  readonly projectionStore: InMemoryProjectionStore;
  readonly boundary: ReturnType<typeof createAdcosReconciliationBoundary>;
  readonly auth: {
    readonly administration: AccountAdministrationService;
    readonly authorization: AuthorizationService;
    readonly users: InMemoryUserRepository;
    readonly organizations: InMemoryOrganizationRepository;
    readonly memberships: InMemoryMembershipRepository;
  };
  readonly experience: {
    readonly registry: DeviceRegistryService;
    readonly intents: ExperienceIntentService;
  };
  readonly commerce: {
    readonly catalog: CatalogService;
    readonly orders: OrderService;
    readonly subscriptions: SubscriptionService;
    readonly payments: PaymentService;
    readonly store: ReturnType<typeof createInMemoryCommerceStore>;
  };
  readonly references: ConnectivityReferenceService;
  readonly evidenceSource: BoundaryEvidenceSource;
  readonly notifications: NotificationService;
  readonly audit: InMemoryAuditLog;
  /** A fresh §5 envelope bound to the world's correlation family. */
  envelope: (input: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly key?: string;
    readonly intentVersion?: number;
    readonly orderVersion?: number;
  }) => CommandEnvelope;
  /** Admits every delivery the fake currently shows, in order. */
  admitAll: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<readonly string[]>;
  /** Admits + projects every current delivery (the async §6 step). */
  admitAndProject: (deliveries?: readonly FakeAdcosDelivery[]) => Promise<void>;
}

/** Builds the full deterministic dogfood world for one scenario. */
export function makeDogfoodWorld(
  scene: string,
  options: DogfoodWorldOptions = {},
): DogfoodWorld {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const ids = new DeterministicUuidGenerator(1);
  const correlation = new CorrelationFamily(scene);

  // --- ADCOS plane: the §10 fake behind the real adapters --------------------
  const fake = new FakeAdcos({
    seedProbe: options.seedProbe ?? false,
    now: () => clock.now(),
  });
  const compatibility = new AdcosCompatibilityState();
  const adapterDeps = {
    client: fake,
    clock,
    commandIds: new DeterministicUuidGenerator(2),
    compatibility,
  };
  const adcos = {
    intents: new AdcosIntentAdapter(adapterDeps),
    offers: new AdcosOfferReservationAdapter(adapterDeps),
  };

  // --- Integration data plane (RL-033/034/035, the §8 boundary) -------------
  const persistence = createInMemoryPersistence();
  const projectionStore = new InMemoryProjectionStore();
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const boundary = createAdcosReconciliationBoundary({
    client: fake,
    projectionStore,
    persistence,
    persistenceReader: persistence,
    verifier,
    clock,
    platformTenantId: PLATFORM_TENANT,
    jobIdGenerator: new DeterministicUuidGenerator(3),
  });

  // --- Auth plane (RL-004) ---------------------------------------------------
  const users = new InMemoryUserRepository();
  const credentials = new InMemoryCredentialRepository();
  const organizations = new InMemoryOrganizationRepository();
  const memberships = new InMemoryMembershipRepository();
  const authLedger = new InMemoryAuthIdempotencyLedger();
  const directory = new InMemoryUserDirectory(users);
  const authorization = new AuthorizationService(memberships, organizations);
  const administration = new AccountAdministrationService({
    users,
    directory,
    credentials,
    organizations,
    memberships,
    ledger: authLedger,
    hasher: new InsecureTestPasswordHasher(),
    authorization,
    now: () => clock.now(),
    generateMembershipId: () => ids.next(),
  });

  // --- Experience plane (RL-010/011) -----------------------------------------
  const devices = new InMemoryDeviceRepository();
  const capabilitySnapshots = new InMemoryDeviceCapabilitySnapshotRepository();
  const contextSnapshots = new InMemoryDeviceContextSnapshotRepository();
  const experienceLedger = new InMemoryExperienceIdempotencyLedger();
  const registry = new DeviceRegistryService({
    devices,
    capabilitySnapshots,
    contextSnapshots,
    policy: { authorize: async () => undefined },
    ledger: experienceLedger,
    now: () => clock.now(),
    generateSnapshotId: () => ids.next(),
  });
  const intents = new ExperienceIntentService({
    intents: new InMemoryExperienceIntentRepository(),
    versions: new InMemoryExperienceIntentVersionRepository(),
    policy: { authorize: async () => undefined },
    ledger: experienceLedger,
    now: () => clock.now(),
    generateIntentVersionId: () => ids.next(),
    devices,
  });

  // --- Commerce plane (RL-020/021/022) ----------------------------------------
  const commerceStore = createInMemoryCommerceStore();
  const commerceLedger = new InMemoryCommerceIdempotencyLedger();
  const commerceDeps: CommerceServiceDeps = {
    store: commerceStore,
    policy: { authorize: async () => undefined },
    ledger: commerceLedger,
    now: () => clock.now(),
    generateId: () => ids.next(),
  };
  const commerce = {
    store: commerceStore,
    catalog: new CatalogService(commerceDeps),
    orders: new OrderService(commerceDeps),
    subscriptions: new SubscriptionService(commerceDeps),
    payments: new PaymentService(commerceDeps),
  };

  // --- Commerce <-> connectivity references (RL-023) --------------------------
  const evidenceSource = new BoundaryEvidenceSource(boundary.projections, clock);
  const references = new ConnectivityReferenceService({
    store: createInMemoryConnectivityReferenceStore(),
    policy: { authorize: async () => undefined },
    ledger: commerceLedger,
    subjects: commerceReadViewsAsSubjectReader(commerceStore.read),
    evidenceSource,
    now: () => clock.now(),
    generateId: () => ids.next(),
  });

  // --- Notifications + audit (RL-014 / RL-051) --------------------------------
  const notifications = new NotificationService({
    store: createInMemoryNotificationsStore(),
    policy: { authorize: async () => undefined },
    ledger: new InMemoryNotificationsIdempotencyLedger(),
    now: () => clock.now(),
    generateId: () => ids.next(),
  });
  const audit = new InMemoryAuditLog({ eventIdGenerator: () => ids.next() });

  const envelope = (input: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly key?: string;
    readonly intentVersion?: number;
    readonly orderVersion?: number;
  }): CommandEnvelope =>
    fixtureCommandEnvelope({
      actorId: input.actorId,
      tenantId: input.tenantId,
      idempotencyKey: input.key ?? `idem.dogfood.${ids.next()}`,
      correlationId: correlation.next(),
      createdAt: clock.now(),
      ...(input.intentVersion !== undefined ? { intentVersion: input.intentVersion } : {}),
      ...(input.orderVersion !== undefined ? { orderVersion: input.orderVersion } : {}),
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

  const admitAll = async (
    deliveries?: readonly FakeAdcosDelivery[],
  ): Promise<readonly string[]> => {
    const list = deliveries ?? fake.deliveries();
    const outcomes: string[] = [];
    for (const delivery of list) {
      const signed = fakeWebhookDelivery({
        spec: toSpec(delivery),
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

  const admitAndProject = async (deliveries?: readonly FakeAdcosDelivery[]): Promise<void> => {
    await admitAll(deliveries);
    await boundary.inbox.processPending();
  };

  return {
    clock,
    ids,
    correlation,
    fake,
    compatibility,
    adcos,
    projectionStore,
    boundary,
    auth: { administration, authorization, users, organizations, memberships },
    experience: { registry, intents },
    commerce,
    references,
    evidenceSource,
    notifications,
    audit,
    envelope,
    admitAll,
    admitAndProject,
  };
}

// ---------------------------------------------------------------------------
// Shared journey vocabulary (deterministic fixtures used by the scenarios)
// ---------------------------------------------------------------------------

/** The Ghana trip intent payload (spec/architecture.md §3, in vocabulary). */
export function journeyIntentPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
    usageProfile: "travel_international",
    preferences: {
      reliability: "high",
      latency: "interactive",
      costSensitivity: "medium",
      privacySensitivity: "high",
      preferredAccessClasses: ["trusted_wifi", "home_cellular"],
    },
    hardConstraints: {
      requireEncryptedTransport: true,
      forbidRoaming: false,
      forbidOpenWifi: true,
    },
    ...overrides,
  };
}

/** The device capability matrix the journey device reports with evidence. */
export function journeyCapabilityMatrix(at: string): Record<string, unknown> {
  return {
    wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: at },
    cellular_data_sim_selection: { status: "available", evidenceClass: "OBSERVED", observedAt: at },
    active_interface_selection: { status: "available", evidenceClass: "OBSERVED", observedAt: at },
    radio_os_telemetry: { status: "available", evidenceClass: "OBSERVED", observedAt: at },
  };
}

/** The minimized device context the journey device reports. */
export function journeyContextPayload(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    network: { visibleWifiNetworkCount: 3, cellularRadio: "nr", vpnActive: false },
    battery: { levelPercent: 82, charging: false },
    ...overrides,
  };
}

export interface JourneyCustomer {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly email: string;
}

/** Registers one customer through the REAL auth boundary (RL-004). */
export async function registerCustomer(
  world: DogfoodWorld,
  seed: number,
): Promise<JourneyCustomer> {
  const userId = parseUserId(
    `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
  );
  const actorId = `usr:${userId}`;
  const tenantId = tenantIdFromUser(userId);
  await world.auth.administration.registerUser(
    world.envelope({ actorId, tenantId }),
    {
      userId,
      email: `traveler-${seed}@acahat.example`,
      displayName: `Traveler ${seed}`,
      password: "correct-horse-battery-staple",
    },
  );
  return { userId, tenantId, actorId, email: `traveler-${seed}@acahat.example` };
}

/** Enrolls the journey device, activates it, records fresh evidence snapshots. */
export async function enrollJourneyDevice(
  world: DogfoodWorld,
  customer: JourneyCustomer,
  seed: number,
): Promise<string> {
  const deviceId = `00000000-0000-4000-8000-${(0x1000 + seed).toString(16).padStart(12, "0")}`;
  const actor = { actorId: customer.actorId, tenantId: customer.tenantId };
  await world.experience.registry.enrollDevice(world.envelope(actor), {
    deviceId,
    ownership: { owningUserId: customer.userId },
    platform: { family: "ios", platformVersion: "18.2", model: "Acahat Phone" },
  });
  await world.experience.registry.transitionDevice(world.envelope(actor), {
    deviceId,
    transition: "activate",
  });
  const at = world.clock.now();
  await world.experience.registry.recordCapabilitySnapshot(world.envelope(actor), {
    deviceId,
    platform: { family: "ios", platformVersion: "18.2" },
    observedAt: at,
    // Freshness guarantee 10 minutes ahead: decisions re-evaluate evidence
    // AT the query instant, so the snapshots must carry a real window.
    freshUntil: instantPlusMs(at, 600_000),
    capabilities: journeyCapabilityMatrix(at),
  });
  await world.experience.registry.recordContextSnapshot(world.envelope(actor), {
    deviceId,
    ownerUserId: customer.userId,
    observedAt: at,
    freshUntil: instantPlusMs(at, 600_000),
    consent: { fineLocationGranted: false },
    payload: journeyContextPayload(),
  });
  return deviceId;
}
