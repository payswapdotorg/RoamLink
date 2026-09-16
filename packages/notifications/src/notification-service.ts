/**
 * The notifications service (RL-014): envelope-gated, idempotent, CAS-aware
 * use cases for notifications, preferences, channel deliveries and support
 * cases, plus the tenant-scoped correlation reads.
 *
 * RL-LOCK-009 DISCIPLINE ("webhooks are signals, not truth"):
 * {@link NotificationService.emitFromTransition} is the ONLY way a
 * notification comes into existence, and it requires a
 * {@link TransitionOrigin} whose closed single-member `origin` vocabulary
 * and REQUIRED durable `eventId` structurally exclude raw ADCOS payloads.
 * The composition layer reads RoamLink's own durable event logs and passes
 * transition facts; ADCOS-derived state reaches notifications only as
 * typed REFERENCES (relatedRefs) after RoamLink durably projected it.
 *
 * The support-case visibility boundary: internal-visibility messages are
 * gated behind the `support_case:internal` policy action, and the
 * customer-facing read (`listCustomerCaseMessages`) drops internal
 * messages BY CONSTRUCTION (see support-case.ts).
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import type { NotificationRecord } from "./notification.js";
import type { SupportCaseMessageRecord, SupportCaseRecord } from "./support-case.js";

import { ChannelDelivery } from "./channel-delivery.js";
import type { ChannelDeliveryRecord } from "./channel-delivery.js";
import {
  admitNotificationsCommand,
  commitNotificationsCommand,
  type NotificationsIdempotencyLedger,
} from "./idempotency.js";
import { NotificationsEvent } from "./events.js";
import type { NotificationsEventRecord } from "./events.js";
import { parseSupportCaseId } from "./ids.js";
import {
  Notification,
  parseRelatedRefs,
  parseTransitionOrigin,
  type NotificationRelatedRef,
  type NotificationSourceAggregateType,
} from "./notification.js";
import {
  NotificationPreferences,
  isTopicMuted,
  resolveEffectiveChannels,
  type NotificationChannel,
  type TopicChannels,
} from "./preferences.js";
import type {
  NotificationAccessPolicy,
  NotificationsSession,
  NotificationsStore,
} from "./ports.js";
import {
  SupportCase,
  SupportCaseMessage,
  caseMessagesCustomerView,
  type CustomerViewMessage,
  type SupportCaseRelatedRef,
} from "./support-case.js";

/** Dependencies of the notifications service. */
export interface NotificationServiceDeps {
  readonly store: NotificationsStore;
  readonly policy: NotificationAccessPolicy;
  readonly ledger: NotificationsIdempotencyLedger;
  /** Explicit time source (never ambient; deterministic in tests). */
  readonly now: () => UtcInstant;
  /** Supplies fresh entity ids (deterministic in tests). */
  readonly generateId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`notifications command rejected: ${issue}`, {
    reason: "NOTIFICATION_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

async function recordEvent(
  session: NotificationsSession,
  envelope: CommandEnvelope,
  aggregateType: NotificationsEventRecord["aggregateType"],
  aggregateId: string,
  aggregateRevision: number,
  transition: NotificationsEventRecord["transition"],
  payload: object,
  at: UtcInstant,
  generateId: () => string,
): Promise<void> {
  const chain = await session.events.listForAggregate(envelope.tenantId, aggregateType, aggregateId);
  const event = new NotificationsEvent({
    eventId: generateId(),
    tenantId: envelope.tenantId,
    aggregateType,
    aggregateId,
    aggregateRevision,
    sequence: chain.length + 1,
    transition,
    payload,
    actorId: envelope.actorId,
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    occurredAt: at,
  });
  await session.events.append(event.toRecord());
}

/** Notifications / preferences / support-case use cases. */
export class NotificationService {
  readonly #deps: NotificationServiceDeps;

  constructor(deps: NotificationServiceDeps) {
    this.#deps = deps;
  }

  private expectRevision(expected: number, current: number, label: string): void {
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      commandInvalid(`${label} must be a positive integer (the observed revision)`);
    }
    if (expected !== current) {
      throw new ConflictError(
        `${label} optimistic-concurrency conflict: the expectedRevision does not match the stored revision (the aggregate changed concurrently); re-read and retry - never overwrite silently`,
        { reason: "REVISION_CONFLICT" },
      );
    }
  }

  // --- notifications ---------------------------------------------------------

  /**
   * Emits a notification FROM A DURABLE ROAMLINK STATE TRANSITION
   * (notification:write; RL-LOCK-009). The source must carry the durable
   * event id that recorded the transition - no receipt, no notification.
   * The recipient's preferences are evaluated IN THE SAME session: a fully
   * muted topic produces a SUPPRESSED notification (durable history, no
   * delivery).
   */
  async emitFromTransition(
    envelope: CommandEnvelope,
    input: {
      readonly notificationId: string;
      readonly recipientUserId: string;
      readonly topic: string;
      readonly severity: string;
      readonly title: string;
      readonly body: string;
      readonly source: {
        readonly origin: typeof NotificationService.SOURCE_ORIGIN;
        readonly aggregateType: NotificationSourceAggregateType;
        readonly aggregateId: string;
        readonly transition: string;
        readonly eventId: string;
        readonly occurredAt: string;
      };
      readonly relatedRefs?: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
    },
  ): Promise<{ readonly notificationId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly notificationId: string; readonly status: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "notification:write", this.#deps.now());

    const source = parseTransitionOrigin(input.source);
    const relatedRefs = parseRelatedRefs(input.relatedRefs ?? []);

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const preferences = await session.preferences.findForUser(
        envelope.tenantId,
        input.recipientUserId as never,
      );
      const muted = isTopicMuted(preferences, source.aggregateType === "support_case"
        ? "support"
        : input.topic as never);
      const notification = new Notification({
        notificationId: input.notificationId,
        tenantId: envelope.tenantId,
        recipientUserId: input.recipientUserId,
        topic: input.topic,
        severity: input.severity,
        title: input.title,
        body: input.body,
        status: muted ? "suppressed" : "pending",
        source,
        relatedRefs,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordEvent(
        session,
        envelope,
        "notification",
        notification.notificationId,
        notification.revision,
        muted ? "notification.suppressed" : "notification.created",
        {
          record: notification.toRecord(),
          sourceTransition: {
            aggregateType: source.aggregateType,
            aggregateId: source.aggregateId,
            transition: source.transition,
            eventId: source.eventId,
          },
        },
        at,
        this.#deps.generateId,
      );
      await session.notifications.save(notification.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        notificationId: notification.notificationId,
        status: notification.status,
        revision: notification.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * Records ONE channel delivery attempt (notification:write). A successful
   * delivery transitions pending -> delivered (first success wins); a
   * failed attempt transitions pending -> failed ONLY once EVERY effective
   * channel has at least one failed attempt.
   */
  async recordChannelDelivery(
    envelope: CommandEnvelope,
    input: {
      readonly notificationId: string;
      readonly channel: string;
      readonly outcome: "delivered" | "failed";
      readonly detail?: string;
    },
  ): Promise<{
    readonly notificationId: string;
    readonly status: string;
    readonly revision: number;
  }> {
    type Outcome = { readonly notificationId: string; readonly status: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "notification:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const current = await this.#findNotification(session, envelope.tenantId, input.notificationId);
      const delivery = new ChannelDelivery({
        tenantId: envelope.tenantId,
        notificationId: current.notificationId,
        channel: input.channel,
        outcome: input.outcome,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        attemptedAt: at,
      });

      let next = current;
      if (input.outcome === "delivered" && current.status === "pending") {
        next = current.deliver(at);
      } else if (input.outcome === "failed" && current.status === "pending") {
        const preferences = await session.preferences.findForUser(
          envelope.tenantId,
          current.recipientUserId,
        );
        const effective: readonly NotificationChannel[] = resolveEffectiveChannels(
          preferences,
          current.topic,
        );
        const attempted = new Set<NotificationChannel>([delivery.channel]);
        for (const prior of await session.channelDeliveries.listForNotification(
          envelope.tenantId,
          current.notificationId,
        )) {
          if (prior.outcome === "failed") attempted.add(prior.channel);
        }
        const allFailed = effective.length > 0 && effective.every((channel) => attempted.has(channel));
        if (allFailed) {
          next = current.fail(at);
        }
      }

      await recordEvent(
        session,
        envelope,
        "notification",
        next.notificationId,
        next.revision,
        "notification.channel_delivery_recorded",
        {
          channel: delivery.channel,
          outcome: delivery.outcome,
          ...(delivery.detail !== undefined ? { detail: delivery.detail } : {}),
          notificationStatus: next.status,
        },
        at,
        this.#deps.generateId,
      );
      if (next.status === "delivered" && current.status === "pending") {
        await recordEvent(
          session,
          envelope,
          "notification",
          next.notificationId,
          next.revision,
          "notification.delivered",
          { record: next.toRecord() },
          at,
          this.#deps.generateId,
        );
      }
      if (next.status === "failed" && current.status === "pending") {
        await recordEvent(
          session,
          envelope,
          "notification",
          next.notificationId,
          next.revision,
          "notification.failed",
          { record: next.toRecord() },
          at,
          this.#deps.generateId,
        );
      }
      await session.channelDeliveries.save(delivery.toRecord());
      if (next.revision !== current.revision) {
        await session.notifications.save(next.toRecord());
      }
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        notificationId: next.notificationId,
        status: next.status,
        revision: next.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** pending|delivered -> read (notification:write; the read receipt). */
  async markRead(
    envelope: CommandEnvelope,
    input: { readonly notificationId: string; readonly expectedRevision: number },
  ): Promise<{ readonly notificationId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly notificationId: string; readonly status: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "notification:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const current = await this.#findNotification(session, envelope.tenantId, input.notificationId);
      this.expectRevision(input.expectedRevision, current.revision, "notification");
      const next = current.markRead(at);
      await recordEvent(
        session,
        envelope,
        "notification",
        next.notificationId,
        next.revision,
        "notification.read",
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.notifications.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        notificationId: next.notificationId,
        status: next.status,
        revision: next.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- preferences -----------------------------------------------------------

  /**
   * Replaces the per-user preferences (preference:write; CAS via
   * expectedRevision, omitted on first write).
   */
  async setPreferences(
    envelope: CommandEnvelope,
    input: {
      readonly userId: string;
      readonly channelsByTopic: TopicChannels;
      readonly expectedRevision?: number;
    },
  ): Promise<{ readonly userId: string; readonly revision: number }> {
    type Outcome = { readonly userId: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "preference:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const existing = await session.preferences.findForUser(
        envelope.tenantId,
        input.userId as never,
      );
      let saved: NotificationPreferences;
      if (existing === undefined) {
        if (input.expectedRevision !== undefined) {
          commandInvalid("expectedRevision must be omitted on the first preferences write");
        }
        saved = new NotificationPreferences({
          tenantId: envelope.tenantId,
          userId: input.userId,
          channelsByTopic: input.channelsByTopic,
          createdAt: at,
          updatedAt: at,
          revision: 1,
        });
      } else {
        this.expectRevision(input.expectedRevision ?? 0, existing.revision, "preferences");
        saved = NotificationPreferences.fromRecord(existing).replace(input.channelsByTopic, at);
      }
      await session.preferences.save(saved.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        userId: saved.userId,
        revision: saved.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- support cases ----------------------------------------------------------

  /** Opens a support case (support_case:write) with optional correlation refs. */
  async openCase(
    envelope: CommandEnvelope,
    input: {
      readonly supportCaseId: string;
      readonly requesterUserId: string;
      readonly subject: string;
      readonly description?: string;
      readonly priority: string;
      readonly relatedRefs?: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
    },
  ): Promise<{ readonly supportCaseId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly supportCaseId: string; readonly status: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "support_case:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const supportCase = new SupportCase({
        supportCaseId: input.supportCaseId,
        tenantId: envelope.tenantId,
        requesterUserId: input.requesterUserId,
        subject: input.subject,
        ...(input.description !== undefined ? { description: input.description } : {}),
        priority: input.priority,
        status: "open",
        relatedRefs: input.relatedRefs ?? [],
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      await recordEvent(
        session,
        envelope,
        "support_case",
        supportCase.supportCaseId,
        supportCase.revision,
        "support_case.created",
        { record: supportCase.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.supportCases.save(supportCase.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        supportCaseId: supportCase.supportCaseId,
        status: supportCase.status,
        revision: supportCase.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /**
   * Adds an IMMUTABLE case message (support_case:write; internal visibility
   * additionally requires support_case:internal - THE visibility boundary).
   */
  async addCaseMessage(
    envelope: CommandEnvelope,
    input: {
      readonly supportCaseId: string;
      readonly messageId: string;
      readonly visibility: "customer" | "internal";
      readonly body: string;
    },
  ): Promise<{ readonly messageId: string; readonly visibility: string }> {
    type Outcome = { readonly messageId: string; readonly visibility: string };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "support_case:write", this.#deps.now());
    if (input.visibility === "internal") {
      await this.#deps.policy.authorize(
        envelope.actorId,
        envelope.tenantId,
        "support_case:internal",
        this.#deps.now(),
      );
    }

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const supportCase = await this.#findCase(session, envelope.tenantId, input.supportCaseId);
      if (supportCase.status === "closed" || supportCase.status === "cancelled") {
        throw new ConflictError(
          "a closed or cancelled case no longer accepts messages (open a new case)",
          { reason: "SUPPORT_CASE_CLOSED" },
        );
      }
      const message = new SupportCaseMessage({
        messageId: input.messageId,
        tenantId: envelope.tenantId,
        supportCaseId: supportCase.supportCaseId,
        authorActorId: envelope.actorId,
        visibility: input.visibility,
        body: input.body,
        createdAt: at,
      });
      await recordEvent(
        session,
        envelope,
        "support_case",
        supportCase.supportCaseId,
        supportCase.revision,
        "support_case.message_added",
        { messageId: message.messageId, visibility: message.visibility },
        at,
        this.#deps.generateId,
      );
      await session.supportCaseMessages.save(message.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        messageId: message.messageId,
        visibility: message.visibility,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** Applies a typed case transition (support_case:write; CAS via expectedRevision). */
  async transitionCase(
    envelope: CommandEnvelope,
    input: {
      readonly supportCaseId: string;
      readonly expectedRevision: number;
      readonly transition: "startProgress" | "resolve" | "close" | "cancel";
      readonly assigneeActorId?: string;
    },
  ): Promise<{ readonly supportCaseId: string; readonly status: string; readonly revision: number }> {
    type Outcome = { readonly supportCaseId: string; readonly status: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "support_case:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const current = await this.#findCase(session, envelope.tenantId, input.supportCaseId);
      this.expectRevision(input.expectedRevision, current.revision, "support case");
      const next =
        input.transition === "startProgress"
          ? current.startProgress(at, input.assigneeActorId as never)
          : input.transition === "resolve"
            ? current.resolve(at)
            : input.transition === "close"
              ? current.close(at)
              : current.cancel(at);
      const transitionEvent: NotificationsEventRecord["transition"] =
        input.transition === "startProgress"
          ? "support_case.started_progress"
          : input.transition === "resolve"
            ? "support_case.resolved"
            : input.transition === "close"
              ? "support_case.closed"
              : "support_case.cancelled";
      await recordEvent(
        session,
        envelope,
        "support_case",
        next.supportCaseId,
        next.revision,
        transitionEvent,
        { record: next.toRecord() },
        at,
        this.#deps.generateId,
      );
      await session.supportCases.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        supportCaseId: next.supportCaseId,
        status: next.status,
        revision: next.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  /** Links an additional correlation reference to an open case (support_case:write). */
  async linkCaseRelatedRef(
    envelope: CommandEnvelope,
    input: {
      readonly supportCaseId: string;
      readonly expectedRevision: number;
      readonly kind: string;
      readonly id: string;
    },
  ): Promise<{ readonly supportCaseId: string; readonly revision: number }> {
    type Outcome = { readonly supportCaseId: string; readonly revision: number };
    const admission = await admitNotificationsCommand(this.#deps.ledger, envelope);
    if (admission.status === "replay") return admission.outcome as unknown as Outcome;

    await this.#deps.policy.authorize(envelope.actorId, envelope.tenantId, "support_case:write", this.#deps.now());

    const at = this.#deps.now();
    const session = await this.#deps.store.begin();
    try {
      const current = await this.#findCase(session, envelope.tenantId, input.supportCaseId);
      this.expectRevision(input.expectedRevision, current.revision, "support case");
      const next = current.linkRelatedRef(
        Object.freeze({ kind: input.kind, id: input.id }) as SupportCaseRelatedRef,
        at,
      );
      await recordEvent(
        session,
        envelope,
        "support_case",
        next.supportCaseId,
        next.revision,
        "support_case.related_ref_linked",
        { relatedRef: { kind: input.kind, id: input.id } },
        at,
        this.#deps.generateId,
      );
      await session.supportCases.save(next.toRecord());
      await session.commit();

      const outcome: CanonicalJsonValue = Object.freeze({
        supportCaseId: next.supportCaseId,
        revision: next.revision,
      });
      await commitNotificationsCommand(this.#deps.ledger, envelope, outcome, this.#deps.now());
      return outcome as unknown as Outcome;
    } catch (error) {
      await session.rollback();
      throw error;
    }
  }

  // --- committed-state reads ---------------------------------------------------

  /** All notifications correlated with a related reference (tenant-scoped). */
  async listNotificationsForRelatedRef(
    tenantId: TenantId,
    ref: NotificationRelatedRef,
  ): Promise<readonly NotificationRecord[]> {
    return this.#deps.store.read.notifications.listByRelatedRef(tenantId, ref);
  }

  /** All support cases correlated with a related reference (tenant-scoped). */
  async listCasesForRelatedRef(
    tenantId: TenantId,
    ref: SupportCaseRelatedRef,
  ): Promise<readonly SupportCaseRecord[]> {
    return this.#deps.store.read.supportCases.listByRelatedRef(tenantId, ref);
  }

  /**
   * The CUSTOMER-facing case-thread view: internal messages are structurally
   * absent (the visibility boundary, RL-014).
   */
  async listCustomerCaseMessages(
    tenantId: TenantId,
    supportCaseId: string,
  ): Promise<readonly CustomerViewMessage[]> {
    const messages = await this.#deps.store.read.supportCaseMessages.listForCase(
      tenantId,
      parseSupportCaseId(supportCaseId),
    );
    return caseMessagesCustomerView(messages);
  }

  /** The SUPPORT-STAFF case-thread view (all visibilities). */
  async listAllCaseMessages(
    tenantId: TenantId,
    supportCaseId: string,
  ): Promise<readonly SupportCaseMessageRecord[]> {
    return this.#deps.store.read.supportCaseMessages.listForCase(
      tenantId,
      parseSupportCaseId(supportCaseId),
    );
  }

  /** The delivery attempts of one notification (tenant-scoped). */
  async listChannelDeliveries(
    tenantId: TenantId,
    notificationId: string,
  ): Promise<readonly ChannelDeliveryRecord[]> {
    return this.#deps.store.read.channelDeliveries.listForNotification(
      tenantId,
      notificationId as never,
    );
  }

  // --- internal helpers --------------------------------------------------------

  async #findNotification(session: NotificationsSession, tenantId: TenantId, notificationId: string) {
    const record = await session.notifications.findById(tenantId, notificationId as never);
    if (record === undefined) {
      throw new NotFoundError("notification not found in the command tenant", {
        reason: "NOTIFICATION_NOT_FOUND",
      });
    }
    return Notification.fromRecord(record);
  }

  async #findCase(session: NotificationsSession, tenantId: TenantId, supportCaseId: string) {
    const record = await session.supportCases.findById(tenantId, parseSupportCaseId(supportCaseId));
    if (record === undefined) {
      throw new NotFoundError("support case not found in the command tenant", {
        reason: "SUPPORT_CASE_NOT_FOUND",
      });
    }
    return SupportCase.fromRecord(record);
  }

  /** The single legal notification origin (RL-LOCK-009). */
  static readonly SOURCE_ORIGIN = "roamlink_state_transition" as const;
}
