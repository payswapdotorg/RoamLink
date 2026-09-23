/**
 * Deterministic seed fixtures for the in-memory fake API (app-kit test
 * surface).
 *
 * The seed is a plain, frozen data structure: organizations with memberships
 * (owner/admin/member roles mirroring @roamlink/auth's permission map),
 * devices with observation freshness, experience intents with version chains,
 * a product catalog, orders/subscriptions/payments/invoices/refunds, delivery
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
  /**
   * Optional per-device eSIM facts (RL-115-F1 remediation, additive): the
   * three capability-evidence rows, the platform's install contract and the
   * profile inventory. Absent renders as the honest unknown rows (nothing
   * is assumed — RL-LOCK-011).
   */
  readonly esim?: FakeDeviceEsimSeed;
}

/**
 * One eSIM capability evidence row (fake-internal; the wire shape is the
 * EsimCapabilityRowResource in the resources module). Status mirrors the
 * edge capability-snapshot vocabulary members that reach this surface.
 */
export interface FakeEsimCapabilitySeed {
  readonly capability: "esim_profile_install" | "esim_profile_remove" | "esim_profile_enable";
  readonly status: "available" | "requires-permission" | "unavailable" | "unknown";
  readonly evidenceClass: string | null;
  readonly freshness: FakeFreshnessSeed | null;
}

/**
 * One eSIM profile record. `evidenceClass`/`freshness` back the CONFIRMED
 * states only; a commanded state (`install-requested`, `remove-requested` or
 * a pending enable/disable) carries them as the last platform confirmation,
 * or null when none exists.
 */
export interface FakeEsimProfileSeed {
  readonly profileId: string;
  readonly label: string;
  readonly state: "install-requested" | "enabled" | "disabled" | "remove-requested";
  readonly evidenceClass: string | null;
  readonly freshness: FakeFreshnessSeed | null;
  readonly installedAt: string | null;
}

/** The per-device eSIM seed composition. */
export interface FakeDeviceEsimSeed {
  readonly capabilities: readonly FakeEsimCapabilitySeed[];
  readonly installRequiresActivationCode: boolean;
  readonly profiles: readonly FakeEsimProfileSeed[];
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

/**
 * Optional enterprise journey fixtures (RL-104, additive): the enrollment
 * journey record mirrors packages/enterprise's enrollment vocabulary and
 * the connector record its provisioning vocabulary (drift-guarded by
 * tests/architecture). Absent sections render as the honest not-started
 * state on the workspace surface.
 *
 * PA-007 (closes RL-115-F7): the organization policy read mirrors
 * packages/enterprise's policy read vocabulary (state + source,
 * drift-guarded by tests/architecture) with its freshness FACTS (observed /
 * received / fresh-until - the fake evaluates the freshness STATE at the
 * query instant, exactly like the device observation freshness). Absent
 * policy renders as the honest null section ("not available"); a seeded
 * `not-configured`/`unknown` record renders those explicit absence states
 * (never a guess, never a collapsed absence).
 */
export interface FakeEnterpriseEnrollmentSeed {
  readonly enrollmentId: string;
  readonly organizationName: string;
  readonly state: "draft" | "submitted" | "verified" | "active" | "rejected" | "cancelled";
  readonly tenantId: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly activatedAt?: string;
  readonly rejectionReason?: "requirements-unmet" | "verification-failed" | "duplicate-organization";
  readonly cancelledAt?: string;
}

export interface FakeEnterpriseConnectorSeed {
  readonly provisioningId: string;
  readonly state: "provisioning" | "provisioned" | "failed" | "revoked";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provisionedAt?: string;
  readonly failureReason?:
    | "connector-unavailable"
    | "capability-negotiation-empty"
    | "configuration-delivery-failed";
  readonly revokedAt?: string;
}

export interface FakeEnterprisePolicySeed {
  readonly policyId: string;
  readonly state: "configured" | "not-configured" | "unknown";
  readonly source: "organization-administration";
  readonly policyVersion?: string;
  readonly summary?: string;
  readonly effectiveAt?: string;
  /** The observation facts; the fake evaluates the state at the query instant. */
  readonly freshness?: FakeFreshnessSeed;
}

/**
 * PA-008 (closes RL-115-F5): the enterprise integration status fixtures
 * mirror packages/enterprise's integration kind + four-state vocabularies
 * (drift-guarded by tests/architecture). The seeded default is the honest
 * wave-2 world: SSO carries a present, configured read (with a fresh
 * observation), while SCIM and MDM carry the honest `unavailable`
 * declaration - the enterprise integration API exposes no status read for
 * those kinds yet, so the fake declares it instead of inventing a status.
 * Scenario seeds derive the not-configured / unknown / stale worlds by
 * copy + override.
 */
export interface FakeEnterpriseIntegrationSeed {
  readonly integrationId: string;
  readonly kind: "sso" | "scim" | "mdm";
  readonly state: "configured" | "not-configured" | "unavailable" | "unknown";
  readonly summary?: string;
  /** The observation facts; the fake evaluates the state at the query instant. */
  readonly freshness?: FakeFreshnessSeed;
}

export interface FakeEnterpriseSeed {
  readonly enrollment?: FakeEnterpriseEnrollmentSeed;
  readonly connector?: FakeEnterpriseConnectorSeed;
  readonly policy?: FakeEnterprisePolicySeed;
  readonly integrations?: readonly FakeEnterpriseIntegrationSeed[];
}

/**
 * The integration-health seed (PA-010): the recorded probe outcome. The
 * `mutationsAllowed` fact is NEVER seeded — it is derived from the state
 * (exactly `compatible`) so the wire cannot lie about the fail-closed gate.
 */
export interface FakeIntegrationHealthSeed {
  readonly state: "compatible" | "incompatible" | "not-configured" | "unknown";
  /** The ONE pinned supported ADCOS API version (mirrors @roamlink/adcos). */
  readonly supportedApiVersion: string;
  /** When the probe recorded its report (report states only). */
  readonly lastCheckedAt?: string;
  /** The recorded report's suite version (report states only). */
  readonly suiteVersion?: string;
  /** The recorded report's checks (report states only; value-free details). */
  readonly checks?: readonly FakeIntegrationHealthCheckSeed[];
}

export interface FakeIntegrationHealthCheckSeed {
  readonly name: string;
  readonly passed: boolean;
  readonly code?: string;
  readonly detail: string;
}

/**
 * PA-002 (closes RL-115-F4): the customer refund fixtures mirror
 * packages/domain-commerce's refund read model vocabularies (the closed
 * `customer_refund_state` / reason-code / failure-reason vocabularies,
 * drift-guarded by tests/architecture). The seeded default is the honest
 * world: one order carrying a SUCCEEDED partial refund plus a PENDING one
 * (both against the order's one succeeded payment - the multi-refund
 * partial-payment case, sums within the payment amount), while a second
 * tenant carries an order with NO refunds (the honest empty section).
 * Scenario seeds derive every state x at least one refund (and the
 * stale/unknown freshness worlds) by copy + override.
 */
export interface FakeRefundSeed {
  readonly refundId: string;
  /** The SUCCEEDED payment this refund returns money from. */
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: "pending" | "succeeded" | "failed" | "cancelled";
  readonly reasonCode:
    | "customer_request"
    | "service_not_delivered"
    | "billing_error"
    | "duplicate_charge"
    | "goodwill"
    | "other";
  /** Optional human-facing note (explicitly clearable in scenario seeds). */
  readonly note?: string | undefined;
  readonly failureReason?:
    | "processor_error"
    | "payment_instrument_unreachable"
    | "compliance_hold"
    | "cancelled_by_operator"
    | undefined;
  /** The observation facts (absent/undefined = the UNKNOWN freshness world);
   * the fake evaluates the state at the query instant. */
  readonly freshness?: FakeFreshnessSeed | undefined;
}

export interface FakeTenantSeed {
  /** Organization tenant data (org:<uuid>). */
  readonly organization?: FakeOrganizationSeed;
  /** Optional enterprise journey fixtures (RL-104, additive). */
  readonly enterprise?: FakeEnterpriseSeed;
  /**
   * The recorded ADCOS integration-health state (PA-010, additive): what
   * the env-gated compatibility probe (RL-108) recorded for this world —
   * compatible/incompatible carry their report (lastCheckedAt, suiteVersion,
   * checks); not-configured/unknown carry none. An ABSENT section is the
   * honest `unknown` world (nothing recorded — the fail-closed default,
   * never a guessed compatibility).
   */
  readonly integrationHealth?: FakeIntegrationHealthSeed;
  readonly devices: readonly FakeDeviceSeed[];
  readonly intents: readonly FakeIntentSeed[];
  readonly orders: readonly FakeOrderSeed[];
  readonly subscriptions: readonly FakeSubscriptionSeed[];
  readonly payments: readonly FakePaymentSeed[];
  readonly invoices: readonly FakeInvoiceSeed[];
  /**
   * PA-002 (closes RL-115-F4, additive): the tenant's refund read records,
   * scoped to orders through their payments. An ABSENT section is the honest
   * null world (this surface composes no refund read - the pre-PA-002 wire,
   * RL-LOCK-017); an empty array composes the read with no refunds.
   */
  readonly refunds?: readonly FakeRefundSeed[];
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
 * second organization (fail-closed cross-tenant target; PA-002: it carries
 * one order with no refunds - the honest empty-section world), two devices
 * (FRESH and STALE observations), one active intent (v2 superseding v1), a
 * product catalog, one placed order with a subscription (UNEVIDENCED
 * reference), one evidenced reference (FRESH), a succeeded payment carrying
 * two refunds (PA-002: one succeeded partial + one pending - the
 * multi-refund partial-payment case), notifications, a support case with an
 * internal message, projections in all three freshness states, SLOs and one
 * completed reconciliation job.
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
        // RL-104: the seeded org has COMPLETED its enterprise journey
        // (verified + activated enrollment, provisioned connector) - a
        // "live organization" world. The OTHER org stays empty (no
        // enterprise record: honest not-started states render there).
        enterprise: {
          enrollment: {
            enrollmentId: "eeeeeeee-0000-4000-8000-000000000001",
            organizationName: "Acme Roaming Corp",
            state: "active",
            tenantId: ORG_TENANT,
            requestedBy: `act:${OWNER_USER}`,
            createdAt: "2024-06-01T00:00:00.000Z",
            updatedAt: "2024-06-01T00:10:00.000Z",
            verifiedAt: "2024-06-01T00:05:00.000Z",
            activatedAt: "2024-06-01T00:10:00.000Z",
          },
          connector: {
            provisioningId: "conn-acme-01",
            state: "provisioned",
            createdAt: "2024-06-01T00:11:00.000Z",
            updatedAt: "2024-06-01T00:12:00.000Z",
            provisionedAt: "2024-06-01T00:12:00.000Z",
          },
          // PA-007 (closes RL-115-F7): the seeded org carries a PRESENT
          // organization policy read - configured upstream by the
          // organization's administration, with a version, a human summary
          // and a fresh observation (the honest happy-path world; scenario
          // seeds derive the absent/stale/unknown worlds by copy + override).
          policy: {
            policyId: "pppppppp-0000-4000-8000-000000000001",
            state: "configured",
            source: "organization-administration",
            policyVersion: "2025-01",
            summary:
              "Roam on approved networks with a capped daily spend; privacy comes first and location is never tracked.",
            effectiveAt: "2024-07-01T00:00:00.000Z",
            freshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
          },
          // PA-008 (closes RL-115-F5): the seeded org carries the honest
          // enterprise integration statuses - SSO is configured upstream
          // (a fresh observation + a human summary), while SCIM and MDM
          // carry the honest `unavailable` declaration (the enterprise
          // integration API exposes no status read for those kinds yet;
          // scenario seeds derive the other state worlds by copy +
          // override).
          integrations: [
            {
              integrationId: "iiiiiiii-0000-4000-8000-000000000001",
              kind: "sso",
              state: "configured",
              summary:
                "Sign in to RoamLink through your organization's identity provider instead of a separate password.",
              freshness: {
                observedAt: T0,
                receivedAt: T0,
                freshUntil: FAKE_SEED_CLOCK.freshUntil,
              },
            },
            {
              integrationId: "iiiiiiii-0000-4000-8000-000000000002",
              kind: "scim",
              state: "unavailable",
            },
            {
              integrationId: "iiiiiiii-0000-4000-8000-000000000003",
              kind: "mdm",
              state: "unavailable",
            },
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
            // RL-115-F1 remediation: the iOS device carries eSIM capability
            // EVIDENCE (available, OBSERVED, fresh) and one platform-confirmed
            // enabled profile — the honest happy-path journey world.
            esim: {
              capabilities: [
                {
                  capability: "esim_profile_install",
                  status: "available",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
                {
                  capability: "esim_profile_remove",
                  status: "available",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
                {
                  capability: "esim_profile_enable",
                  status: "available",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
              ],
              installRequiresActivationCode: true,
              profiles: [
                {
                  profileId: "1a2b3c4d-0000-4000-8000-000000000001",
                  label: "Primary line",
                  state: "enabled",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                  installedAt: "2024-12-01T10:00:00.000Z",
                },
                {
                  profileId: "1a2b3c4d-0000-4000-8000-000000000002",
                  label: "Travel data plan",
                  state: "disabled",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                  installedAt: "2024-11-18T16:30:00.000Z",
                },
              ],
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
            // The macOS device's platform reports the eSIM capabilities as
            // UNAVAILABLE (the capability is not defined on this platform
            // family — the honest blocked world: manual guidance, no actions).
            esim: {
              capabilities: [
                {
                  capability: "esim_profile_install",
                  status: "unavailable",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
                {
                  capability: "esim_profile_remove",
                  status: "unavailable",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
                {
                  capability: "esim_profile_enable",
                  status: "unavailable",
                  evidenceClass: "OBSERVED",
                  freshness: {
                    observedAt: T0,
                    receivedAt: T0,
                    freshUntil: FAKE_SEED_CLOCK.freshUntil,
                  },
                },
              ],
              installRequiresActivationCode: false,
              profiles: [],
            },
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
        // PA-002 (closes RL-115-F4): the honest refund world - the seeded
        // order carries TWO refunds against its one succeeded payment
        // (the multi-refund PARTIAL payment case: 500 + 250 <= 1999): a
        // SUCCEEDED partial refund (customer request, fresh observation)
        // and a PENDING one (billing error, fresh observation). A newly
        // placed order composes the honest EMPTY refund section (no refunds
        // attach to its payments). Scenario seeds derive every state x at
        // least one refund plus the stale/unknown freshness worlds.
        refunds: [
          {
            refundId: "3e3e3e3e-0000-4000-8000-000000000001",
            paymentId: "90909090-0000-4000-8000-000000000001",
            amountMinor: 500,
            currency: "USD",
            state: "succeeded",
            reasonCode: "customer_request",
            note: "Partial refund for the unused days.",
            freshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
          },
          {
            refundId: "3e3e3e3e-0000-4000-8000-000000000002",
            paymentId: "90909090-0000-4000-8000-000000000001",
            amountMinor: 250,
            currency: "USD",
            state: "pending",
            reasonCode: "billing_error",
            freshness: {
              observedAt: T0,
              receivedAt: T0,
              freshUntil: FAKE_SEED_CLOCK.freshUntil,
            },
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
        // PA-010: the default world's recorded probe outcome — the §9
        // compatibility suite ran and PASSED (the real check names from
        // @roamlink/compat's gate + suite; details are value-free). Scenario
        // seeds derive the incompatible / not-configured / unknown worlds.
        integrationHealth: {
          state: "compatible",
          supportedApiVersion: "2.0",
          lastCheckedAt: "2025-01-06T09:00:00.000Z",
          suiteVersion: "1.0",
          checks: [
            {
              name: "application_self.available",
              passed: true,
              detail: "GET application answered with a contract-shaped response",
            },
            {
              name: "contract_lifecycle_states.required",
              passed: true,
              detail:
                "the 13-state v2 lifecycle vocabulary is intact (closed enum, canonical progression, terminal states)",
            },
            {
              name: "request_schemas.closed",
              passed: true,
              detail: "closed request schemas reject unknown members",
            },
            {
              name: "webhook_envelope.closed",
              passed: true,
              detail: "the webhook envelope is closed (9 documented members)",
            },
            {
              name: "webhook_signature_semantics.pinned",
              passed: true,
              detail: "signature scheme constants + HMAC-SHA256 round-trip verified",
            },
            {
              name: "idempotency_behavior.replay",
              passed: true,
              detail: "same-key replay returned the identical response (no duplicate effect)",
            },
            {
              name: "version_pin.single_site",
              passed: true,
              detail: "one supported line, pinned identically in the adcos boundary and the contracts env schema",
            },
            {
              name: "mutation_gate.fail_closed",
              passed: true,
              detail: "the runtime gate refuses mutations unless the compatibility check passed",
            },
          ],
        },
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
        // PA-002: Beta carries one placed order with a succeeded payment and
        // NO refunds (the honest EMPTY refund section world - the read is
        // composed, zero refunds exist for this order).
        orders: [
          {
            orderId: "66666666-0000-4000-8000-000000000002",
            status: "placed",
            lines: [
              {
                lineId: "77777777-0000-4000-8000-000000000002",
                productId: "44444444-0000-4000-8000-000000000001",
                variantId: "55555555-0000-4000-8000-000000000002",
                quantity: 1,
                amountMinor: 499,
                currency: "USD",
              },
            ],
            revision: 1,
          },
        ],
        subscriptions: [],
        payments: [
          {
            paymentId: "90909090-0000-4000-8000-000000000002",
            orderId: "66666666-0000-4000-8000-000000000002",
            amountMinor: 499,
            currency: "USD",
            state: "succeeded",
            recordedAt: "2025-01-06T09:20:00.000Z",
          },
        ],
        invoices: [
          {
            invoiceId: "bbbbbbbb-0000-4000-8000-000000000002",
            orderId: "66666666-0000-4000-8000-000000000002",
            amountMinor: 499,
            currency: "USD",
            state: "issued",
            issuedAt: "2025-01-06T09:20:00.000Z",
          },
        ],
        refunds: [],
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
