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
import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";

import {
  bootHostedJourney,
  orgScopedApp,
  registerHostedOrganization,
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
