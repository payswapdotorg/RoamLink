/**
 * RL-113 — the hosted user-journey E2E suite, part 1:
 * the entry journey, the first-run onboarding journey, and the
 * goal creation/editing journey over the REAL hosted composition.
 *
 * The real chain under test (nothing is a fake):
 *
 *   CustomerWebApp (apps/web, renderDocument + typed flow methods)
 *     -> RoamLinkApiClient (app-kit) over a REAL transport
 *       -> the host's /v1 mount (handleV1 -> services/api)
 *         -> @roamlink/auth session/authorization
 *           -> REAL PostgreSQL (pglite) + the REAL infra/migrations
 *
 * The honest terrain (asserted, never decorated): the real runtime
 * composes the durable COMMAND plane and the principal/session reads;
 * every business read model answers the typed 501
 * READ_MODEL_NOT_COMPOSED, and every page fails closed into the typed
 * error panel instead of rendering invented state.
 */
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "@roamlink/persistence-postgres";

import { bootHostedJourney } from "../src/host.js";

const DESKTOP_NAV_HREFS = [
  "/",
  "/connectivity",
  "/activity",
  "/devices",
  "/intents",
  "/commerce",
  "/support",
] as const;

const MOBILE_NAV_LABELS = ["Home", "Connect", "Activity", "Devices", "More"] as const;

/** Scans a rendered document for the persistent shell's journey chrome. */
function expectShellChrome(html: string): void {
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("RoamLink");
  // The full desktop navigation (labels are HTML-escaped in text nodes, so
  // the scan keys on the stable hrefs: /intents renders Goals, /commerce
  // renders Plans & Billing, /support renders Support).
  for (const href of DESKTOP_NAV_HREFS) {
    expect(html).toContain(`href="${href}"`);
  }
  expect(html).toContain('>Goals</a>');
  expect(html).toContain('>Support</a>');
  // The mobile variant is part of EVERY journey (the bottom navigation).
  for (const label of MOBILE_NAV_LABELS) {
    expect(html).toContain(`>${label}</a>`);
  }
  // The persistent indicator derives ONLY from the authoritative read: on
  // the real runtime the read honestly refuses, so the shell says so.
  expect(html).toContain('data-shell-connectivity="unverifiable"');
  expect(html).toContain("Cannot confirm right now");
  expect(html).toContain(
    "RoamLink could not read the authoritative connectivity state. Nothing is claimed either way.",
  );
  // The escape hatch into the connectivity center is rendered from every page.
  expect(html).toContain('href="/connectivity"');
}

/** Scans a rendered document for the typed fail-closed read refusal. */
function expectFailClosedRead(html: string): void {
  expect(html).toContain('data-error-kind="unavailable"');
  expect(html).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
  // Fail-closed means the body carries NO invented page content either way.
  expect(html).not.toContain('data-connectivity-overview="true"');
}

describe("RL-113 hosted journey: entry (land -> sign in -> Home)", () => {
  it("lands on the honest Home over the real composition after the hosted login", async () => {
    const journey = await bootHostedJourney({ seed: 0x0a1, email: "entry@example.com" });
    try {
      // The principal view IS composed on the real runtime: the raw /v1
      // mount answers the authenticated principal read.
      const me = await journey.v1({ method: "GET", path: "/v1/users/me", headers: {} });
      expect(me.status).toBe(200);
      const principal = JSON.parse(me.body ?? "{}") as Record<string, unknown>;
      expect(principal["actorId"]).toBe(journey.identity.actorId);
      expect(principal["tenantId"]).toBe(journey.identity.tenantId);
      expect(principal["scope"]).toBe("user");

      // CROSS-SURFACE FINDING (RL-113, recorded — never silently passed):
      // the typed app-kit client CANNOT parse the real principal view. The
      // real /v1/users/me body carries personalTenantId + sessionExpiresAt,
      // and the app-kit fail-closed parser (parseActorSessionResource)
      // rejects unknown fields — so getActorSession() over the real runtime
      // fails closed with the typed contract-violation error. The host's
      // own surface session resolution is unaffected (it hand-parses only
      // actorId/tenantId); any app surface that calls getActorSession()
      // (e.g. Settings, Workspace) fails closed on this runtime until the
      // wire shape or the parser is reconciled (owner: services/api x
      // app-kit — both frozen for this work item).
      let sessionError: unknown;
      try {
        await journey.app.client().getActorSession();
      } catch (caught) {
        sessionError = caught;
      }
      expect(sessionError).toMatchObject({ kind: "unknown-state", reason: "RESPONSE_CONTRACT_VIOLATION" });

      const html = await journey.app.renderDocument({ page: "home" });
      expectShellChrome(html);
      // The Home body fails closed: the home read set (connectivity,
      // intents, devices, notifications) is not composed on this runtime.
      expectFailClosedRead(html);
      // ...and no journey vocabulary is fabricated anywhere in the document.
      expect(html).not.toContain("data-journey-stage");
      expect(html).not.toContain("Confirmed by the linked delivery evidence");
    } finally {
      await journey.dispose();
    }
  });

  it("keeps the command plane + read plane honest after many journeys on one composition", async () => {
    const journey = await bootHostedJourney({ seed: 0x0a2, email: "entry-planes@example.com" });
    try {
      // The /v1 mount is honest about authentication FIRST: an
      // unauthenticated read is refused 401 before any read model answer.
      const refused = await journey.v1Raw({ method: "GET", path: "/v1/devices", headers: {} });
      expect(refused.status).toBe(401);
      // The authenticated read answers the typed 501 (honest unavailability).
      const honest = await journey.v1({
        method: "GET",
        path: "/v1/devices",
        headers: { "x-roamlink-actor-id": journey.identity.actorId, "x-roamlink-tenant-id": journey.identity.tenantId },
      });
      expect(honest.status).toBe(501);
      const body = JSON.parse(honest.body ?? "{}") as Record<string, unknown>;
      expect(body["reason"]).toBe("READ_MODEL_NOT_COMPOSED");
      // The webhook signing keys are configured but no delivery was made:
      // the durable inbox is empty (admission is the only ingress).
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.inbox.count()).toBe(0);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: first-run onboarding", () => {
  it("walks the four-step wizard over the real composition and completes the device-enrollment command", async () => {
    const journey = await bootHostedJourney({ seed: 0x0a3, email: "onboarding@example.com" });
    try {
      // Entry point: the wizard renders without any read (steps 1-2 are
      // pure presentation over the route params).
      const welcome = await journey.app.renderDocument({
        page: "onboarding",
        params: { step: "welcome" },
      });
      expect(welcome).toContain('data-onboarding="true"');
      expect(welcome).toContain('data-onboarding-step="welcome"');

      // Discoverability: the goal step presents ALL six human goal choices
      // as radio inputs (the customer never sees architecture vocabulary).
      const goal = await journey.app.renderDocument({
        page: "onboarding",
        params: { step: "goal" },
      });
      expect(goal).toContain('data-onboarding-step="goal"');
      expect(goal).toContain('data-onboarding-form="choose-goal"');
      expect(goal).toContain("Step 2 of 4");
      for (const value of ["travel", "work", "cost", "trusted-wifi", "privacy", "automatic-recovery"]) {
        expect(goal).toContain(`value="${value}"`);
      }

      // Primary task completion (leg 1): the device-enrollment command is
      // durably accepted through the real /v1 boundary.
      const enrolled = await journey.app.enrollDeviceFlow(
        { name: "Acahat Phone", platform: "ios" },
        { idempotencyKey: "e2e-onboarding-enroll" },
      );
      expect(enrolled.status).toBe("ok");
      if (enrolled.status !== "ok") return;
      expect(enrolled.acknowledgement.acceptedAt).toBeDefined();
      expect(enrolled.acknowledgement.executedAt).toBeUndefined();
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);
      expect(await persistence.outbox.count("PENDING")).toBe(1);

      // The mutation panel renders the four-stage pipeline per stage, tied
      // to the REAL durable command id (never collapsed).
      const deviceStep = await journey.app.renderDocument({
        page: "onboarding",
        params: { step: "device" },
        lastResult: enrolled,
      });
      expect(deviceStep).toContain('data-mutation-result="ok"');
      expect(deviceStep).toContain(`data-command-id="${enrolled.acknowledgement.commandId}"`);
      expect(deviceStep).toContain('data-stage="accepted" data-reached="true"');
      expect(deviceStep).toContain('data-stage="executed" data-reached="false"');
      expect(deviceStep).toContain('data-stage="delivered" data-reached="false"');
      expect(deviceStep).toContain('data-stage="billable-final" data-reached="false"');
      // The device-picker step still fails closed on its device-list read
      // (the wizard never invents enrolled devices to pick from).
      expectFailClosedRead(deviceStep);

      // Primary task completion (leg 2): the goal-creation command is
      // durably accepted, and the goal-ACTIVATION leg then honestly cannot
      // proceed — the flow needs the created goal id from the
      // acknowledgement (or the intent read), and the real runtime returns
      // neither (execution is the worker plane's concern). The app fails
      // closed instead of guessing the goal id.
      const finished = await journey.app.completeOnboardingFlow(
        { deviceId: "0f0f0f0f-0000-4000-8000-000000000001", goalChoiceId: "travel" },
        { idempotencyKey: "e2e-onboarding-finish" },
      );
      expect(finished.status).toBe("error");
      if (finished.status !== "error") return;
      expect(finished.error).toMatchObject({
        kind: "unknown-state",
        reason: "ONBOARDING_GOAL_NOT_CREATED",
      });
      // The create command IS in the durable ledger (two commands now).
      expect(await persistence.records("api-commands").count()).toBe(2);

      // Recovery state: the same idempotency key replays the SAME
      // acknowledgement with no additional effect (the sanctioned retry).
      const enrolledReplay = await journey.app.enrollDeviceFlow(
        { name: "Acahat Phone", platform: "ios" },
        { idempotencyKey: "e2e-onboarding-enroll" },
      );
      expect(enrolledReplay.status).toBe("ok");
      if (enrolledReplay.status !== "ok") return;
      expect(enrolledReplay.acknowledgement).toEqual(enrolled.acknowledgement);
      expect(await persistence.records("api-commands").count()).toBe(2);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: goal creation and editing", () => {
  it("creates the goal command durably and refuses versioned goal commands honestly when the read is uncomposed", async () => {
    const journey = await bootHostedJourney({ seed: 0x0a4, email: "goals@example.com" });
    try {
      // Entry point + discoverability: the Goals destination renders the
      // ExperienceIntent surface (fail-closed on this runtime).
      const goalsPage = await journey.app.renderDocument({ page: "intents" });
      expectShellChrome(goalsPage);
      expectFailClosedRead(goalsPage);

      // Primary task completion: the create command is durably accepted.
      const created = await journey.app.createIntentFlow(
        {
          deviceId: "0f0f0f0f-0000-4000-8000-000000000002",
          rationale: "Stay connected while traveling",
          accessClasses: ["any_internet"],
        },
        { idempotencyKey: "e2e-goal-create" },
      );
      expect(created.status).toBe("ok");
      if (created.status !== "ok") return;
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);

      // Editing (activate/supersede) is version-aware: the flow READS the
      // current revision first, the read honestly refuses (501), and the
      // flow fails closed WITHOUT issuing a versionless command into the
      // durable ledger (the read-first discipline holds end to end).
      const intentId = "0e0e0e0e-0000-4000-8000-000000000003";
      const activated = await journey.app.activateIntentFlow(
        { intentId },
        { idempotencyKey: "e2e-goal-activate" },
      );
      expect(activated.status).toBe("error");
      if (activated.status !== "error") return;
      expect(activated.error).toMatchObject({
        kind: "unavailable",
        reason: "READ_MODEL_NOT_COMPOSED",
      });
      const superseded = await journey.app.supersedeIntentFlow(
        { intentId, rationale: "Prefer trusted Wi-Fi when it is good enough", accessClasses: ["any_internet", "metered_cost_cap"] },
        { idempotencyKey: "e2e-goal-supersede" },
      );
      expect(superseded.status).toBe("error");
      expect(await persistence.records("api-commands").count()).toBe(1);

      // Recovery state: the create command's stored-command view is
      // readable and replays the same acknowledgement.
      const stored = await journey.app.client().getCommandStatus(created.acknowledgement.commandId);
      expect(stored.commandId).toBe(created.acknowledgement.commandId);
      expect(stored.acceptedAt).toBe(created.acknowledgement.acceptedAt);
      expect(stored.executedAt).toBeUndefined();
    } finally {
      await journey.dispose();
    }
  });
});
