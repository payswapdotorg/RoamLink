/**
 * PA-06 / RL-115-F3 — the guided connector-enrollment journey tests.
 *
 * The work order's journey, locked end-to-end over the deterministic fake:
 *
 *   Not started -> [Start enrollment] (command; capability-gated) ->
 *   Provisioning (honest in-flight state) -> Verification -> Provisioned
 *
 * with the failure path: Provisioning failure -> explanation (the closed
 * failure-reason vocabulary, honest) -> [Retry] / Support escape.
 *
 * These tests lock:
 *  - the not-started render in BOTH worlds (the actionable world renders the
 *    start command form; the gated worlds render the honest explanation and
 *    NEVER a dead action);
 *  - the command rides the full envelope: the acknowledgement keeps
 *    accepted/executed/delivered/billable-final SEPARATE — and a connector
 *    provisioning tops out at executed (a setup action is NEVER a delivery
 *    claim, RL-LOCK-008 spirit);
 *  - the polling states: the workspace re-read + the command-status read
 *    (the commandId page param) drive every render — the page never invents
 *    a stage the record does not assert;
 *  - the fake's progression controls mirror the owning domain's transition
 *    machinery (provisioning -> provisioned | failed; a failed attempt is
 *    terminal, so retry is a NEW provisioning with a new id);
 *  - idempotent replay: the same idempotency key replays the original
 *    acknowledgement with no additional effect (RL-LOCK-014);
 *  - the server-side gates fail closed even when the UI gate is bypassed
 *    (the UI gate is honest UX, never the authority);
 *  - the support escape pre-carries the connector facts transparently.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  isApiClientError,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const OWNER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";

function buildApp(options?: {
  seed?: FakeApiSeed;
  actor?: string;
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? connectorAbsentSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: options?.actor ?? OWNER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, client, fake, clock };
}

/** The pre-connector world: enrollment active, connector absent. */
function connectorAbsentSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    enterprise: {
      ...(tenant.enterprise?.enrollment !== undefined
        ? { enrollment: tenant.enterprise.enrollment }
        : {}),
    },
  };
  return { ...seed, tenants };
}

/** A workspace with NO enterprise fixtures (the gated, pre-enrollment world). */
function noEnterpriseSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const { enterprise: _stripped, ...rest } = tenant;
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants, [TENANT]: rest };
  return { ...seed, tenants };
}

describe("the not-started render (honest in both worlds)", () => {
  it("the actionable world renders the start command form and the four flow stages", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    // The journey step is the guided action now.
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="action-needed"');
    expect(page.html).toContain("Start connector enrollment");
    // The flow section with its four stages.
    expect(page.html).toContain('data-connector-enrollment="true"');
    for (const stage of ["not-started", "provisioning", "verification", "provisioned"]) {
      expect(page.html).toContain(`data-connector-flow-stage="${stage}"`);
    }
    // Not-started is the action-needed stage; nothing later is claimed.
    expect(page.html).toContain('data-connector-flow-stage="not-started" data-stage-state="action-needed"');
    expect(page.html).toContain('data-connector-flow-stage="provisioning" data-stage-state="upcoming"');
    expect(page.html).toContain('data-connector-flow-stage="verification" data-stage-state="upcoming"');
    expect(page.html).toContain('data-connector-flow-stage="provisioned" data-stage-state="upcoming"');
    // The start command form (the wired host flow).
    expect(page.html).toContain('data-flow="provision-connector"');
    expect(page.html).toContain('action="/flows/provision-connector"');
    expect(page.html).toContain("Start enrollment");
  });

  it("the gated world (no enterprise record) renders the honest explanation, never a dead action", async () => {
    const { app } = buildApp({ seed: noEnterpriseSeed(), actor: MEMBER_ACTOR });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="not-started"');
    expect(page.html).not.toContain('data-flow="provision-connector"');
    expect(page.html).toContain('data-connector-gate="enrollment"');
    expect(page.html).toContain("Organization verification comes first");
  });

  it("the permission gate renders for members of a verified organization", async () => {
    const { app } = buildApp({ seed: connectorAbsentSeed(), actor: MEMBER_ACTOR });
    const page = await app.renderPage({ page: "workspace" });
    // Enrollment is verified here, so the honest gate is the permission one.
    expect(page.html).not.toContain('data-flow="provision-connector"');
    expect(page.html).toContain('data-connector-gate="permission"');
    expect(page.html).toContain("organization-admin action");
  });
});

describe("start -> provisioning -> verification -> provisioned (deterministic fake)", () => {
  it("the start command acknowledges accepted+executed and NEVER claims delivery", async () => {
    const { app } = buildApp();
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    expect(flow.status).toBe("ok");
    if (flow.status !== "ok") throw new Error("unreachable");
    const ack = flow.acknowledgement;
    expect(ack.acceptedAt).toBeDefined();
    expect(ack.executedAt).toBeDefined();
    // A connector provisioning is a SETUP action: the delivered/billable-final
    // stages stay absent — command acceptance is never connectivity delivery.
    expect(ack.deliveredAt).toBeUndefined();
    expect(ack.billableFinalAt).toBeUndefined();
    expect(ack.resource?.type).toBe("connector_provisioning");
  });

  it("the in-flight provisioning renders honestly (nothing claimed as ready)", async () => {
    const { app, fake } = buildApp();
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    if (flow.status !== "ok") throw new Error("unreachable");
    const provisioningId = flow.acknowledgement.resource?.id ?? "";
    expect(provisioningId).not.toBe("");

    const page = await app.renderPage({ page: "workspace" });
    // The journey step waits; the record state renders verbatim.
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="waiting"');
    expect(page.html).toContain('data-state="provisioning"');
    // The flow: provisioning is current; verification is under way; the
    // provisioned stage is NOT claimed.
    expect(page.html).toContain('data-connector-flow-stage="provisioning" data-stage-state="current"');
    expect(page.html).toContain('data-connector-flow-stage="verification" data-stage-state="current"');
    expect(page.html).toContain('data-connector-flow-stage="provisioned" data-stage-state="upcoming"');
    expect(page.html).toContain('data-connector-inflight="true"');
    expect(page.html).toContain("The connector is provisioning.");
    // The polling affordance: the re-read link.
    expect(page.html).toContain("Refresh the connector state");
    // No start form while a provisioning is active.
    expect(page.html).not.toContain('data-flow="provision-connector"');

    // The command-status polling read: the commandId param renders the
    // four-stage pipeline (never fabricated from reads).
    const withCommand = await app.renderPage({
      page: "workspace",
      params: { commandId: flow.acknowledgement.commandId },
    });
    expect(withCommand.html).toContain('data-connector-command="true"');
    expect(withCommand.html).toContain(`data-command-id="${flow.acknowledgement.commandId}"`);
    expect(withCommand.html).toContain('data-stage="accepted"');
    expect(withCommand.html).toContain('data-stage="executed"');
    expect(withCommand.html).toContain('data-stage="delivered" data-reached="false"');

    // The completion happens ONLY through the domain-mirrored transition.
    expect(fake.controls.progressConnectorToProvisioned(provisioningId)).toBe(true);
    const done = await app.renderPage({ page: "workspace" });
    expect(done.html).toContain('data-workspace-step="connector" data-workspace-step-state="complete"');
    expect(done.html).toContain('data-connector-flow-stage="provisioning" data-stage-state="complete"');
    expect(done.html).toContain('data-connector-flow-stage="verification" data-stage-state="complete"');
    expect(done.html).toContain('data-connector-flow-stage="provisioned" data-stage-state="complete"');
    expect(done.html).toContain("Verification passed");
    expect(done.html).toContain("The connector is set up and ready");
  });

  it("replaying the same idempotency key replays the acknowledgement with no new effect", async () => {
    const { app, fake } = buildApp();
    const first = await app.provisionConnectorFlow(
      { connectorId: "acme-hq" },
      { idempotencyKey: "connector-start-1" },
    );
    if (first.status !== "ok") throw new Error("unreachable");
    const replay = await app.provisionConnectorFlow(
      { connectorId: "acme-hq" },
      { idempotencyKey: "connector-start-1" },
    );
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") throw new Error("unreachable");
    expect(replay.acknowledgement.commandId).toBe(first.acknowledgement.commandId);
    // Exactly ONE connector.provision command was recorded.
    const provisions = fake.controls
      .commands()
      .filter((command) => command.kind === "connector.provision");
    expect(provisions).toHaveLength(1);
  });

  it("a second attempt while a provisioning is active is the typed conflict (one active attempt)", async () => {
    const { app } = buildApp();
    const first = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    expect(first.status).toBe("ok");
    const second = await app.provisionConnectorFlow(
      { connectorId: "acme-hq-2" },
      { idempotencyKey: "connector-start-2" },
    );
    expect(second.status).toBe("error");
    if (second.status !== "error") throw new Error("unreachable");
    expect(isApiClientError(second.error)).toBe(true);
    if (isApiClientError(second.error)) {
      expect(second.error.reason).toBe("CONNECTOR_PROVISIONING_EXISTS");
    }
  });
});

describe("failure -> explanation -> retry -> provisioned", () => {
  it("the failure renders the closed reason vocabulary honestly, with retry and support", async () => {
    const { app, fake } = buildApp();
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    if (flow.status !== "ok") throw new Error("unreachable");
    const provisioningId = flow.acknowledgement.resource?.id ?? "";

    // The failure happens DURING provisioning, through the domain-mirrored
    // transition (provisioning -> failed with a closed-vocabulary reason).
    expect(fake.controls.failConnectorProvisioning(provisioningId, "connector-unavailable")).toBe(true);

    const page = await app.renderPage({ page: "workspace" });
    // The journey step is blocked with its fact.
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="blocked"');
    expect(page.html).toContain("Connector provisioning failed (connector-unavailable).");
    // The failure panel: the reason verbatim + the human explanation.
    expect(page.html).toContain('data-connector-failure="true"');
    expect(page.html).toContain('data-state="connector-unavailable"');
    expect(page.html).toContain("the connector service was not available to take the enrollment");
    // The later stages are NEVER claimed for a failed attempt.
    expect(page.html).toContain('data-connector-flow-stage="provisioning" data-stage-state="failed"');
    expect(page.html).toContain('data-connector-flow-stage="verification" data-stage-state="upcoming"');
    expect(page.html).toContain('data-connector-flow-stage="provisioned" data-stage-state="upcoming"');
    // The retry affordance (the same command flow) + the support escape.
    expect(page.html).toContain('data-flow="provision-connector"');
    expect(page.html).toContain("Retry enrollment");
    expect(page.html).toContain('data-support-escape="true"');
  });

  it("retry starts a NEW provisioning (the failed attempt is terminal) and reaches provisioned", async () => {
    const { app, fake } = buildApp();
    const first = await app.provisionConnectorFlow(
      { connectorId: "acme-hq" },
      { idempotencyKey: "attempt-1" },
    );
    if (first.status !== "ok") throw new Error("unreachable");
    const firstId = first.acknowledgement.resource?.id ?? "";
    expect(fake.controls.failConnectorProvisioning(firstId, "configuration-delivery-failed")).toBe(true);

    // The retry: a fresh idempotency key (the domain's failed state is
    // terminal — a retry is a new attempt).
    const retry = await app.provisionConnectorFlow(
      { connectorId: "acme-hq" },
      { idempotencyKey: "attempt-2" },
    );
    expect(retry.status).toBe("ok");
    if (retry.status !== "ok") throw new Error("unreachable");
    const retryId = retry.acknowledgement.resource?.id ?? "";
    expect(retryId).not.toBe(firstId);

    const inFlight = await app.renderPage({ page: "workspace" });
    expect(inFlight.html).toContain('data-state="provisioning"');
    expect(inFlight.html).not.toContain('data-connector-failure="true"');

    // The new attempt completes: provisioned.
    expect(fake.controls.progressConnectorToProvisioned(retryId)).toBe(true);
    const done = await app.renderPage({ page: "workspace" });
    expect(done.html).toContain('data-workspace-step="connector" data-workspace-step-state="complete"');
    expect(done.html).toContain('data-connector-flow-stage="provisioned" data-stage-state="complete"');
  });
});

describe("the support escape pre-carries the connector facts", () => {
  it("a failed enrollment's escape carries the provisioning reference transparently", async () => {
    const { app, fake } = buildApp();
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    if (flow.status !== "ok") throw new Error("unreachable");
    const provisioningId = flow.acknowledgement.resource?.id ?? "";
    expect(fake.controls.failConnectorProvisioning(provisioningId, "capability-negotiation-empty")).toBe(true);

    const page = await app.renderPage({ page: "workspace" });
    // (The rendered HTML escapes the apostrophe — assert the escaped form.)
    expect(page.html).toContain("connector enrollment failed and we need help");
    // The escape's href carries the context params; decode through the
    // Support page exactly as the host would forward them (the rendered
    // href HTML-escapes the query separator — unescape before parsing).
    const hrefMatch = page.html.match(/href="(\/support\?[^"]*)"/);
    expect(hrefMatch).not.toBeNull();
    const query = (hrefMatch?.[1] ?? "").split("?")[1] ?? "";
    const params = Object.fromEntries(new URLSearchParams(query.replaceAll("&amp;", "&")));
    const support = await app.renderPage({ page: "support", params });
    // The carried context pre-fills the case transparently (the connector
    // facts ride in the narrative — the support-context module's documented
    // carrier for facts without a dedicated ref kind).
    expect(support.html).toContain("Subject (carried from the page you came from)");
    expect(support.html).toContain('data-support-context-note="true"');
    expect(support.html).toContain(provisioningId);
    expect(support.html).toContain("capability-negotiation-empty");
  });
});

describe("the server-side gates fail closed (the UI gate is UX, never the authority)", () => {
  it("a member's provision command is the typed permission error even with the UI gate bypassed", async () => {
    const { app } = buildApp({ seed: connectorAbsentSeed(), actor: MEMBER_ACTOR });
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    expect(flow.status).toBe("error");
    if (flow.status !== "error") throw new Error("unreachable");
    expect(isApiClientError(flow.error)).toBe(true);
    if (isApiClientError(flow.error)) {
      expect(flow.error.kind).toBe("unauthorized");
      expect(flow.error.reason).toBe("ACTOR_PERMISSION_MISSING");
    }
  });

  it("a workspace without a verified enrollment is the typed gate conflict", async () => {
    const { app } = buildApp({ seed: noEnterpriseSeed(), actor: OWNER_ACTOR });
    const flow = await app.provisionConnectorFlow({ connectorId: "acme-hq" });
    expect(flow.status).toBe("error");
    if (flow.status !== "error") throw new Error("unreachable");
    expect(isApiClientError(flow.error)).toBe(true);
    if (isApiClientError(flow.error)) {
      expect(flow.error.reason).toBe("CONNECTOR_ENROLLMENT_GATE");
    }
  });
});
