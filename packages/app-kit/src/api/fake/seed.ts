/**
 * Deterministic seed fixtures for the in-memory fake API (app-kit test
 * surface).
 *
 * The seed is a plain, frozen data structure: organizations with memberships
 * (owner/admin/member roles mirroring @roamlink/auth's permission map),
 * devices with observation freshness, experience intents with version chains,
 * a product catalog, orders/subscriptions/payments/invoices, delivery
 * references, notifications, support cases, projections, SLOs and a
 * reconciliation job history. Tests derive scenario-specific seeds from
 * {@link fakeApiSeed} (copy + override) so every app test is deterministic
 * (spec/definition-of-done.md "Deterministic test data").
 */
import type { HttpRequest, HttpResponse } from "../transport.js";

// --------------------------------------------------------------------------------
// Seed types (fake-internal; the wire shapes are the resources module)
// --------------------------------------------------------------------------------

export interface FakeMembershipSeed {
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
  readonly status: "active" | "revoked";
}

export interface FakeOrganizationSeed {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: "active" | "suspended";
  readonly members: readonly FakeMembershipSeed[];
  readonly revision: number;
}

export interface FakeUserSeed {
  readonly userId: string;
  readonly displayName: string;
}

export interface FakeFreshnessSeed {
  readonly observedAt: string | null;
  readonly receivedAt: string | null;
  readonly freshUntil: string | null;
}

export interface FakeDeviceSeed {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: "ios" | "android" | "macos" | "windows" | "linux" | "embedded" | "other";
  readonly status: "enrolled" | "active" | "suspended" | "retired";
  readonly owningUserId: string;
  readonly revision: number;
  readonly capabilityFreshness: FakeFreshnessSeed | null;
  readonly contextFreshness: FakeFreshnessSeed | null;
}

export interface FakeIntentVersionSeed {
  readonly intentVersionId: string;
  readonly versionNumber: number;
  readonly status: "draft" | "active" | "superseded";
  readonly rationale: string;
  readonly accessClasses: readonly string[];
  readonly createdAt: string;
}

export interface FakeDecisionSeed {
  readonly decisionId: string;
  readonly derivedStatus: string;
  readonly computedAt: string;
}

export interface FakeIntentSeed {
  readonly intentId: string;
  readonly deviceId: string;
  readonly status: "draft" | "active" | "superseded" | "archived" | "canceled";
  readonly revision: number;
  readonly versions: readonly FakeIntentVersionSeed[];
  readonly decision: FakeDecisionSeed | null;
}

export interface FakeVariantSeed {
  readonly variantId: string;
  readonly name: string;
  readonly billingModel: "one_time" | "recurring";
  readonly amountMinor: number;
  readonly currency: string;
  readonly termDays?: number;
}

export interface FakeProductSeed {
  readonly productId: string;
  readonly name: string;
  readonly description: string;
  readonly status: "draft" | "active" | "retired";
  readonly variants: readonly FakeVariantSeed[];
}

export interface FakeOrderLineSeed {
  readonly lineId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface FakeOrderSeed {
  readonly orderId: string;
  readonly status: "draft" | "placed" | "completed" | "cancelled";
  readonly lines: readonly FakeOrderLineSeed[];
  readonly revision: number;
}

export interface FakeSubscriptionSeed {
  readonly subscriptionId: string;
  readonly orderId: string;
  readonly variantId: string;
  readonly status: "pending" | "active" | "suspended" | "cancelled" | "expired" | "superseded";
  readonly revision: number;
  readonly periodStart: string;
  readonly periodEnd?: string;
}

export interface FakePaymentSeed {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: "pending" | "succeeded" | "failed" | "cancelled";
  readonly recordedAt: string;
}

export interface FakeInvoiceSeed {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: "issued" | "reconciled" | "voided";
  readonly issuedAt: string;
  readonly reconciledAt?: string;
}

export interface FakeReferenceSeed {
  readonly subjectType: "order" | "subscription";
  readonly subjectId: string;
  readonly status: "active" | "retired";
  readonly deliveryEvidenceState: "UNEVIDENCED" | "EVIDENCED";
  readonly evidence?:
    | {
        readonly evidenceClass: string;
        readonly canonicalResourceType: string;
        readonly canonicalResourceId: string;
        readonly sourceVersion: number | null;
        readonly eventId: string | null;
        readonly payloadDigest: string;
        readonly observedAt: string;
        readonly receivedAt: string;
        readonly freshUntil: string;
        readonly recordedFreshnessState: string;
      }
    | undefined;
}

export interface FakeNotificationSeed {
  readonly notificationId: string;
  readonly recipientUserId: string;
  readonly topic: string;
  readonly severity: "info" | "warning" | "critical";
  readonly title: string;
  readonly body: string;
  readonly state: "pending" | "delivered" | "failed" | "read" | "suppressed";
  readonly source: {
    readonly origin: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly transition: string;
    readonly eventId: string;
    readonly occurredAt: string;
  };
  readonly related: readonly { readonly kind: string; readonly id: string }[];
  readonly channels: readonly {
    readonly channel: "in_app" | "email" | "push" | "webhook";
    readonly outcome: "delivered" | "failed";
    readonly attemptedAt: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FakeSupportCaseSeed {
  readonly caseId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: "open" | "in_progress" | "resolved" | "closed" | "cancelled";
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly createdByUserId: string;
  readonly relatedRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly messages: readonly {
    readonly messageId: string;
    readonly authorUserId: string;
    readonly body: string;
    readonly visibility: "customer" | "internal";
    readonly sentAt: string;
  }[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FakeProjectionSeed {
  readonly projectionId: string;
  readonly canonicalResourceType: string;
  readonly canonicalResourceId: string;
  readonly evidenceClass: string;
  readonly projectionVersion: number;
  readonly payloadDigest: string;
  readonly freshness: FakeFreshnessSeed;
}

export interface FakeSloSeed {
  readonly name: string;
  readonly state: "within-budget" | "at-risk" | "exhausted" | "no-data";
  readonly burnRate: number | null;
  readonly budgetRemainingRatio: number | null;
  readonly total: number;
  readonly bad: number;
}

export interface FakeReconciliationJobSeed {
  readonly jobId: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  readonly trigger: "scheduled" | "startup" | "manual" | "crash-recovery";
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly actions: readonly {
    readonly actionType: string;
    readonly outcome: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly detail?: string;
    readonly at: string;
  }[];
}

export interface FakeTenantSeed {
  /** Organization tenant data (org:<uuid>). */
  readonly organization?: FakeOrganizationSeed;
  readonly devices: readonly FakeDeviceSeed[];
  readonly intents: readonly FakeIntentSeed[];
  readonly orders: readonly FakeOrderSeed[];
  readonly subscriptions: readonly FakeSubscriptionSeed[];
  readonly payments: readonly FakePaymentSeed[];
  readonly invoices: readonly FakeInvoiceSeed[];
  readonly references: readonly FakeReferenceSeed[];
  readonly notifications: readonly FakeNotificationSeed[];
  readonly supportCases: readonly FakeSupportCaseSeed[];
  readonly projections: readonly FakeProjectionSeed[];
  readonly slos: readonly FakeSloSeed[];
  readonly reconciliationJobs: readonly FakeReconciliationJobSeed[];
}

export interface FakeApiSeed {
  readonly users: readonly FakeUserSeed[];
  readonly catalog: readonly FakeProductSeed[];
  readonly tenants: Readonly<Record<string, FakeTenantSeed>>;
}

export interface FakeApiOptions {
  /** Deterministic clock (defaults captured at creation for stable eval). */
  readonly now: () => string;
  /** Deterministic id generator for command ids / new resources. */
  readonly ids: () => string;
}

export type FakeApiTransport = (request: HttpRequest) => Promise<HttpResponse>;

// --------------------------------------------------------------------------------
// The default seed
// --------------------------------------------------------------------------------

const ORG_TENANT = "org:11111111-2222-4333-8444-555555555555";
const ORG_ID = "11111111-2222-4333-8444-555555555555";
const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN_USER = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_ORG_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OTHER_ORG_OWNER = "aaaaaaaa-0000-4000-8000-000000000004";

const T0 = "2025-01-06T09:00:00.000Z";

/** Canonical instants used across the default seed (deterministic). */
export const FAKE_SEED_CLOCK = {
  base: T0,
  freshUntil: "2025-01-06T10:00:00.000Z",
  staleFreshUntil: "2025-01-06T09:30:00.000Z",
} as const;

export const DEFAULT_ORG_TENANT = ORG_TENANT;
export const DEFAULT_OWNER_ACTOR = `usr:${OWNER_USER}`;
export const DEFAULT_ADMIN_ACTOR = `usr:${ADMIN_USER}`;
export const DEFAULT_MEMBER_ACTOR = `usr:${MEMBER_USER}`;
export const DEFAULT_PERSONAL_ACTOR = `usr:${MEMBER_USER}`;

/**
 * A sensible default dataset: one organization (owner + admin + member), a
 * second organization (fail-closed cross-tenant target), two devices (FRESH
 * and STALE observations), one active intent (v2 superseding v1), a product
 * catalog, one placed order with a subscription (UNEVIDENCED reference), one
 * evidenced reference (FRESH), notifications, a support case with an internal
 * message, projections in all three freshness states, SLOs and one completed
 * reconciliation job.
 */
export function fakeApiSeed(): FakeApiSeed {
  return {
    users: [
      { userId: OWNER_USER, displayName: "Olive Owner" },
      { userId: ADMIN_USER, displayName: "Avery Admin" },
      { userId: MEMBER_USER, displayName: "Morgan Member" },
      { userId: OTHER_ORG_OWNER, displayName: "Opal Otherorg" },
    ],
    catalog: [
      {
        productId: "44444444-0000-4000-8000-000000000001",
        name: "RoamLink Global Connectivity",
        description: "Multi-region connectivity experience with priority access classes.",
        status: "active",
        variants: [
          {
            variantId: "55555555-0000-4000-8000-000000000001",
            name: "Global 10GB",
            billingModel: "recurring",
            amountMinor: 1999,
            currency: "USD",
            termDays: 30,
          },
          {
            variantId: "55555555-0000-4000-8000-000000000002",
            name: "Global Day Pass",
            billingModel: "one_time",
            amountMinor: 499,
            currency: "USD",
          },
        ],
      },
    ],
    tenants: {
      [ORG_TENANT]: {
        organization: {
          tenantId: ORG_TENANT,
          organizationId: ORG_ID,
          name: "Acme Roaming Corp",
          status: "active",
          revision: 1,
          members: [
            { userId: OWNER_USER, role: "owner", status: "active" },
            { userId: ADMIN_USER, role: "admin", status: "active" },
            { userId: MEMBER_USER, role: "member", status: "active" },
          ],
        },
        devices: [
          {
            deviceId: "dddddddd-0000-4000-8000-000000000001",
            name: "Phone",
            platform: "ios",
            status: "active",
            owningUserId: MEMBER_USER,
            revision: 1,
            capabilityFreshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
            contextFreshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
          },
          {
            deviceId: "dddddddd-0000-4000-8000-000000000002",
            name: "Laptop",
            platform: "macos",
            status: "enrolled",
            owningUserId: OWNER_USER,
            revision: 1,
            capabilityFreshness: {
              observedAt: "2025-01-06T08:00:00.000Z",
              receivedAt: "2025-01-06T08:00:00.000Z",
              freshUntil: FAKE_SEED_CLOCK.staleFreshUntil,
            },
            contextFreshness: null,
          },
        ],
        intents: [
          {
            intentId: "cccccccc-0000-4000-8000-000000000001",
            deviceId: "dddddddd-0000-4000-8000-000000000001",
            status: "active",
            revision: 2,
            versions: [
              {
                intentVersionId: "cccccccc-0000-4000-8000-0000000000a1",
                versionNumber: 1,
                status: "superseded",
                rationale: "Initial: work apps on the road.",
                accessClasses: ["work_apps_only"],
                createdAt: "2025-01-06T09:00:00.000Z",
              },
              {
                intentVersionId: "cccccccc-0000-4000-8000-0000000000a2",
                versionNumber: 2,
                status: "active",
                rationale: "Widen to any internet with a cost cap.",
                accessClasses: ["any_internet", "metered_cost_cap"],
                createdAt: "2025-01-06T09:10:00.000Z",
              },
            ],
            decision: {
              decisionId: "0c0c0c0c-0000-4000-8000-000000000001",
              derivedStatus: "experience_supported",
              computedAt: "2025-01-06T09:15:00.000Z",
            },
          },
        ],
        orders: [
          {
            orderId: "66666666-0000-4000-8000-000000000001",
            status: "placed",
            lines: [
              {
                lineId: "77777777-0000-4000-8000-000000000001",
                productId: "44444444-0000-4000-8000-000000000001",
                variantId: "55555555-0000-4000-8000-000000000001",
                quantity: 1,
                amountMinor: 1999,
                currency: "USD",
              },
            ],
            revision: 1,
          },
        ],
        subscriptions: [
          {
            subscriptionId: "88888888-0000-4000-8000-000000000001",
            orderId: "66666666-0000-4000-8000-000000000001",
            variantId: "55555555-0000-4000-8000-000000000001",
            status: "active",
            revision: 1,
            periodStart: "2025-01-06T09:05:00.000Z",
            periodEnd: "2025-02-05T09:05:00.000Z",
          },
        ],
        payments: [
          {
            paymentId: "90909090-0000-4000-8000-000000000001",
            orderId: "66666666-0000-4000-8000-000000000001",
            amountMinor: 1999,
            currency: "USD",
            state: "succeeded",
            recordedAt: "2025-01-06T09:06:00.000Z",
          },
        ],
        invoices: [
          {
            invoiceId: "bbbbbbbb-0000-4000-8000-000000000001",
            orderId: "66666666-0000-4000-8000-000000000001",
            amountMinor: 1999,
            currency: "USD",
            state: "issued",
            issuedAt: "2025-01-06T09:06:00.000Z",
          },
        ],
        references: [
          {
            subjectType: "subscription",
            subjectId: "88888888-0000-4000-8000-000000000001",
            status: "active",
            deliveryEvidenceState: "UNEVIDENCED",
          },
          {
            subjectType: "order",
            subjectId: "66666666-0000-4000-8000-000000000001",
            status: "active",
            deliveryEvidenceState: "EVIDENCED",
            evidence: {
              evidenceClass: "AUTHENTICATED_WEBHOOK",
              canonicalResourceType: "connectivity_contract",
              canonicalResourceId: "ctr_123",
              sourceVersion: 4,
              eventId: "evt_777",
              payloadDigest: "a".repeat(64),
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
              recordedFreshnessState: "FRESH",
            },
          },
        ],
        notifications: [
          {
            notificationId: "d0d0d0d0-0000-4000-8000-000000000001",
            recipientUserId: MEMBER_USER,
            topic: "connectivity",
            severity: "info",
            title: "Connectivity evidence linked",
            body: "Delivery evidence for your order is now linked and fresh.",
            state: "delivered",
            source: {
              origin: "roamlink_state_transition",
              aggregateType: "connectivity_reference",
              aggregateId: "ref-1",
              transition: "evidence_linked",
              eventId: "evt_555",
              occurredAt: T0,
            },
            related: [
              { kind: "order", id: "66666666-0000-4000-8000-000000000001" },
            ],
            channels: [
              { channel: "in_app", outcome: "delivered", attemptedAt: T0 },
            ],
            createdAt: T0,
            updatedAt: T0,
          },
        ],
        supportCases: [
          {
            caseId: "cafecafe-0000-4000-8000-000000000001",
            subject: "Connectivity degraded at the border",
            description: "Losing usable connectivity when crossing the regional border.",
            status: "in_progress",
            priority: "high",
            createdByUserId: MEMBER_USER,
            relatedRefs: [
              { kind: "subscription", id: "88888888-0000-4000-8000-000000000001" },
            ],
            messages: [
              {
                messageId: "e0e0e0e0-0000-4000-8000-000000000001",
                authorUserId: MEMBER_USER,
                body: "It dropped twice near the crossing.",
                visibility: "customer",
                sentAt: T0,
              },
              {
                messageId: "e0e0e0e0-0000-4000-8000-000000000002",
                authorUserId: ADMIN_USER,
                body: "Internal: checking projection freshness for this tenant.",
                visibility: "internal",
                sentAt: "2025-01-06T09:05:00.000Z",
              },
            ],
            revision: 2,
            createdAt: T0,
            updatedAt: "2025-01-06T09:05:00.000Z",
          },
        ],
        projections: [
          {
            projectionId: "prj.connectivity_contract.ctr_123",
            canonicalResourceType: "connectivity_contract",
            canonicalResourceId: "ctr_123",
            evidenceClass: "AUTHENTICATED_WEBHOOK",
            projectionVersion: 4,
            payloadDigest: "a".repeat(64),
            freshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
          },
          {
            projectionId: "prj.connectivity_intent.cnt_9",
            canonicalResourceType: "connectivity_intent",
            canonicalResourceId: "cnt_9",
            evidenceClass: "CANONICAL_READ",
            projectionVersion: 2,
            payloadDigest: "b".repeat(64),
            freshness: {
              observedAt: "2025-01-06T08:00:00.000Z",
              receivedAt: "2025-01-06T08:00:00.000Z",
              freshUntil: FAKE_SEED_CLOCK.staleFreshUntil,
            },
          },
          {
            projectionId: "prj.contract_usage.use_5",
            canonicalResourceType: "contract_usage",
            canonicalResourceId: "use_5",
            evidenceClass: "CANONICAL_READ",
            projectionVersion: 1,
            payloadDigest: "c".repeat(64),
            freshness: {
              observedAt: null,
              receivedAt: null,
              freshUntil: null,
            },
          },
        ],
        slos: [
          {
            name: "projection_freshness",
            state: "within-budget",
            burnRate: 0.1,
            budgetRemainingRatio: 0.9,
            total: 1000,
            bad: 10,
          },
          {
            name: "time_to_usable_connectivity",
            state: "at-risk",
            burnRate: 0.6,
            budgetRemainingRatio: 0.4,
            total: 500,
            bad: 60,
          },
        ],
        reconciliationJobs: [
          {
            jobId: "e1e1e1e1-0000-4000-8000-000000000001",
            status: "COMPLETED",
            trigger: "scheduled",
            commandId: "e1e1e1e1-0000-4000-8000-000000000001",
            correlationId: "corr-job-1",
            idempotencyKey: "idem-job-1",
            createdAt: "2025-01-06T08:55:00.000Z",
            startedAt: "2025-01-06T08:55:01.000Z",
            completedAt: "2025-01-06T08:55:05.000Z",
            actions: [
              {
                actionType: "FRESHNESS_SWEEP",
                outcome: "DEGRADED_STALE",
                targetType: "connectivity_intent",
                targetId: "cnt_9",
                at: "2025-01-06T08:55:03.000Z",
              },
              {
                actionType: "CANONICAL_REFRESH",
                outcome: "ALREADY_CONSISTENT",
                targetType: "connectivity_contract",
                targetId: "ctr_123",
                at: "2025-01-06T08:55:04.000Z",
              },
            ],
          },
        ],
      },
      [OTHER_ORG_TENANT]: {
        organization: {
          tenantId: OTHER_ORG_TENANT,
          organizationId: "99999999-8888-4777-8666-555555555555",
          name: "Beta Roaming Ltd",
          status: "active",
          revision: 1,
          members: [{ userId: OTHER_ORG_OWNER, role: "owner", status: "active" }],
        },
        devices: [],
        intents: [],
        orders: [],
        subscriptions: [],
        payments: [],
        invoices: [],
        references: [],
        notifications: [],
        supportCases: [],
        projections: [],
        slos: [],
        reconciliationJobs: [],
      },
    },
  };
}

export const OTHER_ORG = {
  tenantId: OTHER_ORG_TENANT,
  ownerActor: `usr:${OTHER_ORG_OWNER}`,
} as const;
