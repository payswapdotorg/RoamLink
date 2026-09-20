/**
 * RL-113 — the hosted user-journey E2E suite, part 2:
 * device enrollment, connectivity observation, degraded connectivity and
 * automatic recovery over the REAL hosted composition.
 *
 * The connectivity journey's honest law end to end: the lifecycle
 * vocabulary (observed -> requested -> accepted -> reserved -> path active
 * -> delivery -> recovered) renders ONLY from what the read model asserts.
 * On the real runtime the read model is not composed — so NOTHING renders,
 * the indicator says "cannot confirm", and no stage (including a fabricated
 * "recovered") is ever claimed. The recovery that DOES exist on this
 * runtime is real and asserted: idempotent command replay, the durable
 * stored-command view, and replay-safe webhook admission.
 */
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "@roamlink/persistence-postgres";
import { isApiClientError } from "@roamlink/app-kit";

import {
  bootHostedJourney,
  signedWebhookRequest,
} from "../src/host.js";

describe("RL-113 hosted journey: device enrollment", () => {
  it("enrolls durably, then refuses the versioned device commands honestly", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b1, email: "devices@example.com" });
    try {
      const devicesPage = await journey.app.renderDocument({ page: "devices" });
      expect(devicesPage).toContain('data-shell-connectivity="unverifiable"');
      expect(devicesPage).toContain('data-error-kind="unavailable"');
      expect(devicesPage).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');

      // Primary task completion: the enrollment command is durable.
      const enrolled = await journey.app.enrollDeviceFlow(
        { name: "Travel Router", platform: "linux" },
        { idempotencyKey: "e2e-device-enroll" },
      );
      expect(enrolled.status).toBe("ok");
      if (enrolled.status !== "ok") return;
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);

      // The device-detail page reads fail closed (honest 501, no invented
      // device), and the versioned update/retire flows refuse to command
      // blind: the read-first discipline fails closed instead.
      const deviceId = "0d0d0d0d-0000-4000-8000-000000000004";
      const detail = await journey.app.renderDocument({
        page: "device",
        params: { deviceId },
      });
      expect(detail).toContain('data-error-kind="unavailable"');
      const updated = await journey.app.updateDeviceFlow(
        { deviceId, name: "Travel Router (renamed)" },
        { idempotencyKey: "e2e-device-update" },
      );
      expect(updated.status).toBe("error");
      if (updated.status !== "error") return;
      expect(updated.error).toMatchObject({ kind: "unavailable", reason: "READ_MODEL_NOT_COMPOSED" });
      const retired = await journey.app.retireDeviceFlow(
        { deviceId },
        { idempotencyKey: "e2e-device-retire" },
      );
      expect(retired.status).toBe("error");
      expect(await persistence.records("api-commands").count()).toBe(1);

      // Recovery state: same-key replay of the enrollment returns the SAME
      // acknowledgement and stores nothing new.
      const replay = await journey.app.enrollDeviceFlow(
        { name: "Travel Router", platform: "linux" },
        { idempotencyKey: "e2e-device-enroll" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(enrolled.acknowledgement);
      expect(await persistence.records("api-commands").count()).toBe(1);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: connectivity observation", () => {
  it("renders the connectivity center fail-closed with the honest unverifiable indicator", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b2, email: "connectivity@example.com" });
    try {
      const html = await journey.app.renderDocument({ page: "connectivity" });
      // The persistent indicator: the real overview read refused, so the
      // shell claims NOTHING (not success, not failure).
      expect(html).toContain('data-shell-connectivity="unverifiable"');
      expect(html).toContain("Cannot confirm right now");
      expect(html).toContain("this is not a success or a failure claim");
      // The page body is the typed error panel and nothing else.
      expect(html).toContain('data-error-kind="unavailable"');
      expect(html).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(html).not.toContain('data-connectivity-overview="true"');

      // The typed client surfaces the real refusal with its taxonomy kind
      // intact (the app never renders an unvalidated payload either way).
      let error: unknown;
      try {
        await journey.app.client().getConnectivityOverview();
      } catch (caught) {
        error = caught;
      }
      expect(isApiClientError(error)).toBe(true);
      if (isApiClientError(error)) {
        expect(error.status).toBe(501);
        expect(error.kind).toBe("unavailable");
        expect(error.reason).toBe("READ_MODEL_NOT_COMPOSED");
      }
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: degraded connectivity", () => {
  it("never fabricates the journey vocabulary from an unavailable read, and keeps support reachable", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b3, email: "degraded@example.com" });
    try {
      const html = await journey.app.renderDocument({ page: "connectivity" });
      // THE HONEST-STATE LAW over the real composition: no stage of the
      // lifecycle vocabulary is rendered (nothing is asserted by a read
      // that refused), and "recovered" is never claimed from anywhere.
      expect(html).not.toContain("Confirmed by the linked delivery evidence");
      expect(html).not.toContain("No device observations have been recorded yet");
      expect(html).not.toContain("What RoamLink did");
      // Commerce can never leak into the connectivity journey (payment is
      // not delivery, RL-LOCK-008) — trivially true and pinned fail-closed.
      expect(html).not.toContain("Payment confirmed?");
      // The degraded page still exposes the support escape hatch through
      // the persistent navigation (Support is one keyboard stop away).
      expect(html).toContain(">Support</a>");
      expect(html).toContain('href="/support"');
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: automatic recovery", () => {
  it("recovers commands by idempotent replay, by the durable stored-command view, and by replay-safe webhook admission", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b4, email: "recovery@example.com" });
    try {
      // --- (1) Client retry recovery: a mutation lost in transport is
      // retried with the SAME idempotency key; the real ledger replays the
      // original acknowledgement without a second effect.
      const first = await journey.app.enrollDeviceFlow(
        { name: "Recovery Phone", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(first.status).toBe("ok");
      if (first.status !== "ok") return;
      const replay = await journey.app.enrollDeviceFlow(
        { name: "Recovery Phone", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(first.acknowledgement);

      // A DIFFERENT payload under the SAME key is the typed conflict —
      // never a silent overwrite (RL-LOCK-014 at the real boundary).
      const conflict = await journey.app.enrollDeviceFlow(
        { name: "A Different Device", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(conflict.status).toBe("error");
      if (conflict.status !== "error") return;
      expect(conflict.error).toMatchObject({ kind: "conflict", reason: "COMMAND_IDEMPOTENCY_CONFLICT" });

      // --- (2) Durable command-status recovery: a crashed client can
      // re-derive its pipeline state from the stored-command view.
      const stored = await journey.app.client().getCommandStatus(first.acknowledgement.commandId);
      expect(stored).toEqual(first.acknowledgement);
      expect(stored.acceptedAt).toBeDefined();
      expect(stored.executedAt).toBeUndefined();

      // --- (3) Webhook admission is replay-safe: the same delivery
      // admitted twice answers ADMITTED then DUPLICATE, and the durable
      // inbox holds ONE admitted row (no double-processing).
      const delivery = signedWebhookRequest({
        eventId: "evt-e2e-recovery-1",
        deliveryId: "del-e2e-recovery-1",
        resourceType: "connectivity_contract",
        resourceId: "res-e2e-recovery-1",
        resourceVersion: 3,
        eventType: "connectivity_contract.state_changed",
      });
      const firstAdmission = await journey.v1({
        method: "POST",
        path: "/v1/webhooks/adcos",
        headers: Object.fromEntries(new Headers(delivery.headers).entries()),
        body: await delivery.text(),
      });
      expect(firstAdmission.status).toBe(202);
      expect(JSON.parse(firstAdmission.body ?? "{}")).toMatchObject({ outcome: "ADMITTED" });
      const secondDelivery = signedWebhookRequest({
        eventId: "evt-e2e-recovery-1",
        deliveryId: "del-e2e-recovery-1",
        resourceType: "connectivity_contract",
        resourceId: "res-e2e-recovery-1",
        resourceVersion: 3,
        eventType: "connectivity_contract.state_changed",
      });
      const secondAdmission = await journey.v1({
        method: "POST",
        path: "/v1/webhooks/adcos",
        headers: Object.fromEntries(new Headers(secondDelivery.headers).entries()),
        body: await secondDelivery.text(),
      });
      expect(secondAdmission.status).toBe(202);
      expect(JSON.parse(secondAdmission.body ?? "{}")).toMatchObject({ outcome: "DUPLICATE" });
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.inbox.count("ADMITTED")).toBe(1);

      // --- (4) Admission is NOT truth (RL-LOCK-009 end to end): after the
      // webhook was admitted, the connectivity read STILL refuses and no
      // journey state is claimed anywhere.
      let refused: unknown;
      try {
        await journey.app.client().getConnectivityOverview();
      } catch (caught) {
        refused = caught;
      }
      expect(isApiClientError(refused)).toBe(true);
      if (isApiClientError(refused)) {
        expect(refused.reason).toBe("READ_MODEL_NOT_COMPOSED");
      }
      const html = await journey.app.renderDocument({ page: "connectivity" });
      expect(html).toContain('data-shell-connectivity="unverifiable"');
    } finally {
      await journey.dispose();
    }
  });
});
