/**
 * RL-113 — the hosted user-journey E2E suite, part 4:
 * the offline-edge journey (the apps/mobile mobileDocument legs — Now /
 * Capabilities / Controls / Outbox) and the enterprise-onboarding journey.
 *
 * The offline-edge journey is device-side by nature: the edge continues
 * observation and desired-state work while the host is unreachable, and
 * renders its own honest surfaces. The suite drives the REAL edge engine
 * (packages/edge + edge-actions) through the real MobileEdgeShell and
 * asserts the four mobile legs over real outbox state — queued is NOT
 * executed, observation continues offline, freshness is always rendered.
 *
 * The enterprise-onboarding journey is COMPOSED since PA-024: the real
 * hosted runtime answers /v1/enterprise/workspace with the composed read
 * model (the organization section from the bound identity stores, the
 * connector section from the executed-command ledger, the unbound
 * sections the contract's honest nulls), so the workspace page renders
 * its real journey content — the four workspace-composed journey steps,
 * the connector enrollment, the policy summary, the integrations and the
 * enrollment status sections — never the unavailable panels, never a
 * fabricated journey state. The personal tenant composes the honest
 * null organization; an organization-scoped journey composes the REAL
 * organization record from the bound identity stores.
 *
 * PA-026 adds the EXECUTED-state legs: the full enterprise workspace
 * journey over the real hosted composition with the tick advancing the
 * commands (the enrollment journey executed through the worker seam's
 * ENTERPRISE executor table — the domain's own transition functions over
 * the shared-persistence stores; the registrar bound to the REAL auth
 * administration boundary; the connector through the real PA-023 app
 * flow; the policy/integration observations published through the shared
 * persistence; the fleet and the first goal through the hosted demo
 * tick) — then the eight-step walk renders every step's REAL state. The
 * honest pre-execution states stay pinned (accepted is NOT executed),
 * and the personal tenant keeps its honest negatives.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createAesGcmEdgePayloadCipher } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";
import { fragment } from "@roamlink/app-kit";
import {
  InMemoryMobilePlatformProbe,
  MobileEdgeShell,
  actionOutcomeScreen,
  capabilityMatrixScreen,
  connectivityScreen,
  mobileDocument,
  outboxScreen,
} from "@roamlink/mobile";
import { deterministicUuidFromSeed, fixtureCommandEnvelope, fixtureTenantId } from "@roamlink/testkit";
import {
  AccountAdministrationService,
  AuthorizationService,
} from "@roamlink/auth";
import { tenantIdFromOrganization, parseOrganizationId, type ActorId, type TenantId, type UtcInstant } from "@roamlink/contracts";
import {
  ingestCommand,
  ENTERPRISE_INTEGRATION_REPOSITORY,
  ENTERPRISE_POLICY_REPOSITORY,
} from "@roamlink/api-service";
import {
  parseEnterpriseIntegrationStatusRecord,
  parseOrganizationPolicyRecord,
  type OrganizationRegistrar,
} from "@roamlink/enterprise";
import {
  commandLedgerDeliveryPort,
  createBoundedWorkerTick,
  createCommandLedger,
  createEnterpriseCommandExecutors,
  type BoundedWorkerTick,
} from "@roamlink/workers";

import {
  bootHostedJourney,
  createJourneyClock,
  orgScopedApp,
  registerHostedOrganization,
  type HostedJourney,
} from "../src/host.js";

const T = "2026-03-01T08:00:00.000Z";
const KEY_BYTES = new Uint8Array(32).fill(23);
const SIGNING_KEY = "e2e-mobile-enrollment-key";

/** The online observation batch (capability + context evidence). */
const ONLINE_BATCH = [
  { kind: "capability-probe", capability: "wifi_control", status: "available" },
  { kind: "capability-probe", capability: "wifi_observation", status: "available" },
  { kind: "context-observation", contextField: "connectivity-state", value: "online" },
] as const;

function makeSigner(key: string) {
  return {
    algorithm: "hmac-sha256" as const,
    keyId: "e2e-enrollment",
    async sign(message: string): Promise<string> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex");
    },
    async verify(message: string, signature: string): Promise<boolean> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex") === signature;
    },
  };
}

function buildEdgeShell(): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: [
      [...ONLINE_BATCH].map((sample) => ({
        observedAt: T,
        evidence: { kind: "platform-api-probe", source: "E2EProbe" },
        subject: sample,
      })),
    ],
  });
  let counter = 0;
  const uuid = (seed: number): string => deterministicUuidFromSeed(seed + (++counter));
  return new MobileEdgeShell({
    deviceRef: "device-e2e-edge",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-e2e-edge",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "e2e-outbox-key",
    observationIdGenerator: () => uuid(1),
    snapshotIdGenerator: () => uuid(10_000),
    outboxRecordIdGenerator: () => uuid(20_000),
    actionIdGenerator: () => uuid(30_000),
    commandIdGenerator: () => uuid(40_000),
    correlationIdGenerator: () => `corr-e2e-edge-${++counter}`,
    idempotencyKeyGenerator: () => `idem-e2e-edge-${++counter}`,
    desiredStateIdGenerator: () => uuid(50_000),
    publicationIdGenerator: () => uuid(60_000),
    signer: makeSigner(SIGNING_KEY),
    snapshotFreshnessMs: 60_000,
  });
}

describe("RL-113 hosted journey: offline edge (the mobile document legs)", () => {
  it("renders Now / Capabilities / Controls / Outbox honestly while offline", async () => {
    const shell = buildEdgeShell();

    // Enrollment: the signed, versioned, expiring capability publication.
    // The snapshot chain is versioned per capability observation, so the
    // journey-shaped assertions are: signed + versioned (>= 1) and the
    // chain ADVANCES on re-enrollment (never mutated in place).
    const publication = await shell.enroll(T);
    expect(publication.snapshot.sequence).toBeGreaterThanOrEqual(1);
    const second = await shell.enroll(T);
    expect(second.snapshot.sequence).toBeGreaterThan(publication.snapshot.sequence);
    expect(second.snapshotDigest).not.toBe(publication.snapshotDigest);

    // The device goes offline; observation and desired-state continue.
    shell.enterOffline(T);
    await shell.runObservationCycle(T);
    expect(shell.isSyncReachable()).toBe(false);

    // A desired action is QUEUED into the encrypted outbox — queued is not
    // executed (the authoritative result arrives through sync).
    const queued = await shell.requestAction(
      { capability: "wifi_control", parameters: { ssid: "Acahat-Guest" } },
      "server",
      T,
    );
    expect(queued.mode).toBe("server");
    expect(queued.outcome).toBe("QUEUED");

    // The four mobile legs over the real edge state, wrapped in the real
    // mobile document shell (Now / Capabilities / Controls / Outbox).
    const view = await shell.connectivityView(T);
    const records = await shell.outboxRecords();
    const document = mobileDocument(
      "Offline edge journey",
      fragment(
        connectivityScreen(view),
        capabilityMatrixScreen(shell.capabilityMatrix(T)),
        actionOutcomeScreen(queued, "wifi_control"),
        outboxScreen(records),
      ),
    );

    // The mobile navigation (the four legs) is part of the document shell.
    for (const legLabel of ["Now", "Capabilities", "Controls", "Outbox"]) {
      expect(document).toContain(`>${legLabel}</a>`);
    }

    // Leg 1 — Now: the honest offline banner and last-known connectivity.
    expect(document).toContain("Connectivity now");
    expect(document).toContain(
      "Offline - observation continues; queued commands are held in the encrypted outbox",
    );
    // "online" is rendered as a <strong> value next to the label.
    expect(document).toContain("Connectivity (last observed):");
    expect(document).toContain(">online</strong>");
    expect(document).toContain('data-freshness="FRESH"');
    expect(document).toContain("Outbox: 1 pending, 0 synced, 0 dead-lettered");

    // Leg 2 — Capabilities: the evidence-based truth table with the gate.
    expect(document).toContain("Capabilities");
    expect(document).toContain("wifi_control");
    expect(document).toContain('data-state="available"');
    expect(document).toContain("allow");
    expect(document).toContain("Evidence-based: controls only unlock with real platform evidence.");

    // Leg 3 — Controls: the queued outcome with the queued != executed law.
    expect(document).toContain("Controls");
    expect(document).toContain("Server-bound desired state");
    expect(document).toContain(
      "Queued into the encrypted offline outbox - queued is NOT executed; the authoritative result arrives through sync.",
    );

    // Leg 4 — Outbox: the encrypted outbox's honest boundary state.
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("pending");
    expect(document).toContain("Encrypted offline outbox");
    expect(document).toContain('data-state="pending"');
    expect(document).toContain("Payloads are ciphertext-only at rest; identity/dedupe metadata stays in the clear.");
  });
});

describe("RL-113 hosted journey: enterprise onboarding (the composed workspace read, PA-024)", () => {
  it("composes the workspace read honestly for a personal tenant and renders the real journey content (never a fabricated state)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d1, email: "enterprise@example.com" });
    try {
      // The enterprise workspace read is now COMPOSED on the real hosted
      // runtime (PA-024, previously the audit §3 plain 404). A personal
      // tenant composes the honest all-null sections: no organization
      // (a real fact of the personal tenant), no enrollment journey, no
      // connector (accepted is not executed — no executed
      // connector.provision command exists on this composition), no
      // policy/integration reads. Every field is a real fact of the
      // bound state, parsed under the frozen app-kit parser.
      const workspace = await journey.app.client().getEnterpriseWorkspace();
      expect(workspace.organization).toBeNull();
      expect(workspace.enrollment).toBeNull();
      expect(workspace.connector).toBeNull();
      expect(workspace.policy).toBeNull();
      expect(workspace.integrations).toBeNull();
      expect(workspace.presentedAt).toBeDefined();

      // PA-024 flip: the customer surface renders the real journey content
      // from the composed read. The shell still states the honest
      // no-reference connectivity (the ledger projection is empty), the
      // CORE sections (device fleet, goals, org connectivity — all
      // composed reads) render their honest empty-journey content, AND the
      // workspace-composed sections now render from the real resource
      // instead of the quiet unavailable panels: the switcher states the
      // honest unknown-organization fact, the four workspace-composed
      // journey steps render (their honest not-started/complete states),
      // and the connector enrollment, policy summary, integrations and
      // enrollment status sections each render their honest content.
      const html = await journey.app.renderDocument({ page: "workspace" });
      expect(html).toContain('data-shell-connectivity="no-reference"');
      expect(html).toContain('data-device-fleet="true"');
      expect(html).toContain('data-workspace-goals="true"');
      expect(html).toContain('data-org-connectivity="true"');
      // The switcher composes the honest personal-tenant fact.
      expect(html).toContain('data-workspace-switcher="true"');
      expect(html).toContain('data-workspace-org-unknown="true"');
      // The four workspace-composed journey steps render (their facts are
      // known now — honest states, never invented ones).
      expect(html).toContain('data-workspace-journey="true"');
      expect(html).toContain('data-workspace-step="workspace"');
      expect(html).toContain('data-workspace-step="organization-verification"');
      expect(html).toContain('data-workspace-step="policy"');
      expect(html).toContain('data-workspace-step="connector"');
      expect(html).toContain('data-workspace-step="devices"');
      expect(html).toContain('data-workspace-step="live-overview"');
      // The workspace-composed sections render their real content.
      expect(html).toContain('data-connector-enrollment="true"');
      expect(html).toContain('data-policy-summary="not-available"');
      expect(html).toContain('data-integrations="true"');
      expect(html).toContain('data-enrollment-absent="true"');
      expect(html).toContain('data-connector-absent="true"');
      // NO degradation panels remain anywhere on the page: the workspace
      // read composed, so no section needs the quiet unavailable panel.
      expect(html).not.toContain('data-unavailable="true"');
      // The degraded/fail-closed bodies are gone: the page is the real
      // journey content, never a fabricated state.
      expect(html).not.toContain('data-error-kind=');
      // The More destination (the workspace's mobile discovery path) stays
      // discoverable.
      expect(html).toContain('href="/more"');
    } finally {
      await journey.dispose();
    }
  });

  it("composes the REAL organization section for an organization-scoped journey (the bound identity stores' own record)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d2, email: "enterprise-org@example.com" });
    try {
      // The organization is created through the REAL administration
      // boundary over the host's own identity stores (the same boundary
      // the demo-account seeding drives), with the journey's user as the
      // owner. The workspace read in the ORGANIZATION tenant then composes
      // the REAL organization record — the bound identity stores' own
      // facts, never a fabricated workspace identity.
      const orgTenantId = await registerHostedOrganization(
        journey.composition,
        journey.identity,
        0x5d2,
        "Acahat Travel Co",
      );
      const scoped = orgScopedApp(journey, orgTenantId);

      const workspace = await scoped.client.getEnterpriseWorkspace();
      const organization = workspace.organization;
      if (organization === null) throw new Error("organization section missing");
      expect(organization.tenantId).toBe(orgTenantId);
      expect(organization.name).toBe("Acahat Travel Co");
      expect(organization.status).toBe("active");
      // The unbound sections keep the honest nulls in the org scope too.
      expect(workspace.enrollment).toBeNull();
      expect(workspace.connector).toBeNull();
      expect(workspace.policy).toBeNull();
      expect(workspace.integrations).toBeNull();

      // The workspace page in the organization scope renders the REAL
      // organization identity in the switcher (name + active badge) and
      // the full journey content from the composed reads.
      const html = await scoped.app.renderDocument({ page: "workspace" });
      expect(html).toContain("Acahat Travel Co");
      expect(html).toContain('data-workspace-switcher="true"');
      expect(html).not.toContain('data-workspace-org-unknown="true"');
      expect(html).toContain('data-workspace-step="workspace"');
      expect(html).toContain('data-workspace-step="organization-verification"');
      expect(html).toContain('data-workspace-step="policy"');
      expect(html).toContain('data-workspace-step="connector"');
      expect(html).not.toContain('data-unavailable="true"');
      expect(html).not.toContain('data-error-kind=');
    } finally {
      await journey.dispose();
    }
  });
});
// ---------------------------------------------------------------------------------
// PA-026 — the EXECUTED-state legs: the full enterprise workspace journey over
// the REAL hosted composition, with the tick advancing the commands.
//
// The enterprise command-execution composition (the worker seam PA-025
// composed, with the ENTERPRISE executor table — the domain's own transition
// functions over the bound shared-persistence stores):
//
//   the enrollment commands (the domain's vocabulary, ingested through the
//   REAL command-plane ingest at packages/enterprise's pinned route
//   templates — NO services/api mutation route is invented, per the PA-023
//   parity law; the web app renders no enrollment action — the recorded
//   UI-journey finding)
//     -> ONE bounded tick (createBoundedWorkerTick + commandLedgerDeliveryPort
//        + createEnterpriseCommandExecutors) over the HOSTED composition's OWN
//        persistence (one database, one truth) and the JOURNEY'S OWN CLOCK
//       -> the domain's pure functions apply over the bound stores; the
//          ledger records the executed stage + the resource
//         -> the workspace read serves the LIVE enrollment state at every
//            step, and the registrar port (bound to the REAL auth
//            administration boundary over the composition's own identity
//            stores) provisions the organization AT VERIFICATION — the
//            organization section then composes the registrar's own REAL
//            identity-store record.
//
//   the connector: the PA-023 route's command through the REAL app flow
//   (provisionConnectorFlow) -> the enterprise tick -> the domain's
//   negotiation persisted -> the connector section serves the PROVISIONED
//   state.
//
//   the policy/integration records: the upstream organization
//   administration's observations, published through the shared persistence
//   (validated by the domain's own parsers) -> the sections serve the real
//   records.
//
//   the devices + first-goal legs: the hosted demo tick's own executors
//   (the PA-025 path, unchanged).
// ---------------------------------------------------------------------------------

/** The enterprise execution composition bound over one hosted journey. */
interface EnterpriseExecution {
  /** The bounded tick with the ENTERPRISE executor table (the real seam). */
  readonly tick: BoundedWorkerTick;
  /** The organization tenants the registrar provisioned, in order. */
  provisionedTenants(): readonly TenantId[];
  /**
   * Accepts one enterprise command through the REAL command-plane ingest
   * (the same ingestCommand discipline the /v1 routes call).
   */
  ingest(input: {
    readonly path: string;
    readonly kind: string;
    readonly key: string;
    readonly body: unknown;
    readonly tenantId?: string | undefined;
  }): Promise<{ readonly commandId: string }>;
  /**
   * Publishes one upstream administration record (policy or integration
   * observation) through the shared persistence — the domain's own parser
   * validates it before it lands.
   */
  publish(repository: string, recordId: string, record: unknown): Promise<void>;
}

/**
 * Binds the enterprise execution composition over a booted hosted journey:
 * the SAME bounded-tick path PA-025 composed, with the ENTERPRISE executor
 * table and the registrar bound to the REAL auth administration boundary,
 * riding the journey's own clock (the same clock every plane of the host
 * uses — the outbox's due times are the journey's instants).
 */
async function bindEnterpriseExecution(
  journey: HostedJourney,
  now: () => UtcInstant,
): Promise<EnterpriseExecution> {
  const identity = journey.composition.identity;
  const authorization = new AuthorizationService(identity.memberships, identity.organizations);
  const administration = new AccountAdministrationService({
    users: identity.users,
    directory: identity.directory,
    credentials: identity.credentials,
    organizations: identity.organizations,
    memberships: identity.memberships,
    ledger: identity.ledger,
    hasher: identity.hasher,
    authorization,
    now,
    generateMembershipId: () => crypto.randomUUID(),
  });

  // The registrar binding: verification's ONLY tenant source, bound to the
  // REAL auth administration boundary over the composition's own identity
  // stores (the organization + the requesting user's owner membership are
  // REAL identity facts — never enterprise-domain inventions).
  const provisionedTenants: TenantId[] = [];
  const registrar: OrganizationRegistrar = {
    async provisionOrganization(input) {
      const organizationId = crypto.randomUUID();
      const created = await administration.createOrganization(
        fixtureCommandEnvelope({
          commandId: crypto.randomUUID(),
          actorId: input.requestedBy,
          tenantId: tenantIdFromOrganization(parseOrganizationId(organizationId)),
          idempotencyKey: `registrar-${organizationId}`,
          correlationId: `corr-registrar-${organizationId}`,
          createdAt: now(),
        }),
        { organizationId, name: input.organizationName },
      );
      provisionedTenants.push(created.tenantId as TenantId);
      return { tenantId: created.tenantId, organizationId: created.organizationId };
    },
  };

  const persistence = journey.composition.persistence;
  const tick = createBoundedWorkerTick(
    { mode: "development", databaseUrl: undefined },
    {
      persistence,
      delivery: commandLedgerDeliveryPort({
        executors: createEnterpriseCommandExecutors({ persistence, registrar }),
        ledger: createCommandLedger({ persistence }),
        now,
      }),
      now,
    },
  );

  return {
    tick,
    provisionedTenants: () => [...provisionedTenants],
    async ingest(input) {
      const tenantId = input.tenantId ?? journey.identity.tenantId;
      const ack = await ingestCommand({
        request: {
          method: "POST",
          path: input.path,
          headers: {
            "x-roamlink-actor-id": journey.identity.actorId,
            "x-roamlink-tenant-id": tenantId,
            "x-roamlink-request-id": `req-${input.key}`,
            "x-roamlink-correlation-id": `corr-${input.key}`,
            "idempotency-key": input.key,
          },
          body: JSON.stringify(input.body),
        },
        path: input.path,
        commandKind: input.kind,
        actorId: journey.identity.actorId as ActorId,
        authorization,
        persistence,
        now,
        newCommandId: () => crypto.randomUUID(),
      });
      return { commandId: ack.commandId };
    },
    async publish(repository, recordId, record) {
      const unitOfWork = await persistence.begin();
      try {
        await unitOfWork.records(repository).insert(recordId, record as never);
        await unitOfWork.commit();
      } catch (error) {
        await unitOfWork.rollback();
        throw error;
      }
    },
  };
}

/** The deterministic policy record the upstream administration publishes. */
function policyRecordOf(tenantId: string, at: string) {
  const record = parseOrganizationPolicyRecord({
    policyId: deterministicUuidFromSeed(0x5aa1),
    contractVersion: "0.1",
    tenantId,
    state: "configured",
    source: "organization-administration",
    policyVersion: "v2026.1",
    summary: "Regional compliance profile: work apps only, metered cost cap.",
    effectiveAt: at,
    freshness: {
      observedAt: at,
      receivedAt: at,
      freshUntil: "2027-01-01T00:00:00.000Z",
      freshnessState: "FRESH",
    },
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });
  return record;
}

/** The deterministic integration status records the upstream administration publishes. */
function integrationRecordsOf(tenantId: string, at: string) {
  const base = {
    contractVersion: "0.1",
    tenantId,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  };
  return [
    parseEnterpriseIntegrationStatusRecord({
      ...base,
      integrationId: deterministicUuidFromSeed(0x5aa2),
      kind: "sso",
      state: "configured",
      summary: "Okta SAML SSO is in effect for all organization members.",
      freshness: {
        observedAt: at,
        receivedAt: at,
        freshUntil: "2027-01-01T00:00:00.000Z",
        freshnessState: "FRESH",
      },
    }),
    parseEnterpriseIntegrationStatusRecord({
      ...base,
      integrationId: deterministicUuidFromSeed(0x5aa3),
      kind: "scim",
      state: "not-configured",
      freshness: {
        observedAt: at,
        receivedAt: at,
        freshUntil: "2027-01-01T00:00:00.000Z",
        freshnessState: "FRESH",
      },
    }),
    parseEnterpriseIntegrationStatusRecord({
      ...base,
      integrationId: deterministicUuidFromSeed(0x5aa4),
      kind: "mdm",
      state: "unknown",
      freshness: {
        observedAt: null,
        receivedAt: null,
        freshUntil: null,
        freshnessState: "UNKNOWN",
      },
    }),
  ];
}

describe("RL-113 hosted journey: the EXECUTED enterprise workspace journey (PA-026 — the tick advances the commands)", () => {
  it("walks the full journey: enrollment executed via the tick, the registrar-provisioned organization, the connector, the policy, the integrations, the fleet and the first goal — then renders the eight steps", async () => {
    const clock = createJourneyClock();
    const journey = await bootHostedJourney({
      seed: 0x0e1,
      email: "enterprise-execution@example.com",
      composeWorkerTickEndpoint: true,
      now: clock.now,
    });
    try {
      const enterprise = await bindEnterpriseExecution(journey, clock.now);
      const hostedTick = journey.workerTick;
      expect(hostedTick).not.toBeNull();

      // --- Leg 0: the honest personal-tenant negatives --------------------
      const personal = await journey.app.client().getEnterpriseWorkspace();
      expect(personal.organization).toBeNull(); // a real fact, never fabricated
      expect(personal.enrollment).toBeNull();
      expect(personal.connector).toBeNull();
      expect(personal.policy).toBeNull();
      expect(personal.integrations).toBeNull();

      // --- Leg 1: the enrollment journey, EXECUTED via the tick -----------
      const created = await enterprise.ingest({
        path: "/v1/enterprise/enrollments",
        kind: "enrollment.create",
        key: "e2e-enroll-create-1",
        body: { organizationName: "Acahat Freight Co" },
      });
      clock.advanceMinutes();
      let report = await enterprise.tick.execute();
      expect(report.outbox).toMatchObject({ executed: 1, remainingPending: 0 });

      // The personal workspace now serves the actor's IN-FLIGHT journey
      // (requestedBy the principal, tenant still unbound).
      let workspace = await journey.app.client().getEnterpriseWorkspace();
      expect(workspace.enrollment).toMatchObject({
        enrollmentId: created.commandId,
        organizationName: "Acahat Freight Co",
        state: "draft",
        tenantId: null,
      });

      await enterprise.ingest({
        path: `/v1/enterprise/enrollments/${created.commandId}/submit`,
        kind: "enrollment.submit",
        key: "e2e-enroll-submit-2",
        body: {},
      });
      clock.advanceMinutes();
      report = await enterprise.tick.execute();
      expect(report.outbox).toMatchObject({ executed: 1 });
      workspace = await journey.app.client().getEnterpriseWorkspace();
      expect(workspace.enrollment?.state).toBe("submitted");

      // The honest pre-execution negative: the verify command is DURABLY
      // ACCEPTED but NOT ticked — the read serves the SUBMITTED state,
      // never the future one, and the registrar provisioned NOTHING.
      await enterprise.ingest({
        path: `/v1/enterprise/enrollments/${created.commandId}/verify`,
        kind: "enrollment.verify",
        key: "e2e-enroll-verify-3",
        body: {},
      });
      workspace = await journey.app.client().getEnterpriseWorkspace();
      expect(workspace.enrollment?.state).toBe("submitted");
      expect(enterprise.provisionedTenants()).toHaveLength(0);

      clock.advanceMinutes();
      report = await enterprise.tick.execute();
      expect(report.outbox).toMatchObject({ executed: 1 });
      // Verification provisioned the organization through the REAL auth
      // administration boundary: the registrar's own identity-store record.
      const provisionedTenants = enterprise.provisionedTenants();
      expect(provisionedTenants).toHaveLength(1);
      const orgTenantId = provisionedTenants[0];
      if (orgTenantId === undefined) throw new Error("the registrar provisioned no organization");
      expect(orgTenantId.startsWith("org:")).toBe(true);

      // --- Leg 2: the ORGANIZATION workspace (the registrar's own record) --
      const scoped = orgScopedApp(journey, orgTenantId);
      workspace = await scoped.client.getEnterpriseWorkspace();
      const organization = workspace.organization;
      if (organization === null) throw new Error("organization section missing");
      expect(organization.tenantId).toBe(orgTenantId);
      expect(organization.name).toBe("Acahat Freight Co");
      expect(organization.status).toBe("active");
      expect(workspace.enrollment).toMatchObject({
        enrollmentId: created.commandId,
        state: "verified",
        tenantId: orgTenantId,
      });

      // --- Leg 3: activation completes the journey ------------------------
      await enterprise.ingest({
        path: `/v1/enterprise/enrollments/${created.commandId}/activate`,
        kind: "enrollment.activate",
        key: "e2e-enroll-activate-4",
        body: {},
        tenantId: orgTenantId,
      });
      clock.advanceMinutes();
      report = await enterprise.tick.execute();
      expect(report.outbox).toMatchObject({ executed: 1 });
      workspace = await scoped.client.getEnterpriseWorkspace();
      expect(workspace.enrollment?.state).toBe("active");
      expect(workspace.enrollment?.activatedAt).toBeDefined();

      // --- Leg 4: the connector through the REAL app flow + the tick ------
      const provisioned = await scoped.app.provisionConnectorFlow(
        { connectorId: "workspace-main" },
        { idempotencyKey: "e2e-connector-provision-5" },
      );
      expect(provisioned.status).toBe("ok");
      if (provisioned.status !== "ok") return;
      expect(provisioned.acknowledgement.executedAt).toBeUndefined(); // accepted is NOT executed

      workspace = await scoped.client.getEnterpriseWorkspace();
      expect(workspace.connector).toBeNull(); // the honest pre-execution state

      clock.advanceMinutes();
      report = await enterprise.tick.execute();
      expect(report.outbox).toMatchObject({ executed: 1, remainingPending: 0 });
      workspace = await scoped.client.getEnterpriseWorkspace();
      const connector = workspace.connector;
      if (connector === null) throw new Error("connector section missing");
      expect(connector.provisioningId).toBe(provisioned.acknowledgement.commandId);
      // The domain's negotiated state at execution (the guaranteed floor
      // composition provisions the honest user-guided connector).
      expect(connector.state).toBe("provisioned");
      expect(connector.createdAt).toBeDefined();

      // --- Leg 5: the upstream policy administration publishes -------------
      const policyAt = clock.advanceMinutes();
      const policyRecord = policyRecordOf(orgTenantId, policyAt);
      await enterprise.publish(
        ENTERPRISE_POLICY_REPOSITORY,
        policyRecord.policyId,
        policyRecord,
      );
      workspace = await scoped.client.getEnterpriseWorkspace();
      const policy = workspace.policy;
      if (policy === null) throw new Error("policy section missing");
      expect(policy).toMatchObject({
        state: "configured",
        source: "organization-administration",
        policyVersion: "v2026.1",
        summary: "Regional compliance profile: work apps only, metered cost cap.",
      });
      expect(policy.freshness.freshnessState).toBe("FRESH");

      // --- Leg 6: the integration statuses --------------------------------
      for (const record of integrationRecordsOf(orgTenantId, policyAt)) {
        await enterprise.publish(ENTERPRISE_INTEGRATION_REPOSITORY, record.integrationId, record);
      }
      workspace = await scoped.client.getEnterpriseWorkspace();
      const integrations = workspace.integrations;
      if (integrations === null) throw new Error("integrations section missing");
      expect(integrations).toHaveLength(3);
      expect(integrations.find((row) => row.kind === "sso")).toMatchObject({
        state: "configured",
        summary: "Okta SAML SSO is in effect for all organization members.",
      });
      expect(integrations.find((row) => row.kind === "scim")?.state).toBe("not-configured");
      expect(integrations.find((row) => row.kind === "mdm")?.state).toBe("unknown");

      // --- Leg 7: the fleet + the first goal (the hosted demo tick) -------
      const enrolled = await scoped.app.enrollDeviceFlow(
        { name: "Fleet Phone", platform: "ios" },
        { idempotencyKey: "e2e-enterprise-device-6" },
      );
      expect(enrolled.status).toBe("ok");
      if (enrolled.status !== "ok") return;
      clock.advanceMinutes();
      const deviceTick = await (hostedTick as NonNullable<typeof journey.workerTick>)();
      expect(deviceTick.status).toBe(200);
      expect((JSON.parse(await deviceTick.text()) as Record<string, unknown>)["outbox"]).toMatchObject({
        executed: 1,
      });
      const replay = await scoped.app.enrollDeviceFlow(
        { name: "Fleet Phone", platform: "ios" },
        { idempotencyKey: "e2e-enterprise-device-6" },
      );
      const deviceId = replay.status === "ok" ? replay.acknowledgement.resource?.id : undefined;
      expect(deviceId).toBeDefined();

      const goal = await scoped.app.createIntentFlow(
        {
          deviceId: deviceId as string,
          rationale: "Keep the field team connected on work apps only.",
          accessClasses: ["work_apps_only"],
        },
        { idempotencyKey: "e2e-enterprise-goal-7" },
      );
      expect(goal.status).toBe("ok");
      if (goal.status !== "ok") return;
      clock.advanceMinutes();
      await (hostedTick as NonNullable<typeof journey.workerTick>)(); // executes the create
      const goalReplay = await scoped.app.createIntentFlow(
        {
          deviceId: deviceId as string,
          rationale: "Keep the field team connected on work apps only.",
          accessClasses: ["work_apps_only"],
        },
        { idempotencyKey: "e2e-enterprise-goal-7" },
      );
      const intentId = goalReplay.status === "ok" ? goalReplay.acknowledgement.resource?.id : undefined;
      expect(intentId).toBeDefined();
      const activated = await scoped.app.activateIntentFlow(
        { intentId: intentId as string },
        { idempotencyKey: "e2e-enterprise-goal-activate-8" },
      );
      expect(activated.status).toBe("ok");
      clock.advanceMinutes();
      await (hostedTick as NonNullable<typeof journey.workerTick>)(); // executes the activation

      // --- Leg 8: THE EIGHT-STEP WALK over the real reads -----------------
      const html = await scoped.app.renderDocument({ page: "workspace" });
      // The journey renders with every step's REAL state.
      expect(html).toContain('data-workspace-journey="true"');
      const stepStates: readonly [string, string][] = [
        ["workspace", "complete"],
        ["organization-verification", "complete"], // the enrollment is ACTIVE
        ["policy", "complete"], // configured + FRESH
        ["connector", "complete"], // provisioned
        ["devices", "complete"], // the executed fleet device
        ["capability-verification", "waiting"], // no fresh capability verification yet (honest)
        ["first-goal", "complete"], // the activated goal
        ["live-overview", "action-needed"], // no connectivity reference yet (honest)
      ];
      for (const [step, state] of stepStates) {
        expect(html).toContain(`data-workspace-step="${step}" data-workspace-step-state="${state}"`);
      }
      // The real organization identity, the live enrollment, the connector,
      // the policy summary and the integration rows all render.
      expect(html).toContain("Acahat Freight Co");
      expect(html).toContain('data-workspace-enrollment="true"');
      expect(html).not.toContain('data-enrollment-absent="true"');
      expect(html).not.toContain('data-connector-absent="true"');
      expect(html).toContain('data-policy-summary="configured"');
      expect(html).toContain('data-integrations="true"');
      expect(html).toContain('data-integration="sso" data-integration-state="configured"');
      expect(html).toContain('data-integration="scim" data-integration-state="not-configured"');
      expect(html).toContain('data-integration="mdm" data-integration-state="unknown"');
      // The connector flow renders the provisioned record (no start form —
      // the connector exists now).
      expect(html).not.toContain('data-connector-start="true"');
      expect(html).not.toContain('data-unavailable="true"');
      expect(html).not.toContain('data-error-kind=');
    } finally {
      await journey.dispose();
    }
  });
});
