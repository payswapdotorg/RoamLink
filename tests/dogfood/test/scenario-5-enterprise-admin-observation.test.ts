/**
 * RL-072 dogfood scenario 5: ENTERPRISE TENANT ONBOARDING -> ADMIN
 * OBSERVATION (RL-063 -> RL-061).
 *
 * The enterprise leg drives the REAL `/v1/enterprise` public API surface
 * (the typed EnterpriseApiClient over the enterprise package's
 * deterministic in-memory implementation of its own published route table
 * - the same surface production clients call). The admin leg observes the
 * resulting tenant through the REAL apps/admin console (RL-061) rendered
 * over the app-kit typed API client - the same public application API
 * both apps consume - whose world is seeded with the SAME tenant identity
 * the enterprise registrar provisioned.
 *
 * Architectural truth properties:
 *   - the enrollment journey is its own closed state machine and binds the
 *     tenant ONLY through the registrar port (auth stays the identity
 *     authority - no second identity authority, RL-LOCK-003);
 *   - every enterprise mutation is correlation/idempotency-key aware and
 *     replays idempotently (RL-LOCK-014);
 *   - the onboarding decisions are audited with the SAME correlation ids
 *     in a tamper-evident chain (RL-051);
 *   - the admin surface resolves the actor's session BEFORE fetching any
 *     data: a denied actor never triggers the surface request (the
 *     privilege-escalation threat fails closed - spec/security.md);
 *   - the admin observes the SAME tenant truth: the organization the
 *     registrar provisioned is what the console lists, with server-side
 *     authorization and audit on every command.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { AdminConsoleApp } from "@roamlink/admin";
import { EnterpriseApiClient } from "@roamlink/enterprise";
import { createEnterpriseApiHarness } from "@roamlink/enterprise";
import { DeterministicClock, SequenceIdGenerator } from "@roamlink/testkit";

const T0 = "2026-02-01T10:00:00.000Z";

/** The default seed's first tenant (operational fixtures reused verbatim). */
function firstSeedTenant(
  seed: ReturnType<typeof fakeApiSeed>,
): (ReturnType<typeof fakeApiSeed>)["tenants"][string] | undefined {
  const first = Object.keys(seed.tenants)[0];
  return first === undefined ? undefined : seed.tenants[first];
}

/** Deterministic enterprise id sources. */
function enterpriseIds() {
  let counter = 0;
  return {
    uuid: (): string => {
      counter += 1;
      return `90000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
    issued: (): number => counter,
  };
}

describe("RL-072 scenario 5: enterprise tenant onboarding -> admin observes the same truth", () => {
  it("walks the enrollment journey through the enterprise API and observes the provisioned tenant from the admin console", async () => {
    // ------------------------------------------------------------------
    // 1. The enterprise leg (RL-063): the typed client over the /v1 route
    //    table, one correlation family.
    // ------------------------------------------------------------------
    const clock = new DeterministicClock(T0);
    const ids = enterpriseIds();
    const harness = createEnterpriseApiHarness({
      enrollmentIdGenerator: ids.uuid,
      keyIdGenerator: ids.uuid,
      deliveryIdGenerator: ids.uuid,
      now: () => clock.now(),
    });
    const enterpriseClient = new EnterpriseApiClient({ transport: harness.transport });

    // Bootstrap: the first enterprise API key (issued out-of-band through
    // the service surface the fake exposes - production does the same).
    const issuance = await harness.apiKeys.issue(
      {
        tenantId: "org:77777777-0000-4000-8000-000000000001" as never,
        name: "bootstrap",
        scopes: ["enrollments:manage"],
      },
      {
        commandId: ids.uuid(),
        correlationId: "corr.dogfood.enterprise.bootstrap",
        idempotencyKey: "idem.dogfood.enterprise.bootstrap",
        actorId: "actor-bootstrap",
      },
      clock.now(),
    );
    const material = issuance.material.value;

    const context = () => ({
      commandId: ids.uuid(),
      correlationId: `corr.dogfood.enterprise.${ids.issued()}`,
      idempotencyKey: `idem.dogfood.enterprise.${ids.issued()}`,
      apiKeyMaterial: material,
    });

    const created = await enterpriseClient.createEnrollment(
      { organizationName: "Acahat Freight Co" },
      context(),
    );
    expect(created.state).toBe("draft");
    // Draft enrollments carry NO tenant: identity binds only through the
    // registrar at verification (RL-LOCK-003 - one identity authority).
    expect(created.tenantId).toBeNull();

    const submitted = await enterpriseClient.submitEnrollment(created.enrollmentId, context());
    expect(submitted.state).toBe("submitted");

    const verified = await enterpriseClient.verifyEnrollment(created.enrollmentId, context());
    expect(verified.state).toBe("verified");
    expect(verified.tenantId).not.toBeNull();

    // Idempotent replay (RL-LOCK-014): re-issuing the SAME activation
    // command replays the recorded outcome instead of duplicating.
    const activationContext = context();
    const activated = await enterpriseClient.activateEnrollment(
      created.enrollmentId,
      activationContext,
    );
    expect(activated.state).toBe("active");
    const replayed = await enterpriseClient.activateEnrollment(
      created.enrollmentId,
      activationContext,
    );
    expect(replayed.state).toBe("active");
    const listed = await enterpriseClient.listEnrollments(context());
    expect(listed.filter((record) => record.enrollmentId === created.enrollmentId)).toHaveLength(1);

    // The provisioned tenant identity (the truth the admin must observe).
    const tenantId = verified.tenantId as string;
    const organizationId = tenantId.slice("org:".length);
    expect(tenantId).toMatch(/^org:[0-9a-f-]{36}$/);

    // The onboarding decisions are audited, correlated and chain-verified.
    const auditVerification = await harness.audit.verify();
    expect(auditVerification.ok).toBe(true);
    const enrollmentAudits = await harness.audit.query({ tenantId: tenantId as never });
    expect(enrollmentAudits.length).toBeGreaterThan(0);
    for (const event of enrollmentAudits) {
      expect(event.outcome).toBe("allowed");
    }

    // ------------------------------------------------------------------
    // 2. The admin leg (RL-061): the REAL console over the app-kit typed
    //    API client, with the API world seeded to the SAME tenant the
    //    registrar provisioned (the organization identity is one truth).
    // ------------------------------------------------------------------
    const OWNER = "usr:baaaaaaa-0000-4000-8000-000000000001";
    const ADMIN = "usr:baaaaaaa-0000-4000-8000-000000000002";
    const MEMBER = "usr:baaaaaaa-0000-4000-8000-000000000003";
    const seed = fakeApiSeed();
    const bridgedTenant = {
      organization: {
        tenantId,
        organizationId,
        name: "Acahat Freight Co",
        status: "active" as const,
        revision: 1,
        members: [
          { userId: OWNER.slice(4), role: "owner" as const, status: "active" as const },
          { userId: ADMIN.slice(4), role: "admin" as const, status: "active" as const },
          { userId: MEMBER.slice(4), role: "member" as const, status: "active" as const },
        ],
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
      projections: firstSeedTenant(seed)?.projections ?? [],
      slos: firstSeedTenant(seed)?.slos ?? [],
      reconciliationJobs: firstSeedTenant(seed)?.reconciliationJobs ?? [],
    };
    const api = createInMemoryApi(
      {
        users: [
          { userId: OWNER.slice(4), displayName: "Acahat Owner" },
          { userId: ADMIN.slice(4), displayName: "Acahat Admin" },
          { userId: MEMBER.slice(4), displayName: "Acahat Member" },
        ],
        catalog: seed.catalog,
        tenants: { [tenantId]: bridgedTenant },
      },
      { now: () => clock.now(), ids: () => ids.uuid() },
    );

    const captured: HttpRequest[] = [];
    const capturingTransport = {
      async request(request: HttpRequest): Promise<HttpResponse> {
        captured.push(request);
        return api.transport.request(request);
      },
    };
    const adminClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: ADMIN, tenantId },
      ids: new SequenceIdGenerator({ prefix: "c-" }),
    });
    const consoleApp = new AdminConsoleApp({ client: adminClient });

    // The tenants page observes the SAME organization the registrar
    // provisioned - identical tenant + organization identity.
    const tenantsPage = await consoleApp.renderPage({ page: "tenants" });
    expect(tenantsPage.html).toContain("Acahat Freight Co");
    expect(tenantsPage.html).toContain(tenantId);
    const organizations = await adminClient.listOrganizations();
    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.tenantId).toBe(tenantId);
    expect(organizations[0]?.organizationId).toBe(organizationId);

    // The audit page renders the digest-chain verification of the API's
    // own audit trail (the admin's security review surface).
    const auditPage = await consoleApp.renderPage({ page: "audit" });
    expect(auditPage.html).toContain('data-chain-verified="true"');
    const auditEvents = await adminClient.listAuditEvents();
    expect(auditEvents.chain.verified).toBe(true);

    // The reconciliation + projection-health surfaces observe operational
    // truth through the same public API.
    const reconciliationPage = await consoleApp.renderPage({ page: "reconciliation" });
    expect(reconciliationPage.html.length).toBeGreaterThan(0);
    const healthPage = await consoleApp.renderPage({ page: "projectionHealth" });
    expect(healthPage.html.length).toBeGreaterThan(0);

    // ------------------------------------------------------------------
    // 3. Fail-closed privilege boundary (the admin console's top threat):
    //    a member actor is denied the ADMIN command, the denial is
    //    audited server-side, and a personal-tenant actor never even
    //    triggers the surface data request.
    // ------------------------------------------------------------------
    const memberClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: MEMBER, tenantId },
      ids: new SequenceIdGenerator({ prefix: "m-" }),
    });
    const memberConsole = new AdminConsoleApp({ client: memberClient });
    const memberSuspend = await memberConsole.suspendOrganizationFlow({ tenantId });
    expect(memberSuspend.status).toBe("error");
    // The denial is audited server-side with outcome 'denied'.
    const afterDenial = await adminClient.listAuditEvents({ category: "admin-override" });
    expect(
      afterDenial.events.some(
        (event) => event.outcome === "denied" && event.action.includes("org.suspend"),
      ),
    ).toBe(true);

    // A personal-tenant actor is denied every surface WITHOUT fetching it:
    // the console resolves the session first (fail-closed rendering gate).
    const personalRequestsBefore = captured.length;
    const personalClient = new RoamLinkApiClient({
      transport: capturingTransport,
      actor: { actorId: MEMBER, tenantId: `usr:${MEMBER.slice(4)}` },
      ids: new SequenceIdGenerator({ prefix: "p-" }),
    });
    const personalConsole = new AdminConsoleApp({ client: personalClient });
    const personalPage = await personalConsole.renderPage({ page: "tenants" });
    expect(personalPage.html).toContain('data-access-denied="true"');
    // Only the session request was made - the surface data was never fetched.
    expect(captured.length - personalRequestsBefore).toBe(1);

    // ------------------------------------------------------------------
    // 4. An admin command through the same command semantics: suspend ->
    //    reactivate with the four-stage acknowledgement and audit growth.
    // ------------------------------------------------------------------
    const suspendResult = await consoleApp.suspendOrganizationFlow(
      { tenantId },
      { idempotencyKey: "idem.dogfood.admin.suspend", correlationId: "corr.dogfood.admin.suspend" },
    );
    expect(suspendResult.status).toBe("ok");
    if (suspendResult.status !== "ok") throw new Error("unreachable");
    const ack = suspendResult.acknowledgement;
    expect(ack.commandId).toBeDefined();
    expect(ack.acceptedAt).toBeDefined();
    // The suspended org blocks reads (fail-closed) - observed honestly.
    await expect(adminClient.listOrganizations()).rejects.toThrowError(/suspended/i);

    const suspendVersion = ack.resource?.version;
    const reactivateResult = await consoleApp.reactivateOrganizationFlow(
      {
        tenantId,
        ...(suspendVersion !== undefined ? { expectedVersion: suspendVersion } : {}),
      },
      {
        idempotencyKey: "idem.dogfood.admin.reactivate",
        correlationId: "corr.dogfood.admin.reactivate",
      },
    );
    expect(reactivateResult.status).toBe("ok");
    const restored = await adminClient.listOrganizations();
    expect(restored[0]?.status).toBe("active");

    // The command audit trail grew with correlated admin decisions.
    const finalAudit = await adminClient.listAuditEvents();
    expect(finalAudit.events.length).toBeGreaterThan(auditEvents.events.length);
    expect(finalAudit.chain.verified).toBe(true);
    expect(
      finalAudit.events.some((event) => event.correlationId === "corr.dogfood.admin.suspend"),
    ).toBe(true);
  });
});
