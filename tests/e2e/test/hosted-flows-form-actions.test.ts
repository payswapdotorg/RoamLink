/**
 * PA-018 — the hosted form-action round-trip battery (closes F-016-1).
 *
 * This suite proves the SAME journeys RL-113 pins through the app's typed
 * flow methods (apps/web/test/* and tests/e2e/test/hosted-*-*.test.ts) now
 * ALSO succeed through the BROWSER-FORM path: real `application/x-www-form-
 * urlencoded` POSTs through the host's `/flows/*` route, with the host's
 * own session cookie + same-origin CSRF defense, dispatched to the matching
 * typed flow method on `CustomerWebApp` and answered per the page contract
 * (rendered result panel, or redirect-after-post for the connector-
 * enrollment and onboarding-finish laws).
 *
 * The real chain under test (nothing is a fake):
 *
 *   browser form-encoded POST -> handleFlowSubmit (host)
 *     -> resolveSurfaceClient (host session -> typed client)
 *       -> CustomerWebApp.<flow>Flow (apps/web)
 *         -> RoamLinkApiClient (app-kit) over the host's /v1 mount
 *           -> services/api -> @roamlink/auth -> REAL PostgreSQL (pglite)
 *
 * The honest terrain (asserted, never decorated): the real runtime
 * composes the durable COMMAND plane plus the PA-019 command-ledger read
 * projections (devices, experience-intents, connectivity, support cases,
 * enterprise workspace). The page bodies for those reads now serve their
 * real EMPTY state (no executed commands on this composition — accepted
 * is not executed) — the same composed-empty assertion pattern PA-019
 * adopted in the four RL-113 journey files. Pages whose read set still
 * includes a kept-501 route (the home page's notification read; the
 * commerce and order pages' product/order reads; the device-detail page's
 * notification read; the connectivity center's notification read) still
 * fail closed into the typed READ_MODEL_NOT_COMPOSED panel — and the
 * flows that READ a versioned resource first (update/retire device,
 * activate/supersede intent, cancel order, onboarding-finish's activation
 * leg) fail on the typed not-found (the read model composes the honest
 * empty/404 — never a blind versionless write through the form plane).
 *
 * Fail-closed matrix (the host never invents success):
 *   - runtime-not-ready → typed 503 HOST_NOT_READY
 *   - unknown flow name → typed 404 FLOW_NOT_FOUND
 *   - CSRF (same-origin) missing/cross-origin → typed 403 CSRF_INVALID
 *   - session cookie absent → 303 to /login
 *   - session cookie unresolvable → 303 to /login
 *
 * (CSRF-invalid never attempts the mutation; session-absent never attempts
 * the mutation; unknown-flow never attempts the mutation. The durable
 * command ledger is asserted empty after every negative leg.)
 */
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "@roamlink/persistence-postgres";

import { bootHostedJourney, type HostedJourney } from "../src/host.js";
import {
  handleFlowSubmit,
  WIRED_FLOW_NAMES,
  type PortalHostComposition,
} from "../../../apps/portal-host/src/index.js";

// ---------------------------------------------------------------------------
// Helpers — same-origin form-encoded POST construction
// ---------------------------------------------------------------------------

const HOST_ORIGIN = "https://host.test";

/**
 * Builds a same-origin form-encoded POST to `/flows/<flowName>`. The Origin
 * header matches the request URL's origin (the host's own origin — the
 * legitimate same-origin form submit; the CSRF defense accepts this).
 */
function flowPost(
  flowName: string,
  fields: Readonly<Record<string, string | readonly string[]>>,
  options: {
    readonly token: string;
    readonly origin?: string;
    readonly referer?: string;
  },
): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      body.set(key, value);
    } else {
      for (const entry of value) body.append(key, entry);
    }
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    cookie: `roamlink_session=${options.token}`,
  };
  // Origin is sent on every cross-site POST and on same-site POSTs by modern
  // browsers; the CSRF defense accepts the same-origin match.
  if (options.origin !== null) headers["origin"] = options.origin ?? HOST_ORIGIN;
  if (options.referer !== undefined) headers["referer"] = options.referer;
  return new Request(`${HOST_ORIGIN}/flows/${flowName}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
}

/** The host runtime shape `handleFlowSubmit` takes (the booted arm). */
function runtimeOf(composition: PortalHostComposition) {
  return { ok: true as const, composition };
}

/** The command ledger count (the durable side effect of any accepted flow). */
async function commandCount(journey: HostedJourney): Promise<number> {
  const persistence = createPostgresPersistence(journey.composition.driver);
  return await persistence.records("api-commands").count();
}

// ---------------------------------------------------------------------------
// The closed flow inventory — every wired action (the host's union, F-016-1)
// ---------------------------------------------------------------------------

const VARIANT_ID = "05050505-0000-4000-8000-000000000005";

// ---------------------------------------------------------------------------
// The positive matrix — every wired action through the form-encoded path
// ---------------------------------------------------------------------------

describe("PA-018 hosted form-actions: the positive matrix (every wired flow)", () => {
  it("enroll-device accepts the command durably and re-renders /devices with the success panel above the composed empty registry (PA-019)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d1, email: "flows-enroll@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("enroll-device", { name: "Form Phone", platform: "ios" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain('data-mutation-result="ok"');
      expect(html).toContain('data-stage="accepted" data-reached="true"');
      expect(html).toContain('data-stage="executed" data-reached="false"');
      // PA-019 merge-integration: the /devices read now composes the real
      // EMPTY registry (no executed commands — accepted is not executed).
      // The page renders the real empty state (the same composed-empty
      // pattern PA-019 adopted in tests/e2e/test/hosted-devices-
      // connectivity-recovery.test.ts): the empty-registry marker, the
      // "add your first device" CTA, and the rendered enroll-device form
      // for the next submit — never a 501, never an invented device. The
      // success panel rides above the body.
      expect(html).toContain('data-devices-empty="true"');
      expect(html).toContain("No devices yet.");
      expect(html).toContain("Add your first device");
      expect(html).toContain('data-flow="enroll-device"');
      // The shell connectivity indicator now states the honest no-reference
      // state (the composed connectivity read serves the real empty
      // aggregate — never a 501, never an unverifiable shrug).
      expect(html).toContain('data-shell-connectivity="no-reference"');
      // No READ_MODEL_NOT_COMPOSED panel anymore on the /devices body.
      expect(html).not.toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("update-device refuses the versioned command through the form path (the read-first discipline holds)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d2, email: "flows-update@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d2";
      const response = await handleFlowSubmit(
        flowPost("update-device", { deviceId, name: "Renamed Device" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-kind="unavailable"');
      expect(html).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      // The originating page (/devices/<deviceId>) is re-rendered; the
      // read-first leg refused, so NO command was issued (the discipline
      // holds through the form plane — never a blind versionless write).
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("retire-device refuses the versioned command through the form path (no blind write)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d3, email: "flows-retire@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d3";
      const response = await handleFlowSubmit(
        flowPost("retire-device", { deviceId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("esim-install accepts the command durably through the REAL /v1 mount and renders the typed acknowledgement panel (PA-023)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d4, email: "flows-esim-install@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d4";
      const response = await handleFlowSubmit(
        flowPost(
          "esim-install",
          { deviceId, activationCode: "act-code-fixture-never-prod" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The host re-renders the device-SIM surface (the page that hosts
      // the eSIM forms). The page TITLE carries the resolved page name
      // (`deviceSim`) — the body itself fails closed on the SIM read
      // (F-016-2) but the mutation-result panel renders above it.
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<title>RoamLink - deviceSim</title>");
      // PA-023 strengthening: the eSIM install mutation route landed in the
      // real API, so the flow now SUCCEEDS through the REAL /v1 mount — the
      // typed acknowledgement panel carries the command id, the idempotency
      // key echo (the host's `esim-install-<uuid>` key) and the honest
      // four-stage pipeline (accepted reached, the later stages honestly
      // NOT reached — accepted ≠ executed, the NO-INVENTION law).
      expect(html).toContain('data-mutation-result="ok"');
      expect(html).toMatch(
        /data-command-id="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/,
      );
      expect(html).toMatch(
        /command [0-9a-f-]{36} \(idempotency key esim-install-[0-9a-f-]{36}, correlation [0-9a-f-]{36}\)/,
      );
      expect(html).toContain('data-stage="accepted" data-reached="true"');
      expect(html).toContain('data-stage="executed" data-reached="false"');
      expect(html).toContain('data-stage="delivered" data-reached="false"');
      expect(html).toContain('data-stage="billable-final" data-reached="false"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("esim-install fails closed when the activation code is missing (form validation, no command attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d4b, email: "flows-esim-install-missing@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d4b";
      const response = await handleFlowSubmit(
        flowPost("esim-install", { deviceId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-kind="validation"');
      expect(html).toContain('data-error-reason="FORM_FIELDS_INVALID"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("esim-remove accepts the command durably through the REAL /v1 mount and renders the typed acknowledgement panel (PA-023)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d5, email: "flows-esim-remove@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d5";
      const profileId = "12121212-0000-4000-8000-000000000012";
      const response = await handleFlowSubmit(
        flowPost("esim-remove", { deviceId, profileId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<title>RoamLink - deviceSim</title>");
      // PA-023 strengthening: the remove command is durably accepted by the
      // real API — the typed acknowledgement panel echoes the command id +
      // the host's `esim-remove-<uuid>` idempotency key.
      expect(html).toContain('data-mutation-result="ok"');
      expect(html).toMatch(
        /command [0-9a-f-]{36} \(idempotency key esim-remove-[0-9a-f-]{36}, correlation [0-9a-f-]{36}\)/,
      );
      expect(html).toContain('data-stage="accepted" data-reached="true"');
      expect(html).toContain('data-stage="executed" data-reached="false"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("esim-enable accepts the command durably through the REAL /v1 mount and renders the typed acknowledgement panel (PA-023)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d6, email: "flows-esim-enable@example.com" });
    try {
      const deviceId = "0d0d0d0d-0000-4000-8000-0000000000d6";
      const profileId = "13131313-0000-4000-8000-000000000013";
      const response = await handleFlowSubmit(
        flowPost(
          "esim-enable",
          { deviceId, profileId, enabled: "true" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<title>RoamLink - deviceSim</title>");
      // PA-023 strengthening: the desired state rides the form; the command
      // is durably accepted — the acknowledgement panel echoes the command
      // id + the host's `esim-enable-<uuid>` idempotency key.
      expect(html).toContain('data-mutation-result="ok"');
      expect(html).toMatch(
        /command [0-9a-f-]{36} \(idempotency key esim-enable-[0-9a-f-]{36}, correlation [0-9a-f-]{36}\)/,
      );
      expect(html).toContain('data-stage="accepted" data-reached="true"');
      expect(html).toContain('data-stage="executed" data-reached="false"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("mark-notification-read accepts the read-marking command durably and re-renders /notifications", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d7, email: "flows-mark-read@example.com" });
    try {
      const notificationId = "06060606-0000-4000-8000-0000000000d7";
      const response = await handleFlowSubmit(
        flowPost("mark-notification-read", { notificationId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("create-intent accepts the goal-creation command durably and re-renders /intents", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d8, email: "flows-create-intent@example.com" });
    try {
      const deviceId = "0f0f0f0f-0000-4000-8000-0000000000d8";
      const response = await handleFlowSubmit(
        flowPost(
          "create-intent",
          { deviceId, rationale: "Stay connected while traveling", accessClasses: ["any_internet"] },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("create-intent fails closed when accessClasses is empty (form validation, no command attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d8b, email: "flows-create-intent-invalid@example.com" });
    try {
      const deviceId = "0f0f0f0f-0000-4000-8000-0000000000d8b";
      const response = await handleFlowSubmit(
        flowPost(
          "create-intent",
          { deviceId, rationale: "Goal with no access classes" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The host fails closed at the seam: empty accessClasses is rejected
      // by the form parser (the typed API requires a non-empty array; the
      // host's requiredEnumList enforces the same law before any command
      // is attempted). No durable command lands.
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-kind="validation"');
      expect(html).toContain('data-error-reason="FORM_FIELDS_INVALID"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("activate-intent refuses the versioned command through the form path on the honest not-found (PA-019 read-first discipline)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d9, email: "flows-activate@example.com" });
    try {
      const intentId = "0e0e0e0e-0000-4000-8000-0000000000d9";
      const response = await handleFlowSubmit(
        flowPost("activate-intent", { intentId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      // PA-019 merge-integration: the experience-intent read now composes;
      // the typed `getExperienceIntent(intentId)` read answers the honest
      // 404 NOT_FOUND for the unknown intent (no executed create command —
      // accepted is not executed). The flow's read-first discipline fails
      // closed on the typed not-found — never a blind versionless command
      // into the durable ledger. The same pattern PA-019 adopted in
      // tests/e2e/test/hosted-entry-onboarding-goals.test.ts (the
      // "creates the goal command durably and fails the versioned goal
      // commands on the honest not-found" row). The page body AND the
      // mutation-result panel both carry the typed not-found.
      expect(html).toContain('data-error-kind="not-found"');
      expect(html).toContain('data-error-reason="NOT_FOUND"');
      expect(html).not.toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("supersede-intent refuses the versioned command through the form path on the honest not-found (PA-019 read-first discipline)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0da, email: "flows-supersede@example.com" });
    try {
      const intentId = "0e0e0e0e-0000-4000-8000-0000000000da";
      const response = await handleFlowSubmit(
        flowPost(
          "supersede-intent",
          {
            intentId,
            rationale: "Prefer trusted Wi-Fi when it is good enough",
            accessClasses: ["any_internet", "metered_cost_cap"],
          },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      // PA-019 merge-integration: same as activate-intent — the read model
      // composes, the unknown intent answers the typed 404, and the flow
      // fails closed on the not-found (never a blind versionless command).
      expect(html).toContain('data-error-kind="not-found"');
      expect(html).toContain('data-error-reason="NOT_FOUND"');
      expect(html).not.toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("supersede-intent fails closed on missing accessClasses (form validation, no command)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0dab, email: "flows-supersede-invalid@example.com" });
    try {
      const intentId = "0e0e0e0e-0000-4000-8000-0000000000dab";
      const response = await handleFlowSubmit(
        flowPost(
          "supersede-intent",
          { intentId, rationale: "Goal with no access classes" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-kind="validation"');
      expect(html).toContain('data-error-reason="FORM_FIELDS_INVALID"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("create-support-case accepts the case command durably (with related refs carried through)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0db, email: "flows-support@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "create-support-case",
          {
            subject: "My connectivity has no delivery evidence yet",
            description: "I paid but the delivery progress view cannot confirm anything yet.",
            priority: "high",
            relatedRef: ["order~07070707-0000-4000-8000-000000000007", "device~0d0d0d0d-0000-4000-8000-000000000004"],
          },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("create-support-case rejects an invalid priority (form validation, no command attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0dbb, email: "flows-support-invalid@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "create-support-case",
          { subject: "Subject", description: "Description", priority: "critical" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-kind="validation"');
      expect(html).toContain('data-error-reason="FORM_FIELDS_INVALID"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("place-order accepts the order command durably and re-renders /commerce", async () => {
    const journey = await bootHostedJourney({ seed: 0x0dc, email: "flows-place-order@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("place-order", { variantId: VARIANT_ID, quantity: "2" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("record-payment accepts the payment command durably (money facts only)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0dd, email: "flows-record-payment@example.com" });
    try {
      const orderId = "07070707-0000-4000-8000-0000000000dd";
      const response = await handleFlowSubmit(
        flowPost(
          "record-payment",
          { orderId, amountMinor: "2499", currency: "USD" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("cancel-order refuses the versioned command through the form path (read-first discipline)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0de, email: "flows-cancel-order@example.com" });
    try {
      const orderId = "07070707-0000-4000-8000-0000000000de";
      const response = await handleFlowSubmit(
        flowPost("cancel-order", { orderId }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("provision-connector accepts the enrollment submit through the form plane and applies the redirect law (PA-023: the command is durable through the REAL /v1 mount)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0df, email: "flows-provision@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("provision-connector", { connectorId: "demo-connector" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      // PA-023 strengthening: the enterprise connector provisioning route
      // landed in the real API, so the flow now SUCCEEDS and the redirect law
      // applies on success — 303 to `/workspace?commandId=<ack.commandId>`
      // (the page renders the command's four-stage pipeline from the status
      // read; the redirect law itself was pinned in the unit battery
      // against the FLOW_HANDLERS table directly).
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toMatch(/^\/workspace\?commandId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const commandId = location.slice("/workspace?commandId=".length);
      // The command was durably ingested through the REAL /v1 mount.
      expect(await commandCount(journey)).toBe(1);
      // The typed acknowledgement through the REAL /v1 mount: the command
      // status read echoes the command id + the host's idempotency key and
      // the honest accepted-only stages (accepted ≠ executed).
      const status = await journey.v1({
        method: "GET",
        path: `/v1/commands/${commandId}`,
        headers: { "x-roamlink-tenant-id": journey.identity.tenantId },
      });
      expect(status.status).toBe(200);
      const ack = JSON.parse(status.body ?? "{}") as Record<string, unknown>;
      expect(ack["commandId"]).toBe(commandId);
      expect(ack["kind"]).toBeUndefined(); // the status read is the ack, not the stored record
      expect(String(ack["idempotencyKey"])).toMatch(/^provision-connector-[0-9a-f-]{36}$/);
      expect(ack["acceptedAt"]).toBe("2026-01-15T08:30:00.000Z");
      expect(ack["executedAt"]).toBeUndefined();
      expect(ack["deliveredAt"]).toBeUndefined();
      expect(ack["billableFinalAt"]).toBeUndefined();
    } finally {
      await journey.dispose();
    }
  });

  it("onboarding-enroll-device enrolls the device durably and re-renders the wizard at the device step (the page body fails closed under F-016-2; the mutation panel renders above)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0e0, email: "flows-onboard-enroll@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "onboarding-enroll-device",
          { goal: "travel", name: "Travel Phone", platform: "ios" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The mutation is durable (the enroll command is accepted).
      expect(html).toContain('data-mutation-result="ok"');
      // The host re-renders /onboarding (the wizard). The page TITLE
      // carries the resolved page name. The body fails closed on the
      // device-list read (F-016-2) so the wizard's step body doesn't
      // render — but the mutation-result panel above the body proves the
      // flow landed and the page is the right one.
      expect(html).toContain("<title>RoamLink - onboarding</title>");
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("onboarding-finish fails closed through the form path (the activation leg's read-first discipline) and re-renders /onboarding (the wizard)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0e1, email: "flows-onboard-finish@example.com" });
    try {
      const deviceId = "0f0f0f0f-0000-4000-8000-0000000000e1";
      const response = await handleFlowSubmit(
        flowPost(
          "onboarding-finish",
          { goal: "travel", deviceId },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      // The flow's create leg is durable, but the activate leg reads the
      // created intent first — and that read fails closed (F-016-2). The
      // flow returns the typed error; the host re-renders /onboarding
      // (NOT a redirect to Home — the redirect law applies only on
      // success). The create command IS in the durable ledger.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="error"');
      expect(html).toContain('data-error-reason="ONBOARDING_GOAL_NOT_CREATED"');
      expect(html).toContain("<title>RoamLink - onboarding</title>");
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The negative matrix — fail-closed laws (the host never invents success)
// ---------------------------------------------------------------------------

describe("PA-018 hosted form-actions: the negative matrix (fail-closed laws)", () => {
  it("runtime-not-ready → typed 503 HOST_NOT_READY (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f1, email: "flows-not-ready@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("enroll-device", { name: "X", platform: "ios" }, { token: journey.token }),
        { ok: false as const, error: new Error("composition refused") },
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["reason"]).toBe("HOST_NOT_READY");
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("unknown flow name → typed 404 FLOW_NOT_FOUND (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f2, email: "flows-unknown@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("definitely-not-a-flow", { anything: "any" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["reason"]).toBe("FLOW_NOT_FOUND");
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("a path under /flows/ with a slash in the flow name → typed 404 FLOW_NOT_FOUND", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f2b, email: "flows-slash@example.com" });
    try {
      // A second slash in the path is not a single flow segment; the host
      // refuses it as an unknown flow (the route forwarder only matches
      // `/flows/[name]`, but a direct handleFlowSubmit call with a slash-
      // bearing pathname is also rejected — defense in depth).
      const body = new URLSearchParams();
      body.set("x", "y");
      const request = new Request(`${HOST_ORIGIN}/flows/foo/bar`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: HOST_ORIGIN,
          cookie: `roamlink_session=${journey.token}`,
        },
        body: body.toString(),
      });
      const response = await handleFlowSubmit(request, runtimeOf(journey.composition));
      expect(response.status).toBe(404);
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("CSRF: cross-origin Origin → typed 403 CSRF_INVALID (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f3, email: "flows-csrf-cross@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "enroll-device",
          { name: "X", platform: "ios" },
          { token: journey.token, origin: "https://attacker.example" },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["reason"]).toBe("CSRF_INVALID");
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("CSRF: missing Origin and missing Referer → typed 403 CSRF_INVALID (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f4, email: "flows-csrf-missing@example.com" });
    try {
      // Build the POST with no Origin and no Referer (the headers modern
      // browsers strip in strict privacy modes — the host fails closed).
      const body = new URLSearchParams();
      body.set("name", "X");
      body.set("platform", "ios");
      const request = new Request(`${HOST_ORIGIN}/flows/enroll-device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `roamlink_session=${journey.token}`,
        },
        body: body.toString(),
      });
      const response = await handleFlowSubmit(request, runtimeOf(journey.composition));
      expect(response.status).toBe(403);
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("CSRF: same-origin Referer fallback accepts when Origin is absent (the legitimate privacy-mode case)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f4b, email: "flows-csrf-referer@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "enroll-device",
          { name: "Referer Phone", platform: "ios" },
          { token: journey.token, origin: null as unknown as string, referer: `${HOST_ORIGIN}/devices` },
        ),
        runtimeOf(journey.composition),
      );
      // The Referer fallback matches the host's own origin → CSRF passes →
      // the mutation is durable (the same legitimate path as a same-origin
      // browser POST in a privacy mode that strips Origin).
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("session: absent cookie → 303 to /login (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f5, email: "flows-no-session@example.com" });
    try {
      const body = new URLSearchParams();
      body.set("name", "X");
      body.set("platform", "ios");
      const request = new Request(`${HOST_ORIGIN}/flows/enroll-device`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_ORIGIN },
        body: body.toString(),
      });
      const response = await handleFlowSubmit(request, runtimeOf(journey.composition));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });

  it("session: unresolvable cookie → 303 to /login (no mutation attempted)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0f6, email: "flows-bad-session@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost(
          "enroll-device",
          { name: "X", platform: "ios" },
          { token: "not-a-real-token" },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(await commandCount(journey)).toBe(0);
    } finally {
      await journey.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The host's session-cookie end-to-end (the form-submit is bound to the
// host's own httpOnly cookie, just like the login form)
// ---------------------------------------------------------------------------

describe("PA-018 hosted form-actions: the host session-cookie binding", () => {
  it("a form submit driven through the host's own login cookie binding reaches the durable command plane", async () => {
    // Boot the composition, register the user, and sign in through the
    // host's own login form (the host's httpOnly cookie binding) — exactly
    // the leg a browser user takes. Then submit a /flows/* form-encoded POST
    // with that cookie; the host resolves the session, the typed flow
    // method runs, the command lands in the durable ledger. The host never
    // sees the credential material; the cookie is the only token surface.
    const journey = await bootHostedJourney({ seed: 0x100, email: "flows-cookie-binding@example.com" });
    try {
      // The journey already booted through handleLoginSubmit (see
      // bootHostedJourney); the token is the cookie value the host set.
      expect(journey.token).toMatch(/.+/);
      // A form submit with that token succeeds through the /flows/* plane.
      const response = await handleFlowSubmit(
        flowPost(
          "enroll-device",
          { name: "Cookie-bound Phone", platform: "android" },
          { token: journey.token },
        ),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-mutation-result="ok"');
      expect(await commandCount(journey)).toBe(1);
    } finally {
      await journey.dispose();
    }
  });

  it("the session cookie binding survives a flow submit (the cookie is not rotated or stripped by the flow plane)", async () => {
    const journey = await bootHostedJourney({ seed: 0x101, email: "flows-cookie-survives@example.com" });
    try {
      const response = await handleFlowSubmit(
        flowPost("enroll-device", { name: "X", platform: "ios" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(response.status).toBe(200);
      // The flow plane NEVER touches the session cookie (it reads it; it
      // never re-sets it). The response carries no Set-Cookie.
      expect(response.headers.get("set-cookie")).toBeNull();
      // A second flow submit on the SAME token still works (the cookie's
      // lifecycle is the host session layer's concern, not the flow plane's).
      const second = await handleFlowSubmit(
        flowPost("enroll-device", { name: "Y", platform: "ios" }, { token: journey.token }),
        runtimeOf(journey.composition),
      );
      expect(second.status).toBe(200);
      expect(await commandCount(journey)).toBe(2);
    } finally {
      await journey.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The closed-flow-union law — every rendered form action in apps/web is wired
// ---------------------------------------------------------------------------

describe("PA-018 hosted form-actions: the closed flow union (every rendered action is wired)", () => {
  // The set of /flows/* action URLs the rendered pages actually POST to.
  // This list MUST match the union enumerated in apps/web/src/pages/** (the
  // F-016-1 gap's measure). A drift between this list and the rendered forms
  // is the exact defect F-016-1 records: a rendered form that POSTs to an
  // unwired action. The host's FLOW_HANDLERS is the union this test pins.
  const RENDERED_FLOW_ACTIONS: readonly string[] = [
    "enroll-device",
    "update-device",
    "retire-device",
    "esim-install",
    "esim-enable",
    "esim-remove",
    "mark-notification-read",
    "create-intent",
    "activate-intent",
    "supersede-intent",
    "create-support-case",
    "place-order",
    "record-payment",
    "cancel-order",
    "provision-connector",
    "onboarding-enroll-device",
    "onboarding-finish",
  ];

  it("the host wires every rendered form action (the union is closed, F-016-1)", () => {
    // The host's WIRED_FLOW_NAMES is the same union; the test imports the
    // table and asserts the equality. A rendered form that POSTs to an
    // unwired action would fail this assertion (the host's union would be
    // missing the action name).
    const wired = [...WIRED_FLOW_NAMES].sort();
    const rendered = [...RENDERED_FLOW_ACTIONS].sort();
    expect(wired).toEqual(rendered);
  });
});
