/**
 * The deterministic security-verification world (RL-074).
 *
 * Composes the REAL public packages exactly as production composition
 * would - the only external stand-in is the §10 ADCOS fake, driven by the
 * testkit clock/id generators: no sleeps, no network, no ambient time, no
 * randomness (the exceptions exercised here are themselves deterministic
 * attack fixtures).
 *
 * The threat model under verification (spec/security.md "Threat priorities",
 * the checklist for this suite):
 *
 *   1. forged/replayed ADCOS webhooks          -> webhook-source-attacks
 *   2. confused-deputy cross-tenant commands   -> tenant-actor-boundary
 *   3. stale projection causing unsafe action  -> (RL-071 delay suites;
 *      here: auth/session + evidence freshness negative proofs)
 *   4. duplicated reservation/order/payment cmds -> auth-session + boundary
 *      idempotency negative proofs (full duplicate coverage is RL-071)
 *   5. leaked ADCOS/provider credentials       -> secret-material-leakage
 *   6. compromised edge device                  -> auth-session (evidence)
 *   7. malicious provider metadata             -> secret-material-leakage
 *      (scan every persisted surface, incl. provider-shaped payloads)
 *   8. dependency/SDK supply-chain             -> tests/architecture +
 *      conformance RL-LOCK-012/013 (referenced, not duplicated here)
 *   9. loss/reordering of offline commands      -> tests/simulation (ref)
 *  10. privilege escalation through admin tooling -> tenant-actor-boundary
 *
 * This harness exposes every public surface the attack fixtures target:
 * the auth plane (RL-004), the ADCOS webhook inbox through the §8
 * reconciliation boundary (RL-033/034/035), the audit stream (RL-051),
 * the retention engine (RL-054), the enterprise API-key + customer-webhook
 * plane (RL-063), the notifications service (RL-014), and the app-kit fake
 * API + admin console (RL-060/061 surfaces).
 */
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";
import type { ActorId, CommandEnvelope, TenantId, UserId } from "@roamlink/contracts";
import { parseActorId, parseUserId, tenantIdFromUser } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import {
  AccountAdministrationService,
  AuthenticationService,
  AuthorizationService,
  InMemoryAuthSessionRepository,
  InMemoryCredentialRepository,
  InMemoryIdempotencyLedger as InMemoryAuthIdempotencyLedger,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserDirectory,
  InMemoryUserRepository,
  InsecureTestPasswordHasher,
} from "@roamlink/auth";
import { InMemoryAuditLog } from "@roamlink/audit";
import {
  InMemoryNotificationsIdempotencyLedger,
  NotificationService,
  createInMemoryNotificationsStore,
} from "@roamlink/notifications";

import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";
import type { WebhookAdmissionResult } from "@roamlink/webhook-inbox";

/** The platform tenant the reconciliation boundary records jobs under. */
export const PLATFORM_TENANT = "org:00000000-0000-4000-8000-000000000001";
/** The deterministic epoch every security scenario starts at. */
export const T0 = "2026-03-01T09:00:00.000Z";
/** A short hop used between attack steps (well inside webhook TTLs). */
export const STEP_MS = 1_000;

/** Deterministic instant arithmetic over ISO strings (no ambient Date.now). */
export function instantPlusMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

/** The composed security world (one scenario = one world). */
export interface SecurityWorld {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicUuidGenerator;
  readonly fake: FakeAdcos;
  readonly boundary: ReturnType<typeof createAdcosReconciliationBoundary>;
  readonly projectionStore: InMemoryProjectionStore;
  readonly persistence: ReturnType<typeof createInMemoryPersistence>;
  readonly verifier: HmacWebhookVerifier;
  readonly auth: {
    readonly administration: AccountAdministrationService;
    readonly authentication: AuthenticationService;
    readonly authorization: AuthorizationService;
    readonly users: InMemoryUserRepository;
    readonly credentials: InMemoryCredentialRepository;
    readonly sessions: InMemoryAuthSessionRepository;
    readonly organizations: InMemoryOrganizationRepository;
    readonly memberships: InMemoryMembershipRepository;
  };
  readonly audit: InMemoryAuditLog;
  readonly notifications: NotificationService;
  /** A fresh §5 envelope with attacker-controllable actor/tenant/key. */
  envelope: (input: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly key?: string;
    readonly commandId?: string;
    readonly correlationId?: string;
    readonly intentVersion?: number;
    readonly orderVersion?: number;
  }) => CommandEnvelope;
  /** Builds a SIGNED webhook delivery from an event spec (the honest path). */
  signedDelivery: (input: {
    readonly spec: FakeWebhookEventSpec;
    readonly deliveryId: string;
    readonly sequence: number;
    readonly receivedAt?: string;
  }) => { readonly headers: Record<string, string>; readonly payload: string };
  /** Admits a raw delivery (headers + payload) through the real inbox. */
  admit: (delivery: {
    readonly headers: Record<string, string>;
    readonly payload: string;
  }) => Promise<WebhookAdmissionResult>;
}

export interface SecurityWorldOptions {
  readonly startAt?: string;
}

/** Builds the deterministic security world for one scenario. */
export function makeSecurityWorld(options: SecurityWorldOptions = {}): SecurityWorld {
  const clock = new DeterministicClock(options.startAt ?? T0);
  const ids = new DeterministicUuidGenerator(1);
  let issued = 0;

  // --- ADCOS data plane (RL-033/034/035, the §8 boundary) --------------------
  const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
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
    jobIdGenerator: new DeterministicUuidGenerator(2),
  });

  // --- Auth plane (RL-004) ---------------------------------------------------
  const users = new InMemoryUserRepository();
  const credentials = new InMemoryCredentialRepository();
  const sessions = new InMemoryAuthSessionRepository();
  const organizations = new InMemoryOrganizationRepository();
  const memberships = new InMemoryMembershipRepository();
  const authLedger = new InMemoryAuthIdempotencyLedger();
  const directory = new InMemoryUserDirectory(users);
  const hasher = new InsecureTestPasswordHasher();
  const authorization = new AuthorizationService(memberships, organizations);
  const administration = new AccountAdministrationService({
    users,
    directory,
    credentials,
    organizations,
    memberships,
    ledger: authLedger,
    hasher,
    authorization,
    now: () => clock.now(),
    generateMembershipId: () => ids.next(),
  });
  const authentication = new AuthenticationService({
    users,
    directory,
    credentials,
    sessions,
    hasher,
    ledger: authLedger,
    now: () => clock.now(),
    generateSessionId: () => ids.next(),
  });

  // --- Audit + notifications (RL-051 / RL-014) -------------------------------
  const audit = new InMemoryAuditLog({ eventIdGenerator: () => ids.next() });
  const notifications = new NotificationService({
    store: createInMemoryNotificationsStore(),
    policy: { authorize: async () => undefined },
    ledger: new InMemoryNotificationsIdempotencyLedger(),
    now: () => clock.now(),
    generateId: () => ids.next(),
  });

  const envelope = (input: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly key?: string;
    readonly commandId?: string;
    readonly correlationId?: string;
    readonly intentVersion?: number;
    readonly orderVersion?: number;
  }): CommandEnvelope => {
    issued += 1;
    return fixtureCommandEnvelope({
      actorId: input.actorId,
      tenantId: input.tenantId,
      idempotencyKey: input.key ?? `idem.security.${issued}`,
      correlationId: input.correlationId ?? `corr.security.${issued}`,
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      ...(input.intentVersion !== undefined ? { intentVersion: input.intentVersion } : {}),
      ...(input.orderVersion !== undefined ? { orderVersion: input.orderVersion } : {}),
      createdAt: clock.now(),
    });
  };

  const signedDelivery = (input: {
    readonly spec: FakeWebhookEventSpec;
    readonly deliveryId: string;
    readonly sequence: number;
    readonly receivedAt?: string;
  }) =>
    fakeWebhookDelivery({
      spec: input.spec,
      deliveryId: input.deliveryId,
      sequence: input.sequence,
      receivedAt: input.receivedAt ?? clock.now(),
    });

  const admit = (delivery: {
    readonly headers: Record<string, string>;
    readonly payload: string;
  }) =>
    boundary.inbox.admitDelivery({
      headers: delivery.headers,
      payload: delivery.payload,
      receivedAt: clock.now(),
    });

  return {
    clock,
    ids,
    fake,
    boundary,
    projectionStore,
    persistence,
    verifier,
    auth: {
      administration,
      authentication,
      authorization,
      users,
      credentials,
      sessions,
      organizations,
      memberships,
    },
    audit,
    notifications,
    envelope,
    signedDelivery,
    admit,
  };
}

// ---------------------------------------------------------------------------
// Deterministic principals + attack-fixture builders
// ---------------------------------------------------------------------------

export interface SecurityPrincipal {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly email: string;
  readonly password: string;
}

/** Deterministic user id from a small seed (canonical UUID shape). */
export function seededUserId(seed: number): UserId {
  return parseUserId(
    `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
  );
}

/** Registers one user through the REAL auth boundary; returns the principal. */
export async function registerPrincipal(
  world: SecurityWorld,
  seed: number,
  password = "correct-horse-battery-staple",
): Promise<SecurityPrincipal> {
  const userId = seededUserId(seed);
  const actorId = parseActorId(`usr:${userId}`);
  const tenantId = tenantIdFromUser(userId);
  await world.auth.administration.registerUser(
    world.envelope({ actorId, tenantId }),
    {
      userId,
      email: `principal-${seed}@security.example`,
      displayName: `Principal ${seed}`,
      password,
    },
  );
  return { userId, tenantId, actorId, email: `principal-${seed}@security.example`, password };
}

/** A deterministic webhook event spec bound to the world clock. */
export function webhookEventSpec(input: {
  readonly eventId: string;
  readonly resourceId?: string;
  readonly resourceVersion?: number;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly apiVersion?: string;
  readonly environment?: "sandbox" | "production";
  readonly extraMembers?: Record<string, unknown>;
}): FakeWebhookEventSpec {
  return {
    eventId: input.eventId,
    eventType: "connectivity_intent.created",
    resourceId: input.resourceId ?? `00000000-0000-4000-8000-${input.eventId.slice(-12)}`,
    resourceKind: "connectivity_intent",
    resourceVersion: input.resourceVersion ?? 1,
    occurredAt: input.occurredAt ?? T0,
    correlationId: input.correlationId ?? `corr.security.${input.eventId}`,
    environment: input.environment ?? "sandbox",
    ...(input.apiVersion !== undefined ? { apiVersion: input.apiVersion } : {}),
    ...(input.extraMembers !== undefined ? { extraMembers: input.extraMembers } : {}),
  };
}

/** Deterministic sequence of delivery ids. */
export class DeliveryIds {
  readonly #prefix: string;
  #next = 0;
  constructor(prefix: string) {
    this.#prefix = prefix;
  }
  next(): string {
    this.#next += 1;
    return `${this.#prefix}-${this.#next}`;
  }
}
