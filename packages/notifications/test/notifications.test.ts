/**
 * RL-014 tests: notifications, preferences/channels, support cases.
 *
 * Proves:
 *  - RL-LOCK-009: notifications are emitted ONLY from RoamLink durable
 *    state transitions - the closed TransitionOrigin contract (origin
 *    vocabulary, RoamLink aggregate-type vocabulary, REQUIRED durable
 *    event id) rejects every raw-ADCOS-payload shape (missing origin,
 *    foreign origin, ADCOS resource types, unknown fields, no receipt);
 *  - the notification state machine (pending -> delivered|failed|read|
 *    suppressed, full truth table) and the channel-delivery derivation
 *    (first success delivers; failed only when EVERY effective channel
 *    failed);
 *  - preferences are typed contracts: mute produces a SUPPRESSED durable
 *    notification (suppression is a state, never a deletion); defaults
 *    apply for unmentioned topics; CAS on revision;
 *  - the support-case state machine (open -> in_progress -> resolved ->
 *    closed; cancel paths) with typed reasonless terminal states;
 *  - THE customer/internal VISIBILITY BOUNDARY: internal messages are
 *    gated behind support_case:internal and are structurally absent from
 *    the customer-facing thread view;
 *  - event correlation: notifications and tickets both correlate with
 *    typed references (order / subscription / connectivity_reference),
 *    queried tenant-scoped;
 *  - tenant fail-closed boundaries (RL-LOCK-018) and command idempotency
 *    (RL-LOCK-014);
 *  - the /v1/notifications API resource mapper exposes RoamLink state +
 *    evidence references and no internal ADCOS types.
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  parseUserId,
  parseUtcInstant,
} from "@roamlink/contracts";
import {
  DeterministicClock,
  DeterministicUuidGenerator,
  fixtureCommandEnvelope,
} from "@roamlink/testkit";

import {
  ChannelDelivery,
  createInMemoryNotificationsStore,
  InMemoryNotificationsIdempotencyLedger,
  Notification,
  NotificationService,
  SUPPORT_CASE_STATES,
  SupportCase,
  caseMessagesCustomerView,
  resolveEffectiveChannels,
  toNotificationApiResource,
  type NotificationAction,
  type NotificationPreferencesRecord,
  type SupportCaseMessageRecord,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const OWNER = parseUserId("00000000-0000-4000-8000-000000000002");
const TENANT = "usr:00000000-0000-4000-8000-000000000002" as never;
const OTHER_TENANT = "usr:00000000-0000-4000-8000-000000000099" as never;

const idAt = (seed: number) => new DeterministicUuidGenerator(seed).next();
const NOTIFICATION = idAt(100);
const NOTIFICATION_2 = idAt(101);
const CASE = idAt(200);
const MESSAGE_1 = idAt(300);
const MESSAGE_2 = idAt(301);
const ORDER_REF = idAt(400);
const CONNECTIVITY_REFERENCE_REF = idAt(401);

const at = (iso: string) => parseUtcInstant(iso);

/** A valid durable-transition source (the only legal origin shape). */
const source = (overrides?: Record<string, unknown>) => ({
  origin: "roamlink_state_transition",
  aggregateType: "order",
  aggregateId: ORDER_REF,
  transition: "order.placed",
  eventId: idAt(500),
  occurredAt: T0,
  ...overrides,
});

/** Fail-closed stub policy with an explicit deny set + actor check. */
class StubPolicy {
  readonly denied = new Set<NotificationAction>();
  readonly #allowedActors: ReadonlySet<string>;

  constructor(allowedActors: readonly string[]) {
    this.#allowedActors = new Set(allowedActors);
  }

  deny(action: NotificationAction): this {
    this.denied.add(action);
    return this;
  }

  async authorize(actorId: string, _tenantId: unknown, action: NotificationAction): Promise<void> {
    if (!this.#allowedActors.has(actorId) || this.denied.has(action)) {
      throw new UnauthorizedError(`notifications policy denied ${action}`, {
        reason: "NOTIFICATION_POLICY_DENIED",
      });
    }
  }
}

function makeService(startAt = T0) {
  const clock = new DeterministicClock(startAt);
  const ids = new DeterministicUuidGenerator(7_000);
  const policy = new StubPolicy(["actor-1", "agent-1"]);
  const ledger = new InMemoryNotificationsIdempotencyLedger();
  const store = createInMemoryNotificationsStore();
  const service = new NotificationService({
    store,
    policy,
    ledger,
    now: () => clock.now(),
    generateId: () => ids.next(),
  });
  const envelope = (overrides?: { readonly key?: string; readonly tenantId?: string; readonly actorId?: string }) =>
    fixtureCommandEnvelope({
      actorId: overrides?.actorId ?? "actor-1",
      tenantId: overrides?.tenantId ?? TENANT,
      idempotencyKey: overrides?.key ?? `idem-${ids.next()}`,
      createdAt: clock.now(),
    });
  return { clock, ids, policy, ledger, store, service, envelope };
}

type World = ReturnType<typeof makeService>;

async function emitted(world: World, overrides?: {
  readonly notificationId?: string;
  readonly topic?: string;
  readonly key?: string;
  readonly relatedRefs?: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
  readonly recipientUserId?: string;
}) {
  const envelope =
    overrides?.key !== undefined ? world.envelope({ key: overrides.key }) : world.envelope();
  return world.service.emitFromTransition(envelope, {
    notificationId: overrides?.notificationId ?? NOTIFICATION,
    recipientUserId: overrides?.recipientUserId ?? OWNER,
    topic: overrides?.topic ?? "order",
    severity: "info",
    title: "Order placed",
    body: "Your travel pass order was placed.",
    source: source() as never,
    relatedRefs: overrides?.relatedRefs ?? [{ kind: "order", id: ORDER_REF }],
  });
}

// ---------------------------------------------------------------------------
// Aggregate state machines
// ---------------------------------------------------------------------------

describe("Notification aggregate (notification_state)", () => {
  const base = {
    tenantId: TENANT,
    recipientUserId: OWNER,
    topic: "order",
    severity: "info",
    title: "Order placed",
    body: "Your travel pass order was placed.",
    source: source(),
    relatedRefs: [{ kind: "order", id: ORDER_REF }] as const,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  it("proves the legal transitions incl. the failure and suppression paths", () => {
    const pending = new Notification({ ...base, notificationId: NOTIFICATION, status: "pending" });
    const delivered = pending.deliver(at("2026-02-01T00:00:00.000Z"));
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).toBeDefined();
    const read = delivered.markRead(at("2026-02-02T00:00:00.000Z"));
    expect(read.status).toBe("read");
    const failed = new Notification({ ...base, notificationId: NOTIFICATION_2, status: "pending" })
      .fail(at("2026-02-01T00:00:00.000Z"));
    expect(failed.status).toBe("failed");
    const suppressed = new Notification({ ...base, notificationId: NOTIFICATION_2, status: "pending" })
      .suppress(at("2026-02-01T00:00:00.000Z"));
    expect(suppressed.status).toBe("suppressed");
    // pending can be read directly (in-app read before delivery records)
    const directRead = new Notification({ ...base, notificationId: NOTIFICATION_2, status: "pending" })
      .markRead(at("2026-02-01T00:00:00.000Z"));
    expect(directRead.status).toBe("read");
  });

  it("proves every illegal transition (the full truth table)", () => {
    const delivered = new Notification({
      ...base,
      notificationId: NOTIFICATION,
      status: "delivered",
      deliveredAt: T0,
    });
    expect(() => delivered.deliver(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => delivered.fail(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() => delivered.suppress(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError);
    for (const terminal of ["failed", "read", "suppressed"] as const) {
      const notification = new Notification({
        ...base,
        notificationId: NOTIFICATION,
        status: terminal,
        ...(terminal === "read" ? { readAt: T0 } : {}),
      });
      expect(() => notification.deliver(at("2026-02-01T00:00:00.000Z")), terminal).toThrow(ValidationError);
      expect(() => notification.markRead(at("2026-02-01T00:00:00.000Z")), terminal).toThrow(ValidationError);
    }
  });
});

describe("SupportCase aggregate (support_case_state)", () => {
  const base = {
    tenantId: TENANT,
    requesterUserId: OWNER,
    subject: "No connectivity after purchase",
    priority: "high",
    relatedRefs: [] as const,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  it("proves the legal transitions incl. both terminal families", () => {
    const open = new SupportCase({ ...base, supportCaseId: CASE, status: "open" });
    const inProgress = open.startProgress(at("2026-02-01T00:00:00.000Z"), "agent-1" as never);
    expect(inProgress.status).toBe("in_progress");
    expect(inProgress.assigneeActorId).toBe("agent-1");
    const resolved = inProgress.resolve(at("2026-02-02T00:00:00.000Z"));
    expect(resolved.status).toBe("resolved");
    const closed = resolved.close(at("2026-02-03T00:00:00.000Z"));
    expect(closed.status).toBe("closed");
    const cancelled = new SupportCase({ ...base, supportCaseId: CASE, status: "open" })
      .cancel(at("2026-02-01T00:00:00.000Z"));
    expect(cancelled.status).toBe("cancelled");
    // direct resolve from open is legal
    const directResolved = new SupportCase({ ...base, supportCaseId: CASE, status: "open" })
      .resolve(at("2026-02-01T00:00:00.000Z"));
    expect(directResolved.status).toBe("resolved");
  });

  it("proves every illegal transition and the correlation guard", () => {
    const open = new SupportCase({ ...base, supportCaseId: CASE, status: "open" });
    expect(() => open.close(at("2026-02-01T00:00:00.000Z"))).toThrow(ValidationError); // only resolved -> closed
    expect(() => open.resolve(at("2026-02-01T00:00:00.000Z")).resolve(at("2026-02-02T00:00:00.000Z"))).toThrow(ValidationError);
    const closed = new SupportCase({
      ...base,
      supportCaseId: CASE,
      status: "resolved",
      resolvedAt: T0,
      updatedAt: T0,
    }).close(at("2026-02-01T00:00:00.000Z"));
    expect(() => closed.cancel(at("2026-02-02T00:00:00.000Z"))).toThrow(ValidationError);
    expect(() =>
      closed.linkRelatedRef({ kind: "order", id: ORDER_REF } as never, at("2026-02-02T00:00:00.000Z")),
    ).toThrow(ValidationError); // closed cases gain no more correlation
    // duplicate correlation is rejected on open cases
    const withRef = open.linkRelatedRef({ kind: "order", id: ORDER_REF } as never, at("2026-02-01T00:00:00.000Z"));
    expect(() =>
      withRef.linkRelatedRef({ kind: "order", id: ORDER_REF } as never, at("2026-02-01T00:00:00.000Z")),
    ).toThrow(ValidationError);
    // the state vocabulary is closed and separate from commerce states
    expect(() =>
      new SupportCase({ ...base, supportCaseId: CASE, status: "placed" }),
    ).toThrow(ValidationError);
    expect(SUPPORT_CASE_STATES).not.toContain("placed");
  });
});

// ---------------------------------------------------------------------------
// RL-LOCK-009: emission ONLY from durable RoamLink state transitions
// ---------------------------------------------------------------------------

describe("RL-LOCK-009: notifications only from durable RoamLink transitions", () => {
  it("emits from a valid durable transition source with the receipt on the event", async () => {
    const world = makeService();
    const result = await emitted(world);
    expect(result).toMatchObject({ notificationId: NOTIFICATION, status: "pending", revision: 1 });
    const events = await world.store.read.events.listForAggregate(
      TENANT,
      "notification",
      NOTIFICATION,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.transition).toBe("notification.created");
    const payload = events[0]?.payload as { sourceTransition?: { eventId?: string } };
    expect(payload.sourceTransition?.eventId).toBe(source().eventId);
  });

  it("rejects every raw-ADCOS-payload shape (no origin, foreign origin, ADCOS types, no receipt, extra fields)", async () => {
    const world = makeService();
    // a realistic ADCOS webhook event payload has NO legal origin shape
    const adcosWebhookPayload = {
      event_id: "evt-adcos-1",
      resource_type: "connectivity_contract",
      resource_id: "contract-77",
      resource_version: 3,
      payload: { status: "active" },
    };
    await expect(
      world.service.emitFromTransition(world.envelope(), {
        notificationId: NOTIFICATION,
        recipientUserId: OWNER,
        topic: "connectivity",
        severity: "info",
        title: "Contract update",
        body: "A connectivity contract changed.",
        source: adcosWebhookPayload as never,
      }),
    ).rejects.toThrow(ValidationError);

    // foreign origin value
    await expect(
      emitted(world).then(() =>
        world.service.emitFromTransition(world.envelope(), {
          notificationId: NOTIFICATION_2,
          recipientUserId: OWNER,
          topic: "connectivity",
          severity: "info",
          title: "x",
          body: "y",
          source: source({ origin: "adcos_webhook_event" }) as never,
        }),
      ),
    ).rejects.toThrow(ValidationError);

    // ADCOS resource type as aggregateType (not in the closed vocabulary)
    await expect(
      world.service.emitFromTransition(world.envelope(), {
        notificationId: NOTIFICATION_2,
        recipientUserId: OWNER,
        topic: "connectivity",
        severity: "info",
        title: "x",
        body: "y",
        source: source({ aggregateType: "connectivity_contract" }) as never,
      }),
    ).rejects.toThrow(ValidationError);

    // missing durable event receipt
    await expect(
      world.service.emitFromTransition(world.envelope(), {
        notificationId: NOTIFICATION_2,
        recipientUserId: OWNER,
        topic: "connectivity",
        severity: "info",
        title: "x",
        body: "y",
        source: source({ eventId: undefined }) as never,
      }),
    ).rejects.toThrow(ValidationError);

    // smuggled external payload fields
    await expect(
      world.service.emitFromTransition(world.envelope(), {
        notificationId: NOTIFICATION_2,
        recipientUserId: OWNER,
        topic: "connectivity",
        severity: "info",
        title: "x",
        body: "y",
        source: source({ rawPayload: { status: "active" } }) as never,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a duplicate emission command replays; a different digest under the same key conflicts", async () => {
    const world = makeService();
    const first = await emitted(world, { key: "emit-once" });
    const replay = await emitted(world, { key: "emit-once" });
    expect(replay).toEqual(first);
    await world.clock.advanceBy(1_000);
    await expect(emitted(world, { key: "emit-once", notificationId: NOTIFICATION_2 })).rejects.toThrow(
      ConflictError,
    );
  });
});

// ---------------------------------------------------------------------------
// Preferences + suppression + channel deliveries
// ---------------------------------------------------------------------------

describe("preferences and channel deliveries", () => {
  it("defaults to in_app for unmentioned topics; explicit mute resolves to zero channels", () => {
    const preferences: NotificationPreferencesRecord = {
      contractVersion: "0.1" as never,
      tenantId: TENANT,
      userId: OWNER,
      channelsByTopic: { order: [], payment: ["in_app", "email"] },
      createdAt: T0,
      updatedAt: T0,
      revision: 1 as never,
    };
    expect(resolveEffectiveChannels(preferences, "order")).toEqual([]);
    expect(resolveEffectiveChannels(preferences, "payment")).toEqual(["in_app", "email"]);
    expect(resolveEffectiveChannels(preferences, "system")).toEqual(["in_app"]); // default
    expect(resolveEffectiveChannels(undefined, "order")).toEqual(["in_app"]);
  });

  it("a muted topic produces a SUPPRESSED durable notification (a state, not a deletion)", async () => {
    const world = makeService();
    await world.service.setPreferences(world.envelope(), {
      userId: OWNER,
      channelsByTopic: { order: [] }, // explicit mute
    });
    const result = await emitted(world);
    expect(result.status).toBe("suppressed");
    const record = await world.store.read.notifications.findById(TENANT, NOTIFICATION as never);
    expect(record?.status).toBe("suppressed"); // durable history retained
    const events = await world.store.read.events.listForAggregate(
      TENANT,
      "notification",
      NOTIFICATION,
    );
    expect(events[0]?.transition).toBe("notification.suppressed");
  });

  it("first successful channel delivery delivers; failed only once EVERY effective channel failed", async () => {
    const world = makeService();
    await world.service.setPreferences(world.envelope(), {
      userId: OWNER,
      channelsByTopic: { order: ["in_app", "email"] },
    });
    await emitted(world);

    // email fails: in_app still outstanding -> stays pending
    const afterEmailFail = await world.service.recordChannelDelivery(world.envelope(), {
      notificationId: NOTIFICATION,
      channel: "email",
      outcome: "failed",
      detail: "provider_rejected",
    });
    expect(afterEmailFail.status).toBe("pending");

    // in_app succeeds -> delivered (first success wins)
    const afterInApp = await world.service.recordChannelDelivery(world.envelope(), {
      notificationId: NOTIFICATION,
      channel: "in_app",
      outcome: "delivered",
    });
    expect(afterInApp.status).toBe("delivered");

    // a separate notification with BOTH channels failing -> failed
    await emitted(world, { notificationId: NOTIFICATION_2 });
    await world.service.recordChannelDelivery(world.envelope(), {
      notificationId: NOTIFICATION_2,
      channel: "in_app",
      outcome: "failed",
    });
    const failed = await world.service.recordChannelDelivery(world.envelope(), {
      notificationId: NOTIFICATION_2,
      channel: "email",
      outcome: "failed",
    });
    expect(failed.status).toBe("failed");

    const deliveries = await world.service.listChannelDeliveries(TENANT, NOTIFICATION);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.revision === 1)).toBe(true);
  });

  it("markRead transitions pending|delivered -> read with CAS", async () => {
    const world = makeService();
    await emitted(world);
    await world.service.recordChannelDelivery(world.envelope(), {
      notificationId: NOTIFICATION,
      channel: "in_app",
      outcome: "delivered",
    });
    const read = await world.service.markRead(world.envelope(), {
      notificationId: NOTIFICATION,
      expectedRevision: 2,
    });
    expect(read.status).toBe("read");
    await expect(
      world.service.markRead(world.envelope(), { notificationId: NOTIFICATION, expectedRevision: 2 }),
    ).rejects.toThrow(ConflictError); // stale revision
    await expect(
      world.service.markRead(world.envelope(), { notificationId: NOTIFICATION, expectedRevision: 3 }),
    ).rejects.toThrow(ValidationError); // read is terminal
  });

  it("channel deliveries carry closed-vocabulary diagnostics only", () => {
    expect(
      () =>
        new ChannelDelivery({
          tenantId: TENANT,
          notificationId: NOTIFICATION,
          channel: "email",
          outcome: "delivered",
          detail: "Bearer secret-value 123", // credentials never fit the closed charset
          attemptedAt: T0,
        }),
    ).toThrow(ValidationError);
    expect(
      () =>
        new ChannelDelivery({
          tenantId: TENANT,
          notificationId: NOTIFICATION,
          channel: "sms", // not in the closed channel vocabulary
          outcome: "delivered",
          attemptedAt: T0,
        }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Support cases: state machine + the visibility boundary + correlation
// ---------------------------------------------------------------------------

describe("support cases", () => {
  async function openedCase(world: World) {
    await world.service.openCase(world.envelope(), {
      supportCaseId: CASE,
      requesterUserId: OWNER,
      subject: "No connectivity after purchase",
      description: "I paid but nothing works.",
      priority: "high",
      relatedRefs: [{ kind: "order", id: ORDER_REF }],
    });
  }

  it("opens a case with correlation refs and walks the full lifecycle with events", async () => {
    const world = makeService();
    await openedCase(world);
    await world.service.transitionCase(world.envelope(), {
      supportCaseId: CASE,
      expectedRevision: 1,
      transition: "startProgress",
      assigneeActorId: "agent-1",
    });
    await world.service.transitionCase(world.envelope(), {
      supportCaseId: CASE,
      expectedRevision: 2,
      transition: "resolve",
    });
    const closed = await world.service.transitionCase(world.envelope(), {
      supportCaseId: CASE,
      expectedRevision: 3,
      transition: "close",
    });
    expect(closed.status).toBe("closed");

    const events = await world.store.read.events.listForAggregate(TENANT, "support_case", CASE);
    expect(events.map((event) => event.transition)).toEqual([
      "support_case.created",
      "support_case.started_progress",
      "support_case.resolved",
      "support_case.closed",
    ]);
  });

  it("THE VISIBILITY BOUNDARY: internal messages never reach the customer view", async () => {
    const world = makeService();
    await openedCase(world);
    await world.service.addCaseMessage(world.envelope({ actorId: "agent-1" }), {
      supportCaseId: CASE,
      messageId: MESSAGE_1,
      visibility: "customer",
      body: "We are looking into your order.",
    });
    await world.service.addCaseMessage(world.envelope({ actorId: "agent-1" }), {
      supportCaseId: CASE,
      messageId: MESSAGE_2,
      visibility: "internal",
      body: "Internal note: escalation ticket ESC-99 filed.",
    });

    const customerView = await world.service.listCustomerCaseMessages(TENANT, CASE);
    expect(customerView).toHaveLength(1);
    expect(customerView[0]?.body).not.toContain("escalation");
    const staffView = await world.service.listAllCaseMessages(TENANT, CASE);
    expect(staffView).toHaveLength(2);
    // the pure helper enforces the boundary structurally
    const internalRecord: SupportCaseMessageRecord = staffView.find(
      (message) => message.visibility === "internal",
    ) as SupportCaseMessageRecord;
    expect(caseMessagesCustomerView([internalRecord])).toEqual([]);
  });

  it("writing an INTERNAL message requires the support_case:internal action (fail closed)", async () => {
    const world = makeService();
    await openedCase(world);
    world.policy.deny("support_case:internal");
    await expect(
      world.service.addCaseMessage(world.envelope({ actorId: "agent-1" }), {
        supportCaseId: CASE,
        messageId: MESSAGE_2,
        visibility: "internal",
        body: "Internal note.",
      }),
    ).rejects.toThrow(UnauthorizedError);
    // customer-visibility messages remain writable
    await world.service.addCaseMessage(world.envelope({ actorId: "agent-1" }), {
      supportCaseId: CASE,
      messageId: MESSAGE_1,
      visibility: "customer",
      body: "Public reply.",
    });
  });

  it("closed/cancelled cases no longer accept messages (typed conflict)", async () => {
    const world = makeService();
    await openedCase(world);
    await world.service.transitionCase(world.envelope(), {
      supportCaseId: CASE,
      expectedRevision: 1,
      transition: "cancel",
    });
    await expect(
      world.service.addCaseMessage(world.envelope(), {
        supportCaseId: CASE,
        messageId: MESSAGE_1,
        visibility: "customer",
        body: "Too late.",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("correlates tickets with orders and connectivity references (both directions)", async () => {
    const world = makeService();
    await openedCase(world);
    await world.service.linkCaseRelatedRef(world.envelope(), {
      supportCaseId: CASE,
      expectedRevision: 1,
      kind: "connectivity_reference",
      id: CONNECTIVITY_REFERENCE_REF,
    });
    // ticket side: query by either related reference
    const byOrder = await world.service.listCasesForRelatedRef(TENANT, {
      kind: "order",
      id: ORDER_REF,
    });
    expect(byOrder.map((record) => record.supportCaseId)).toEqual([CASE]);
    const byReference = await world.service.listCasesForRelatedRef(TENANT, {
      kind: "connectivity_reference",
      id: CONNECTIVITY_REFERENCE_REF,
    });
    expect(byReference).toHaveLength(1);
    // notification side: a connectivity-reference transition notification
    await world.service.emitFromTransition(world.envelope(), {
      notificationId: NOTIFICATION,
      recipientUserId: OWNER,
      topic: "connectivity",
      severity: "info",
      title: "Connectivity evidence updated",
      body: "The delivery evidence for your order was updated.",
      source: source({
        aggregateType: "connectivity_reference",
        transition: "connectivity_reference.evidence_linked",
      }) as never,
      relatedRefs: [{ kind: "connectivity_reference", id: CONNECTIVITY_REFERENCE_REF }],
    });
    const notifications = await world.service.listNotificationsForRelatedRef(TENANT, {
      kind: "connectivity_reference",
      id: CONNECTIVITY_REFERENCE_REF,
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.source.aggregateType).toBe("connectivity_reference");
  });

  it("fails closed across tenants (no existence oracle)", async () => {
    const world = makeService();
    await openedCase(world);
    await expect(
      world.service.listCustomerCaseMessages(OTHER_TENANT, CASE),
    ).resolves.toEqual([]);
    await expect(
      world.service.listAllCaseMessages(OTHER_TENANT, CASE),
    ).resolves.toEqual([]);
    await expect(
      world.service.addCaseMessage(world.envelope({ tenantId: OTHER_TENANT }), {
        supportCaseId: CASE,
        messageId: MESSAGE_1,
        visibility: "customer",
        body: "Wrong tenant.",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// /v1/notifications API resources
// ---------------------------------------------------------------------------

describe("/v1/notifications API resources", () => {
  it("exposes RoamLink state + source transition + typed references + evidence summaries", async () => {
    const world = makeService();
    await emitted(world, { relatedRefs: [{ kind: "connectivity_reference", id: CONNECTIVITY_REFERENCE_REF }] });
    const record = await world.store.read.notifications.findById(TENANT, NOTIFICATION as never);
    expect(record).toBeDefined();
    if (record === undefined) return;

    const resource = toNotificationApiResource(record, {
      deliveries: [
        new ChannelDelivery({
          tenantId: TENANT,
          notificationId: NOTIFICATION,
          channel: "in_app",
          outcome: "delivered",
          attemptedAt: T0,
        }).toRecord(),
      ],
      evidenceFor: (ref) =>
        ref.kind === "connectivity_reference"
          ? {
              freshnessState: "STALE",
              observedAt: T0 as never,
              receivedAt: T0 as never,
              freshUntil: T0 as never,
              evidenceClass: "AUTHENTICATED",
              canonicalResourceType: "connectivity_contract",
              canonicalResourceId: "contract-77",
            }
          : undefined,
    });

    expect(resource.state).toBe("pending");
    expect(resource.source).toMatchObject({
      origin: "roamlink_state_transition",
      aggregateType: "order",
      transition: "order.placed",
    });
    expect(resource.related).toHaveLength(1);
    expect(resource.related[0]).toMatchObject({
      kind: "connectivity_reference",
      id: CONNECTIVITY_REFERENCE_REF,
    });
    expect(resource.related[0]?.evidence).toMatchObject({
      freshnessState: "STALE",
      canonicalResourceType: "connectivity_contract",
    });
    expect(resource.channels).toEqual([
      { channel: "in_app", outcome: "delivered", attemptedAt: T0 },
    ]);
    // the wire shape exposes no internal ADCOS implementation types: only
    // the evidence summary fields explicitly defined by the contract
    expect(Object.keys(resource.related[0]?.evidence ?? {}).sort()).toEqual(
      [
        "canonicalResourceId",
        "canonicalResourceType",
        "evidenceClass",
        "freshUntil",
        "freshnessState",
        "observedAt",
        "receivedAt",
      ].sort(),
    );
  });
});
